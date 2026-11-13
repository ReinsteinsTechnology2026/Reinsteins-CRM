const multer = require("multer");
const { createMsEmailService, EmailServiceError } = require("../services/msEmailService");
const graphMail = require("../services/graphMailService");
const { GraphError } = require("../services/graphClient");
const { OAuthError } = require("../services/microsoftOAuthService");
const { SecretBoxError } = require("../utils/secretBox");
const {
    EmailValidationError,
    validateAttachment,
    attachmentDisposition,
    MAX_ATTACHMENT_BYTES,
    assertGraphId,
} = require("../utils/emailValidation");
const { sanitizeEmailHtml } = require("../utils/emailHtmlSanitizer");

// ==========================================
// MICROSOFT 365 EMAIL -- HTTP handlers.
//
// IDENTITY RULES:
//   * The company comes from req.tenantCompany and the employee from req.user, both set by tenantProtect from the
//     verified token. Nothing in a body, query string or URL can name another company or another employee: there is
//     no "userId" or "mailboxId" parameter on any mail route, the mailbox is always the caller's OWN.
//   * Admin routes are admin-only (requireAccess() in the router) and manage connections and mailbox links. They do not
//     give an administrator any way to read an employee's mail.
//   * Microsoft's own error text is never forwarded; every failure is mapped to a stable code and a safe message.
// ==========================================

const service = createMsEmailService();

const GRAPH_HTTP_STATUS = {
    REAUTH_REQUIRED: 409,
    ACCESS_DENIED: 403,
    MAILBOX_NOT_AVAILABLE: 409,
    NOT_FOUND: 404,
    BAD_REQUEST: 400,
    CONFLICT: 409,
    TOO_LARGE: 413,
    THROTTLED: 429,
    NOT_DOWNLOADABLE: 422,
    MICROSOFT_UNAVAILABLE: 502,
};

function respondError(res, error, logLabel) {
    if (error instanceof EmailServiceError || error instanceof OAuthError) {
        return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
    }
    if (error instanceof EmailValidationError) {
        return res.status(400).json({ success: false, code: error.code, message: error.message });
    }
    if (error instanceof GraphError) {
        if (error.retryAfterSeconds) res.set("Retry-After", String(Math.min(error.retryAfterSeconds, 120)));
        return res.status(GRAPH_HTTP_STATUS[error.code] || 502).json({ success: false, code: error.code, message: error.message });
    }
    if (error instanceof SecretBoxError) {
        console.error(`${logLabel} encryption error:`, error.code);
        return res.status(503).json({ success: false, code: "MS_NOT_CONFIGURED", message: "Microsoft 365 email is not configured correctly on this server." });
    }
    if (error && error.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ success: false, code: "ATTACHMENT_TOO_LARGE", message: "That file is too large." });
    }
    console.error(logLabel, error && (error.code || error.message));
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
}

const who = (req) => ({ companyId: req.tenantCompany.id, userId: req.user.id });

const handler = (label, fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (error) {
        respondError(res, error, `${label}:`);
    }
};

// ==========================================
// ADMIN
// ==========================================

const getCompanyStatus = handler("MS company status", async (req, res) => {
    res.json({ success: true, ...(await service.companyStatus(req.tenantCompany.id)) });
});

const connectCompany = handler("MS connect company", async (req, res) => {
    const connection = await service.connectCompany({ companyId: req.tenantCompany.id, actorUserId: req.user.id, domainId: Number(req.body && req.body.domainId) });
    res.status(201).json({ success: true, connection });
});

const checkCompany = handler("MS check company", async (req, res) => {
    const connection = await service.checkCompanyConnection({ companyId: req.tenantCompany.id, actorUserId: req.user.id });
    res.json({ success: true, connection });
});

const disconnectCompany = handler("MS disconnect company", async (req, res) => {
    res.json({ success: true, ...(await service.disconnectCompany({ companyId: req.tenantCompany.id, actorUserId: req.user.id })) });
});

