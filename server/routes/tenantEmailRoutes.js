const express = require("express");

const {
    createDomain,
    listDomains,
    getDomainDnsInstructions,
    verifyDomain,
    deleteDomain,
    createMailbox,
    listMailboxes,
    getMailboxById,
    getMyMailbox,
    updateMailboxStatus,
    deleteMailbox,
} = require("../controllers/tenantEmailController");

const { tenantProtect } = require("../middleware/tenantAuthMiddleware");
const { requireAccess } = require("../middleware/accessMiddleware");
const { tenantEmailLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

// ==========================================
// TENANT EMAIL ROUTES (Phase 16A)
//
// Mounted under tenantProtect (company-aware tenant auth), NOT
// platformProtect -- this is a Company Admin / employee self-service
// surface, not a Platform Owner one (Step 18: "Every route must be
// tenant protected"). tenantProtect resolves req.tenantCompany/
// req.tenantDb/req.user fresh from the verified JWT on every request;
// every controller handler below reads company identity from THAT,
// never from the URL or body -- see tenantEmailController.js's header
// comment for why that's the actual isolation boundary.
//
// Domain/mailbox ADMINISTRATION (create/verify/delete a domain,
// create/suspend/delete a mailbox) is gated to role='admin' via
// requireAccess() with no allowed system_access tiers -- mirrors the
// exact convention departmentRoutes.js already uses for its own
// admin-only mutations. Reading your OWN mailbox (GET /mailboxes/me)
// is open to any active tenant user, no admin gate -- an ordinary
// employee needs to see their own mailbox, not manage the company's.
// ==========================================

router.post("/domains", tenantProtect, requireAccess(), tenantEmailLimiter, createDomain);
router.get("/domains", tenantProtect, listDomains);
router.get("/domains/:id/dns-instructions", tenantProtect, getDomainDnsInstructions);
router.post("/domains/:id/verify", tenantProtect, requireAccess(), tenantEmailLimiter, verifyDomain);
router.delete("/domains/:id", tenantProtect, requireAccess(), tenantEmailLimiter, deleteDomain);

router.post("/mailboxes", tenantProtect, requireAccess(), tenantEmailLimiter, createMailbox);
router.get("/mailboxes", tenantProtect, requireAccess(), listMailboxes);
router.get("/mailboxes/me", tenantProtect, getMyMailbox);
router.get("/mailboxes/:id", tenantProtect, requireAccess(), getMailboxById);
router.patch("/mailboxes/:id/status", tenantProtect, requireAccess(), tenantEmailLimiter, updateMailboxStatus);
router.delete("/mailboxes/:id", tenantProtect, requireAccess(), tenantEmailLimiter, deleteMailbox);

module.exports = router;
