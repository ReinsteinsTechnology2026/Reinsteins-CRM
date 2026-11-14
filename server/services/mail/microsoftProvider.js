const gm = require("../graphMailService");
const { validateCompose, EmailValidationError } = require("../../utils/emailValidation");

// ==========================================
// MICROSOFT PROVIDER -- the unified-provider face of services/graphMailService.js (Microsoft Graph), for personal Outlook.com /
// Hotmail accounts AND Microsoft 365 work or school accounts. The Graph operations are unchanged; this layer only
//   * speaks the unified folder names (inbox, sent, drafts, trash, junk, archive) the screens use for every provider;
//   * turns "compose" into one call that saves a draft, syncs its attachments, and optionally sends it;
//   * adds change tracking for new-mail notifications (polling + Graph change notifications).
// Personal accounts do not support every Graph feature (for example /me/people); those calls degrade to "nothing available".
// ==========================================

const GRAPH_FOLDER = { inbox: "inbox", sent: "sentitems", drafts: "drafts", trash: "deleteditems", junk: "junkemail", archive: "archive" };
const UNIFIED_FOLDER = { inbox: "inbox", sentitems: "sent", drafts: "drafts", deleteditems: "trash", junkemail: "junk", archive: "archive" };

const toGraphFolder = (ref) => GRAPH_FOLDER[String(ref || "inbox").toLowerCase()] || ref;

const capabilities = {
    provider: "microsoft",
    folders: "folders",
    permanentDelete: true,
    sortOldest: true,
    contacts: true,
    categories: "categories",
    flag: "flag",
    autoReplySeparateMessages: true,
    folderDeleteRemovesMessages: true,
    push: "graph-subscription",
};

async function listFolders(c) {
    const { folders } = await gm.listFolders(c.api);
    return { folders: folders.map((f) => (f.wellKnown ? { ...f, wellKnown: UNIFIED_FOLDER[f.wellKnown] || f.wellKnown } : f)) };
}

const listChildFolders = (c, id) => gm.listChildFolders(c.api, id);
const createFolder = (c, input) => gm.createFolder(c.api, input);
const renameFolder = (c, id, name) => gm.renameFolder(c.api, id, name);
const deleteFolder = (c, id) => gm.deleteFolder(c.api, id);

const listMessages = (c, params = {}) => gm.listMessages(c.api, { ...params, folderId: toGraphFolder(params.folderId) });
const getMessage = (c, id) => gm.getMessage(c.api, id);
const getConversation = (c, id) => gm.getConversation(c.api, id);
const downloadAttachment = (c, messageId, attachmentId) => gm.downloadAttachment(c.api, messageId, attachmentId);
const updateMessage = (c, id, changes) => gm.updateMessage(c.api, id, changes);
const moveMessage = (c, id, destination) => gm.moveMessage(c.api, id, toGraphFolder(destination));
const deleteMessage = (c, id, options) => gm.deleteMessage(c.api, id, options);
const restoreMessage = (c, id) => gm.restoreMessage(c.api, id);
const archiveMessage = (c, id) => gm.archiveMessage(c.api, id);
const bulkAction = (c, ids, action, options = {}) => gm.bulkAction(c.api, ids, action, { ...options, destination: options.destination ? toGraphFolder(options.destination) : undefined });

// ---------- compose ----------
// Saves the draft (creating it on first save), removes attachments the client no longer lists, uploads the new files, and
// returns the draft as the composer needs it (id + current attachments).
async function saveDraft(c, payload, files = []) {
    let draftId = payload.draftId;
    if (draftId) {
        await gm.updateDraft(c.api, draftId, payload);
    } else {
        draftId = (await gm.createDraft(c.api, payload)).id;
    }
    const keep = new Set((payload.keepAttachmentIds || []).map(String));
    for (const a of (await gm.listAttachments(c.api, draftId)).attachments) {
        if (!keep.has(a.id)) await gm.deleteAttachment(c.api, draftId, a.id);
    }
    for (const file of files) await gm.addAttachment(c.api, draftId, file);
    return gm.getDraftForEdit(c.api, draftId);
}

async function sendDraft(c, payload, files = []) {
    validateCompose(payload, { requireRecipient: true });
    const saved = await saveDraft(c, payload, files);
    await gm.sendDraft(c.api, saved.id);
    return { sent: true };
}