// Mailbox rows plus the employee's name, read from THIS company's own tenant database.
const listMailboxes = handler("MS list mailboxes", async (req, res) => {
    const rows = await service.listMailboxes(req.tenantCompany.id);
    const ids = [...new Set(rows.map((row) => row.tenant_user_id))];
    const names = new Map();
    if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(",");
        const [users] = await req.tenantDb.query(`SELECT id, full_name FROM users WHERE id IN (${placeholders})`, ids);
        for (const user of users) names.set(user.id, user.full_name);
    }
    res.json({ success: true, mailboxes: rows.map((row) => ({ ...row, employeeName: names.get(row.tenant_user_id) || null })) });
});

const mailboxIdFrom = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new EmailValidationError("Invalid mailbox.", "INVALID_ID");
    return id;
};

const linkMailbox = handler("MS link mailbox", async (req, res) => {
    const mailbox = await service.linkMailbox({ companyId: req.tenantCompany.id, actorUserId: req.user.id, mailboxId: mailboxIdFrom(req) });
    res.json({ success: true, mailbox });
});

const unlinkMailbox = handler("MS unlink mailbox", async (req, res) => {
    const mailbox = await service.unlinkMailbox({ companyId: req.tenantCompany.id, actorUserId: req.user.id, mailboxId: mailboxIdFrom(req) });
    res.json({ success: true, mailbox });
});

const setMailboxEnabled = handler("MS enable mailbox", async (req, res) => {
    const result = await service.setMailboxEnabled({ companyId: req.tenantCompany.id, actorUserId: req.user.id, mailboxId: mailboxIdFrom(req), enabled: Boolean(req.body && req.body.enabled) });
    res.json({ success: true, ...result });
});

const listAudit = handler("MS audit", async (req, res) => {
    const entries = await service.listAudit(req.tenantCompany.id, { limit: req.query.limit, beforeId: req.query.before ? Number(req.query.before) : null });
    res.json({ success: true, entries });
});

// ==========================================
// EMPLOYEE: connect / disconnect
// ==========================================

const getMyStatus = handler("MS my status", async (req, res) => {
    res.json({ success: true, ...(await service.employeeStatus(who(req))) });
});

const beginConnect = handler("MS begin connect", async (req, res) => {
    const portal = req.user.role === "admin" && req.body && req.body.portal === "admin" ? "admin" : "employee";
    res.json({ success: true, ...(await service.beginConnect({ ...who(req), returnPortal: portal })) });
});

const disconnectMine = handler("MS disconnect", async (req, res) => {
    res.json({ success: true, ...(await service.disconnectOwn(who(req))) });
});

// Microsoft redirects the BROWSER here (no Authorization header). Identity comes from the single-use state row only.
// Always ends in a redirect to the CRM; the reason is a short code, never Microsoft's text.
const handleCallback = async (req, res) => {
    let result = { ok: false, reason: "failed" };
    try {
        result = await service.completeCallback({ code: req.query.code, state: req.query.state, error: req.query.error });
    } catch (error) {
        console.error("MS callback:", error && (error.code || error.name));
    }
    try {
        if (!result.companyId) {
            const { getConfig } = require("../config/microsoftEmailConfig");
            const origin = getConfig().frontendOrigin;
            return origin ? res.redirect(302, `${origin}/?ms=error&reason=${encodeURIComponent(result.reason)}`) : res.status(400).send("Sign-in could not be completed.");
        }
        return res.redirect(302, await service.frontendRedirect({ companyId: result.companyId, returnPortal: result.returnPortal, result }));
    } catch (error) {
        console.error("MS callback redirect:", error && error.message);
        return res.status(400).send("Sign-in could not be completed.");
    }
};

// ==========================================
// MAIL (the caller's own mailbox)
// ==========================================

// Builds the caller's mail context, runs the operation, and keeps connection state honest if Microsoft rejects the token.
const mail = (label, fn) =>
    handler(label, async (req, res) => {
        const context = await service.getMailContext(who(req));
        try {
            await fn(req, res, context);
        } catch (error) {
            await service.noteGraphFailure(who(req), error).catch(() => {});
            throw error;
        }
    });

const getFolders = mail("MS folders", async (_req, res, { graph }) => res.json({ success: true, ...(await graphMail.listFolders(graph)) }));
const getChildFolders = mail("MS child folders", async (req, res, { graph }) => res.json({ success: true, ...(await graphMail.listChildFolders(graph, req.params.id)) }));
const createFolder = mail("MS create folder", async (req, res, { graph }) => res.status(201).json({ success: true, folder: await graphMail.createFolder(graph, req.body || {}) }));
const renameFolder = mail("MS rename folder", async (req, res, { graph }) => res.json({ success: true, folder: await graphMail.renameFolder(graph, req.params.id, req.body && req.body.name) }));
const deleteFolder = mail("MS delete folder", async (req, res, { graph }) => res.json({ success: true, ...(await graphMail.deleteFolder(graph, req.params.id)) }));

