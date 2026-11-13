import api from "../../../services/api";

// ==========================================
// COMPANY EMAIL API (Microsoft 365)
//
// Thin wrappers over /api/email/ms/* and /api/email/mail/*. There is deliberately NO user, mailbox or company id in any
// call: the server takes the signed-in employee from the session token, and the mailbox is always their own.
//
// Microsoft sign-in problems are reported by the server as HTTP 409 (never 401), so a lapsed Microsoft connection does not
// sign the employee out of the CRM; see errorInfo() for the codes the screens react to.
// ==========================================

const data = (promise) => promise.then((response) => response.data);
const enc = encodeURIComponent;

export const connection = {
  status: () => data(api.get("/email/ms/me")),
  begin: (portal) => data(api.post("/email/ms/me/connect", { portal })),
  disconnect: () => data(api.post("/email/ms/me/disconnect", {})),
};

export const mail = {
  folders: () => data(api.get("/email/mail/folders")),
  childFolders: (id) => data(api.get(`/email/mail/folders/${enc(id)}/children`)),
  createFolder: (name, parentId) => data(api.post("/email/mail/folders", { name, parentId })),
  renameFolder: (id, name) => data(api.patch(`/email/mail/folders/${enc(id)}`, { name })),
  deleteFolder: (id) => data(api.delete(`/email/mail/folders/${enc(id)}`)),

  messages: (params) => data(api.get("/email/mail/messages", { params })),
  message: (id) => data(api.get(`/email/mail/messages/${enc(id)}`)),
  conversation: (id) => data(api.get(`/email/mail/conversations/${enc(id)}`)),
  update: (id, changes) => data(api.patch(`/email/mail/messages/${enc(id)}`, changes)),
  move: (id, destination) => data(api.post(`/email/mail/messages/${enc(id)}/move`, { destination })),
  remove: (id, permanent = false) => data(api.post(`/email/mail/messages/${enc(id)}/delete${permanent ? "?permanent=1" : ""}`, {})),
  restore: (id) => data(api.post(`/email/mail/messages/${enc(id)}/restore`, {})),
  archive: (id) => data(api.post(`/email/mail/messages/${enc(id)}/archive`, {})),
  bulk: (ids, action, destination) => data(api.post("/email/mail/messages/bulk", { ids, action, destination })),

  createDraft: (payload) => data(api.post("/email/mail/drafts", payload)),
  getDraft: (id) => data(api.get(`/email/mail/drafts/${enc(id)}`)),
  updateDraft: (id, payload) => data(api.put(`/email/mail/drafts/${enc(id)}`, payload)),
  discardDraft: (id) => data(api.delete(`/email/mail/drafts/${enc(id)}`)),
  sendDraft: (id) => data(api.post(`/email/mail/drafts/${enc(id)}/send`, {})),
  replyDraft: (id, mode) => data(api.post(`/email/mail/messages/${enc(id)}/reply-draft`, { mode })),

  addAttachment: (messageId, file, onProgress) => {
    const form = new FormData();
    form.append("file", file);
    return data(api.post(`/email/mail/messages/${enc(messageId)}/attachments`, form, {
      headers: { "Content-Type": "multipart/form-data" },
      onUploadProgress: (event) => onProgress && event.total && onProgress(Math.round((event.loaded / event.total) * 100)),
    }));
  },
  removeAttachment: (messageId, attachmentId) => data(api.delete(`/email/mail/messages/${enc(messageId)}/attachments/${enc(attachmentId)}`)),
  // The download is authenticated (a bearer token), so it is fetched as a blob and saved from memory.
  attachmentBlob: (messageId, attachmentId, inline = false) =>
    api.get(`/email/mail/messages/${enc(messageId)}/attachments/${enc(attachmentId)}/download`, {
      params: inline ? { inline: "1" } : undefined,
      responseType: "blob",
    }),

  categories: () => data(api.get("/email/mail/categories")),
  contacts: (q) => data(api.get("/email/mail/contacts", { params: { q } })),
  settings: () => data(api.get("/email/mail/settings")),
  saveSettings: (payload) => data(api.put("/email/mail/settings", payload)),
};

// What a failed call means for the screen. `message` comes from the server and is already safe to show.
export function errorInfo(error) {
  const body = error?.response?.data || {};
  const code = body.code || (error?.response ? "ERROR" : "NETWORK");
  return {
    code,
    status: error?.response?.status || 0,
    message: body.message || (error?.response ? "Something went wrong. Please try again." : "Could not reach the server. Check your connection."),
    needsReconnect: code === "REAUTH_REQUIRED" || code === "NOT_CONNECTED",
    notReady: ["COMPANY_NOT_READY", "NO_MAILBOX", "MAILBOX_DISABLED", "MS_NOT_CONFIGURED", "FEATURE_NOT_ENABLED"].includes(code),
  };
}
