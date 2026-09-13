const express = require("express");

const router = express.Router();

const { listLogs } = require("../controllers/platformAuditController");
const { platformProtect } = require("../middleware/platformAuthMiddleware");

// ==========================================
// PLATFORM AUDIT ROUTES (Phase 12K)
// Mounted at /api/platform/audit-logs in app.js. Read-only, Platform
// Owner only.
// ==========================================

router.get("/", platformProtect, listLogs);

module.exports = router;
