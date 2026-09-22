const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");

const platformCompanyService = require("../services/platformCompanyService");
const { getTenantPoolForCompany } = require("../config/tenantConnectionManager");
const { isValidSlug } = require("../utils/tenantDbName");
const { UPLOADS_ROOT } = require("../utils/tenantUploadPath");

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

        // Phase 17c: the same submitted value is accepted as EITHER an
        // employee ID (e.g. "RS001") OR a company email address (e.g.
        // "shafiqmohammed@reinsteins.com") -- the request body field is
        // deliberately left named `employeeId` (no wire-format change)
        // since it is just a string identifier either way; only the
        // lookup below is widened.
        const loginIdentifier = String(employeeId).trim();

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
            `SELECT id, employee_id, full_name, email, password, role, status, employment_status, system_access, designation
             FROM users WHERE employee_id = ? OR LOWER(email) = LOWER(?) LIMIT 1`,
            [loginIdentifier, loginIdentifier]
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
                fullName: user.full_name,
                employeeId: user.employee_id,
                role: user.role,
                systemAccess: user.system_access,
                designation: user.designation || null,
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
// logoUrl points at the public, unauthenticated GET
// /:companySlug/logo endpoint below (never a raw filesystem path or
// the stored filename itself) when the company has uploaded one, or
// null otherwise -- the frontend already renders the existing "Zi"
// fallback mark for null exactly as before, unchanged by this phase.
// The ?v= query param is a cache-busting version derived from the
// company row's own updated_at, so a Platform Owner replacing a logo
// (see platformCompanyController.js's setCompanyLogo) is reflected
// immediately even though the underlying URL is otherwise stable and
// cached aggressively (see getCompanyLogo below).
// ==========================================

const buildCompanyLogoUrl = (req, company) => {
    if (!company.logo_url) return null;
    const origin = `${req.protocol}://${req.get("host")}`;
    const version = new Date(company.updated_at).getTime();
    return `${origin}/api/tenant-auth/${company.company_slug}/logo?v=${version}`;
};

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
                logoUrl: buildCompanyLogoUrl(req, company),
            },
        });

    } catch (error) {
        console.error("[tenant-auth] getCompanyInfo failed:", error);
        return res.status(500).json({ success: false, message: "Unable to load company info." });
    }

};

// Content-Type derived from the file's own validated extension only
// (never a client-supplied or stored mimetype) -- same reasoning as
// fileTypeValidation.js's header comment on why extension/mimetype
// must never be trusted independently of each other. logo_url can
// only ever end in one of these (see companyLogoUploadMiddleware.js),
// so an unrecognized extension here means the stored value is
// corrupt, not a request the client can influence.
const LOGO_CONTENT_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
};

// ==========================================
// GET /api/tenant-auth/:companySlug/logo -- public, unauthenticated
// by design (same reasoning as getCompanyInfo above: needed on the
// pre-login page). Deliberately NOT the existing authenticated
// /uploads/*splat route (that one requires a signed, per-user token
// minted only for an already-logged-in caller, unusable before login)
// -- this is a narrow, separate, read-only exception that can only
// ever serve exactly the one file this company's own companies.logo_url
// row currently names, in this company's own isolated branding
// directory. No path/filename is ever accepted from the client --
// companySlug is the only input, and it only ever selects WHICH
// company's single configured logo to serve, never a location within
// it.
// ==========================================

const getCompanyLogo = async (req, res) => {

    try {

        const companySlugRaw = req.params.companySlug;

        if (typeof companySlugRaw !== "string" || !isValidSlug(companySlugRaw.trim().toLowerCase())) {
            return res.status(404).json({ success: false, message: "Logo not found." });
        }

        const companySlug = companySlugRaw.trim().toLowerCase();
        const company = await platformCompanyService.getActiveCompanyBySlug(companySlug);

        if (!company || !company.logo_url) {
            return res.status(404).json({ success: false, message: "Logo not found." });
        }

        const extension = path.extname(company.logo_url).toLowerCase();
        const contentType = LOGO_CONTENT_TYPES[extension];

        if (!contentType) {
            // Stored value doesn't match any extension this system ever
            // writes -- treat exactly like "no logo" rather than
            // attempting to serve/guess an unsafe content type.
            return res.status(404).json({ success: false, message: "Logo not found." });
        }

        // Path-traversal defense, independent of the DB lookup above --
        // same containment pattern as the existing /uploads/*splat
        // route and employeeController.js's profile-photo replacement.
        const resolvedPath = path.resolve(UPLOADS_ROOT, `tenant_${company.company_slug}`, "branding", company.logo_url);
        const expectedDir = path.resolve(UPLOADS_ROOT, `tenant_${company.company_slug}`, "branding");

        if (resolvedPath !== expectedDir && !resolvedPath.startsWith(expectedDir + path.sep)) {
            return res.status(404).json({ success: false, message: "Logo not found." });
        }

        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
            return res.status(404).json({ success: false, message: "Logo not found." });
        }

        // Long-lived, immutable cache -- safe because the URL itself
        // never changes for a given upload, and the ?v= query param
        // getCompanyInfo's buildCompanyLogoUrl appends changes whenever
        // the company row updates, busting any cached copy from before
        // a logo replacement.
        res.set("Content-Type", contentType);
        res.set("Cache-Control", "public, max-age=31536000, immutable");

        return res.sendFile(resolvedPath);

    } catch (error) {
        console.error("[tenant-auth] getCompanyLogo failed:", error);
        return res.status(500).json({ success: false, message: "Unable to load company logo." });
    }

};

module.exports = {
    login,
    getCompanyInfo,
    getCompanyLogo,
    TENANT_JWT_ISSUER,
    TENANT_JWT_AUDIENCE,
};
