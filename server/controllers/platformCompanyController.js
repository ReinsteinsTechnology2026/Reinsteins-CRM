const bcrypt = require("bcrypt");

const platformCompanyService = require("../services/platformCompanyService");
const subscriptionPlanService = require("../services/subscriptionPlanService");
const tenantProvisioningService = require("../services/tenantProvisioningService");
const tenantUserService = require("../services/tenantUserService");
const { getTenantPoolForCompany } = require("../config/tenantConnectionManager");
const { isValidSlug, buildTenantDbName } = require("../utils/tenantDbName");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_ADMIN_PASSWORD_LENGTH = 8;

// ==========================================
// PLATFORM COMPANY CONTROLLER (Phase 2D)
//
// Every route using this controller is mounted behind
// platformProtect -- only an authenticated, active Platform Owner
// ever reaches these handlers.
// ==========================================

const VALID_ACCESS_TYPES = ["complimentary", "trial", "paid"];

// Phase 5 introduced company-aware frontend routes shaped like
// /:companySlug/login, /:companySlug/admin, etc. -- a company slug
// matching one of the app's own OTHER top-level route segments would
// make that company's URLs ambiguous with (or shadow) a real route.
// isValidSlug() alone doesn't prevent this (it only checks character
// shape), so this is a small, explicit blocklist checked in addition
// to it.
const RESERVED_COMPANY_SLUGS = new Set([
    "admin", "employee", "platform", "login", "register",
    "meeting", "api", "task-management-test",
]);

// Saga-style creation flow (CREATE DATABASE cannot participate in a
// normal SQL transaction, so this is explicit compensation, not a
// rollback):
//
//   1. INSERT a 'pending' company row (reserves the slug via its
//      UNIQUE constraint -- the real concurrency guard).
//   2. Provision the tenant database.
//        - on failure: DELETE the pending row just created in step 1
//          (guarded so it can only ever remove that specific,
//          still-pending, still-unprovisioned row) and report failure.
//          No tenant database exists at this point, so there is
//          nothing else to compensate.
//   3. UPDATE the row to status='active' with its tenant_db_name.
//        - on failure: do NOT drop the tenant database created in
//          step 2. It is a real, schema-verified database; destroying
//          it over a metadata write failure (typically transient)
//          would be far more destructive than leaving the row
//          recoverable. The row stays 'pending' with a known,
//          deterministic tenant_db_name (buildTenantDbName(slug)),
//          so manual/automated reconciliation can complete the
//          activation without re-provisioning.
const createCompany = async (req, res) => {

    try {

        // Only these three fields are ever read from the request
        // body. tenant_db_name, status, id, DB host/user/password, or
        // any other field the client sends is simply never
        // referenced anywhere below -- there is no path by which a
        // client-supplied value for any of those can reach the
        // company row or the tenant database.
        const companyNameRaw = req.body?.companyName;
        const companySlugRaw = req.body?.companySlug;
        const accessTypeRaw = req.body?.accessType;

        if (
            typeof companyNameRaw !== "string" ||
            companyNameRaw.trim().length < 2 ||
            companyNameRaw.trim().length > 255
        ) {
            return res.status(400).json({
                success: false,
                message: "companyName is required (2-255 characters).",
            });
        }

        if (typeof companySlugRaw !== "string" || companySlugRaw.trim().length === 0) {
            return res.status(400).json({ success: false, message: "companySlug is required." });
        }

        // Server normalizes the slug (trim + lowercase) rather than
        // trusting client casing/whitespace, then validates it
        // against the same strict whitelist used for tenant database
        // names -- this also means any SQL/identifier-injection-style
        // slug is rejected here, before it ever reaches a query.
        const companySlug = companySlugRaw.trim().toLowerCase();

        if (!isValidSlug(companySlug)) {
            return res.status(400).json({
                success: false,
                message:
                    "companySlug must be lowercase, start with a letter, contain only " +
                    "letters/digits/underscore, and be 2-40 characters long.",
            });
        }

        if (RESERVED_COMPANY_SLUGS.has(companySlug)) {
            return res.status(400).json({
                success: false,
                message: `"${companySlug}" is a reserved name and cannot be used as a company slug.`,
            });
        }

        if (!VALID_ACCESS_TYPES.includes(accessTypeRaw)) {
            return res.status(400).json({
                success: false,
                message: `accessType must be one of: ${VALID_ACCESS_TYPES.join(", ")}.`,
            });
        }

        const companyName = companyNameRaw.trim();
        const accessType = accessTypeRaw;

        // Database name is generated server-side from the validated
        // slug -- never accepted from the client.
        let tenantDbName;
        try {
            tenantDbName = buildTenantDbName(companySlug);
        } catch (nameError) {
            return res.status(400).json({ success: false, message: nameError.message });
        }

        // ---------- Step 1: reserve the slug ----------
        let company;
        try {
            company = await platformCompanyService.createPendingCompany({
                companyName,
                companySlug,
                accessType,
            });
        } catch (createError) {
            if (createError.code === "COMPANY_SLUG_TAKEN") {
                return res.status(409).json({
                    success: false,
                    message: "A company with this slug already exists.",
                });
            }
            throw createError;
        }

        // ---------- Step 2: provision the tenant database ----------
        const provisionResult = await tenantProvisioningService.provisionTenantDatabase({
            databaseName: tenantDbName,
        });

        if (!provisionResult.success) {
            await platformCompanyService.deletePendingCompany(company.id);

            console.error(
                `[platform] Tenant provisioning failed for company id=${company.id} ` +
                `slug=${companySlug}: ${provisionResult.error}`
            );

            return res.status(500).json({
                success: false,
                message: "Failed to provision the tenant database. The company was not created.",
            });
        }

        // ---------- Step 3: activate ----------
        const activated = await platformCompanyService.activateCompany(company.id, tenantDbName);

        if (!activated) {
            console.error(
                `[platform] Company id=${company.id} slug=${companySlug} provisioned tenant ` +
                `database "${tenantDbName}" but the activation UPDATE did not apply. ` +
                `Row remains 'pending'; tenant_db_name is recoverable via buildTenantDbName(slug).`
            );

            return res.status(500).json({
                success: false,
                message:
                    "The tenant database was created, but the company record could not be " +
                    "finalized. This has been logged for manual review.",
            });
        }

        return res.status(201).json({
            success: true,
            company: {
                id: activated.id,
                companyName: activated.company_name,
                companySlug: activated.company_slug,
                status: activated.status,
                accessType: activated.access_type,
                tenantDbName: activated.tenant_db_name,
                createdAt: activated.created_at,
            },
        });

    } catch (error) {
        console.error("[platform] createCompany failed:", error);
        return res.status(500).json({ success: false, message: "Failed to create company." });
    }

};

