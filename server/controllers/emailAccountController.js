const multer = require("multer");
const { createEmailAccountService, EmailAccountError } = require("../services/emailAccountService");
const { createEmailSyncService } = require("../services/emailSyncService");
const { GraphError } = require("../services/graphClient");
const { OAuthError } = require("../services/microsoftOAuthService");
const oauthGoogle = require("../services/googleOAuthService");
const { getGoogleConfig } = require("../config/emailProvidersConfig");
const { SecretBoxError } = require("../utils/secretBox");
const { EmailValidationError, validateAttachment, attachmentDisposition, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } = require("../utils/emailValidation");
const { sanitizeEmailHtml } = require("../utils/emailHtmlSanitizer");

// ==========================================
// EMAIL ACCOUNTS -- HTTP handlers.
//
// IDENTITY RULES:
//   * the company comes from req.tenantCompany and the employee from req.user (set by tenantProtect from the verified token).
//     An account id in a URL is only a lookup key INSIDE that employee's own accounts: someone else's id answers "not found".
//   * admin routes expose CONNECTION STATUS only (provider, masked address, state). No admin route returns mail, and the mail
//     routes accept only the caller's own accounts, administrator or not.
//   * the provider's own error text is never forwarded; every failure is mapped to a stable code and a safe message.
// ==========================================

const service = createEmailAccountService();
const sync = createEmailSyncService({ accountService: service, store: service.store });

const GRAPH_HTTP_STATUS = {
    REAUTH_REQUIRED: 409,
    ACCESS_DENIED: 403,
    MAILBOX_NOT_AVAILABLE: 409,
    NOT_FOUND: 404,
    BAD_REQUEST: 400,
    CONFLICT: 409,
    TOO_LARGE: 413,
    THROTTLED: 429,
    UNSUPPORTED: 422,
    NOT_DOWNLOADABLE: 422,
    APP_MISCONFIGURED: 502,
    MICROSOFT_UNAVAILABLE: 502,
    PROVIDER_UNAVAILABLE: 502,
};

