const express = require("express");
const c = require("../controllers/msEmailController");
const { tenantProtect } = require("../middleware/tenantAuthMiddleware");
const { requireAccess } = require("../middleware/accessMiddleware");
const { tenantEmailLimiter, msEmailConnectLimiter, msEmailSendLimiter } = require("../middleware/rateLimiters");

// ==========================================
// MICROSOFT 365 EMAIL ROUTES -- mounted at /api/email (next to the existing domain / mailbox routes).
// The whole /api/email prefix is already behind the "email" company feature gate (config/tenantFeatures.js), so a
// company without the Company Email module gets FEATURE_NOT_ENABLED here exactly like the existing routes.
//
//   /ms/callback        public by necessity: Microsoft redirects the browser here without a CRM token. It acts only on a
//                       single-use, 10-minute state row created by the signed-in employee.
//   /ms/company*, /ms/mailboxes*, /ms/audit   admin only (requireAccess() with no tiers = role "admin").
//   /ms/me*             the signed-in employee's own connection.
//   /mail/*             the signed-in employee's OWN mailbox. No id of a user or mailbox is accepted anywhere.
// ==========================================

const router = express.Router();

// ---- public redirect target ----
router.get("/ms/callback", msEmailConnectLimiter, c.handleCallback);

// ---- admin ----
router.get("/ms/company", tenantProtect, requireAccess(), c.getCompanyStatus);
router.post("/ms/company/connect", tenantProtect, requireAccess(), tenantEmailLimiter, c.connectCompany);
router.post("/ms/company/check", tenantProtect, requireAccess(), tenantEmailLimiter, c.checkCompany);
router.post("/ms/company/disconnect", tenantProtect, requireAccess(), tenantEmailLimiter, c.disconnectCompany);
router.get("/ms/mailboxes", tenantProtect, requireAccess(), c.listMailboxes);
router.post("/ms/mailboxes/:id/link", tenantProtect, requireAccess(), tenantEmailLimiter, c.linkMailbox);
router.post("/ms/mailboxes/:id/unlink", tenantProtect, requireAccess(), tenantEmailLimiter, c.unlinkMailbox);
router.post("/ms/mailboxes/:id/enabled", tenantProtect, requireAccess(), tenantEmailLimiter, c.setMailboxEnabled);
router.get("/ms/audit", tenantProtect, requireAccess(), c.listAudit);

// ---- employee connection ----
router.get("/ms/me", tenantProtect, c.getMyStatus);
router.post("/ms/me/connect", tenantProtect, msEmailConnectLimiter, c.beginConnect);
router.post("/ms/me/disconnect", tenantProtect, msEmailConnectLimiter, c.disconnectMine);

// ---- mail: folders ----
router.get("/mail/folders", tenantProtect, c.getFolders);
router.get("/mail/folders/:id/children", tenantProtect, c.getChildFolders);
router.post("/mail/folders", tenantProtect, c.createFolder);
router.patch("/mail/folders/:id", tenantProtect, c.renameFolder);
router.delete("/mail/folders/:id", tenantProtect, c.deleteFolder);

// ---- mail: messages ----
router.get("/mail/messages", tenantProtect, c.listMessages);
router.post("/mail/messages/bulk", tenantProtect, c.bulk);
router.get("/mail/messages/:id", tenantProtect, c.getMessage);
router.patch("/mail/messages/:id", tenantProtect, c.updateMessage);
router.post("/mail/messages/:id/move", tenantProtect, c.moveMessage);
router.post("/mail/messages/:id/delete", tenantProtect, c.deleteMessage);
router.post("/mail/messages/:id/restore", tenantProtect, c.restoreMessage);
router.post("/mail/messages/:id/archive", tenantProtect, c.archiveMessage);
router.get("/mail/conversations/:id", tenantProtect, c.getConversation);

// ---- mail: drafts and sending ----
router.post("/mail/drafts", tenantProtect, c.createDraft);
router.get("/mail/drafts/:id", tenantProtect, c.getDraft);
router.put("/mail/drafts/:id", tenantProtect, c.updateDraft);
router.delete("/mail/drafts/:id", tenantProtect, c.discardDraft);
router.post("/mail/drafts/:id/send", tenantProtect, msEmailSendLimiter, c.sendDraft);
router.post("/mail/messages/:id/reply-draft", tenantProtect, c.replyDraft);
router.post("/mail/send", tenantProtect, msEmailSendLimiter, c.sendNew);

// ---- mail: attachments (on a draft or a received message) ----
router.get("/mail/messages/:id/attachments", tenantProtect, c.listAttachments);
router.post("/mail/messages/:id/attachments", tenantProtect, c.uploadSingle, c.addAttachment);
router.delete("/mail/messages/:id/attachments/:attachmentId", tenantProtect, c.deleteAttachment);
router.get("/mail/messages/:id/attachments/:attachmentId/download", tenantProtect, c.downloadAttachment);

// ---- mail: categories, contacts, settings ----
router.get("/mail/categories", tenantProtect, c.getCategories);
router.get("/mail/contacts", tenantProtect, c.suggestContacts);
router.get("/mail/settings", tenantProtect, c.getSettings);
router.put("/mail/settings", tenantProtect, c.saveSettings);
router.post("/mail/preview", tenantProtect, c.previewHtml);

module.exports = router;