// ==========================================
// CREATE FIRST TENANT ADMIN (Phase 2E)
//
// POST /api/platform/companies/:companyId/admin -- Platform Owner
// only. Resolves the target tenant database entirely server-side
// from companyId (never from the request body), then inserts the
// new admin ONLY into that tenant's own `users` table. The Platform
// Owner never becomes a tenant user, and no platform_users row is
// ever created here.
// ==========================================
const createFirstAdmin = async (req, res) => {

    try {

        const companyId = Number(req.params.companyId);
        if (!Number.isInteger(companyId) || companyId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid company id." });
        }

        const nameRaw = req.body?.name;
        const emailRaw = req.body?.email;
        const passwordRaw = req.body?.password;
        const phoneRaw = req.body?.phone;
        // Nothing else on req.body is ever read -- there is no path
        // by which a client-supplied role, system_access, status, or
        // tenant database identifier can reach this admin's row.

        if (typeof nameRaw !== "string" || nameRaw.trim().length < 2 || nameRaw.trim().length > 100) {
            return res.status(400).json({ success: false, message: "name is required (2-100 characters)." });
        }

        if (typeof emailRaw !== "string" || !EMAIL_PATTERN.test(emailRaw.trim())) {
            return res.status(400).json({ success: false, message: "A valid email is required." });
        }

        if (typeof passwordRaw !== "string" || passwordRaw.length < MIN_ADMIN_PASSWORD_LENGTH) {
            return res.status(400).json({
                success: false,
                message: `password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`,
            });
        }

        if (phoneRaw !== undefined && phoneRaw !== null && typeof phoneRaw !== "string") {
            return res.status(400).json({ success: false, message: "phone must be a string." });
        }

        // ---------- Resolve tenant database from companyId ----------
        // 1. look up the company in the platform DB
        // 2. verify it exists
        // 3. verify status is active
        // 4. read tenant_db_name
        // 5. validate tenant_db_name
        // 6. connect only to that database
        // All six steps happen inside getTenantPoolForCompany() plus
        // the getCompanyById() call below -- nothing here accepts a
        // database name, host, or credential from the client.
        const company = await platformCompanyService.getCompanyById(companyId);

        let tenantPool;
        try {
            tenantPool = getTenantPoolForCompany(company);
        } catch (resolveError) {
            const statusByCode = {
                COMPANY_NOT_FOUND: 404,
                COMPANY_NOT_ACTIVE: 409,
                COMPANY_NO_TENANT_DB: 409,
                COMPANY_TENANT_DB_INVALID: 409,
            };
            return res.status(statusByCode[resolveError.code] || 400).json({
                success: false,
                message: resolveError.message,
            });
        }

        // This endpoint creates THE first admin -- if the tenant
        // already has one (role='admin'), refuse rather than quietly
        // creating a second "first" admin. Ongoing admin management
        // is a normal in-tenant-portal feature for a later phase, not
        // this one-time bootstrap action.
        const existingAdminCount = await tenantUserService.countAdmins(tenantPool);
        if (existingAdminCount > 0) {
            return res.status(409).json({
                success: false,
                message: "This company already has an administrator.",
            });
        }

        const passwordHash = await bcrypt.hash(passwordRaw, 12);

        let admin;
        try {
            admin = await tenantUserService.createFirstAdmin(tenantPool, {
                name: nameRaw,
                email: emailRaw,
                phone: phoneRaw || null,
                passwordHash,
            });
        } catch (createError) {
            if (createError.code === "TENANT_EMAIL_TAKEN") {
                return res.status(409).json({
                    success: false,
                    message: "A user with this email already exists in this tenant.",
                });
            }
            throw createError;
        }

        return res.status(201).json({
            success: true,
            admin: {
                id: admin.id,
                employeeId: admin.employeeId,
                fullName: admin.fullName,
                email: admin.email,
                phone: admin.phone,
                role: admin.role,
                systemAccess: admin.systemAccess,
                status: admin.status,
            },
        });

    } catch (error) {
        console.error("[platform] createFirstAdmin failed:", error);
        return res.status(500).json({ success: false, message: "Failed to create the company admin." });
    }

};

