const {
    assertGraphId,
    validateCompose,
    EmailValidationError,
    MAX_ATTACHMENT_BYTES,
    MAX_TOTAL_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS,
    clampInt,
} = require("../../utils/emailValidation");
const { sanitizeEmailHtml, htmlToText, textToHtml } = require("../../utils/emailHtmlSanitizer");
const { GraphError, API, UPLOAD } = require("./gmailClient");
const { buildMime, toRaw } = require("./mimeBuilder");
const parser = require("./gmailParser");

// ==========================================
// GOOGLE PROVIDER -- every mail operation for ONE connected Gmail / Google Workspace account, against the Gmail API (users/me).
// Mail stays at Google: nothing here stores a message. The unified shape it returns is the same as the Microsoft provider's, so
// the screens do not care which provider an account uses.
//
// What Gmail does differently (each handled below, and shown to the user through `capabilities`):
//   * folders are LABELS; "Archive" is a virtual folder (not in the inbox, trash, spam, sent or drafts); a message can carry several;
//   * the star is the flag; user labels are the categories;
//   * a draft has its OWN id (not the message id) and every save replaces the message, so a draft's attachments are rebuilt from
//     the MIME each time;
//   * with the minimum scope (gmail.modify) Gmail can move to Trash but cannot delete permanently (Trash empties itself after 30 days);
//   * search takes Gmail's own query syntax, so every filter is applied by Google and results can only be newest-first.
// ==========================================

const U = API;
const PAGE_DEFAULT = 25;
const PAGE_MAX = 50;
const METADATA_HEADERS = ["From", "To", "Subject", "Date", "Content-Type", "X-Priority", "Importance"];
const FIELDS = "id,threadId,labelIds,snippet,internalDate,payload/headers";

const capabilities = {
    provider: "google",
    folders: "labels",
    permanentDelete: false,
    sortOldest: false,
    contacts: false,
    categories: "labels",
    flag: "star",
    autoReplySeparateMessages: false,
    folderDeleteRemovesMessages: false,
    push: "gmail-watch",
};

const FOLDERS = [
    ["INBOX", "inbox", "Inbox"],
    ["STARRED", "starred", "Starred"],
    ["DRAFT", "drafts", "Drafts"],
    ["SENT", "sent", "Sent"],
    ["ARCHIVE", "archive", "Archive"],
    ["SPAM", "junk", "Spam"],
    ["TRASH", "trash", "Trash"],
];
const LABEL_OF = { inbox: "INBOX", starred: "STARRED", drafts: "DRAFT", sent: "SENT", junk: "SPAM", trash: "TRASH" };

