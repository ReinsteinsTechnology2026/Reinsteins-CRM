const {
    assertGraphId,
    assertFolderRef,
    validateCompose,
    toGraphRecipient,
    validateAttachment,
    parseRecipientList,
    clampInt,
    EmailValidationError,
    SIMPLE_ATTACHMENT_LIMIT,
    WELL_KNOWN_FOLDERS,
} = require("../utils/emailValidation");
const { sanitizeEmailHtml, htmlToText, textToHtml } = require("../utils/emailHtmlSanitizer");
const { GraphError } = require("./graphClient");

// ==========================================
// GRAPH MAIL SERVICE -- every mail operation for ONE signed-in employee, against /me (never another user).
//
// All functions take a `graph` client already bound to that employee's token (see graphClient.js). Nothing here
// knows about companies or databases; the caller has already proven WHO the employee is and that the connection
// belongs to them, and /me guarantees Microsoft itself only ever returns that employee's own mailbox.
//
// Graph rules this code works around (documented because they are easy to trip over):
//   * $search cannot be combined with $filter or $orderby -- text searches use $search alone and the unread /
//     flagged / attachment filters are then applied to the returned page.
//   * $filter plus $orderby on messages needs the filtered property first in $orderby, and Exchange rejects an
//     "InefficientFilter" without a receivedDateTime restriction -- a harmless "received since 1900" clause is added.
//   * Message bodies are requested as HTML (Prefer header) and sanitized before leaving this module.
// ==========================================

const MAIL_FOLDER_SELECT = "id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount";
const LIST_SELECT = [
    "id", "conversationId", "subject", "bodyPreview", "from", "toRecipients", "receivedDateTime", "sentDateTime",
    "isRead", "isDraft", "hasAttachments", "importance", "flag", "categories", "parentFolderId",
].join(",");
const DETAIL_SELECT = `${LIST_SELECT},ccRecipients,bccRecipients,replyTo,body,internetMessageId`;

const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 50;

// Folders Outlook creates for its own purposes. They are not "mail folders" a person browses.
const HIDDEN_SYSTEM_FOLDERS = new Set([
    "outbox", "conversation history", "sync issues", "conflicts", "local failures", "server failures", "rss feeds",
    "rss subscriptions", "clutter", "quick step settings", "scheduled", "yammer root", "social activity notifications",
    "recoverable items", "journal", "notes", "tasks", "calendar", "contacts", "suggested contacts", "files",
]);

const WELL_KNOWN_LABELS = {
    inbox: "Inbox",
    sentitems: "Sent Items",
    drafts: "Drafts",
    deleteditems: "Deleted Items",
    junkemail: "Junk Email",
    archive: "Archive",
};

const b64u = (text) => Buffer.from(text, "utf8").toString("base64url");
const fromB64u = (text) => Buffer.from(text, "base64url").toString("utf8");

const path = (...segments) => segments.map((s) => encodeURIComponent(s)).join("/");

function cleanRecipient(entry) {
    const address = entry && entry.emailAddress;
    return address ? { name: address.name || "", address: address.address || "" } : null;
}

function mapListMessage(message) {
    return {
        id: message.id,
        conversationId: message.conversationId || null,
        subject: message.subject || "",
        preview: message.bodyPreview || "",
        from: cleanRecipient(message.from),
        to: (message.toRecipients || []).map(cleanRecipient).filter(Boolean),
        receivedAt: message.receivedDateTime || null,
        sentAt: message.sentDateTime || null,
        isRead: Boolean(message.isRead),
        isDraft: Boolean(message.isDraft),
        hasAttachments: Boolean(message.hasAttachments),
        importance: message.importance || "normal",
        flag: (message.flag && message.flag.flagStatus) || "notFlagged",
        categories: Array.isArray(message.categories) ? message.categories : [],
        folderId: message.parentFolderId || null,
    };
}

// ---------- folders ----------