// ==========================================
// COMPANY MANAGEMENT (Phase 4 -- Platform Owner Dashboard)
//
// Everything below reads/writes groworgs_platform_db.companies ONLY.
// getCompanyDetails is the one exception that ALSO touches a tenant
// database -- and even then only to count admin rows (never list,
// never read employee/chat/file data), so the Platform Owner can see
// "has this company's first admin been created yet" without this
// becoming a window into tenant business data.
// ==========================================

const toSafeCompany = (row) => ({
    id: row.id,
    companyName: row.company_name,
    companySlug: row.company_slug,
    status: row.status,
    accessType: row.access_type,
    tenantDbName: row.tenant_db_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    subscription: {
        planId: row.plan_id,
        subscriptionStatus: row.subscription_status,
        trialEndsAt: row.trial_ends_at,
        subscriptionStartedAt: row.subscription_started_at,
        subscriptionExpiresAt: row.subscription_expires_at,
        accessAllowed: platformCompanyService.isCompanyAccessAllowed(row),
    },
});

const listCompanies = async (_req, res) => {
    try {
        const companies = await platformCompanyService.listCompanies();
        return res.status(200).json({
            success: true,
            companies: companies.map(toSafeCompany),
        });
    } catch (error) {
        console.error("[platform] listCompanies failed:", error);
        return res.status(500).json({ success: false, message: "Failed to load companies." });
    }
};

