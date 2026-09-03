const express = require("express");

const router = express.Router();

const { createCompany, createFirstAdmin } = require("../controllers/platformCompanyController");
const { platformProtect } = require("../middleware/platformAuthMiddleware");

// ==========================================
// PLATFORM COMPANY ROUTES (Phase 2D / 2E)
// Mounted at /api/platform/companies in app.js. Every route here
// requires an authenticated, active Platform Owner -- a tenant JWT
// (or no token at all) is rejected by platformProtect before any
// handler runs.
// ==========================================

router.post("/", platformProtect, createCompany);

// Phase 2E -- create a company's first tenant Administrator. Writes
// only to that company's own tenant database (resolved server-side
// from :companyId); never touches groworgs_platform_db.platform_users.
router.post("/:companyId/admin", platformProtect, createFirstAdmin);

module.exports = router;