async function listFolders(graph) {
    const batch = await graph.post("/$batch", {
        body: {
            requests: WELL_KNOWN_FOLDERS.map((name, index) => ({
                id: String(index + 1),
                method: "GET",
                url: `/me/mailFolders/${name}?$select=${MAIL_FOLDER_SELECT}`,
            })),
        },
    });

    const wellKnown = [];
    const wellKnownIds = new Set();
    for (const response of (batch && batch.responses) || []) {
        const name = WELL_KNOWN_FOLDERS[Number(response.id) - 1];
        if (!name || response.status !== 200 || !response.body) continue; // e.g. no Archive folder yet
        wellKnownIds.add(response.body.id);
        wellKnown.push({ ...mapFolder(response.body), wellKnown: name, name: WELL_KNOWN_LABELS[name] });
    }
    wellKnown.sort((a, b) => WELL_KNOWN_FOLDERS.indexOf(a.wellKnown) - WELL_KNOWN_FOLDERS.indexOf(b.wellKnown));

    const all = await graph.get("/me/mailFolders", { query: { $top: 100, $select: MAIL_FOLDER_SELECT } });
    const custom = ((all && all.value) || [])
        .filter((folder) => !wellKnownIds.has(folder.id) && !HIDDEN_SYSTEM_FOLDERS.has(String(folder.displayName || "").toLowerCase()))
        .map((folder) => ({ ...mapFolder(folder), wellKnown: null }))
        .sort((a, b) => a.name.localeCompare(b.name));

    return { folders: [...wellKnown, ...custom] };
}

function mapFolder(folder) {
    return {
        id: folder.id,
        name: folder.displayName,
        parentId: folder.parentFolderId || null,
        childCount: folder.childFolderCount || 0,
        unread: folder.unreadItemCount || 0,
        total: folder.totalItemCount || 0,
    };
}

async function listChildFolders(graph, folderId) {
    assertGraphId(folderId, "folder");
    const result = await graph.get(`/me/mailFolders/${path(folderId)}/childFolders`, { query: { $top: 100, $select: MAIL_FOLDER_SELECT } });
    return { folders: ((result && result.value) || []).map((folder) => ({ ...mapFolder(folder), wellKnown: null })) };
}

function cleanFolderName(name) {
    const value = String(name == null ? "" : name).trim();
    if (value.length < 1 || value.length > 100 || /[\u0000-\u001f]/.test(value)) {
        throw new EmailValidationError("A folder name must be 1-100 characters.", "INVALID_FOLDER_NAME");
    }
    return value;
}

async function createFolder(graph, { name, parentId }) {
    const displayName = cleanFolderName(name);
    const target = parentId ? `/me/mailFolders/${path(assertGraphId(parentId, "folder"))}/childFolders` : "/me/mailFolders";
    return mapFolder(await graph.post(target, { body: { displayName } }));
}

// Well-known folders cannot be renamed or deleted -- a folder is well-known when its id is the id of one of them.
async function assertCustomFolder(graph, folderId) {
    assertGraphId(folderId, "folder");
    const batch = await graph.post("/$batch", {
        body: {
            requests: WELL_KNOWN_FOLDERS.map((name, index) => ({ id: String(index + 1), method: "GET", url: `/me/mailFolders/${name}?$select=id` })),
        },
    });
    for (const response of (batch && batch.responses) || []) {
        if (response.status === 200 && response.body && response.body.id === folderId) {
            throw new EmailValidationError("Built-in folders cannot be renamed or deleted.", "FOLDER_PROTECTED");
        }
    }
}

async function renameFolder(graph, folderId, name) {
    await assertCustomFolder(graph, folderId);
    return mapFolder(await graph.patch(`/me/mailFolders/${path(folderId)}`, { body: { displayName: cleanFolderName(name) } }));
}

async function deleteFolder(graph, folderId) {
    await assertCustomFolder(graph, folderId);
    await graph.delete(`/me/mailFolders/${path(folderId)}`);
    return { deleted: true };
}

