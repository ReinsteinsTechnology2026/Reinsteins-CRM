const bcrypt = require("bcrypt");

const platformCompanyService = require("../services/platformCompanyService");
const subscriptionPlanService = require("../services/subscriptionPlanService");
const tenantProvisioningService = require("../services/tenantProvisioningService");
const tenantUserService = require("../services/tenantUserService");
const demoRequestService = require("../services/demoRequestService");
const paymentService = require("../services/paymentService");
const platformAuditService = require("../services/platformAuditService");
const subscriptionHistoryService = require("../services/subscriptionHistoryService");
const emailDeliveryService = require("../services/emailDeliveryService");
const { getTenantPoolForCompany } = require("../config/tenantConnectionManager");
const { isValidSlug, buildTenantDbName } = require("../utils/tenantDbName");
const { __LEGACY_COMPANY_SLUG: LEGACY_COMPANY_SLUG } = require("../config/db");

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

        await platformAuditService.logAction({
            platformUserId: req.platformUser.id,
            actionType: "company_created",
            targetType: "company",
            targetId: activated.id,
            companyId: activated.id,
            metadata: { companyName: activated.company_name, companySlug: activated.company_slug, accessType: activated.access_type },
        }).catch((auditError) => console.error("[platform] audit log failed (company_created):", auditError.message));

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
    billingContact: {
        name: row.billing_contact_name,
        email: row.billing_contact_email,
        phone: row.billing_contact_phone,
    },
    subscription: {
        planId: row.plan_id,
        subscriptionStatus: row.subscription_status,
        trialEndsAt: row.trial_ends_at,
        subscriptionStartedAt: row.subscription_started_at,
        subscriptionExpiresAt: row.subscription_expires_at,
        gracePeriodEndsAt: row.grace_period_ends_at,
        accessAllowed: platformCompanyService.isCompanyAccessAllowed(row),
    },
});

// Best-effort headcount for one company -- same boundary as
// getCompanyDetails' firstAdminCreated above: only ever a COUNT
// against the tenant's own `users` table, never a row list, never any
// other tenant table. Returns null (not an error) for a company with
// no usable tenant connection yet (still 'pending', or a resolution
// failure) so callers can distinguish "unknown" from "zero".
const getEmployeeCountForCompany = async (company) => {
    if (company.status === "pending") return null;
    try {
        const tenantPool = getTenantPoolForCompany(company);
        const { total, employees } = await tenantUserService.countUsersByRole(tenantPool);
        return { total, employees };
    } catch (_resolveError) {
        return null;
    }
};

// One query for every plan, reused as an id -> plan lookup map so
// listCompanies/getStats never run a plan query per company (which
// would turn an 11-company list into 11+ extra round trips for a
// field this cheap to batch once).
const getPlanMap = async () => {
    const plans = await subscriptionPlanService.listPlans();
    const map = new Map();
    for (const plan of plans) map.set(plan.id, plan);
    return map;
};

const listCompanies = async (req, res) => {
    try {
        const [companies, planMap] = await Promise.all([
            platformCompanyService.listCompanies(),
            getPlanMap(),
        ]);

        // Optional, best-effort admin-email lookup -- ONLY performed
        // when the caller explicitly asks for it (?includeAdmin=1),
        // since it costs one extra tenant-DB query per company and
        // the plain company list (used by every other page) doesn't
        // need it. Only the Companies page's search-by-admin-email
        // feature passes this flag.
        const includeAdmin = req.query?.includeAdmin === "1";

        const withExtras = await Promise.all(
            companies.map(async (row) => {
                const counts = await getEmployeeCountForCompany(row);
                const plan = row.plan_id ? planMap.get(row.plan_id) : null;
                const safe = toSafeCompany(row);
                safe.subscription.planName = plan ? plan.name : null;

                let adminEmail = null;
                if (includeAdmin && row.status !== "pending") {
                    try {
                        const tenantPool = getTenantPoolForCompany(row);
                        const admin = await tenantUserService.getFirstAdmin(tenantPool);
                        adminEmail = admin?.email || null;
                    } catch (_e) {
                        adminEmail = null;
                    }
                }

                return { ...safe, employeeCount: counts?.total ?? null, adminEmail };
            })
        );

        return res.status(200).json({
            success: true,
            companies: withExtras,
        });
    } catch (error) {
        console.error("[platform] listCompanies failed:", error);
        return res.status(500).json({ success: false, message: "Failed to load companies." });
    }
};