function respondError(res, error, logLabel) {
    if (error instanceof EmailAccountError || error instanceof OAuthError) {
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
        return res.status(503).json({ success: false, code: "PROVIDER_NOT_CONFIGURED", message: "Email is not configured correctly on this server." });
    }
    if (error && error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ success: false, code: "ATTACHMENT_TOO_LARGE", message: "That file is too large." });
    if (error && (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE")) return res.status(400).json({ success: false, code: "ATTACHMENT_COUNT", message: "Too many attachments." });
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
// ACCOUNTS (the employee's own)
// ==========================================
const listAccounts = handler("accounts list", async (req, res) => res.json({ success: true, accounts: await service.listAccounts(who(req)), providers: service.providersStatus() }));
const getSummary = handler("accounts summary", async (req, res) => res.json({ success: true, ...(await service.summary({ ...who(req), refresh: req.query.refresh === "1" })) }));

const beginConnect = handler("accounts connect", async (req, res) => {
    const body = req.body || {};
    const portal = req.user.role === "admin" && body.portal === "admin" ? "admin" : "employee";
    res.json({ success: true, ...(await service.beginConnect({ ...who(req), provider: body.provider, accountId: body.accountId, returnPortal: portal })) });
});

const updateAccount = handler("accounts update", async (req, res) => {
    res.json({ success: true, account: await service.updateAccount({ ...who(req), accountId: req.params.accountId, displayName: req.body && req.body.displayName, color: req.body && req.body.color }) });
});

const disconnectAccount = handler("accounts disconnect", async (req, res) => res.json({ success: true, ...(await service.disconnect({ ...who(req), accountId: req.params.accountId })) }));

// The provider redirects the BROWSER here (no Authorization header). Identity comes only from the single-use state row. Always ends
// in a redirect to the CRM with a short reason code, never the provider's own text.
const handleCallback = (provider) => async (req, res) => {
    let result = { ok: false, reason: "failed" };
    try {
        result = await service.completeCallback({ provider, code: req.query.code, state: req.query.state, error: req.query.error });
    } catch (error) {
        console.error("email callback:", error && (error.code || error.name));
    }
    try {
        if (!result.companyId) {
            const { getProviderConfig } = require("../config/emailProvidersConfig");
            const origin = getProviderConfig(provider).frontendOrigin;
            return origin ? res.redirect(302, `${origin}/?ea=error&reason=${encodeURIComponent(result.reason)}`) : res.status(400).send("Sign-in could not be completed.");
        }
        return res.redirect(302, await service.frontendRedirect({ companyId: result.companyId, returnPortal: result.returnPortal, result }));
    } catch (error) {
        console.error("email callback redirect:", error && error.message);
        return res.status(400).send("Sign-in could not be completed.");
    }
};

// ==========================================
// MAIL (always one of the caller's OWN accounts)
// ==========================================
const mail = (label, fn) =>
    handler(label, async (req, res) => {
        const ctx = await service.getContext({ ...who(req), accountId: req.params.accountId });
        try {
            await fn(req, res, ctx);
        } catch (error) {
            await service.noteFailure(ctx, error).catch(() => {});
            throw error;
        }
    });

const unifiedMessages = handler("unified inbox", async (req, res) => res.json({ success: true, ...(await service.listUnified({ ...who(req), params: req.query })) }));

const getFolders = mail("folders", async (_req, res, c) => res.json({ success: true, capabilities: c.provider.capabilities, ...(await c.provider.listFolders(c)) }));
const getChildFolders = mail("child folders", async (req, res, c) => res.json({ success: true, ...(await c.provider.listChildFolders(c, req.params.id)) }));
const createFolder = mail("create folder", async (req, res, c) => res.status(201).json({ success: true, folder: await c.provider.createFolder(c, req.body || {}) }));
const renameFolder = mail("rename folder", async (req, res, c) => res.json({ success: true, folder: await c.provider.renameFolder(c, req.params.id, req.body && req.body.name) }));
const deleteFolder = mail("delete folder", async (req, res, c) => res.json({ success: true, ...(await c.provider.deleteFolder(c, req.params.id)) }));

const listMessages = mail("list messages", async (req, res, c) => res.json({ success: true, ...(await c.provider.listMessages(c, req.query)) }));
const getMessage = mail("get message", async (req, res, c) => res.json({ success: true, message: await c.provider.getMessage(c, req.params.id) }));
const getConversation = mail("conversation", async (req, res, c) => res.json({ success: true, ...(await c.provider.getConversation(c, req.params.id)) }));
const updateMessage = mail("update message", async (req, res, c) => res.json({ success: true, ...(await c.provider.updateMessage(c, req.params.id, req.body || {})) }));
const moveMessage = mail("move message", async (req, res, c) => res.json({ success: true, ...(await c.provider.moveMessage(c, req.params.id, req.body && req.body.destination)) }));
const deleteMessage = mail("delete message", async (req, res, c) => res.json({ success: true, ...(await c.provider.deleteMessage(c, req.params.id, { permanent: req.query.permanent === "1" })) }));
const restoreMessage = mail("restore message", async (req, res, c) => res.json({ success: true, ...(await c.provider.restoreMessage(c, req.params.id)) }));
const archiveMessage = mail("archive message", async (req, res, c) => res.json({ success: true, ...(await c.provider.archiveMessage(c, req.params.id)) }));
const bulk = mail("bulk", async (req, res, c) => {
    const body = req.body || {};
    const result = await c.provider.bulkAction(c, body.ids, body.action, { destination: body.destination });
    await service.auditMailEvent({ companyId: c.companyId, userId: c.userId, action: `bulk_${String(body.action).slice(0, 20)}`, targetId: c.account.id, detail: { count: Array.isArray(body.ids) ? body.ids.length : 0, failed: result.failed } });
    res.json({ success: true, ...result });
});

// ---------- compose: ONE request carries the payload and any new files ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES, files: MAX_ATTACHMENTS, fields: 4, fieldSize: 1_600_000 } });
const uploadFiles = (req, res, next) => upload.array("files", MAX_ATTACHMENTS)(req, res, (error) => (error ? respondError(res, error, "email upload:") : next()));

function readPayload(req) {
    let payload;
    try {
        payload = JSON.parse(String((req.body && req.body.payload) || "{}"));
    } catch (_error) {
        throw new EmailValidationError("The message could not be read.", "INVALID_PAYLOAD");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new EmailValidationError("The message could not be read.", "INVALID_PAYLOAD");
    return payload;
}

// New files are validated BEFORE any provider call: blocked types, empty files, size and count limits.
function readFiles(req) {
    const files = [];
    let total = 0;
    for (const f of req.files || []) {
        const checked = validateAttachment({ name: f.originalname, size: f.size, contentType: f.mimetype }, { totalSoFar: total, countSoFar: files.length });
        total += f.size;
        files.push({ ...checked, buffer: f.buffer });
    }
    return files;
}

const saveDraft = mail("save draft", async (req, res, c) => {
    const draft = await c.provider.saveDraft(c, readPayload(req), readFiles(req));
    res.status(201).json({ success: true, draft });
});

const sendMessage = mail("send", async (req, res, c) => {
    const result = await c.provider.sendDraft(c, readPayload(req), readFiles(req));
    await service.auditMailEvent({ companyId: c.companyId, userId: c.userId, action: "message_sent", targetId: c.account.id, detail: { provider: c.account.provider } });
    res.json({ success: true, ...result });
});

const getDraft = mail("get draft", async (req, res, c) => res.json({ success: true, draft: await c.provider.getDraftForEdit(c, req.params.id) }));
const discardDraft = mail("discard draft", async (req, res, c) => res.json({ success: true, ...(await c.provider.discardDraft(c, req.params.id)) }));
const replyDraft = mail("reply draft", async (req, res, c) => res.status(201).json({ success: true, draft: await c.provider.createReplyDraft(c, req.params.id, req.body && req.body.mode) }));

const downloadAttachment = mail("download attachment", async (req, res, c) => {
    const file = await c.provider.downloadAttachment(c, req.params.id, req.params.attachmentId);
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

const getCategories = mail("categories", async (_req, res, c) => res.json({ success: true, ...(await c.provider.listCategories(c)) }));
const suggestContacts = mail("contacts", async (req, res, c) => res.json({ success: true, ...(await c.provider.suggestContacts(c, req.query.q)) }));
const getAutoReply = mail("auto reply", async (_req, res, c) => res.json({ success: true, capabilities: c.provider.capabilities, ...(await c.provider.getSettings(c)) }));
const saveAutoReply = mail("save auto reply", async (req, res, c) => {
    const settings = await c.provider.updateAutoReply(c, req.body || {});
    await service.auditMailEvent({ companyId: c.companyId, userId: c.userId, action: "auto_reply_changed", targetId: c.account.id, detail: { status: settings.automaticReplies.status } });
    res.json({ success: true, ...settings });
});

// ---------- CRM-level preferences (signature, favourite folders): not tied to one account ----------
const getSettings = handler("settings", async (req, res) => {
    const prefs = await service.getSettings(who(req));
    res.json({ success: true, signature: { html: prefs.signatureHtml, enabled: prefs.signatureEnabled }, favoriteFolders: prefs.favoriteFolders });
});
const saveSettings = handler("save settings", async (req, res) => {
    const body = req.body || {};
    const saved = await service.saveSettings({ ...who(req), signatureHtml: body.signature && body.signature.html, signatureEnabled: body.signature && body.signature.enabled, favoriteFolders: body.favoriteFolders });
    res.json({ success: true, signature: { html: saved.signatureHtml, enabled: saved.signatureEnabled }, favoriteFolders: saved.favoriteFolders });
});
const previewHtml = handler("preview", async (req, res) => res.json({ success: true, html: sanitizeEmailHtml(String((req.body && req.body.html) || "").slice(0, 200000)).html }));

// ==========================================
// ADMIN: connection STATUS only
// ==========================================
const adminOverview = handler("admin overview", async (req, res) => {
    const overview = await service.adminOverview(req.tenantCompany.id);
    const ids = overview.employees.map((e) => e.userId);
    const names = new Map();
    if (ids.length > 0) {
        const [users] = await req.tenantDb.query(`SELECT id, full_name FROM users WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
        for (const u of users) names.set(u.id, u.full_name);
    }
    res.json({ success: true, ...overview, employees: overview.employees.map((e) => ({ ...e, name: names.get(e.userId) || `Employee #${e.userId}` })) });
});
const adminDisconnect = handler("admin disconnect", async (req, res) => res.json({ success: true, ...(await service.adminDisconnect({ companyId: req.tenantCompany.id, actorUserId: req.user.id, accountId: req.params.accountId })) }));
const adminAudit = handler("admin audit", async (req, res) => res.json({ success: true, entries: await service.listAudit(req.tenantCompany.id, { limit: req.query.limit, beforeId: req.query.before ? Number(req.query.before) : null }) }));

// ==========================================
// PUSH (public, authenticated by the provider's own mechanism)
// ==========================================
// Gmail: Pub/Sub push carries a Google-signed OIDC token. Checked: signature (Google's keys), issuer, audience (our endpoint), and the
// configured push service account. A request that fails any check is refused and nothing is synchronised.
const googlePush = async (req, res) => {
    try {
        const config = getGoogleConfig();
        if (!config.pushConfigured) return res.status(404).end();
        await oauthGoogle.verifyPushJwt(req.headers.authorization, { audience: config.pushAudience, serviceAccount: config.pushServiceAccount });
        await sync.handleGooglePush(req.body);
        return res.status(204).end();
    } catch (error) {
        if (error instanceof OAuthError) return res.status(401).end();
        console.error("google push:", error && (error.code || error.message));
        return res.status(500).end();
    }
};

// Microsoft Graph: (1) subscription VALIDATION echoes a token as text/plain; (2) notifications carry the clientState we chose.
const microsoftPush = async (req, res) => {
    try {
        const token = req.query.validationToken;
        if (typeof token === "string") {
            if (!/^[\x20-\x7e]{1,2048}$/.test(token)) return res.status(400).end();
            res.set({ "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
            return res.status(200).send(token);
        }
        await sync.handleMicrosoftNotifications(req.body);
        return res.status(202).end();
    } catch (error) {
        console.error("microsoft push:", error && (error.code || error.message));
        return res.status(500).end();
    }
};

module.exports = {
    service,
    sync,
    respondError,
    listAccounts, getSummary, beginConnect, updateAccount, disconnectAccount,
    callbackGoogle: handleCallback("google"),
    callbackMicrosoft: handleCallback("microsoft"),
    unifiedMessages,
    getFolders, getChildFolders, createFolder, renameFolder, deleteFolder,
    listMessages, getMessage, getConversation, updateMessage, moveMessage, deleteMessage, restoreMessage, archiveMessage, bulk,
    uploadFiles, saveDraft, sendMessage, getDraft, discardDraft, replyDraft, downloadAttachment,
    getCategories, suggestContacts, getAutoReply, saveAutoReply, getSettings, saveSettings, previewHtml,
    adminOverview, adminDisconnect, adminAudit,
    googlePush, microsoftPush,
};
