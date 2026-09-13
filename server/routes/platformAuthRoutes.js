const express = require("express");

const router = express.Router();

const {
    login,
    verifyTwoFactorLogin,
    changePassword,
    getTwoFactorStatus,
    setupTwoFactor,
    confirmTwoFactor,
    disableTwoFactor,
    regenerateBackupCodes,
} = require("../controllers/platformAuthController");
const { platformProtect } = require("../middleware/platformAuthMiddleware");
const { platformLoginLimiter, platformTwoFactorLoginLimiter, twoFactorLimiter, passwordChangeLimiter } = require("../middleware/rateLimiters");

// ==========================================
// PLATFORM AUTH ROUTES (Phase 2B, extended Phase 14)
// Mounted at /api/platform/auth in app.js --
// entirely separate from /api/auth (tenant).
//
// Phase 14: /verify-2fa gets its OWN limiter instance (not a reuse of
// platformLoginLimiter) -- see middleware/rateLimiters.js for why.
// Everything else new here is a platformProtect-guarded account-
// management action and gets the separate, tighter
// twoFactorLimiter/passwordChangeLimiter instead.
// ==========================================

router.post("/login", platformLoginLimiter, login);
router.post("/verify-2fa", platformTwoFactorLoginLimiter, verifyTwoFactorLogin);

// Minimal authenticated smoke-test route -- lets Phase 2B's own
// verification (and later phases) confirm platformProtect works
// end-to-end over real HTTP without needing any other platform
// route to exist yet.
//
// Phase 14: returns an explicit safe shape, not req.platformUser
// wholesale -- that object now also carries token_version (an
// internal implementation detail with no legitimate frontend use),
// which this deliberately never exposes.
router.get("/me", platformProtect, (req, res) => {
    return res.json({
        success: true,
        platformUser: {
            id: req.platformUser.id,
            name: req.platformUser.name,
            email: req.platformUser.email,
            role: req.platformUser.role,
            status: req.platformUser.status,
            totpEnabled: Boolean(req.platformUser.totp_enabled),
        },
    });
});

router.patch("/password", platformProtect, passwordChangeLimiter, changePassword);

// Phase 14D -- two-factor authentication enrollment/management.
router.get("/2fa/status", platformProtect, getTwoFactorStatus);
router.post("/2fa/setup", platformProtect, twoFactorLimiter, setupTwoFactor);
router.post("/2fa/confirm", platformProtect, twoFactorLimiter, confirmTwoFactor);
router.post("/2fa/disable", platformProtect, twoFactorLimiter, disableTwoFactor);
router.post("/2fa/backup-codes/regenerate", platformProtect, twoFactorLimiter, regenerateBackupCodes);

module.exports = router;