// ==========================================
// DASHBOARD AGGREGATES: attention-required + recent activity
//
// Both are built ENTIRELY from data this codebase already stores --
// no invented metrics, no new table for either. See each helper's own
// comment for exactly which real column(s) it reads.
// ==========================================

// Companies whose access is currently blocked by their SUBSCRIPTION
// (not by platform suspension, which already has its own "Suspended
// Companies" stat card) -- reuses the exact same
// isCompanyAccessAllowed() logic that already gates real tenant
// login, so this list can never disagree with what actually happens
// when that company's users try to sign in.
const getExpiredSubscriptionCompanies = (companies) =>
    companies
        .filter((c) => c.status === "active" && !platformCompanyService.isCompanyAccessAllowed(c))
        .map((c) => ({ id: c.id, companyName: c.company_name, companySlug: c.company_slug }));

// A 'pending' row that has been sitting for more than 15 minutes is
// not "mid-creation" anymore -- the creation saga (createCompany)
// completes synchronously within one request; a row still pending
// this long means step 2 or 3 of that saga was interrupted (server
// restart, crash) and needs manual follow-up. 15 minutes is generous
// slack above the seconds a real provisioning call takes.
const STALE_PENDING_MS = 15 * 60 * 1000;
const getStalePendingCompanies = (companies) =>
    companies
        .filter((c) => c.status === "pending" && (Date.now() - new Date(c.created_at).getTime()) > STALE_PENDING_MS)
        .map((c) => ({ id: c.id, companyName: c.company_name, companySlug: c.company_slug }));

// Phase 10F: companies whose trial or paid subscription is still
// currently valid (isCompanyAccessAllowed() is true -- this is
// deliberately the OPPOSITE set from getExpiredSubscriptionCompanies
// above, never overlapping with it) but will lapse within the next 7
// days. Purely a computed DISPLAY signal for the Platform Owner --
// it changes nothing about actual access enforcement, which still
// runs exactly the same isCompanyAccessAllowed() check it always has
// at tenant login/tenantProtect/Socket.IO auth/file access.
const EXPIRING_SOON_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const getExpiringSoonCompanies = (companies) =>
    companies
        .filter((c) => {
            if (c.status !== "active" || !platformCompanyService.isCompanyAccessAllowed(c)) return false;
            const relevantDate = c.subscription_status === "trial" ? c.trial_ends_at : c.subscription_expires_at;
            if (!relevantDate) return false;
            const msUntil = new Date(relevantDate).getTime() - Date.now();
            return msUntil > 0 && msUntil <= EXPIRING_SOON_WINDOW_MS;
        })
        .map((c) => ({
            id: c.id,
            companyName: c.company_name,
            companySlug: c.company_slug,
            expiresAt: c.subscription_status === "trial" ? c.trial_ends_at : c.subscription_expires_at,
        }));

// Phase 12O -- companies currently in a grace period (see
// subscriptionLifecycleService.processGracePeriodStart). Computed
// live from grace_period_ends_at directly, not from any sweep-run
// cache, so this is always accurate regardless of when the sweep last
// ran.
const getGracePeriodCompanies = (companies) =>
    companies
        .filter((c) => c.status === "active" && c.grace_period_ends_at && new Date(c.grace_period_ends_at) >= new Date())
        .map((c) => ({ id: c.id, companyName: c.company_name, companySlug: c.company_slug, gracePeriodEndsAt: c.grace_period_ends_at }));