const getStats = async (_req, res) => {
    try {
        // Merged into the SAME existing /companies/stats response
        // (reused, not a new endpoint) -- Part 6 of the phase spec
        // explicitly prefers reusing existing APIs over adding new
        // ones for the Dashboard.
        const [stats, subscriptionStats] = await Promise.all([
            platformCompanyService.getCompanyStats(),
            platformCompanyService.getSubscriptionStats(),
        ]);
        return res.status(200).json({ success: true, stats, subscriptionStats });
    } catch (error) {
        console.error("[platform] getStats failed:", error);
        return res.status(500).json({ success: false, message: "Failed to load dashboard stats." });
    }
};

const getCompanyDetails = async (req, res) => {
    try {
        const companyId = Number(req.params.id);
        if (!Number.isInteger(companyId) || companyId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid company id." });
        }

        const company = await platformCompanyService.getCompanyById(companyId);
        if (!company) {
            return res.status(404).json({ success: false, message: "Company not found." });
        }

        // Best-effort only -- a pending (unprovisioned) company has no
        // tenant database yet, so "unknown" is the correct answer, not
        // an error. Never reads anything beyond a row count.
        let firstAdminCreated = null;
        if (company.status !== "pending") {
            try {
                const tenantPool = getTenantPoolForCompany(company);
                const adminCount = await tenantUserService.countAdmins(tenantPool);
                firstAdminCreated = adminCount > 0;
            } catch (_resolveError) {
                firstAdminCreated = null;
            }
        }

        // Best-effort plan name for display -- a company with no
        // plan_id yet (shouldn't happen post-migration, but defensive)
        // simply shows no plan name rather than erroring the page.
        let planName = null;
        if (company.plan_id) {
            const plan = await subscriptionPlanService.getPlanById(company.plan_id);
            planName = plan ? plan.name : null;
        }

        const safeCompany = toSafeCompany(company);
        safeCompany.subscription.planName = planName;

        return res.status(200).json({
            success: true,
            company: { ...safeCompany, firstAdminCreated },
        });
    } catch (error) {
        console.error("[platform] getCompanyDetails failed:", error);
        return res.status(500).json({ success: false, message: "Failed to load company details." });
    }
};

const VALID_STATUS_ACTIONS = ["suspend", "reactivate"];

const updateStatus = async (req, res) => {
    try {
        const companyId = Number(req.params.id);
        if (!Number.isInteger(companyId) || companyId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid company id." });
        }

        // Only an explicit action verb is accepted -- never a raw
        // target status string -- so the client can never request an
        // arbitrary/invented status value (e.g. "pending", "deleted").
        const action = req.body?.action;
        if (!VALID_STATUS_ACTIONS.includes(action)) {
            return res.status(400).json({
                success: false,
                message: `action must be one of: ${VALID_STATUS_ACTIONS.join(", ")}.`,
            });
        }

        const updated = action === "suspend"
            ? await platformCompanyService.suspendCompany(companyId)
            : await platformCompanyService.reactivateCompany(companyId);

        if (!updated) {
            return res.status(409).json({
                success: false,
                message: action === "suspend"
                    ? "Company could not be suspended (it may not exist or is not currently active)."
                    : "Company could not be reactivated (it may not exist or is not currently suspended).",
            });
        }

        return res.status(200).json({ success: true, company: toSafeCompany(updated) });
    } catch (error) {
        console.error("[platform] updateStatus failed:", error);
        return res.status(500).json({ success: false, message: "Failed to update company status." });
    }
};

const updateAccessType = async (req, res) => {
    try {
        const companyId = Number(req.params.id);
        if (!Number.isInteger(companyId) || companyId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid company id." });
        }

        const accessType = req.body?.accessType;
        if (!VALID_ACCESS_TYPES.includes(accessType)) {
            return res.status(400).json({
                success: false,
                message: `accessType must be one of: ${VALID_ACCESS_TYPES.join(", ")}.`,
            });
        }

        const updated = await platformCompanyService.updateCompanyAccessType(companyId, accessType);

        if (!updated) {
            return res.status(409).json({
                success: false,
                message: "Access type could not be updated (company may not exist or is still pending provisioning).",
            });
        }

        return res.status(200).json({ success: true, company: toSafeCompany(updated) });
    } catch (error) {
        console.error("[platform] updateAccessType failed:", error);
        return res.status(500).json({ success: false, message: "Failed to update access type." });
    }
};

