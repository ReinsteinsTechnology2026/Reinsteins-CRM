const bcrypt = require("bcrypt");

const platformCompanyService = require("../services/platformCompanyService");
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

module.exports = { createCompany, createFirstAdmin };