const b64u = (text) => Buffer.from(text, "utf8").toString("base64url");
const fromB64u = (text) => Buffer.from(text, "base64url").toString("utf8");
const path = (...segments) => segments.map((s) => encodeURIComponent(s)).join("/");

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await fn(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

// ---------- labels (cached briefly per account: they change rarely and every list needs the names) ----------
const labelCache = new Map();
const LABEL_TTL_MS = 60000;

async function labels(c, { fresh = false } = {}) {
    const hit = labelCache.get(c.account.id);
    if (!fresh && hit && Date.now() - hit.at < LABEL_TTL_MS) return hit.list;
    const result = await c.api.get(`${U}/labels`);
    const list = (result && result.labels) || [];
    labelCache.set(c.account.id, { at: Date.now(), list });
    return list;
}
const forgetLabels = (c) => labelCache.delete(c.account.id);
const labelNameMap = (list) => new Map(list.filter((l) => l.type === "user").map((l) => [l.id, l.name]));

// A folder reference from the client: a well-known name, "archive", or a label id.
function folderRef(value) {
    const ref = String(value || "inbox");
    const lower = ref.toLowerCase();
    if (lower === "archive") return { virtual: "archive" };
    if (LABEL_OF[lower]) return { label: LABEL_OF[lower] };
    return { label: assertGraphId(ref, "folder") };
}

// ---------- folders ----------
async function listFolders(c) {
    const all = await labels(c, { fresh: true });
    const user = all.filter((l) => l.type === "user").sort((a, b) => a.name.localeCompare(b.name)).slice(0, 40);
    const wanted = [...FOLDERS.filter(([id]) => id !== "ARCHIVE").map(([id]) => id), ...user.map((l) => l.id)];
    const details = new Map();
    await mapLimit(wanted, 6, async (id) => {
        try {
            details.set(id, await c.api.get(`${U}/labels/${path(id)}`));
        } catch (error) {
            if (error.code !== "NOT_FOUND") throw error;
        }
    });
    const folder = (id, name, wellKnown) => {
        const d = details.get(id) || {};
        return { id, name, wellKnown, parentId: null, childCount: 0, unread: d.messagesUnread || 0, total: d.messagesTotal || 0 };
    };
    return {
        folders: [
            ...FOLDERS.map(([id, wellKnown, name]) => (id === "ARCHIVE" ? { id, name, wellKnown, parentId: null, childCount: 0, unread: 0, total: 0 } : folder(id, name, wellKnown))),
            ...user.map((l) => folder(l.id, l.name, null)),
        ],
    };
}

async function listChildFolders() {
    return { folders: [] }; // Gmail labels are flat
}

function cleanLabelName(name) {
    const value = String(name == null ? "" : name).trim();
    if (value.length < 1 || value.length > 100 || /[\u0000-\u001f]/.test(value)) throw new EmailValidationError("A label name must be 1-100 characters.", "INVALID_FOLDER_NAME");
    return value;
}

async function createFolder(c, { name }) {
    const label = await c.api.post(`${U}/labels`, { body: { name: cleanLabelName(name), labelListVisibility: "labelShow", messageListVisibility: "show" } });
    forgetLabels(c);
    return { id: label.id, name: label.name, wellKnown: null, parentId: null, childCount: 0, unread: 0, total: 0 };
}

async function assertUserLabel(c, id) {
    assertGraphId(id, "folder");
    const label = await c.api.get(`${U}/labels/${path(id)}`);
    if (label.type !== "user") throw new EmailValidationError("Built-in folders cannot be renamed or deleted.", "FOLDER_PROTECTED");
}

async function renameFolder(c, id, name) {
    await assertUserLabel(c, id);
    const label = await c.api.patch(`${U}/labels/${path(id)}`, { body: { name: cleanLabelName(name) } });
    forgetLabels(c);
    return { id: label.id, name: label.name, wellKnown: null, parentId: null, childCount: 0, unread: 0, total: 0 };
}

// Deleting a Gmail label removes the label only; the messages stay in Gmail (Outlook deletes the folder's messages).
async function deleteFolder(c, id) {
    await assertUserLabel(c, id);
    await c.api.delete(`${U}/labels/${path(id)}`);
    forgetLabels(c);
    return { deleted: true };
}

// ---------- listing and search ----------
const encodeCursor = (token) => (token ? b64u(JSON.stringify({ p: token })) : null);
function decodeCursor(cursor) {
    try {
        const parsed = JSON.parse(fromB64u(String(cursor)));
        if (typeof parsed.p !== "string" || !/^[A-Za-z0-9_\-=+/.]{1,2000}$/.test(parsed.p)) throw new Error("shape");
        return parsed.p;
    } catch (_error) {
        throw new EmailValidationError("Invalid page cursor.", "INVALID_CURSOR");
    }
}

// Search terms sit inside Gmail's query language; quotes, parentheses and backslashes are removed so a term can never close a group.
const term = (value) => String(value).replace(/["\\()]/g, " ").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
const group = (value) => {
    const clean = term(value);
    return /\s/.test(clean) ? `(${clean})` : clean;
};
function dateTerm(value, label) {
    const text = String(value || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new EmailValidationError("Dates must be YYYY-MM-DD.", "INVALID_DATE");
    return `${label}:${text.replace(/-/g, "/")}`;
}
const truthy = (value) => value === true || value === "1" || value === "true";

function buildQuery(params, ref) {
    const parts = [];
    if (ref.virtual === "archive") parts.push("-in:inbox -in:trash -in:spam -in:sent -in:drafts");
    if (params.q) parts.push(term(String(params.q).slice(0, 200)));
    if (params.from) parts.push(`from:${group(String(params.from).slice(0, 254))}`);
    if (params.to) parts.push(`to:${group(String(params.to).slice(0, 254))}`);
    if (params.subject) parts.push(`subject:${group(String(params.subject).slice(0, 200))}`);
    if (params.after) parts.push(dateTerm(params.after, "after"));
    if (params.before) parts.push(dateTerm(params.before, "before"));
    // Used by the unified inbox to page by time: Gmail accepts seconds since the epoch.
    if (params.beforeTime && /^\d{9,11}$/.test(String(params.beforeTime))) parts.push(`before:${params.beforeTime}`);
    if (truthy(params.unread)) parts.push("is:unread");
    if (truthy(params.flagged)) parts.push("is:starred");
    if (truthy(params.hasAttachments)) parts.push("has:attachment");
    if (params.category) parts.push(`label:${group(String(params.category).slice(0, 100)).replace(/\s+/g, "-")}`);
    return parts.join(" ");
}

async function fetchMetadata(c, id) {
    const headers = METADATA_HEADERS.map((h) => `metadataHeaders=${h}`).join("&");
    try {
        return await c.api.get(`${U}/messages/${path(id)}?format=metadata&${headers}&fields=${encodeURIComponent(FIELDS).replace(/%2C/g, ",")}`);
    } catch (error) {
        if (error.code === "NOT_FOUND") return null; // deleted between the list and the fetch
        throw error;
    }
}

async function listMessages(c, params = {}) {
    const top = clampInt(params.top, { min: 1, max: PAGE_MAX, fallback: PAGE_DEFAULT });
    const ref = folderRef(params.folderId);
    const query = { maxResults: top, q: buildQuery(params, ref) || undefined, pageToken: params.cursor ? decodeCursor(params.cursor) : undefined };
    if (ref.label) {
        query.labelIds = ref.label;
        if (ref.label === "TRASH" || ref.label === "SPAM") query.includeSpamTrash = "true";
    }
    const page = await c.api.get(`${U}/messages`, { query });
    const names = labelNameMap(await labels(c));
    const found = await mapLimit((page && page.messages) || [], 8, (m) => fetchMetadata(c, m.id));
    return {
        messages: found.filter(Boolean).map((m) => parser.listFields(m, names)),
        nextCursor: encodeCursor(page && page.nextPageToken),
        filteredLocally: false,
        sortIgnored: params.sort === "oldest",
    };
}

// ---------- reading ----------
async function fetchFull(c, id) {
    return c.api.get(`${U}/messages/${path(assertGraphId(id, "message"))}?format=full`);
}

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/i;
const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;

// Inline "cid:" pictures are replaced with data: URLs (only small png / jpeg / gif / webp); the sanitizer keeps nothing else.
async function inlineImages(c, messageId, html, attachments) {
    const wanted = attachments.filter((a) => a.contentId && IMAGE_TYPES.test(a.contentType) && a.size <= MAX_INLINE_IMAGE_BYTES && html.toLowerCase().includes(`cid:${a.contentId.toLowerCase()}`)).slice(0, 10);
    let out = html;
    for (const a of wanted) {
        try {
            const data = a.inlineData ? a.inlineData : (await c.api.get(`${U}/messages/${path(messageId)}/attachments/${path(a.gmailAttachmentId)}`)).data;
            const dataUrl = `data:${a.contentType.toLowerCase()};base64,${Buffer.from(data, "base64url").toString("base64")}`;
            out = out.replace(new RegExp(`cid:${a.contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi"), dataUrl);
        } catch (_error) {
            /* a missing inline picture is not worth failing the message */
        }
    }
    return out;
}

function renderBody(html, text) {
    const sanitized = html ? sanitizeEmailHtml(html) : { html: textToHtml(text), blockedRemoteImages: 0, truncated: false };
    return {
        html: sanitized.html,
        text: (html ? htmlToText(sanitized.html) : text).slice(0, 200000),
        blockedRemoteImages: sanitized.blockedRemoteImages,
        truncated: sanitized.truncated,
    };
}

function publicAttachment(a) {
    return { id: a.id, name: a.name, contentType: a.contentType, size: a.size, isInline: a.isInline, downloadable: a.downloadable };
}

async function getMessage(c, id) {
    const message = await fetchFull(c, id);
    const names = labelNameMap(await labels(c));
    const headers = parser.headerMap(message.payload);
    const attachments = parser.attachmentsOf(message.payload);
    const bodies = parser.bodiesOf(message.payload);
    const html = bodies.html ? await inlineImages(c, id, bodies.html, attachments) : "";
    return {
        ...parser.listFields(message, names),
        // The list reads headers only; here the real MIME tree is known.
        hasAttachments: attachments.some((a) => !a.isInline),
        cc: parser.parseAddressHeader(headers["cc"]),
        bcc: parser.parseAddressHeader(headers["bcc"]),
        replyTo: parser.parseAddressHeader(headers["reply-to"]),
        internetMessageId: headers["message-id"] || null,
        body: renderBody(html, bodies.text),
        attachments: attachments.map(publicAttachment),
    };
}

async function getConversation(c, threadId) {
    assertGraphId(threadId, "conversation");
    const thread = await c.api.get(`${U}/threads/${path(threadId)}?format=metadata&${METADATA_HEADERS.map((h) => `metadataHeaders=${h}`).join("&")}`);
    const names = labelNameMap(await labels(c));
    const messages = ((thread && thread.messages) || []).slice(0, 50).map((m) => parser.listFields(m, names));
    messages.sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
    return { messages };
}

async function downloadAttachment(c, messageId, attachmentId) {
    assertGraphId(attachmentId, "attachment");
    const message = await fetchFull(c, messageId);
    const part = parser.attachmentsOf(message.payload).find((a) => a.id === attachmentId);
    if (!part) throw new GraphError("NOT_FOUND", "That item no longer exists.", { status: 404 });
    let data = part.inlineData;
    if (!data) data = (await c.api.get(`${U}/messages/${path(messageId)}/attachments/${path(part.gmailAttachmentId)}`)).data;
    return { name: part.name, contentType: part.contentType, buffer: Buffer.from(data || "", "base64url") };
}

// ---------- message state ----------
const FLAG_STATUS = new Set(["flagged", "complete", "notFlagged"]);

async function modify(c, id, add = [], remove = []) {
    await c.api.post(`${U}/messages/${path(id)}/modify`, { body: { addLabelIds: add, removeLabelIds: remove } });
    return { id };
}

async function updateMessage(c, id, changes) {
    assertGraphId(id, "message");
    const add = [];
    const remove = [];
    if (changes.isRead !== undefined) (changes.isRead ? remove : add).push("UNREAD");
    if (changes.flag !== undefined) {
        if (!FLAG_STATUS.has(changes.flag)) throw new EmailValidationError("Invalid flag.", "INVALID_FLAG");
        (changes.flag === "flagged" ? add : remove).push("STARRED");
    }
    if (changes.categories !== undefined) {
        if (!Array.isArray(changes.categories) || changes.categories.length > 25) throw new EmailValidationError("Invalid categories.", "INVALID_CATEGORIES");
        const all = await labels(c);
        const byName = new Map(all.filter((l) => l.type === "user").map((l) => [l.name.toLowerCase(), l.id]));
        const wanted = new Set(changes.categories.map((n) => byName.get(String(n).trim().toLowerCase())).filter(Boolean));
        const current = await fetchMetadata(c, id);
        const userIds = new Set(all.filter((l) => l.type === "user").map((l) => l.id));
        for (const labelId of (current && current.labelIds) || []) if (userIds.has(labelId) && !wanted.has(labelId)) remove.push(labelId);
        for (const labelId of wanted) add.push(labelId);
    }
    if (add.length === 0 && remove.length === 0) throw new EmailValidationError("Nothing to change.", "NOTHING_TO_CHANGE");
    return modify(c, id, add, remove);
}

function unsupported(message) {
    return new GraphError("UNSUPPORTED", message, { status: 422 });
}

async function moveMessage(c, id, destination) {
    assertGraphId(id, "message");
    const ref = folderRef(destination);
    if (ref.virtual === "archive") return modify(c, id, [], ["INBOX"]);
    switch (ref.label) {
        case "INBOX": return modify(c, id, ["INBOX"], ["TRASH", "SPAM"]);
        case "TRASH": await c.api.post(`${U}/messages/${path(id)}/trash`); return { id };
        case "SPAM": return modify(c, id, ["SPAM"], ["INBOX"]);
        case "SENT": case "DRAFT": case "STARRED": throw unsupported("Messages cannot be moved into this folder in Gmail.");
        default: return modify(c, id, [ref.label], ["INBOX"]);
    }
}

async function deleteMessage(c, id, { permanent = false } = {}) {
    assertGraphId(id, "message");
    if (permanent) throw unsupported("Gmail empties the Trash by itself after 30 days; it cannot be deleted from here.");
    await c.api.post(`${U}/messages/${path(id)}/trash`);
    return { id, deleted: true, permanent: false };
}

const restoreMessage = (c, id) => modify(c, assertGraphId(id, "message"), ["INBOX"], ["TRASH", "SPAM"]);
const archiveMessage = (c, id) => modify(c, assertGraphId(id, "message"), [], ["INBOX"]);

async function bulkAction(c, ids, action, options = {}) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) throw new EmailValidationError("Select between 1 and 100 messages.", "INVALID_SELECTION");
    ids.forEach((id) => assertGraphId(id, "message"));
    if (action === "delete") {
        const results = await mapLimit(ids, 5, async (id) => {
            try {
                await c.api.post(`${U}/messages/${path(id)}/trash`);
                return { id, ok: true, status: 200 };
            } catch (error) {
                return { id, ok: false, status: error.status || 0 };
            }
        });
        return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
    }
    let add = [];
    let remove = [];
    switch (action) {
        case "read": remove = ["UNREAD"]; break;
        case "unread": add = ["UNREAD"]; break;
        case "flag": add = ["STARRED"]; break;
        case "unflag": remove = ["STARRED"]; break;
        case "archive": remove = ["INBOX"]; break;
        case "restore": add = ["INBOX"]; remove = ["TRASH", "SPAM"]; break;
        case "move": {
            const ref = folderRef(options.destination);
            if (ref.virtual === "archive") remove = ["INBOX"];
            else if (ref.label === "INBOX") { add = ["INBOX"]; remove = ["TRASH", "SPAM"]; }
            else if (ref.label === "SPAM") { add = ["SPAM"]; remove = ["INBOX"]; }
            else if (["TRASH", "SENT", "DRAFT", "STARRED"].includes(ref.label)) throw unsupported("Messages cannot be moved into this folder in Gmail.");
            else { add = [ref.label]; remove = ["INBOX"]; }
            break;
        }
        default: throw new EmailValidationError("Unknown bulk action.", "INVALID_ACTION");
    }
    // One call for up to 1000 messages (the selection is capped at 100): every message succeeds or the call fails.
    await c.api.post(`${U}/messages/batchModify`, { body: { ids, addLabelIds: add, removeLabelIds: remove } });
    const results = ids.map((id) => ({ id, ok: true, status: 200 }));
    return { results, succeeded: results.length, failed: 0 };
}

// ---------- drafts, compose, reply ----------
async function loadDraft(c, draftId) {
    return c.api.get(`${U}/drafts/${path(assertGraphId(draftId, "draft"))}?format=full`);
}

// Lists show the draft's MESSAGE id; every draft operation needs the DRAFT id. Find it by scanning the drafts list.
async function resolveDraftId(c, id) {
    assertGraphId(id, "draft");
    try {
        await c.api.get(`${U}/drafts/${path(id)}?format=minimal`);
        return id; // it already is a draft id
    } catch (error) {
        if (error.code !== "NOT_FOUND") throw error;
    }
    let pageToken;
    for (let page = 0; page < 5; page += 1) {
        const result = await c.api.get(`${U}/drafts`, { query: { maxResults: 100, pageToken } });
        const hit = ((result && result.drafts) || []).find((d) => d.message && d.message.id === id);
        if (hit) return hit.id;
        pageToken = result && result.nextPageToken;
        if (!pageToken) break;
    }
    throw new GraphError("NOT_FOUND", "That item no longer exists.", { status: 404 });
}

function draftView(draft, names) {
    const message = draft.message || {};
    const headers = parser.headerMap(message.payload);
    const attachments = parser.attachmentsOf(message.payload);
    const bodies = parser.bodiesOf(message.payload);
    return {
        id: draft.id,
        conversationId: message.threadId || null,
        subject: parser.decodeHeader(headers["subject"]),
        bodyHtml: sanitizeEmailHtml(bodies.html || textToHtml(bodies.text)).html,
        to: parser.parseAddressHeader(headers["to"]),
        cc: parser.parseAddressHeader(headers["cc"]),
        bcc: parser.parseAddressHeader(headers["bcc"]),
        importance: /^(1|high)/i.test(String(headers["x-priority"] || headers["importance"] || "")) ? "high" : /^(5|low)/i.test(String(headers["x-priority"] || headers["importance"] || "")) ? "low" : "normal",
        attachments: attachments.filter((a) => !a.isInline).map(publicAttachment),
        _headers: headers,
        _names: names,
    };
}
const stripPrivate = ({ _headers, _names, ...view }) => view;

async function getDraftForEdit(c, id) {
    const draftId = await resolveDraftId(c, id);
    return stripPrivate(draftView(await loadDraft(c, draftId)));
}

async function bytesOf(c, messageId, attachment) {
    const data = attachment.inlineData || (await c.api.get(`${U}/messages/${path(messageId)}/attachments/${path(attachment.gmailAttachmentId)}`)).data;
    return Buffer.from(data || "", "base64url");
}

// Writes (creates or replaces) a draft from a compose payload. Returns the draft id and its CURRENT attachment list.
async function writeDraft(c, { draftId, compose, files = [], keepAttachmentIds = [], threadId, inReplyTo, references, extraAttachments = [] }) {
    let existing = null;
    if (draftId) existing = await loadDraft(c, await resolveDraftId(c, draftId));
    const existingMessage = existing && existing.message;
    const existingHeaders = existingMessage ? parser.headerMap(existingMessage.payload) : {};

    // Attachments already on the draft are kept only if the client still lists them; their bytes are read back from Gmail.
    const retained = [];
    if (existingMessage) {
        const keep = new Set((keepAttachmentIds || []).map(String));
        for (const a of parser.attachmentsOf(existingMessage.payload)) {
            if (a.isInline || !keep.has(a.id)) continue;
            retained.push({ name: a.name, contentType: a.contentType, buffer: await bytesOf(c, existingMessage.id, a) });
        }
    }
    const attachments = [...retained, ...extraAttachments, ...files];
    if (attachments.length > MAX_ATTACHMENTS) throw new EmailValidationError("Too many attachments.", "ATTACHMENT_COUNT");
    if (attachments.reduce((sum, f) => sum + f.buffer.length, 0) > MAX_TOTAL_ATTACHMENT_BYTES) throw new EmailValidationError("Attachments together are larger than 25 MB.", "ATTACHMENT_TOO_LARGE");

    const html = sanitizeEmailHtml(compose.body).html;
    const mime = buildMime({
        from: { name: c.account.display_name || "", address: c.account.email_address },
        to: compose.to,
        cc: compose.cc,
        bcc: compose.bcc,
        subject: compose.subject,
        html,
        text: htmlToText(html),
        attachments,
        importance: compose.importance,
        inReplyTo: existingHeaders["in-reply-to"] || inReplyTo,
        references: existingHeaders["references"] || references,
    });
    const thread = (existingMessage && existingMessage.threadId) || threadId || undefined;
    const large = Buffer.byteLength(mime) > 4 * 1024 * 1024;
    let saved;
    if (large) {
        // Above ~5 MB the JSON "raw" form is too big: upload the message as message/rfc822.
        const target = draftId ? `${UPLOAD}/drafts/${path(existing.id)}?uploadType=media` : `${UPLOAD}/drafts?uploadType=media`;
        saved = await c.api.request(draftId ? "PUT" : "POST", target, { rawBody: mime, headers: { "Content-Type": "message/rfc822" } });
    } else {
        const body = { message: { raw: toRaw(mime), ...(thread ? { threadId: thread } : {}) } };
        saved = draftId ? await c.api.put(`${U}/drafts/${path(existing.id)}`, { body }) : await c.api.post(`${U}/drafts`, { body });
    }
    const view = stripPrivate(draftView(await loadDraft(c, saved.id)));
    return view;
}

async function saveDraft(c, payload, files) {
    const compose = validateCompose(payload, { requireRecipient: false });
    return writeDraft(c, { draftId: payload.draftId, compose, files, keepAttachmentIds: payload.keepAttachmentIds });
}

async function sendDraft(c, payload, files) {
    const compose = validateCompose(payload, { requireRecipient: true });
    const draft = await writeDraft(c, { draftId: payload.draftId, compose, files, keepAttachmentIds: payload.keepAttachmentIds });
    await c.api.post(`${U}/drafts/send`, { body: { id: draft.id } });
    return { sent: true };
}

async function discardDraft(c, id) {
    await c.api.delete(`${U}/drafts/${path(await resolveDraftId(c, id))}`);
    return { deleted: true };
}

const escapeHtml = (text) => String(text == null ? "" : text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const addressText = (p) => (p.name ? `${escapeHtml(p.name)} &lt;${escapeHtml(p.address)}&gt;` : escapeHtml(p.address));
const sameAddress = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function createReplyDraft(c, messageId, mode) {
    if (!["reply", "replyAll", "forward"].includes(mode)) throw new EmailValidationError("Unknown reply mode.", "INVALID_MODE");
    const original = await fetchFull(c, messageId);
    const headers = parser.headerMap(original.payload);
    const bodies = parser.bodiesOf(original.payload);
    const quotedHtml = sanitizeEmailHtml(bodies.html || textToHtml(bodies.text)).html;
    const self = c.account.email_address;
    const from = parser.parseAddressHeader(headers["from"])[0];
    const subject = parser.decodeHeader(headers["subject"]);
    const when = original.internalDate ? new Date(Number(original.internalDate)).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "";
    const messageIdHeader = headers["message-id"] || "";

    let to = [];
    let cc = [];
    let quote;
    let attachments = [];
    if (mode === "forward") {
        quote = `<div><p>---------- Forwarded message ---------<br>From: ${from ? addressText(from) : ""}<br>Date: ${escapeHtml(when)}<br>Subject: ${escapeHtml(subject)}<br>To: ${parser.parseAddressHeader(headers["to"]).map(addressText).join(", ")}</p>${quotedHtml}</div>`;
        let total = 0;
        for (const a of parser.attachmentsOf(original.payload).filter((x) => !x.isInline && x.downloadable)) {
            if (attachments.length >= MAX_ATTACHMENTS || total + a.size > MAX_ATTACHMENT_BYTES) break;
            const buffer = await bytesOf(c, original.id, a);
            total += buffer.length;
            attachments.push({ name: a.name, contentType: a.contentType, buffer });
        }
    } else {
        const replyTo = parser.parseAddressHeader(headers["reply-to"])[0] || from;
        to = replyTo ? [replyTo] : [];
        if (mode === "replyAll") {
            const seen = new Set([self.toLowerCase(), ...to.map((p) => p.address.toLowerCase())]);
            for (const p of [...parser.parseAddressHeader(headers["to"]), ...parser.parseAddressHeader(headers["cc"])]) {
                if (seen.has(p.address.toLowerCase())) continue;
                seen.add(p.address.toLowerCase());
                cc.push(p);
            }
        }
        to = to.filter((p) => !sameAddress(p.address, self) || to.length === 1);
        quote = `<div><p>On ${escapeHtml(when)}, ${from ? addressText(from) : "the sender"} wrote:</p><blockquote>${quotedHtml}</blockquote></div>`;
    }
    const prefix = mode === "forward" ? "Fwd: " : "Re: ";
    const newSubject = /^\s*(re|fwd?)\s*:/i.test(subject) ? subject : prefix + subject;
    const compose = validateCompose({ to, cc, bcc: [], subject: newSubject.slice(0, 255), body: `<p><br></p>${quote}` }, { requireRecipient: false });
    const references = [headers["references"], messageIdHeader].filter(Boolean).join(" ");
    return writeDraft(c, { compose, threadId: mode === "forward" ? undefined : original.threadId, inReplyTo: mode === "forward" ? undefined : messageIdHeader, references: mode === "forward" ? undefined : references, extraAttachments: attachments });
}

// ---------- labels as categories, contacts, settings ----------
async function listCategories(c) {
    const all = await labels(c, { fresh: true });
    return { categories: all.filter((l) => l.type === "user").map((l) => ({ id: l.id, name: l.name, color: l.color ? l.color.backgroundColor : null })) };
}

// Gmail contact suggestions need a contacts scope, which is deliberately NOT requested (minimum permissions). Typing an address always works.
async function suggestContacts() {
    return { contacts: [] };
}

const iso = (ms) => (ms ? new Date(Number(ms)).toISOString().slice(0, 19) : null);

async function getSettings(c) {
    const v = await c.api.get(`${U}/settings/vacation`);
    let status = "disabled";
    if (v.enableAutoReply) status = v.startTime || v.endTime ? "scheduled" : "alwaysEnabled";
    const message = v.responseBodyHtml || v.responseBodyPlainText || "";
    return {
        timeZone: null,
        automaticReplies: {
            status,
            externalAudience: v.restrictToContacts ? "contactsOnly" : v.restrictToDomain ? "none" : "all",
            internalReplyMessage: message,
            externalReplyMessage: message,
            scheduledStartDateTime: iso(v.startTime),
            scheduledEndDateTime: iso(v.endTime),
            subject: v.responseSubject || "",
        },
    };
}

async function updateAutoReply(c, input) {
    const status = ["disabled", "alwaysEnabled", "scheduled"].includes(input.status) ? input.status : null;
    if (!status) throw new EmailValidationError("Invalid automatic replies status.", "INVALID_SETTING");
    const audience = ["none", "contactsOnly", "all"].includes(input.externalAudience) ? input.externalAudience : "all";
    const message = sanitizeEmailHtml(String(input.externalReplyMessage || input.internalReplyMessage || "").slice(0, 20000)).html;
    const body = {
        enableAutoReply: status !== "disabled",
        responseSubject: String(input.subject || "Automatic reply").replace(/[\r\n]+/g, " ").slice(0, 200),
        responseBodyHtml: message || "<p>I am away.</p>",
        restrictToContacts: audience === "contactsOnly",
        restrictToDomain: audience === "none",
    };
    if (status === "scheduled") {
        const offset = Number(input.utcOffsetMinutes) || 0; // minutes, as Date.getTimezoneOffset() reports them
        const epoch = (value) => {
            const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ""));
            if (!m) throw new EmailValidationError("Scheduled replies need a start and an end time.", "INVALID_SETTING");
            return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + offset * 60000;
        };
        body.startTime = String(epoch(input.scheduledStartDateTime));
        body.endTime = String(epoch(input.scheduledEndDateTime));
    }
    await c.api.put(`${U}/settings/vacation`, { body });
    return getSettings(c);
}

// ---------- identity, sync, push ----------
async function getProfile(c) {
    const p = await c.api.get(`${U}/profile`);
    return { id: p.emailAddress, displayName: "", mail: p.emailAddress, userPrincipalName: p.emailAddress, historyId: p.historyId };
}

async function getUnread(c) {
    const inbox = await c.api.get(`${U}/labels/INBOX`);
    return inbox.messagesUnread || 0;
}

// A cursor is the Gmail historyId. The FIRST call returns no events (old mail must not notify) and just records "now".
async function initCursor(c) {
    const p = await c.api.get(`${U}/profile`);
    return String(p.historyId);
}

async function pollNewMail(c, cursor) {
    if (!cursor) return { events: [], cursor: await initCursor(c), unread: await getUnread(c), reset: true };
    const added = new Map();
    let pageToken;
    let latest = cursor;
    try {
        for (let page = 0; page < 5; page += 1) {
            const result = await c.api.get(`${U}/history`, { query: { startHistoryId: cursor, historyTypes: "messageAdded", labelId: "INBOX", maxResults: 100, pageToken } });
            if (result.historyId) latest = String(result.historyId);
            for (const h of result.history || []) {
                for (const added1 of h.messagesAdded || []) {
                    const m = added1.message || {};
                    if ((m.labelIds || []).includes("INBOX") && (m.labelIds || []).includes("UNREAD") && !added.has(m.id)) added.set(m.id, m);
                }
            }
            pageToken = result.nextPageToken;
            if (!pageToken) break;
        }
    } catch (error) {
        // History is only kept for about a week: an old cursor is rejected with 404. Start over from "now" instead of failing forever.
        if (error.code === "NOT_FOUND") return { events: [], cursor: await initCursor(c), unread: await getUnread(c), reset: true };
        throw error;
    }
    const events = [];
    for (const m of [...added.values()].slice(0, 20)) {
        const meta = await fetchMetadata(c, m.id);
        if (!meta) continue;
        const f = parser.listFields(meta);
        events.push({ id: m.id, from: f.from, subject: f.subject, receivedAt: f.receivedAt });
    }
    return { events, cursor: latest, unread: await getUnread(c), reset: false };
}

// Gmail "watch": Google publishes a message to our Pub/Sub topic when the INBOX changes. A watch lasts at most 7 days: call again to renew.
async function ensurePush(c, { topic }) {
    const result = await c.api.post(`${U}/watch`, { body: { topicName: topic, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" } });
    return { subscriptionId: null, resource: "gmail-watch", expiresAt: result.expiration ? new Date(Number(result.expiration)) : null, historyId: result.historyId ? String(result.historyId) : null };
}

async function stopPush(c) {
    await c.api.post(`${U}/stop`, {});
}

module.exports = {
    capabilities,
    listFolders,
    listChildFolders,
    createFolder,
    renameFolder,
    deleteFolder,
    listMessages,
    getMessage,
    getConversation,
    downloadAttachment,
    updateMessage,
    moveMessage,
    deleteMessage,
    restoreMessage,
    archiveMessage,
    bulkAction,
    saveDraft,
    sendDraft,
    discardDraft,
    getDraftForEdit,
    createReplyDraft,
    listCategories,
    suggestContacts,
    getSettings,
    updateAutoReply,
    getProfile,
    getUnread,
    initCursor,
    pollNewMail,
    ensurePush,
    stopPush,
    _forgetLabels: forgetLabels,
};
