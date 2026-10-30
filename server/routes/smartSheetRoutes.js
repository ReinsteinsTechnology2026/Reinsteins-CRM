const express = require("express");

const { getDefaultController } = require("../controllers/smartSheetController");
const { uploadSmartSheetFile } = require("../middleware/smartSheetUploadMiddleware");

// ==========================================
// SMART SHEETS ROUTES   (mounted at /api/smart-sheets)
//
// Authentication (protect -> the existing legacy/tenant JWT chain) and an active account
// (requireActiveUser) apply to everything. Management routes additionally require the admin tier
// (requireAccess passes role 'admin' and system_access 'admin' | 'super_admin'; it re-reads both
// from the database on every call).
//
// These route-level checks are only the first gate. The service re-checks the caller's role and
// -- for anything addressed by sheet id -- their assignment on EVERY call, so an employee who guesses
// an id gets the same 404 as for an id that does not exist, and an assigned employee can never
// reach a management action even if a route were mistakenly left open.
//
// Live edits do NOT go through here: they travel over Socket.IO (services/smartSheetRealtime.js).
// ==========================================

// Dependencies are injectable so the HTTP behaviour can be tested without a database; the production
// defaults are the real middleware chain and the PostgreSQL-backed controller.
function createSmartSheetRouter({
    controller = getDefaultController(),
    authenticate,   // [protect, requireActiveUser] in production
    adminTier,      // requireAccess("super_admin", "admin") in production
    upload = uploadSmartSheetFile,
} = {}) {
    const router = express.Router();

    router.use(...authenticate);

    // Everyone (admin tier sees all sheets, others only sheets assigned to them)
    router.get("/", controller.listSheets);

    // Admin tier only
    router.get("/assignable-employees", adminTier, controller.searchEmployees);
    router.post("/", adminTier, controller.createSheet);
    router.post("/import", adminTier, upload, controller.importSheet);

    // By sheet id (access decided by the service)
    router.get("/:id", controller.getSheet);
    router.get("/:id/workbook", controller.getWorkbook);
    router.get("/:id/export", controller.exportSheet);

    router.patch("/:id", adminTier, controller.updateSheet);
    router.delete("/:id", adminTier, controller.deleteSheet);

    router.get("/:id/access", adminTier, controller.listAccess);
    router.put("/:id/access", adminTier, controller.assign);
    router.delete("/:id/access/:userId", adminTier, controller.revoke);

    return router;
}

// The real wiring, built when app.js mounts it.
function createDefaultSmartSheetRouter() {
    const { protect } = require("../middleware/authMiddleware");
    const { requireAccess, requireActiveUser } = require("../middleware/accessMiddleware");
    return createSmartSheetRouter({
        authenticate: [protect, requireActiveUser],
        adminTier: requireAccess("super_admin", "admin"),
    });
}

module.exports = createDefaultSmartSheetRouter();
module.exports.createSmartSheetRouter = createSmartSheetRouter;