const listMessages = mail("MS list messages", async (req, res, { graph }) => res.json({ success: true, ...(await graphMail.listMessages(graph, req.query)) }));
const getMessage = mail("MS get message", async (req, res, { graph }) => res.json({ success: true, message: await graphMail.getMessage(graph, req.params.id) }));
const getConversation = mail("MS conversation", async (req, res, { graph }) => res.json({ success: true, ...(await graphMail.getConversation(graph, req.params.id)) }));

const updateMessage = mail("MS update message", async (req, res, { graph }) => res.json({ success: true, ...(await graphMail.updateMessage(graph, req.params.id, req.body || {})) }));
const moveMessage = mail("MS move message", async (req, res, { graph }) => res.json({ success: true, ...(await graphMail.moveMessage(graph, req.params.id, req.body && req.body.destination)) }));
const deleteMessage = mail("MS delete message", async (req, res, { graph }) =>
    res.json({ success: true, ...(await graphMail.deleteMessage(graph, req.params.id, { permanent: req.query.permanent === "1" })) }));
const restoreMessage = mail("MS restore message", async (req, res, { graph }) => res.json({ success: true, ...(await graphMail.restoreMessage(graph, req.params.id)) }));
const archiveMessage = mail("MS archive message", async (req, res, { graph }) => res.json({ success: true, ...(await graphMail.archiveMessage(graph, req.params.id)) }));
const bulk = mail("MS bulk", async (req, res, { graph, companyId, userId }) => {
    const body = req.body || {};
    const result = await graphMail.bulkAction(graph, body.ids, body.action, { destination: body.destination });
    await service.auditMailEvent({ companyId, userId, action: "bulk_" + String(body.action).slice(0, 20), detail: { count: Array.isArray(body.ids) ? body.ids.length : 0, failed: result.failed } });
    res.json({ success: true, ...result });
});

const createDraft = mail("MS create draft", async (req, res, { graph, companyId, userId }) => {
    const settings = await service.getSettings({ companyId, userId });
    const draft = await graphMail.createDraft(graph, req.body || {}, { signatureHtml: settings.signatureEnabled ? settings.signatureHtml : "" });
    res.status(201).json({ success: true, draft });
});
const updateDraft = mail("MS update draft", async (req, res, { graph }) => res.json({ success: true, ...(await graphMail.updateDraft(graph, req.params.id, req.body || {})) }));
const getDraft = mail("MS get draft", async (req, res, { graph }) => {
    assertGraphId(req.params.id, "message");
    res.json({ success: true, draft: await graphMail.getDraftForEdit(graph, req.params.id) });
});
const discardDraft = mail("MS discard draft", async (req, res, { graph }) => res.json({ success: true, ...(await graphMail.discardDraft(graph, req.params.id)) }));
const replyDraft = mail("MS reply draft", async (req, res, { graph }) => res.status(201).json({ success: true, draft: await graphMail.createReplyDraft(graph, req.params.id, req.body && req.body.mode) }));

const sendDraft = mail("MS send draft", async (req, res, { graph, companyId, userId }) => {
    // The composer saves the latest content to the draft first; sending an existing draft only releases it.
    const result = await graphMail.sendDraft(graph, req.params.id);
    await service.auditMailEvent({ companyId, userId, action: "message_sent" });
    res.json({ success: true, ...result });
});
const sendNew = mail("MS send", async (req, res, { graph, companyId, userId }) => {
    const settings = await service.getSettings({ companyId, userId });
    const result = await graphMail.sendNew(graph, req.body || {}, { signatureHtml: settings.signatureEnabled ? settings.signatureHtml : "" });
    await service.auditMailEvent({ companyId, userId, action: "message_sent" });
    res.json({ success: true, ...result });
});

// ---------- attachments ----------

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 5 } });
const uploadSingle = (req, res, next) =>
    upload.single("file")(req, res, (error) => (error ? respondError(res, error, "MS upload:") : next()));

