const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const platformCompanyService = require("../services/platformCompanyService");
const { getTenantPoolForCompany } = require("../config/tenantConnectionManager");
const { isValidSlug } = require("../utils/tenantDbName");

// ==========================================
// TENANT-AWARE AUTH CONTROLLER (Phase 2F)
//
// A NEW, additive login path -- POST /api/tenant-auth/:companySlug/login
// -- that determines which company's tenant database to authenticate
// against BEFORE querying any users table. This does not touch, call,
// or modify server/controllers/authController.js (the existing
// single-tenant Reinsteins login) in any way; both continue to work
// side by side.
//
// JWT SEPARATION: signed with TENANT_JWT_SECRET -- a THIRD secret,
// distinct from both JWT_SECRET (existing Reinsteins login) and
// PLATFORM_JWT_SECRET (Platform Owner login). This was necessary,
// not just consistent-for-its-own-sake: server/middleware/
// authMiddleware.js's `protect` calls jwt.verify(token, JWT_SECRET)
// with no issuer/audience/type check at all, so a token merely
// SIGNED with JWT_SECRET (even carrying extra companyId/companySlug
// claims) would be silently accepted by the existing Reinsteins
// portal. Reusing JWT_SECRET here would have created exactly the
// cross-tenant hole this phase exists to prevent. A separate secret
// makes cross-authentication fail at jwt.verify() itself, for both
// directions, before any claim is ever inspected.
// ==========================================

const TENANT_JWT_ISSUER = "groworgs-tenant";
const TENANT_JWT_AUDIENCE = "groworgs-tenant-user";

const login = async (req, res) => {

    try {

        const companySlugRaw = req.params.companySlug;
        const { employeeId, password } = req.body || {};

        if (typeof companySlugRaw !== "string" || companySlugRaw.trim().length === 0) {
            return res.status(400).json({ success: false, message: "Company is required." });
        }

        const companySlug = companySlugRaw.trim().toLowerCase();

        if (!isValidSlug(companySlug)) {
            return res.status(404).json({ success: false, message: "Company not found." });
        }

        if (!employeeId || !password) {
            return res.status(400).json({ success: false, message: "Employee ID and password are required." });
        }

        // ---------- Resolve company -> tenant database ----------
        const company = await platformCompanyService.getCompanyBySlug(companySlug);

        if (!company) {
            return res.status(404).json({ success: false, message: "Company not found." });
        }

        if (company.status !== "active") {
            return res.status(403).json({ success: false, message: "This company is not currently active." });
        }

        // Phase 8: subscription enforcement, extending the existing
        // status check above rather than replacing it -- suspension
        // (status !== 'active') is still checked and reported exactly
        // as before. This is the one login-time spot where a clear,
        // professional message matters (Part 9 of the phase spec) --
        // the user is trying to sign in and needs to know why they
        // can't, unlike an already-issued token silently expiring
        // mid-session (tenantProtect), where a generic message is
        // deliberately kept for security-posture consistency.
        if (!platformCompanyService.isCompanyAccessAllowed(company)) {
            return res.status(403).json({
                success: false,
                message:
                    "Company access is currently unavailable. Please contact your administrator or the GrowOrgs platform owner.",
            });
        }

        let tenantPool;
        try {
            tenantPool = getTenantPoolForCompany(company);
        } catch (resolveError) {
            // Covers COMPANY_NO_TENANT_DB / COMPANY_TENANT_DB_INVALID --
            // an active company row that isn't actually provisioned
            // yet, or whose tenant_db_name failed re-validation.
            console.error(`[tenant-auth] Could not resolve tenant DB for company id=${company.id}:`, resolveError.message);
            return res.status(403).json({ success: false, message: "This company is not currently available." });
        }

        // ---------- Authenticate against THAT tenant's users table only ----------
        // Same query shape, same status/employment_status checks, and
        // the same generic "invalid credentials" message for both
        // "no such employee" and "wrong password" as the existing
        // authController.js login -- just run against the resolved
        // tenant pool instead of the fixed Reinsteins pool.
        const [users] = await tenantPool.query(
            `SELECT id, employee_id, full_name, email, password, role, status, employment_status, system_access
             FROM users WHERE employee_id = ? LIMIT 1`,
            [employeeId]
        );

        if (users.length === 0) {
            return res.status(401).json({ success: false, message: "Invalid Employee ID or password" });
        }

        const user = users[0];

        if (user.status !== "active" || (user.employment_status && user.employment_status !== "active")) {
            return res.status(403).json({
                success: false,
                message: "Your account is no longer active. Please contact your administrator.",
            });
        }

        const passwordMatches = await bcrypt.compare(password, user.password);

        if (!passwordMatches) {
            return res.status(401).json({ success: false, message: "Invalid Employee ID or password" });
        }

        // ---------- Issue tenant-aware JWT ----------
        const token = jwt.sign(
            {
                userId: user.id,
                companyId: company.id,
                companySlug: company.company_slug,
                type: "tenant_user",
            },
            process.env.TENANT_JWT_SECRET,
            {
                expiresIn: "8h",
                issuer: TENANT_JWT_ISSUER,
                audience: TENANT_JWT_AUDIENCE,
            }
        );

        await tenantPool.query(`UPDATE users SET last_login = NOW() WHERE id = ?`, [user.id]);

        return res.status(200).json({
            success: true,
            token,
            user: {
                id: user.id,
                name: user.full_name,
                employeeId: user.employee_id,
                role: user.role,
            },
            company: {
                id: company.id,
                name: company.company_name,
                slug: company.company_slug,
            },
        });

    } catch (error) {
        console.error("[tenant-auth] login failed:", error);
        return res.status(500).json({ success: false, message: "Unable to log in." });
    }

};

// ==========================================
// PUBLIC COMPANY INFO (Phase 5)
//
// GET /api/tenant-auth/:companySlug/info -- unauthenticated, by
// design: the company-aware login page (/:companySlug/login) needs a
// display name BEFORE anyone has logged in. Returns only the two
// fields a login page's branding needs (name, slug) -- never status,
// access type, tenant_db_name, or anything else from the companies
// row. A slug that doesn't resolve to an ACTIVE company (unknown OR
// suspended OR still pending) gets the same generic 404, so this
// endpoint never confirms/denies "does this company exist but isn't
// active yet" to an unauthenticated caller.
//
// logoUrl is always null today -- no logo storage exists yet (no
// schema change made this phase, per the explicit "do not
// over-engineer branding" instruction). The field is returned now so
// the frontend branding component already has the right shape to
// consume once a future phase adds real logo storage.
// ==========================================

const getCompanyInfo = async (req, res) => {

    try {

        const companySlugRaw = req.params.companySlug;

        if (typeof companySlugRaw !== "string" || !isValidSlug(companySlugRaw.trim().toLowerCase())) {
            return res.status(404).json({ success: false, message: "Company not found." });
        }

        const companySlug = companySlugRaw.trim().toLowerCase();
        const company = await platformCompanyService.getActiveCompanyBySlug(companySlug);

        if (!company) {
            return res.status(404).json({ success: false, message: "Company not found." });
        }

        return res.status(200).json({
            success: true,
            company: {
                name: company.company_name,
                slug: company.company_slug,
                logoUrl: null,
            },
        });

    } catch (error) {
        console.error("[tenant-auth] getCompanyInfo failed:", error);
        return res.status(500).json({ success: false, message: "Unable to load company info." });
    }

};

module.exports = {
    login,
    getCompanyInfo,
    TENANT_JWT_ISSUER,
    TENANT_JWT_AUDIENCE,
};
