const express = require("express");
const c = require("../controllers/emailAccountController");
const { tenantProtect } = require("../middleware/tenantAuthMiddleware");
const { requireAccess } = require("../middleware/accessMiddleware");
const { tenantEmailLimiter, msEmailConnectLimiter, msEmailSendLimiter, emailReadLimiter, emailPushLimiter } = require("../middleware/rateLimiters");

// ==========================================
// EMAIL ACCOUNT ROUTES -- mounted at /api/email (next to the earlier company-mailbox routes, which are untouched).
// The whole /api/email prefix is behind the existing "email" company feature gate (config/tenantFeatures.js).
//
//   /accounts/callback/<provider>, /push/*   public by necessity (the provider calls them without a CRM token); each authenticates
//                                            itself (single-use state row / Google-signed JWT / Graph clientState).
//   /accounts/admin/*                        admin only, CONNECTION STATUS only: no route returns mail.
//   everything else                          the signed-in employee's OWN accounts. The account id in the path is a lookup key
//                                            inside that employee's accounts; there is no user or company id anywhere.
// ==========================================

const router = express.Router();

// ---- public: provider redirects and push ----
router.get("/accounts/callback/google", msEmailConnectLimiter, c.callbackGoogle);
router.get("/accounts/callback/microsoft", msEmailConnectLimiter, c.callbackMicrosoft);
router.post("/push/google", emailPushLimiter, c.googlePush);
router.post("/push/microsoft", emailPushLimiter, c.microsoftPush);

// ---- admin: status only (declared before "/accounts/:accountId") ----
router.get("/accounts/admin/overview", tenantProtect, requireAccess(), c.adminOverview);
router.get("/accounts/admin/audit", tenantProtect, requireAccess(), c.adminAudit);
router.delete("/accounts/admin/:accountId", tenantProtect, requireAccess(), tenantEmailLimiter, c.adminDisconnect);

// ---- the employee's accounts ----
router.get("/accounts", tenantProtect, emailReadLimiter, c.listAccounts);
router.get("/accounts/summary", tenantProtect, emailReadLimiter, c.getSummary);
router.post("/accounts/connect", tenantProtect, msEmailConnectLimiter, c.beginConnect);
router.patch("/accounts/:accountId", tenantProtect, c.updateAccount);
router.delete("/accounts/:accountId", tenantProtect, msEmailConnectLimiter, c.disconnectAccount);

// ---- CRM-level preferences and the unified inbox ----
router.get("/mailbox/settings", tenantProtect, c.getSettings);
router.put("/mailbox/settings", tenantProtect, c.saveSettings);
router.post("/mailbox/preview", tenantProtect, c.previewHtml);
router.get("/unified/messages", tenantProtect, emailReadLimiter, c.unifiedMessages);

// ---- mail of ONE account ----
const A = "/accounts/:accountId/mail";
router.get(`${A}/folders`, tenantProtect, emailReadLimiter, c.getFolders);
router.get(`${A}/folders/:id/children`, tenantProtect, emailReadLimiter, c.getChildFolders);
router.post(`${A}/folders`, tenantProtect, c.createFolder);
router.patch(`${A}/folders/:id`, tenantProtect, c.renameFolder);
router.delete(`${A}/folders/:id`, tenantProtect, c.deleteFolder);

router.get(`${A}/messages`, tenantProtect, emailReadLimiter, c.listMessages);
router.post(`${A}/messages/bulk`, tenantProtect, c.bulk);
router.get(`${A}/messages/:id`, tenantProtect, emailReadLimiter, c.getMessage);
router.patch(`${A}/messages/:id`, tenantProtect, c.updateMessage);
router.post(`${A}/messages/:id/move`, tenantProtect, c.moveMessage);
router.post(`${A}/messages/:id/delete`, tenantProtect, c.deleteMessage);
router.post(`${A}/messages/:id/restore`, tenantProtect, c.restoreMessage);
router.post(`${A}/messages/:id/archive`, tenantProtect, c.archiveMessage);
router.post(`${A}/messages/:id/reply-draft`, tenantProtect, c.replyDraft);
router.get(`${A}/messages/:id/attachments/:attachmentId/download`, tenantProtect, c.downloadAttachment);
router.get(`${A}/conversations/:id`, tenantProtect, emailReadLimiter, c.getConversation);

router.post(`${A}/drafts`, tenantProtect, c.uploadFiles, c.saveDraft);
router.get(`${A}/drafts/:id`, tenantProtect, c.getDraft);
router.delete(`${A}/drafts/:id`, tenantProtect, c.discardDraft);
router.post(`${A}/send`, tenantProtect, msEmailSendLimiter, c.uploadFiles, c.sendMessage);

router.get(`${A}/categories`, tenantProtect, c.getCategories);
router.get(`${A}/contacts`, tenantProtect, c.suggestContacts);
router.get(`${A}/auto-reply`, tenantProtect, c.getAutoReply);
router.put(`${A}/auto-reply`, tenantProtect, c.saveAutoReply);

module.exports = router;
