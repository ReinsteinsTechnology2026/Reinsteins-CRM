import api from "../../../services/api";

// ==========================================
// EMAIL API (unified client: Gmail, Google Workspace, Outlook.com / Hotmail, Microsoft 365)
//
// Thin wrappers over /api/email/accounts/* . There is deliberately NO user or company id in any call: the server takes the signed-in
// employee from the session token, and an account id only selects one of THAT employee's own accounts.
//
// Provider sign-in problems come back as HTTP 409 (never 401), so a lapsed Google / Microsoft connection does not sign the employee
// out of the CRM; see errorInfo() for the codes the screens react to.
// ==========================================

const data = (promise) => promise.then((response) => response.data);
const enc = encodeURIComponent;

export const accounts = {
  list: () => data(api.get("/email/accounts")),
  summary: (refresh = false) => data(api.get("/email/accounts/summary", { params: refresh ? { refresh: "1" } : undefined })),
  connect: (provider, portal, accountId) => data(api.post("/email/accounts/connect", { provider, portal, accountId })),
  update: (id, changes) => data(api.patch(`/email/accounts/${enc(id)}`, changes)),
  disconnect: (id) => data(api.delete(`/email/accounts/${enc(id)}`)),
};

export const unified = {
  messages: (params) => data(api.get("/email/unified/messages", { params })),
};

// CRM-level preferences (signature, favourite folders): shared by all of the employee's accounts.
export const prefs = {
  get: () => data(api.get("/email/mailbox/settings")),
  save: (payload) => data(api.put("/email/mailbox/settings", payload)),
};

// One account's mail. `mailFor(accountId)` returns an object with every operation already bound to that account.
export function mailFor(accountId) {
  const base = `/email/accounts/${enc(accountId)}/mail`;
  return {
    accountId,
    folders: () => data(api.get(`${base}/folders`)),
    createFolder: (name) => data(api.post(`${base}/folders`, { name })),
    renameFolder: (id, name) => data(api.patch(`${base}/folders/${enc(id)}`, { name })),
    deleteFolder: (id) => data(api.delete(`${base}/folders/${enc(id)}`)),

    messages: (params) => data(api.get(`${base}/messages`, { params })),
    message: (id) => data(api.get(`${base}/messages/${enc(id)}`)),
    conversation: (id) => data(api.get(`${base}/conversations/${enc(id)}`)),
    update: (id, changes) => data(api.patch(`${base}/messages/${enc(id)}`, changes)),
    move: (id, destination) => data(api.post(`${base}/messages/${enc(id)}/move`, { destination })),
    remove: (id, permanent = false) => data(api.post(`${base}/messages/${enc(id)}/delete${permanent ? "?permanent=1" : ""}`, {})),
    restore: (id) => data(api.post(`${base}/messages/${enc(id)}/restore`, {})),
    archive: (id) => data(api.post(`${base}/messages/${enc(id)}/archive`, {})),
    bulk: (ids, action, destination) => data(api.post(`${base}/messages/bulk`, { ids, action, destination })),

    // Compose: ONE request carries the message and any new files (multipart). The server returns the saved draft with its attachments.
    saveDraft: (payload, files, onProgress) => data(api.post(`${base}/drafts`, form(payload, files), uploadOptions(onProgress))),
    send: (payload, files, onProgress) => data(api.post(`${base}/send`, form(payload, files), uploadOptions(onProgress))),
    getDraft: (id) => data(api.get(`${base}/drafts/${enc(id)}`)),
    discardDraft: (id) => data(api.delete(`${base}/drafts/${enc(id)}`)),
    replyDraft: (id, mode) => data(api.post(`${base}/messages/${enc(id)}/reply-draft`, { mode })),

    // The download is authenticated (a bearer token), so it is fetched as a blob and saved from memory.
    attachmentBlob: (messageId, attachmentId, inline = false) =>
      api.get(`${base}/messages/${enc(messageId)}/attachments/${enc(attachmentId)}/download`, { params: inline ? { inline: "1" } : undefined, responseType: "blob" }),

    categories: () => data(api.get(`${base}/categories`)),
    contacts: (q) => data(api.get(`${base}/contacts`, { params: { q } })),
    autoReply: () => data(api.get(`${base}/auto-reply`)),
    saveAutoReply: (payload) => data(api.put(`${base}/auto-reply`, payload)),
  };
}

function form(payload, files) {
  const body = new FormData();
  body.append("payload", JSON.stringify(payload));
  for (const file of files || []) body.append("files", file);
  return body;
}

function uploadOptions(onProgress) {
  return {
    headers: { "Content-Type": "multipart/form-data" },
    onUploadProgress: (event) => onProgress && event.total && onProgress(Math.round((event.loaded / event.total) * 100)),
  };
}

// What a failed call means for the screen. `message` comes from the server and is already safe to show.
export function errorInfo(error) {
  const body = error?.response?.data || {};
  const code = body.code || (error?.response ? "ERROR" : "NETWORK");
  return {
    code,
    status: error?.response?.status || 0,
    message: body.message || (error?.response ? "Something went wrong. Please try again." : "Could not reach the server. Check your connection."),
    needsReconnect: code === "REAUTH_REQUIRED",
    unsupported: code === "UNSUPPORTED",
    notAvailable: ["ACCOUNT_NOT_FOUND", "PROVIDER_NOT_CONFIGURED", "FEATURE_NOT_ENABLED"].includes(code),
    throttled: code === "THROTTLED" || code === "READ_LIMIT",
  };
}

export const PROVIDER_NAME = { google: "Google", microsoft: "Microsoft" };
