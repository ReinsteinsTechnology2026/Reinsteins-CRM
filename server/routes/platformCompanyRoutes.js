const express = require("express");

const router = express.Router();

const {
    createCompany,
    createFirstAdmin,
    listCompanies,
    getStats,
    getCompanyDetails,
    updateStatus,
    updateAccessType,
    updateSubscription,
} = require("../controllers/platformCompanyController");
const { platformProtect } = require("../middleware/platformAuthMiddleware");

// ==========================================
// PLATFORM COMPANY ROUTES (Phase 2D / 2E / 4)
// Mounted at /api/platform/companies in app.js. Every route here
// requires an authenticated, active Platform Owner -- a tenant JWT
// (or no token at all) is rejected by platformProtect before any
// handler runs.
//
// Route order matters: /stats must be registered before /:id, or
// Express would match a request for "/stats" as :id="stats".
// ==========================================

router.get("/", platformProtect, listCompanies);
router.get("/stats", platformProtect, getStats);

router.post("/", platformProtect, createCompany);

// Phase 2E -- create a company's first tenant Administrator. Writes
// only to that company's own tenant database (resolved server-side
// from :companyId); never touches groworgs_platform_db.platform_users.
router.post("/:companyId/admin", platformProtect, createFirstAdmin);

// Phase 4 -- company management (Platform Owner Dashboard).
router.get("/:id", platformProtect, getCompanyDetails);
router.patch("/:id/status", platformProtect, updateStatus);
router.patch("/:id/access-type", platformProtect, updateAccessType);

// Phase 8 -- company subscription/plan management. Metadata-only;
// never touches tenant_db_name or any tenant database.
router.patch("/:id/subscription", platformProtect, updateSubscription);

module.exports = router;