const listAttachments = mail("MS attachments", async (req, res, { graph }) => res.json({ success: true, ...(await graphMail.listAttachments(graph, req.params.id)) }));
const addAttachment = mail("MS add attachment", async (req, res, { graph }) => {
    if (!req.file) throw new EmailValidationError("Choose a file to attach.", "NO_FILE");
    const existing = (await graphMail.listAttachments(graph, req.params.id)).attachments;
    const checked = validateAttachment(
        { name: req.file.originalname, size: req.file.size, contentType: req.file.mimetype },
        { totalSoFar: existing.reduce((sum, a) => sum + (a.size || 0), 0), countSoFar: existing.length }
    );
    const attachment = await graphMail.addAttachment(graph, req.params.id, { ...checked, buffer: req.file.buffer });
    res.status(201).json({ success: true, attachment });
});
const deleteAttachment = mail("MS delete attachment", async (req, res, { graph }) => res.json({ success: true, ...(await graphMail.deleteAttachment(graph, req.params.id, req.params.attachmentId)) }));
const downloadAttachment = mail("MS download attachment", async (req, res, { graph }) => {
    const file = await graphMail.downloadAttachment(graph, req.params.id, req.params.attachmentId);
    const headers = attachmentDisposition(file.name, file.contentType, req.query.inline === "1");
    res.set({
        "Content-Type": headers.contentType,
        "Content-Disposition": headers.disposition,
        "Content-Length": String(file.buffer.length),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "sandbox; default-src 'none'",
    });
    res.send(file.buffer);
});

// ---------- categories, contacts, settings ----------

const getCategories = mail("MS categories", async (_req, res, { graph }) => res.json({ success: true, ...(await graphMail.listCategories(graph)) }));
const suggestContacts = mail("MS contacts", async (req, res, { graph }) => res.json({ success: true, ...(await graphMail.suggestContacts(graph, req.query.q)) }));

const getSettings = mail("MS settings", async (_req, res, { graph, companyId, userId }) => {
    const [prefs, mailbox] = await Promise.all([service.getSettings({ companyId, userId }), graphMail.getMailboxSettings(graph)]);
    res.json({ success: true, signature: { html: prefs.signatureHtml, enabled: prefs.signatureEnabled }, favoriteFolders: prefs.favoriteFolders, ...mailbox });
});
const saveSettings = mail("MS save settings", async (req, res, { graph, companyId, userId }) => {
    const body = req.body || {};
    const saved = await service.saveSettings({ companyId, userId, signatureHtml: body.signature && body.signature.html, signatureEnabled: body.signature && body.signature.enabled, favoriteFolders: body.favoriteFolders });
    let mailboxSettings = null;
    if (body.automaticReplies) {
        mailboxSettings = await graphMail.updateAutomaticReplies(graph, body.automaticReplies);
        await service.auditMailEvent({ companyId, userId, action: "auto_reply_changed", detail: { status: mailboxSettings.automaticReplies.status } });
    }
    res.json({ success: true, signature: { html: saved.signatureHtml, enabled: saved.signatureEnabled }, favoriteFolders: saved.favoriteFolders, ...(mailboxSettings || {}) });
});

// Live check of the signature / reply HTML so the composer can show exactly what will be sent.
const previewHtml = handler("MS preview", async (req, res) => {
    res.json({ success: true, html: sanitizeEmailHtml(String((req.body && req.body.html) || "").slice(0, 200_000)).html });
});

module.exports = {
    service,
    respondError,
    getCompanyStatus, connectCompany, checkCompany, disconnectCompany, listMailboxes, linkMailbox, unlinkMailbox, setMailboxEnabled, listAudit,
    getMyStatus, beginConnect, disconnectMine, handleCallback,
    getFolders, getChildFolders, createFolder, renameFolder, deleteFolder,
    listMessages, getMessage, getConversation, updateMessage, moveMessage, deleteMessage, restoreMessage, archiveMessage, bulk,
    createDraft, updateDraft, getDraft, discardDraft, replyDraft, sendDraft, sendNew,
    uploadSingle, listAttachments, addAttachment, deleteAttachment, downloadAttachment,
    getCategories, suggestContacts, getSettings, saveSettings, previewHtml,
};