// ==========================================
// COMPANY SUBSCRIPTION MANAGEMENT (Phase 8)
//
// PATCH /api/platform/companies/:id/subscription -- assigns/changes a
// company's plan and subscription metadata only. Never touches
// tenant_db_name, never recreates or drops a tenant database, never
// reaches into any tenant database's own tables -- it is a pure
// metadata write against this one companies row, exactly like
// updateAccessType above.
//
// VALID_SUBSCRIPTION_STATUSES intentionally mirrors the enum defined
// in the companies table itself (see _migrate_add_subscriptions.js) --
// a client can never request an arbitrary/invented status string.
// ==========================================

const VALID_SUBSCRIPTION_STATUSES = ["active", "trial", "expired", "cancelled"];

// Accepts either a null/undefined (no date set) or a value that
// parses to a valid Date -- rejects garbage strings before they ever
// reach a query. Returns a MySQL-friendly value (Date object,
// mysql2 handles the conversion) or null.
const parseOptionalDate = (value, fieldName) => {
    if (value === undefined || value === null || value === "") {
        return { value: null };
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return { error: `${fieldName} must be a valid date, or omitted.` };
    }
    return { value: date };
};

const updateSubscription = async (req, res) => {
    try {
        const companyId = Number(req.params.id);
        if (!Number.isInteger(companyId) || companyId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid company id." });
        }

        const planIdRaw = req.body?.planId;
        const planId = Number(planIdRaw);
        if (!Number.isInteger(planId) || planId <= 0) {
            return res.status(400).json({ success: false, message: "A valid planId is required." });
        }

        const subscriptionStatus = req.body?.subscriptionStatus;
        if (!VALID_SUBSCRIPTION_STATUSES.includes(subscriptionStatus)) {
            return res.status(400).json({
                success: false,
                message: `subscriptionStatus must be one of: ${VALID_SUBSCRIPTION_STATUSES.join(", ")}.`,
            });
        }

        const trialEndsAtResult = parseOptionalDate(req.body?.trialEndsAt, "trialEndsAt");
        if (trialEndsAtResult.error) {
            return res.status(400).json({ success: false, message: trialEndsAtResult.error });
        }

        const subscriptionExpiresAtResult = parseOptionalDate(req.body?.subscriptionExpiresAt, "subscriptionExpiresAt");
        if (subscriptionExpiresAtResult.error) {
            return res.status(400).json({ success: false, message: subscriptionExpiresAtResult.error });
        }

        const existingCompany = await platformCompanyService.getCompanyById(companyId);
        if (!existingCompany) {
            return res.status(404).json({ success: false, message: "Company not found." });
        }

        const plan = await subscriptionPlanService.getPlanById(planId);
        if (!plan) {
            return res.status(400).json({ success: false, message: "Invalid plan id." });
        }

        // Security requirement G: a disabled plan cannot be newly
        // assigned. The one deliberate, documented exception -- kept
        // narrow on purpose -- is a company that is ALREADY on this
        // plan: that lets a Platform Owner still edit that company's
        // subscription status/dates after the plan itself was later
        // disabled, without being forced to switch plans first.
        if (plan.status !== "active" && existingCompany.plan_id !== plan.id) {
            return res.status(400).json({
                success: false,
                message: "This plan is disabled and cannot be newly assigned to a company.",
            });
        }

        const updated = await platformCompanyService.updateCompanySubscription(companyId, {
            planId: plan.id,
            subscriptionStatus,
            trialEndsAt: trialEndsAtResult.value,
            subscriptionExpiresAt: subscriptionExpiresAtResult.value,
        });

        if (!updated) {
            return res.status(409).json({
                success: false,
                message: "Subscription could not be updated (company may not exist or is still pending provisioning).",
            });
        }

        const safeCompany = toSafeCompany(updated);
        safeCompany.subscription.planName = plan.name;

        return res.status(200).json({ success: true, company: safeCompany });
    } catch (error) {
        console.error("[platform] updateSubscription failed:", error);
        return res.status(500).json({ success: false, message: "Failed to update subscription." });
    }
};

module.exports = {
    createCompany,
    createFirstAdmin,
    listCompanies,
    getStats,
    getCompanyDetails,
    updateStatus,
    updateAccessType,
    updateSubscription,
};
