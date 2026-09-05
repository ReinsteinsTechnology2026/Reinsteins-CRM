const express = require("express");

const router = express.Router();

const {
    listDemoRequests,
    getDemoRequestDetails,
    updateDemoRequestStatus,
} = require("../controllers/platformDemoRequestController");
const { platformProtect } = require("../middleware/platformAuthMiddleware");

// ==========================================
// PLATFORM DEMO REQUEST ROUTES (Phase 7)
// Mounted at /api/platform/demo-requests in app.js. Every route here
// requires an authenticated, active Platform Owner -- a tenant JWT
// (or no token at all) is rejected by platformProtect before any
// handler runs, exactly like platformCompanyRoutes.js.
// ==========================================

router.get("/", platformProtect, listDemoRequests);
router.get("/:id", platformProtect, getDemoRequestDetails);
router.patch("/:id/status", platformProtect, updateDemoRequestStatus);

module.exports = router;