// Only meaningful for a company whose plan actually sets a limit
// (employee_limit IS NOT NULL) -- an unlimited plan can never
// "approach" a limit that doesn't exist. 80% is a common, simple
// early-warning threshold; not configurable yet.
const APPROACHING_LIMIT_RATIO = 0.8;
const getApproachingEmployeeLimitCompanies = (companies, planMap, employeeCounts) =>
    companies
        .map((c, i) => {
            const plan = c.plan_id ? planMap.get(c.plan_id) : null;
            const limit = plan?.employee_limit;
            const count = employeeCounts[i]?.total;
            if (c.status !== "active" || !limit || count === undefined || count === null) return null;
            if (count < limit * APPROACHING_LIMIT_RATIO) return null;
            return { id: c.id, companyName: c.company_name, companySlug: c.company_slug, employeeCount: count, employeeLimit: limit };
        })
        .filter(Boolean);

// Two REAL, unambiguous event types only -- both read directly off an
// existing created_at column. Deliberately does NOT attempt to show
// "company suspended"/"subscription changed"/etc: those would have to
// be inferred from `updated_at`, which changes for many different
// reasons and can't be labeled correctly without an actual audit-log
// table (which does not exist -- see the Phase-11 report for why one
// wasn't added this phase). Showing a guessed label would violate the
// "no fake activity" requirement, so those event types are simply
// left out rather than faked.
const getRecentActivity = (companies, recentDemoRequests) => {
    const events = [
        ...companies.map((c) => ({
            type: "company_created",
            at: c.created_at,
            companyId: c.id,
            companyName: c.company_name,
            companySlug: c.company_slug,
        })),
        ...recentDemoRequests.map((d) => ({
            type: "demo_request_received",
            at: d.created_at,
            demoRequestId: d.id,
            companyName: d.company_name,
            requesterName: d.name,
        })),
    ];
    events.sort((a, b) => new Date(b.at) - new Date(a.at));
    return events.slice(0, 8);
};

