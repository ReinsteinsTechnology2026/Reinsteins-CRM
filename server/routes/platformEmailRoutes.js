const express = require("express");

const router = express.Router();

const { listEmailLogs, retryEmailLog, getEmailStatus, testEmailConnection } = require("../controllers/platformEmailController");
const { platformProtect } = require("../middleware/platformAuthMiddleware");
const { emailActionLimiter } = require("../middleware/rateLimiters");

// ==========================================
// PLATFORM EMAIL ROUTES (Phase 13)
// Mounted at /api/platform/email-logs in app.js. Every route requires
// an authenticated, active Platform Owner.
//
// Route order: /status and /test-connection before /:id/retry, same
// convention as every other platform route file in this codebase.
// ==========================================

router.get("/", platformProtect, listEmailLogs);
router.get("/status", platformProtect, getEmailStatus);
router.post("/test-connection", platformProtect, emailActionLimiter, testEmailConnection);
router.post("/:id/retry", platformProtect, emailActionLimiter, retryEmailLog);

module.exports = router;