const discardDraft = (c, id) => gm.discardDraft(c.api, id);
const getDraftForEdit = (c, id) => gm.getDraftForEdit(c.api, id);
const createReplyDraft = (c, id, mode) => gm.createReplyDraft(c.api, id, mode);

// ---------- categories, contacts, settings ----------
const listCategories = async (c) => {
    try {
        return await gm.listCategories(c.api);
    } catch (error) {
        if (["ACCESS_DENIED", "NOT_FOUND", "BAD_REQUEST", "MAILBOX_NOT_AVAILABLE"].includes(error.code)) return { categories: [] };
        throw error;
    }
};

// /me/people is not available for personal Microsoft accounts: suggestions are simply empty there.
const suggestContacts = async (c, query) => {
    try {
        return await gm.suggestContacts(c.api, query);
    } catch (error) {
        if (["ACCESS_DENIED", "NOT_FOUND", "BAD_REQUEST", "MAILBOX_NOT_AVAILABLE"].includes(error.code)) return { contacts: [] };
        throw error;
    }
};

const getSettings = async (c) => {
    try {
        return await gm.getMailboxSettings(c.api);
    } catch (error) {
        if (["ACCESS_DENIED", "NOT_FOUND", "BAD_REQUEST", "MAILBOX_NOT_AVAILABLE"].includes(error.code)) {
            return { timeZone: null, unavailable: true, automaticReplies: { status: "disabled", externalAudience: "none", internalReplyMessage: "", externalReplyMessage: "" } };
        }
        throw error;
    }
};
const updateAutoReply = (c, input) => gm.updateAutomaticReplies(c.api, input);
const getProfile = (c) => gm.getProfile(c.api);

// ---------- sync + push ----------
async function getUnread(c) {
    const inbox = await c.api.get("/me/mailFolders/inbox", { query: { $select: "unreadItemCount" } });
    return (inbox && inbox.unreadItemCount) || 0;
}

const initCursor = async () => new Date().toISOString();

// A cursor is the receivedDateTime of the newest message seen. `ge` (not `gt`) means a message that arrives in the same second as
// the last one is still found; the new-mail event table's uniqueness drops the repeat.
async function pollNewMail(c, cursor) {
    if (!cursor || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(cursor)) return { events: [], cursor: await initCursor(c), unread: await getUnread(c), reset: true };
    const page = await c.api.get("/me/mailFolders/inbox/messages", {
        query: { $filter: `receivedDateTime ge ${cursor}`, $orderby: "receivedDateTime asc", $top: 25, $select: "id,subject,from,receivedDateTime,isRead" },
    });
    const items = (page && page.value) || [];
    const events = items.filter((m) => !m.isRead).map((m) => {
        const a = m.from && m.from.emailAddress;
        return { id: m.id, from: a ? { name: a.name || "", address: a.address || "" } : null, subject: m.subject || "", receivedAt: m.receivedDateTime };
    });
    const last = items.length ? items[items.length - 1].receivedDateTime : cursor;
    return { events, cursor: last && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(last) ? last : cursor, unread: await getUnread(c), reset: false };
}

// Graph change notifications: mail subscriptions live at most 4230 minutes (about 3 days) and must be renewed before then.
const MAX_SUBSCRIPTION_MINUTES = 4200;
const expiry = () => new Date(Date.now() + MAX_SUBSCRIPTION_MINUTES * 60000).toISOString();

async function ensurePush(c, { notificationUrl, clientState }) {
    const sub = await c.api.post("/subscriptions", {
        body: {
            changeType: "created",
            notificationUrl,
            lifecycleNotificationUrl: notificationUrl,
            resource: "me/mailFolders('inbox')/messages",
            expirationDateTime: expiry(),
            clientState,
        },
    });
    return { subscriptionId: sub.id, resource: sub.resource || "inbox", expiresAt: new Date(sub.expirationDateTime) };
}

async function renewPush(c, { subscriptionId }) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(String(subscriptionId))) throw new EmailValidationError("Invalid subscription.", "INVALID_ID");
    const sub = await c.api.patch(`/subscriptions/${encodeURIComponent(subscriptionId)}`, { body: { expirationDateTime: expiry() } });
    return { subscriptionId, expiresAt: new Date(sub.expirationDateTime) };
}

async function stopPush(c, { subscriptionId }) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(String(subscriptionId))) return;
    await c.api.delete(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
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
    renewPush,
    stopPush,
};