const getStats = async (req, res) => {
    try {
        // Merged into the SAME existing /companies/stats response
        // (reused, not a new endpoint) -- Part 6 of the Phase 8 spec
        // explicitly preferred reusing existing APIs over adding new
        // ones for the Dashboard, and this phase follows the same
        // convention for every new aggregate below.
        const [stats, subscriptionStats, companies, planMap, demoRequests, paymentStats] = await Promise.all([
            platformCompanyService.getCompanyStats(),
            platformCompanyService.getSubscriptionStats(),
            platformCompanyService.listCompanies(),
            getPlanMap(),
            demoRequestService.listDemoRequests(),
            paymentService.getPaymentStats(),
        ]);

        // Sums real per-tenant COUNTs -- never fabricated, never a
        // cross-tenant row list. A company whose tenant connection
        // can't be resolved right now simply contributes 0 rather
        // than failing the whole dashboard.
        const employeeCounts = await Promise.all(companies.map(getEmployeeCountForCompany));
        const totalUsers = employeeCounts.reduce((sum, c) => sum + (c?.total ?? 0), 0);
        const totalEmployees = employeeCounts.reduce((sum, c) => sum + (c?.employees ?? 0), 0);

        // "New Users This Month" -- real COUNT(created_at >= start of
        // month) per tenant, summed. Companies still 'pending' (no
        // tenant DB yet) simply contribute 0.
        const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        const newUserCounts = await Promise.all(companies.map(async (c) => {
            if (c.status === "pending") return 0;
            try {
                const tenantPool = getTenantPoolForCompany(c);
                return await tenantUserService.countUsersSince(tenantPool, startOfMonth);
            } catch (_e) {
                return 0;
            }
        }));
        const newUsersThisMonth = newUserCounts.reduce((sum, n) => sum + n, 0);

        const newDemoRequestCount = demoRequests.filter((d) => d.status === "new").length;

        // Phase 12O -- real failed payments only, newest first, capped
        // to a short list (this is a dashboard attention widget, not a
        // full payment browser -- /owner/payments already covers that).
        const failedPayments = await paymentService.listPayments({ status: "failed", sortBy: "newest" });

        // Phase 13N -- same pattern for failed lifecycle emails, capped
        // to 10 by emailDeliveryService.getFailedEmailSummary itself.
        const failedEmails = await emailDeliveryService.getFailedEmailSummary();

        const attentionRequired = {
            newDemoRequests: newDemoRequestCount,
            expiredSubscriptions: getExpiredSubscriptionCompanies(companies),
            stalePendingProvisioning: getStalePendingCompanies(companies),
            approachingEmployeeLimit: getApproachingEmployeeLimitCompanies(companies, planMap, employeeCounts),
            expiringSoon: getExpiringSoonCompanies(companies),
            gracePeriod: getGracePeriodCompanies(companies),
            failedPayments: failedPayments.slice(0, 10).map((p) => ({
                id: p.id, companyId: p.company_id, companyName: p.company_name, companySlug: p.company_slug,
                amount: Number(p.amount), currency: p.currency,
            })),
            failedEmails: failedEmails.map((e) => ({
                id: e.id, companyId: e.company_id, companyName: e.company_name, companySlug: e.company_slug,
                emailType: e.email_type, retryCount: e.retry_count,
            })),
        };

        const recentActivity = getRecentActivity(companies, demoRequests.slice(0, 5));

        const recentCompanies = companies.slice(0, 5).map((c) => {
            const safe = toSafeCompany(c);
            const plan = c.plan_id ? planMap.get(c.plan_id) : null;
            safe.subscription.planName = plan ? plan.name : null;
            return safe;
        });

        return res.status(200).json({
            success: true,
            stats,
            subscriptionStats,
            platformStats: { totalUsers, totalEmployees, newUsersThisMonth },
            attentionRequired,
            recentActivity,
            recentCompanies,
            paymentStats,
        });
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

        // Best-effort plan name + pricing for display -- a company
        // with no plan_id yet (shouldn't happen post-migration, but
        // defensive) simply shows no plan info rather than erroring
        // the page.
        let plan = null;
        if (company.plan_id) {
            plan = await subscriptionPlanService.getPlanById(company.plan_id);
        }

        // Admin display info (name + email ONLY, never a password or
        // full profile) -- same tenant-DB boundary as firstAdminCreated
        // above, just returning the two fields instead of a boolean.
        let adminName = null;
        let adminEmail = null;
        let newUsersThisMonth = null;
        if (company.status !== "pending") {
            try {
                const tenantPool = getTenantPoolForCompany(company);
                const admin = await tenantUserService.getFirstAdmin(tenantPool);
                adminName = admin?.full_name || null;
                adminEmail = admin?.email || null;
                const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
                newUsersThisMonth = await tenantUserService.countUsersSince(tenantPool, startOfMonth);
            } catch (_resolveError) {
                // leaves all three null -- "unknown", not an error
            }
        }

        const employeeCounts = await getEmployeeCountForCompany(company);

        const safeCompany = toSafeCompany(company);
        safeCompany.subscription.planName = plan ? plan.name : null;
        safeCompany.subscription.planEmployeeLimit = plan ? plan.employee_limit : null;
        safeCompany.subscription.planStorageLimitMb = plan ? plan.storage_limit_mb : null;
        safeCompany.subscription.planMonthlyPrice = plan?.monthly_price === undefined || plan?.monthly_price === null ? null : Number(plan.monthly_price);
        safeCompany.subscription.planYearlyPrice = plan?.yearly_price === undefined || plan?.yearly_price === null ? null : Number(plan.yearly_price);

        return res.status(200).json({
            success: true,
            company: {
                ...safeCompany,
                firstAdminCreated,
                employeeCount: employeeCounts?.total ?? null,
                adminName,
                adminEmail,
                newUsersThisMonth,
            },
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

        await platformAuditService.logAction({
            platformUserId: req.platformUser.id,
            actionType: action === "suspend" ? "company_suspended" : "company_reactivated",
            targetType: "company",
            targetId: updated.id,
            companyId: updated.id,
            metadata: { companyName: updated.company_name },
        }).catch((auditError) => console.error("[platform] audit log failed (company status):", auditError.message));

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

        // Phase 10E: auto-calculate trial_ends_at from the plan's own
        // trial_duration_days -- but ONLY when the caller didn't send
        // trialEndsAt at all (the key is genuinely absent from the
        // request body, not merely null/empty). This is what "do not
        // overwrite dates unnecessarily" means in practice: the
        // existing Company Details UI always sends an explicit value
        // (a date string, or null to clear it) and is completely
        // unaffected by this; only a caller that omits the field
        // entirely -- e.g. a future "start trial" quick-action -- gets
        // the plan's default trial length applied automatically.
        let trialEndsAt = trialEndsAtResult.value;
        if (subscriptionStatus === "trial" && req.body?.trialEndsAt === undefined && plan.trial_duration_days) {
            trialEndsAt = new Date(Date.now() + plan.trial_duration_days * 24 * 60 * 60 * 1000);
        }

        const updated = await platformCompanyService.updateCompanySubscription(companyId, {
            planId: plan.id,
            subscriptionStatus,
            trialEndsAt,
            subscriptionExpiresAt: subscriptionExpiresAtResult.value,
        });

        if (!updated) {
            return res.status(409).json({
                success: false,
                message: "Subscription could not be updated (company may not exist or is still pending provisioning).",
            });
        }

        // Phase 12A -- log a REAL lifecycle event for this manual
        // change, derived purely from the before/after states this
        // request actually produced (never invented/backfilled). At
        // most one event per status-shape change; a same-status
        // plan-only change logs 'plan_changed' instead.
        let finalCompany = updated;
        try {
            const prevStatus = existingCompany.subscription_status;
            const newStatusValue = updated.subscription_status;
            let eventType = null;
            if (prevStatus !== "trial" && newStatusValue === "trial") eventType = "trial_started";
            else if ((prevStatus === "cancelled" || prevStatus === "expired") && newStatusValue === "active") eventType = "subscription_reactivated";
            else if (prevStatus !== "active" && newStatusValue === "active") eventType = "subscription_activated";
            else if (prevStatus !== "cancelled" && newStatusValue === "cancelled") eventType = "subscription_cancelled";
            else if (existingCompany.plan_id !== updated.plan_id) eventType = "plan_changed";

            if (eventType) {
                await subscriptionHistoryService.logEvent({
                    companyId, planId: updated.plan_id, eventType,
                    previousStatus: prevStatus, newStatus: newStatusValue,
                    previousPlanId: existingCompany.plan_id, newPlanId: updated.plan_id,
                    effectiveAt: new Date(), source: "manual",
                    notes: `Changed by Platform Owner (${req.platformUser.email}).`,
                });
            }

            // A manual move to 'active' supersedes any lingering grace
            // period the same way a verified renewal payment does (see
            // subscriptionLifecycleService.processRenewalSuccess) -- a
            // stale grace_period_ends_at is otherwise harmless (it's
            // only ever consulted once subscription_expires_at is
            // ALREADY in the past), but clearing it keeps the stored
            // data honest rather than leaving a dangling old value.
            if (newStatusValue === "active" && existingCompany.grace_period_ends_at) {
                finalCompany = await platformCompanyService.setGracePeriodEndsAt(companyId, null) || updated;
                await subscriptionHistoryService.logEvent({
                    companyId, planId: updated.plan_id, eventType: "grace_period_ended",
                    previousStatus: "active", newStatus: "active", effectiveAt: new Date(), source: "manual",
                    notes: "Cleared by a manual subscription update.",
                });
            }
        } catch (historyError) {
            console.error("[platform] subscription_history logging failed:", historyError.message);
        }

        await platformAuditService.logAction({
            platformUserId: req.platformUser.id,
            actionType: "subscription_changed",
            targetType: "company",
            targetId: companyId,
            companyId,
            metadata: {
                previousStatus: existingCompany.subscription_status, newStatus: updated.subscription_status,
                previousPlanId: existingCompany.plan_id, newPlanId: updated.plan_id,
            },
        }).catch((auditError) => console.error("[platform] audit log failed (subscription_changed):", auditError.message));

        const safeCompany = toSafeCompany(finalCompany);
        safeCompany.subscription.planName = plan.name;

        return res.status(200).json({ success: true, company: safeCompany });
    } catch (error) {
        console.error("[platform] updateSubscription failed:", error);
        return res.status(500).json({ success: false, message: "Failed to update subscription." });
    }
};

// ==========================================
// BILLING CONTACT (Phase 13A/13B)
//
// Platform-level SaaS metadata only -- companies.billing_contact_*.
// Never touches any tenant database or tenant employee data. This is
// the recipient emailDeliveryService.resolveRecipient() prefers over
// the tenant's first Admin (see that file's module header for the
// full priority order).
// ==========================================

const BILLING_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const updateBillingContact = async (req, res) => {
    try {
        const companyId = Number(req.params.id);
        if (!Number.isInteger(companyId) || companyId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid company id." });
        }

        const nameRaw = req.body?.name;
        const emailRaw = req.body?.email;
        const phoneRaw = req.body?.phone;

        if (typeof emailRaw !== "string" || !BILLING_EMAIL_PATTERN.test(emailRaw.trim())) {
            return res.status(400).json({ success: false, message: "A valid billing contact email is required." });
        }
        if (nameRaw !== undefined && nameRaw !== null && (typeof nameRaw !== "string" || nameRaw.trim().length > 255)) {
            return res.status(400).json({ success: false, message: "Billing contact name must be 255 characters or fewer." });
        }
        if (phoneRaw !== undefined && phoneRaw !== null && phoneRaw !== "" && (typeof phoneRaw !== "string" || phoneRaw.trim().length > 30)) {
            return res.status(400).json({ success: false, message: "Billing contact phone must be 30 characters or fewer." });
        }

        const existingCompany = await platformCompanyService.getCompanyById(companyId);
        if (!existingCompany) {
            return res.status(404).json({ success: false, message: "Company not found." });
        }

        const updated = await platformCompanyService.updateBillingContact(companyId, {
            billingContactName: typeof nameRaw === "string" ? nameRaw.trim() : null,
            billingContactEmail: emailRaw.trim(),
            billingContactPhone: typeof phoneRaw === "string" && phoneRaw.trim() ? phoneRaw.trim() : null,
        });
        if (!updated) {
            return res.status(409).json({ success: false, message: "Billing contact could not be updated (company may not exist or is still pending provisioning)." });
        }

        await platformAuditService.logAction({
            platformUserId: req.platformUser.id, actionType: "billing_contact_updated", targetType: "company", targetId: companyId, companyId,
            metadata: { billingContactEmail: updated.billing_contact_email },
        }).catch((auditError) => console.error("[platform] audit log failed (billing_contact_updated):", auditError.message));

        return res.status(200).json({ success: true, company: toSafeCompany(updated) });
    } catch (error) {
        console.error("[platform] updateBillingContact failed:", error);
        return res.status(500).json({ success: false, message: "Failed to update billing contact." });
    }
};

const removeBillingContact = async (req, res) => {
    try {
        const companyId = Number(req.params.id);
        if (!Number.isInteger(companyId) || companyId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid company id." });
        }

        const existingCompany = await platformCompanyService.getCompanyById(companyId);
        if (!existingCompany) {
            return res.status(404).json({ success: false, message: "Company not found." });
        }

        const updated = await platformCompanyService.removeBillingContact(companyId);
        if (!updated) {
            return res.status(409).json({ success: false, message: "Billing contact could not be removed." });
        }

        await platformAuditService.logAction({
            platformUserId: req.platformUser.id, actionType: "billing_contact_removed", targetType: "company", targetId: companyId, companyId,
        }).catch((auditError) => console.error("[platform] audit log failed (billing_contact_removed):", auditError.message));

        return res.status(200).json({ success: true, company: toSafeCompany(updated) });
    } catch (error) {
        console.error("[platform] removeBillingContact failed:", error);
        return res.status(500).json({ success: false, message: "Failed to remove billing contact." });
    }
};

// ==========================================
// DELETE COMPANY (with confirmation)
//
// DELETE /api/platform/companies/:id -- permanently removes a
// company and drops its tenant database. This is the one genuinely
// destructive action in the whole Platform Owner surface, so it has
// three independent safeguards, not one:
//
//   1. Reinsteins can NEVER be deleted through this endpoint,
//      unconditionally, checked first and hardcoded -- not just
//      "protected by confirmation" like every other company.
//   2. The caller must echo the company's own slug back as
//      `confirmSlug` in the request body -- verified server-side
//      against the real row, never trusting a client-side "are you
//      sure?" dialog alone.
//   3. tenantProvisioningService.dropProvisionedDatabase() has its
//      own independent safe-name allowlist (see utils/tenantDbName.js
//      PROTECTED_DB_NAMES, which now explicitly includes
//      "tenant_reinsteins") -- so even a bug in (1)/(2) above would
//      still be caught at the database layer.
//
// Order matters: the tenant database is dropped BEFORE the companies
// row is deleted, so a failure partway through leaves the company row
// (and its accurate tenant_db_name) in place for manual follow-up,
// rather than an orphaned tenant database with no owning row.
// ==========================================

const deleteCompany = async (req, res) => {
    try {
        const companyId = Number(req.params.id);
        if (!Number.isInteger(companyId) || companyId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid company id." });
        }

        const company = await platformCompanyService.getCompanyById(companyId);
        if (!company) {
            return res.status(404).json({ success: false, message: "Company not found." });
        }

        if (company.company_slug === LEGACY_COMPANY_SLUG) {
            return res.status(403).json({ success: false, message: "This company cannot be deleted." });
        }

        const confirmSlug = req.body?.confirmSlug;
        if (typeof confirmSlug !== "string" || confirmSlug.trim().toLowerCase() !== company.company_slug) {
            return res.status(400).json({
                success: false,
                message: "Type the company's exact ID to confirm deletion.",
            });
        }

        if (company.tenant_db_name) {
            try {
                await tenantProvisioningService.dropProvisionedDatabase(company.tenant_db_name);
            } catch (dropError) {
                console.error(`[platform] deleteCompany: failed to drop tenant database for company id=${companyId}:`, dropError.message);
                return res.status(500).json({
                    success: false,
                    message: "Failed to remove the company's tenant database. The company was not deleted.",
                });
            }
        }

        let deleted;
        try {
            deleted = await platformCompanyService.deleteCompany(companyId);
        } catch (dbError) {
            // Phase 10: payments.company_id has ON DELETE RESTRICT
            // (see _migrate_add_payments.js) -- a company with real
            // payment history cannot be deleted through this endpoint.
            // The tenant database was ALREADY dropped above by this
            // point, but the companies row (and its accurate
            // tenant_db_name) is preserved, so this is reported
            // clearly rather than surfacing a raw foreign-key error --
            // financial records are never silently discarded.
            if (dbError.code === "23503") { // PostgreSQL foreign_key_violation (config/pgCompat.js runs against PostgreSQL)
                return res.status(409).json({
                    success: false,
                    message: "This company has payment records and cannot be deleted. Its tenant database has already been removed; contact support to fully archive this company.",
                });
            }
            throw dbError;
        }

        if (!deleted) {
            return res.status(409).json({
                success: false,
                message: "Company could not be deleted (it may already be pending provisioning only).",
            });
        }

        // company_id is intentionally NOT included here -- the company
        // row itself is now gone, and platform_audit_logs.company_id
        // is ON DELETE SET NULL specifically so this row survives the
        // FK regardless; the company's identity is preserved in
        // metadata instead.
        await platformAuditService.logAction({
            platformUserId: req.platformUser.id,
            actionType: "company_deleted",
            targetType: "company",
            targetId: companyId,
            metadata: { companyName: company.company_name, companySlug: company.company_slug },
        }).catch((auditError) => console.error("[platform] audit log failed (company_deleted):", auditError.message));

        return res.status(200).json({ success: true, message: "Company deleted." });
    } catch (error) {
        console.error("[platform] deleteCompany failed:", error);
        return res.status(500).json({ success: false, message: "Failed to delete company." });
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
    updateBillingContact,
    removeBillingContact,
    deleteCompany,
};
