const express = require("express");

const router = express.Router();

const { login } = require("../controllers/platformAuthController");
const { platformProtect } = require("../middleware/platformAuthMiddleware");
const { platformLoginLimiter } = require("../middleware/rateLimiters");

// ==========================================
// PLATFORM AUTH ROUTES (Phase 2B)
// Mounted at /api/platform/auth in app.js --
// entirely separate from /api/auth (tenant).
// ==========================================

router.post("/login", platformLoginLimiter, login);

// Minimal authenticated smoke-test route -- lets Phase 2B's own
// verification (and later phases) confirm platformProtect works
// end-to-end over real HTTP without needing any other platform
// route to exist yet.

router.get("/me", platformProtect, (req, res) => {
    return res.json({ success: true, platformUser: req.platformUser });
});

module.exports = router;
