const express = require("express");

const router = express.Router();

const { login, getCompanyInfo, getCompanyLogo } = require("../controllers/tenantAuthController");
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

// Public, unauthenticated by design -- see getCompanyLogo's own
// comment for exactly what it does and doesn't expose. Needed before
// login, same reasoning as /:companySlug/info above.
router.get("/:companySlug/logo", getCompanyLogo);

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

// ==========================================
// SUBSCRIPTION STATUS (Phase 12R)
//
// Admin-only (never ordinary employees -- "prefer Admin-level
// messaging", per the Phase 12 spec) plain-language summary of the
// company's own subscription state, for a small warning banner in the
// Admin portal. Reads req.tenantCompany -- already resolved by
// tenantProtect from the token alone, including grace_period_ends_at
// (COMPANY_COLUMNS was extended for exactly this in Phase 12G) -- no
// second DB query, and no path for a client to ask about any OTHER
// company. Deliberately returns no pricing/payment/invoice data, only
// a status + date + short message.
// ==========================================

router.get("/subscription-status", tenantProtect, (req, res) => {
    if (req.user.role !== "admin" && req.user.role !== "super_admin") {
        return res.status(403).json({ success: false, message: "Admin access required." });
    }

    const company = req.tenantCompany;
    const now = new Date();
    const oneDayMs = 24 * 60 * 60 * 1000;

    let status = "active";
    let message = null;
    let relevantDate = null;

    if (company.subscription_status === "trial" && company.trial_ends_at) {
        const trialEndsAt = new Date(company.trial_ends_at);
        relevantDate = company.trial_ends_at;
        if (trialEndsAt <= now) {
            status = "trial_expired";
            message = "Your trial has ended. Please contact your administrator.";
        } else {
            const daysRemaining = Math.ceil((trialEndsAt - now) / oneDayMs);
            if (daysRemaining <= 3) {
                status = "trial_ending_soon";
                message = `Your trial ends in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}.`;
            }
        }
    } else if (company.subscription_status === "expired") {
        status = "expired";
        message = "Your subscription has expired. Please contact your administrator.";
    } else if (company.subscription_status === "cancelled") {
        status = "cancelled";
        message = "Your subscription has been cancelled. Please contact your administrator.";
    } else if (company.subscription_status === "active" && company.subscription_expires_at) {
        const expiresAt = new Date(company.subscription_expires_at);
        relevantDate = company.subscription_expires_at;
        if (expiresAt <= now && company.grace_period_ends_at && new Date(company.grace_period_ends_at) >= now) {
            status = "grace_period";
            message = `Your ZioVenture subscription needs renewal. Access continues until ${new Date(company.grace_period_ends_at).toLocaleDateString()}.`;
            relevantDate = company.grace_period_ends_at;
        } else {
            const daysRemaining = Math.ceil((expiresAt - now) / oneDayMs);
            if (daysRemaining > 0 && daysRemaining <= 7) {
                status = "expiring_soon";
                message = `Your ZioVenture subscription expires on ${expiresAt.toLocaleDateString()}.`;
            }
        }
    }

    return res.json({ success: true, status, message, relevantDate });
});

module.exports = router;