// ---------- listing and search ----------

// Opaque cursor <-> Graph's @odata.nextLink. The link is validated again when it is used (graphClient).
// It also carries the filters Graph could not apply (see the $search note above), so page 2 is filtered like page 1.
const encodeCursor = (nextLink, local) => (nextLink ? b64u(JSON.stringify({ l: nextLink, f: local || null })) : null);
const decodeCursor = (cursor) => {
    try {
        const parsed = JSON.parse(fromB64u(String(cursor)));
        if (typeof parsed.l !== "string") throw new Error("shape");
        return { link: parsed.l, local: parsed.f || null };
    } catch (_error) {
        throw new EmailValidationError("Invalid page cursor.", "INVALID_CURSOR");
    }
};

const kqlEscape = (value) => String(value).replace(/["\\()]/g, " ").replace(/\s+/g, " ").trim();
// A term with spaces is grouped in parentheses (KQL), a single token is used as is.
const kqlTerm = (value) => {
    const clean = kqlEscape(value);
    return /\s/.test(clean) ? "(" + clean + ")" : clean;
};
const odataString = (value) => String(value).replace(/'/g, "''");
const isoDate = (value, endOfDay) => {
    const text = String(value || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new EmailValidationError("Dates must be YYYY-MM-DD.", "INVALID_DATE");
    return `${text}T${endOfDay ? "23:59:59" : "00:00:00"}Z`;
};

function buildSearchExpression(filters) {
    const terms = [];
    if (filters.from) terms.push(`from:${kqlTerm(filters.from)}`);
    if (filters.to) terms.push(`to:${kqlTerm(filters.to)}`);
    if (filters.subject) terms.push(`subject:${kqlTerm(filters.subject)}`);
    if (filters.q) terms.push(kqlEscape(filters.q));
    if (filters.after) terms.push(`received>=${filters.after}`);
    if (filters.before) terms.push(`received<=${filters.before}`);
    return terms.join(" ");
}

function buildFilterExpression(filters) {
    const clauses = ["receivedDateTime ge 1900-01-01T00:00:00Z"];
    if (filters.after) clauses[0] = `receivedDateTime ge ${isoDate(filters.after, false)}`;
    if (filters.before) clauses.push(`receivedDateTime le ${isoDate(filters.before, true)}`);
    if (filters.unread) clauses.push("isRead eq false");
    if (filters.flagged) clauses.push("flag/flagStatus eq 'flagged'");
    if (filters.hasAttachments) clauses.push("hasAttachments eq true");
    if (filters.category) clauses.push(`categories/any(c:c eq '${odataString(filters.category)}')`);
    if (filters.from) clauses.push(`from/emailAddress/address eq '${odataString(filters.from)}'`);
    return clauses.join(" and ");
}

async function listMessages(graph, params = {}) {
    const pageSize = clampInt(params.top, { min: 1, max: PAGE_SIZE_MAX, fallback: PAGE_SIZE_DEFAULT });
    const headers = { Prefer: 'outlook.body-content-type="text"' };

    if (params.cursor) {
        const { link, local } = decodeCursor(params.cursor);
        const page = await graph.get(link, { headers });
        return shapePage(page, local ? { ...local, applyFlagsLocally: true } : {});
    }

    const folder = params.folderId ? assertFolderRef(params.folderId) : "inbox";
    const base = `/me/mailFolders/${path(folder)}/messages`;
    const textSearch = Boolean(params.q || params.subject || params.to);
    const filters = {
        q: params.q ? String(params.q).slice(0, 200) : "",
        from: params.from ? String(params.from).slice(0, 254) : "",
        to: params.to ? String(params.to).slice(0, 254) : "",
        subject: params.subject ? String(params.subject).slice(0, 200) : "",
        after: params.after || "",
        before: params.before || "",
        unread: truthy(params.unread),
        flagged: truthy(params.flagged),
        hasAttachments: truthy(params.hasAttachments),
        category: params.category ? String(params.category).slice(0, 100) : "",
    };
    if (filters.after) isoDate(filters.after, false);
    if (filters.before) isoDate(filters.before, true);

    let page;
    if (textSearch) {
        // $search cannot be combined with $filter / $orderby (Graph limitation); the result order is relevance.
        const expression = buildSearchExpression(filters);
        page = await graph.get(base, { headers, query: { $search: `"${expression}"`, $top: pageSize, $select: LIST_SELECT } });
    } else {
        const oldestFirst = params.sort === "oldest";
        page = await graph.get(base, {
            headers,
            query: {
                $filter: buildFilterExpression(filters),
                $orderby: `receivedDateTime ${oldestFirst ? "asc" : "desc"}`,
                $top: pageSize,
                $select: LIST_SELECT,
            },
        });
    }
    return shapePage(page, { ...params, applyFlagsLocally: textSearch, ...filters });
}

const truthy = (value) => value === true || value === "1" || value === "true";

function shapePage(page, params) {
    let messages = ((page && page.value) || []).map(mapListMessage);
    if (params.applyFlagsLocally) {
        if (params.unread) messages = messages.filter((m) => !m.isRead);
        if (params.flagged) messages = messages.filter((m) => m.flag === "flagged");
        if (params.hasAttachments) messages = messages.filter((m) => m.hasAttachments);
        if (params.sort === "oldest") messages.sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
    }
    const local = params.applyFlagsLocally
        ? { unread: Boolean(params.unread), flagged: Boolean(params.flagged), hasAttachments: Boolean(params.hasAttachments), sort: params.sort || null }
        : null;
    return { messages, nextCursor: encodeCursor(page && page["@odata.nextLink"], local), filteredLocally: Boolean(params.applyFlagsLocally) };
}

// ---------- reading ----------

function renderBody(message) {
    const body = message.body || {};
    const isHtml = String(body.contentType || "").toLowerCase() === "html";
    const raw = typeof body.content === "string" ? body.content : "";
    const sanitized = isHtml ? sanitizeEmailHtml(raw) : { html: textToHtml(raw), blockedRemoteImages: 0, truncated: false };
    return {
        html: sanitized.html,
        text: (isHtml ? htmlToText(sanitized.html) : raw).slice(0, 200_000),
        blockedRemoteImages: sanitized.blockedRemoteImages,
        truncated: sanitized.truncated,
    };
}

async function getMessage(graph, messageId) {
    assertGraphId(messageId, "message");
    const message = await graph.get(`/me/messages/${path(messageId)}`, {
        headers: { Prefer: 'outlook.body-content-type="html"' },
        query: { $select: DETAIL_SELECT },
    });
    const attachments = message.hasAttachments ? (await listAttachments(graph, messageId)).attachments : [];
    return {
        ...mapListMessage(message),
        cc: (message.ccRecipients || []).map(cleanRecipient).filter(Boolean),
        bcc: (message.bccRecipients || []).map(cleanRecipient).filter(Boolean),
        replyTo: (message.replyTo || []).map(cleanRecipient).filter(Boolean),
        internetMessageId: message.internetMessageId || null,
        body: renderBody(message),
        attachments,
    };
}

async function getConversation(graph, conversationId) {
    assertGraphId(conversationId, "conversation");
    // Graph cannot $orderby together with a conversationId filter, so the thread is sorted here.
    const page = await graph.get("/me/messages", {
        headers: { Prefer: 'outlook.body-content-type="text"' },
        query: { $filter: `conversationId eq '${odataString(conversationId)}'`, $top: 50, $select: LIST_SELECT },
    });
    const messages = ((page && page.value) || []).map(mapListMessage);
    messages.sort((a, b) => String(a.receivedAt || a.sentAt).localeCompare(String(b.receivedAt || b.sentAt)));
    return { messages };
}

// ---------- attachments ----------

async function listAttachments(graph, messageId) {
    assertGraphId(messageId, "message");
    const result = await graph.get(`/me/messages/${path(messageId)}/attachments`, {
        query: { $select: "id,name,contentType,size,isInline", $top: 50 },
    });
    return {
        attachments: ((result && result.value) || []).map((a) => ({
            id: a.id,
            name: a.name || "attachment",
            contentType: a.contentType || "application/octet-stream",
            size: a.size || 0,
            isInline: Boolean(a.isInline),
            // Only file attachments can be downloaded; item / reference attachments are listed but not downloadable.
            downloadable: !a["@odata.type"] || a["@odata.type"] === "#microsoft.graph.fileAttachment",
        })),
    };
}

async function downloadAttachment(graph, messageId, attachmentId) {
    assertGraphId(messageId, "message");
    assertGraphId(attachmentId, "attachment");
    const meta = await graph.get(`/me/messages/${path(messageId)}/attachments/${path(attachmentId)}`, { query: { $select: "id,name,contentType,size" } });
    if (meta["@odata.type"] && meta["@odata.type"] !== "#microsoft.graph.fileAttachment") {
        throw new GraphError("NOT_DOWNLOADABLE", "This attachment type cannot be downloaded here.", { status: 422 });
    }
    const content = await graph.get(`/me/messages/${path(messageId)}/attachments/${path(attachmentId)}/$value`, { raw: true, headers: { Accept: "*/*" } });
    return { name: meta.name || "attachment", contentType: meta.contentType || content.contentType || "application/octet-stream", buffer: content.buffer };
}

// Adds a file to a DRAFT. Up to ~3 MB goes in one request; larger files use a Graph upload session (chunked).
async function addAttachment(graph, messageId, file, { fetchImpl = fetch } = {}) {
    assertGraphId(messageId, "message");
    const base = `/me/messages/${path(messageId)}/attachments`;
    if (file.size <= SIMPLE_ATTACHMENT_LIMIT) {
        const created = await graph.post(base, {
            body: {
                "@odata.type": "#microsoft.graph.fileAttachment",
                name: file.name,
                contentType: file.contentType,
                contentBytes: file.buffer.toString("base64"),
            },
        });
        return { id: created.id, name: created.name, size: created.size, contentType: created.contentType };
    }

    const session = await graph.post(`${base}/createUploadSession`, {
        body: { AttachmentItem: { attachmentType: "file", name: file.name, size: file.size, contentType: file.contentType } },
    });
    assertUploadUrl(session && session.uploadUrl);
    const CHUNK = 4 * 1024 * 1024;
    for (let offset = 0; offset < file.size; offset += CHUNK) {
        const end = Math.min(offset + CHUNK, file.size);
        const response = await fetchImpl(session.uploadUrl, {
            method: "PUT",
            // The upload URL is pre-authenticated: it must NOT receive our bearer token.
            headers: { "Content-Length": String(end - offset), "Content-Range": `bytes ${offset}-${end - 1}/${file.size}`, "Content-Type": "application/octet-stream" },
            body: file.buffer.subarray(offset, end),
            signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) throw new GraphError("MICROSOFT_UNAVAILABLE", "Uploading the attachment failed.", { status: response.status });
    }
    return { name: file.name, size: file.size, contentType: file.contentType };
}

function assertUploadUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch (_error) {
        throw new GraphError("MICROSOFT_UNAVAILABLE", "Microsoft returned an invalid upload address.", {});
    }
    const hostOk = /(^|\.)(graph\.microsoft\.com|outlook\.office\.com|outlook\.office365\.com|outlook\.com|office\.com|office365\.com|office\.net|microsoft\.com)$/i.test(url.hostname);
    if (url.protocol !== "https:" || !hostOk) {
        throw new GraphError("MICROSOFT_UNAVAILABLE", "Microsoft returned an unexpected upload address.", {});
    }
}

async function deleteAttachment(graph, messageId, attachmentId) {
    assertGraphId(messageId, "message");
    assertGraphId(attachmentId, "attachment");
    await graph.delete(`/me/messages/${path(messageId)}/attachments/${path(attachmentId)}`);
    return { deleted: true };
}

// ---------- compose, drafts, send ----------

function draftPayload(compose, signatureHtml) {
    const cleaned = sanitizeEmailHtml(compose.body).html;
    const body = signatureHtml ? `${cleaned}<br><div class="zv-signature">${sanitizeEmailHtml(signatureHtml).html}</div>` : cleaned;
    return {
        subject: compose.subject,
        body: { contentType: "HTML", content: body },
        toRecipients: compose.to.map(toGraphRecipient),
        ccRecipients: compose.cc.map(toGraphRecipient),
        bccRecipients: compose.bcc.map(toGraphRecipient),
        importance: compose.importance,
    };
}

async function createDraft(graph, input, { signatureHtml } = {}) {
    const compose = validateCompose(input, { requireRecipient: false });
    // A signature is appended only when the editor has not already included it (the composer sends signed: false then).
    const created = await graph.post("/me/messages", { body: draftPayload(compose, input.appendSignature ? signatureHtml : null) });
    return { id: created.id, conversationId: created.conversationId || null };
}

async function updateDraft(graph, messageId, input) {
    assertGraphId(messageId, "message");
    const compose = validateCompose(input, { requireRecipient: false });
    await graph.patch(`/me/messages/${path(messageId)}`, { body: draftPayload(compose, null) });
    return { id: messageId };
}

async function sendDraft(graph, messageId) {
    assertGraphId(messageId, "message");
    await graph.post(`/me/messages/${path(messageId)}/send`);
    return { sent: true };
}

// One-step send for a message with no attachments. Saves a copy to Sent Items.
async function sendNew(graph, input, { signatureHtml } = {}) {
    const compose = validateCompose(input, { requireRecipient: true });
    const message = draftPayload(compose, input.appendSignature ? signatureHtml : null);
    await graph.post("/me/sendMail", { body: { message, saveToSentItems: true } });
    return { sent: true };
}

async function discardDraft(graph, messageId) {
    assertGraphId(messageId, "message");
    await graph.delete(`/me/messages/${path(messageId)}`);
    return { deleted: true };
}

// Reply / reply all / forward open an editable DRAFT that already carries the quoted original and the right
// recipients (createReply / createReplyAll / createForward). The composer then edits and sends it like any draft.
async function createReplyDraft(graph, messageId, mode) {
    assertGraphId(messageId, "message");
    const action = { reply: "createReply", replyAll: "createReplyAll", forward: "createForward" }[mode];
    if (!action) throw new EmailValidationError("Unknown reply mode.", "INVALID_MODE");
    const draft = await graph.post(`/me/messages/${path(messageId)}/${action}`, {});
    return getDraftForEdit(graph, draft.id);
}

async function getDraftForEdit(graph, draftId) {
    const draft = await graph.get(`/me/messages/${path(draftId)}`, {
        headers: { Prefer: 'outlook.body-content-type="html"' },
        query: { $select: "id,subject,body,toRecipients,ccRecipients,bccRecipients,importance,hasAttachments,conversationId" },
    });
    return {
        id: draft.id,
        conversationId: draft.conversationId || null,
        subject: draft.subject || "",
        bodyHtml: sanitizeEmailHtml((draft.body && draft.body.content) || "").html,
        to: (draft.toRecipients || []).map(cleanRecipient).filter(Boolean),
        cc: (draft.ccRecipients || []).map(cleanRecipient).filter(Boolean),
        bcc: (draft.bccRecipients || []).map(cleanRecipient).filter(Boolean),
        importance: draft.importance || "normal",
        attachments: draft.hasAttachments ? (await listAttachments(graph, draft.id)).attachments : [],
    };
}

// ---------- message state ----------

const FLAG_STATUS = new Set(["flagged", "complete", "notFlagged"]);

async function updateMessage(graph, messageId, changes) {
    assertGraphId(messageId, "message");
    const patch = {};
    if (changes.isRead !== undefined) patch.isRead = Boolean(changes.isRead);
    if (changes.flag !== undefined) {
        if (!FLAG_STATUS.has(changes.flag)) throw new EmailValidationError("Invalid flag.", "INVALID_FLAG");
        patch.flag = { flagStatus: changes.flag };
    }
    if (changes.categories !== undefined) {
        if (!Array.isArray(changes.categories) || changes.categories.length > 25) throw new EmailValidationError("Invalid categories.", "INVALID_CATEGORIES");
        patch.categories = changes.categories.map((c) => String(c).trim().slice(0, 100)).filter(Boolean);
    }
    if (Object.keys(patch).length === 0) throw new EmailValidationError("Nothing to change.", "NOTHING_TO_CHANGE");
    await graph.patch(`/me/messages/${path(messageId)}`, { body: patch });
    return { id: messageId };
}

async function moveMessage(graph, messageId, destination) {
    assertGraphId(messageId, "message");
    const moved = await graph.post(`/me/messages/${path(messageId)}/move`, { body: { destinationId: assertFolderRef(destination) } });
    return { id: moved && moved.id ? moved.id : messageId };
}

// Delete = move to Deleted Items (recoverable). Permanent delete is only allowed from Deleted Items or for a draft.
async function deleteMessage(graph, messageId, { permanent = false } = {}) {
    assertGraphId(messageId, "message");
    if (permanent) {
        await graph.delete(`/me/messages/${path(messageId)}`);
        return { deleted: true, permanent: true };
    }
    return { ...(await moveMessage(graph, messageId, "deleteditems")), deleted: true, permanent: false };
}

const restoreMessage = (graph, messageId) => moveMessage(graph, messageId, "inbox");
const archiveMessage = (graph, messageId) => moveMessage(graph, messageId, "archive");

// Up to 100 ids per call; Graph batches are 20 requests each. Per-message outcome is reported, never all-or-nothing.
async function bulkAction(graph, ids, action, options = {}) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) throw new EmailValidationError("Select between 1 and 100 messages.", "INVALID_SELECTION");
    ids.forEach((id) => assertGraphId(id, "message"));

    const build = (id) => {
        const url = `/me/messages/${path(id)}`;
        switch (action) {
            case "read": return { method: "PATCH", url, body: { isRead: true } };
            case "unread": return { method: "PATCH", url, body: { isRead: false } };
            case "flag": return { method: "PATCH", url, body: { flag: { flagStatus: "flagged" } } };
            case "unflag": return { method: "PATCH", url, body: { flag: { flagStatus: "notFlagged" } } };
            case "delete": return { method: "POST", url: `${url}/move`, body: { destinationId: "deleteditems" } };
            case "restore": return { method: "POST", url: `${url}/move`, body: { destinationId: "inbox" } };
            case "archive": return { method: "POST", url: `${url}/move`, body: { destinationId: "archive" } };
            case "move": return { method: "POST", url: `${url}/move`, body: { destinationId: assertFolderRef(options.destination) } };
            default: throw new EmailValidationError("Unknown bulk action.", "INVALID_ACTION");
        }
    };
    const requests = ids.map((id) => ({ id, ...build(id), headers: { "Content-Type": "application/json" } }));

    const results = [];
    for (let start = 0; start < requests.length; start += 20) {
        const chunk = requests.slice(start, start + 20);
        const response = await graph.post("/$batch", { body: { requests: chunk.map((r, i) => ({ ...r, id: String(i + 1) })) } });
        const byId = new Map(((response && response.responses) || []).map((r) => [r.id, r]));
        chunk.forEach((request, i) => {
            const outcome = byId.get(String(i + 1));
            results.push({ id: request.id, ok: Boolean(outcome && outcome.status >= 200 && outcome.status < 300), status: outcome ? outcome.status : 0 });
        });
    }
    return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

// ---------- categories, contacts, settings ----------

async function listCategories(graph) {
    const result = await graph.get("/me/outlook/masterCategories", { query: { $top: 100 } });
    return { categories: ((result && result.value) || []).map((c) => ({ id: c.id, name: c.displayName, color: c.color })) };
}

async function suggestContacts(graph, query) {
    const text = String(query || "").trim().slice(0, 80);
    if (text.length < 2) return { contacts: [] };
    const result = await graph.get("/me/people", { query: { $search: `"${kqlEscape(text)}"`, $top: 8, $select: "displayName,scoredEmailAddresses" } });
    const contacts = [];
    for (const person of (result && result.value) || []) {
        const address = person.scoredEmailAddresses && person.scoredEmailAddresses[0] && person.scoredEmailAddresses[0].address;
        if (address) contacts.push({ name: person.displayName || "", address });
    }
    return { contacts };
}

async function getMailboxSettings(graph) {
    const settings = await graph.get("/me/mailboxSettings");
    const auto = (settings && settings.automaticRepliesSetting) || {};
    return {
        timeZone: (settings && settings.timeZone) || null,
        automaticReplies: {
            status: auto.status || "disabled", // disabled | alwaysEnabled | scheduled
            externalAudience: auto.externalAudience || "none",
            internalReplyMessage: auto.internalReplyMessage || "",
            externalReplyMessage: auto.externalReplyMessage || "",
            scheduledStartDateTime: (auto.scheduledStartDateTime && auto.scheduledStartDateTime.dateTime) || null,
            scheduledEndDateTime: (auto.scheduledEndDateTime && auto.scheduledEndDateTime.dateTime) || null,
        },
    };
}

async function updateAutomaticReplies(graph, input) {
    const status = ["disabled", "alwaysEnabled", "scheduled"].includes(input.status) ? input.status : null;
    if (!status) throw new EmailValidationError("Invalid automatic replies status.", "INVALID_SETTING");
    const audience = ["none", "contactsOnly", "all"].includes(input.externalAudience) ? input.externalAudience : "none";
    const cleanMessage = (value) => sanitizeEmailHtml(String(value || "").slice(0, 20_000)).html;
    const setting = {
        status,
        externalAudience: audience,
        internalReplyMessage: cleanMessage(input.internalReplyMessage),
        externalReplyMessage: cleanMessage(input.externalReplyMessage),
    };
    if (status === "scheduled") {
        const timeZone = String(input.timeZone || "UTC").slice(0, 64);
        for (const key of ["scheduledStartDateTime", "scheduledEndDateTime"]) {
            if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(String(input[key] || ""))) {
                throw new EmailValidationError("Scheduled replies need a start and an end time.", "INVALID_SETTING");
            }
            setting[key] = { dateTime: input[key], timeZone };
        }
    }
    await graph.patch("/me/mailboxSettings", { body: { automaticRepliesSetting: setting } });
    return getMailboxSettings(graph);
}

async function getProfile(graph) {
    const me = await graph.get("/me", { query: { $select: "id,displayName,mail,userPrincipalName" } });
    return { id: me.id, displayName: me.displayName || "", mail: me.mail || null, userPrincipalName: me.userPrincipalName || null };
}

module.exports = {
    listFolders,
    listChildFolders,
    createFolder,
    renameFolder,
    deleteFolder,
    listMessages,
    getMessage,
    getConversation,
    listAttachments,
    downloadAttachment,
    addAttachment,
    deleteAttachment,
    createDraft,
    updateDraft,
    sendDraft,
    sendNew,
    discardDraft,
    createReplyDraft,
    getDraftForEdit,
    updateMessage,
    moveMessage,
    deleteMessage,
    restoreMessage,
    archiveMessage,
    bulkAction,
    listCategories,
    suggestContacts,
    getMailboxSettings,
    updateAutomaticReplies,
    getProfile,
    validateAttachment,
    parseRecipientList,
};
