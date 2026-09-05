const express = require("express");

const router = express.Router();

const { login, getCompanyInfo } = require("../controllers/tenantAuthController");
const { tenantProtect } = require("../middleware/tenantAuthMiddleware");
const { tenantLoginLimiter } = require("../middleware/rateLimiters");

// ==========================================
// TENANT-AWARE AUTH ROUTES (Phase 2F)
// Mounted at /api/tenant-auth in app.js -- entirely separate from
// /api/auth (existing Reinsteins login) and /api/platform/auth
// (Platform Owner login).
// ==========================================

router.post("/:companySlug/login", tenantLoginLimiter, login);

// Phase 5 -- public, unauthenticated company branding lookup for the
// company-aware login page. Read-only, active-companies-only; see
// getCompanyInfo's own comment for exactly what it does and doesn't
// expose.
router.get("/:companySlug/info", getCompanyInfo);

// Minimal authenticated smoke-test route -- lets this phase's own
// verification (and later phases) confirm tenantProtect resolves
// company/tenant-DB context correctly end-to-end over real HTTP,
// mirroring the same precedent as platformAuthRoutes.js's /me.
// Deliberately takes NO companySlug/companyId from the request --
// the company context comes entirely from the token, proving it
// cannot be overridden by anything the caller sends.
router.get("/me", tenantProtect, (req, res) => {
    return res.json({
        success: true,
        user: req.user,
        company: {
            id: req.tenantCompany.id,
            name: req.tenantCompany.company_name,
            slug: req.tenantCompany.company_slug,
        },
    });
});

module.exports = router;
