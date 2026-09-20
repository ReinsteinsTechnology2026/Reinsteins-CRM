const platformPool = require("../config/platformDb");
const emailDomainService = require("./emailDomainService");
const { getEmailLimitsForPlan } = require("./emailPlanLimitsService");

// ==========================================
// MAILBOX SERVICE (Phase 16A)
//
// Same isolation discipline as emailDomainService.js: every read/
// write scoped to companyId in the query itself. Mailboxes live in
// the platform database (see schemas/platformSchema.postgresql.sql's
// "PHASE 16A" banner), but a mailbox's OWNER (tenant_user_id) lives in
// that company's own, physically separate tenant database -- there is
// no cross-database foreign key possible, so ownership is verified
// here, at write time, by actually querying the tenant's own pool.
// This mirrors the exact pattern tenantAuthMiddleware.js already uses
// for every request: never trust a client-supplied id, resolve it
// fresh from the authenticated source.
// ==========================================

const LOCAL_PART_PATTERN = /^[a-z0-9._-]{1,64}$/;

const MAILBOX_COLUMNS = `
    id, company_id, domain_id, tenant_user_id, email_address,
    mailbox_provider_id, provisioning_status, status, quota_mb,
    created_at, updated_at
`;

function normalizeLocalPart(rawLocalPart) {
    return String(rawLocalPart || "").trim().toLowerCase();
}

// ------------------------------------------
// Verifies the given tenant_user_id is a REAL, currently-active
// employee of THIS company -- queried fresh from that company's own
// tenant pool, never inferred from anything the client sent about who
// they are. `tenantPool` is passed in by the controller, already
// resolved for the authenticated request by tenantAuthMiddleware.js
// (the same pool tenantProtect attaches as req.tenantDb) -- this
// function never resolves its own pool from a client-supplied
// company/slug, which is what makes it safe against a forged
// tenant_user_id from a different company: even a valid employee id
// belonging to COMPANY B, submitted by an authenticated user of
// COMPANY A, simply won't exist in COMPANY A's own tenant pool.
// ------------------------------------------

async function getTenantEmployee(tenantPool, tenantUserId) {
    const [rows] = await tenantPool.query(
        `SELECT id, full_name, email, status, employment_status, role
         FROM users WHERE id = ? LIMIT 1`,
        [tenantUserId]
    );
    return rows[0] || null;
}

// ------------------------------------------
// CREATE
// ------------------------------------------

const createMailbox = async ({ companyId, planId, tenantPool, domainId, tenantUserId, localPart }) => {

    const cleanLocalPart = normalizeLocalPart(localPart);

    if (!LOCAL_PART_PATTERN.test(cleanLocalPart)) {
        const error = new Error("Enter a valid mailbox name (letters, numbers, dots, hyphens, underscores only).");
        error.code = "MAILBOX_INVALID_LOCAL_PART";
        throw error;
    }

    // 1. Domain must belong to THIS company and be verified -- a
    // mailbox can never be created on an unverified or foreign domain
    // (Phase 16A Step 8/9).
    const domain = await emailDomainService.getDomainForCompany(domainId, companyId);
    if (!domain) {
        const error = new Error("Domain not found.");
        error.code = "DOMAIN_NOT_FOUND";
        throw error;
    }
    if (domain.verification_status !== "verified") {
        const error = new Error("This domain has not been verified yet. Verify domain ownership before creating mailboxes on it.");
        error.code = "DOMAIN_NOT_VERIFIED";
        throw error;
    }
    if (domain.status !== "active") {
        const error = new Error("This domain is disabled.");
        error.code = "DOMAIN_DISABLED";
        throw error;
    }

    // 2. The employee must be real, active, and belong to THIS
    // company's own tenant database -- see getTenantEmployee's header
    // comment for why this is the actual cross-tenant defense here.
    const employee = await getTenantEmployee(tenantPool, tenantUserId);
    if (!employee) {
        const error = new Error("Employee not found in this company.");
        error.code = "EMPLOYEE_NOT_FOUND";
        throw error;
    }
    if (employee.status !== "active" || (employee.employment_status && employee.employment_status !== "active")) {
        const error = new Error("Cannot create a mailbox for an inactive employee.");
        error.code = "EMPLOYEE_NOT_ACTIVE";
        throw error;
    }

    // 3. Plan limit.
    const { maxMailboxes } = await getEmailLimitsForPlan(planId);
    const [[{ existingCount }]] = await platformPool.query(
        `SELECT COUNT(*) AS "existingCount" FROM mailboxes WHERE company_id = ?`,
        [companyId]
    );
    if (Number(existingCount) >= maxMailboxes) {
        const error = new Error(`This plan allows up to ${maxMailboxes} mailbox(es). Upgrade your plan to add more.`);
        error.code = "MAILBOX_LIMIT_REACHED";
        throw error;
    }

    const emailAddress = `${cleanLocalPart}@${domain.domain}`;

    try {

        const [result] = await platformPool.query(
            `INSERT INTO mailboxes (company_id, domain_id, tenant_user_id, email_address, provisioning_status, status)
             VALUES (?, ?, ?, ?, 'pending_infrastructure', 'active')
             RETURNING ${MAILBOX_COLUMNS}`,
            [companyId, domainId, tenantUserId, emailAddress]
        );

        return { ...result[0], employeeName: employee.full_name };

    } catch (dbError) {
        if (dbError.code === "23505") {
            const error = new Error("This mailbox address is already taken.");
            error.code = "MAILBOX_ADDRESS_TAKEN";
            throw error;
        }
        throw dbError;
    }

};

// ------------------------------------------
// READ
// ------------------------------------------

const listMailboxesForCompany = async (companyId) => {
    const [rows] = await platformPool.query(
        `SELECT ${MAILBOX_COLUMNS} FROM mailboxes WHERE company_id = ? ORDER BY created_at DESC`,
        [companyId]
    );
    return rows;
};

const getMailboxForCompany = async (mailboxId, companyId) => {
    const [rows] = await platformPool.query(
        `SELECT ${MAILBOX_COLUMNS} FROM mailboxes WHERE id = ? AND company_id = ? LIMIT 1`,
        [mailboxId, companyId]
    );
    return rows[0] || null;
};

// The self-service lookup an employee uses to find their OWN mailbox
// -- scoped to BOTH companyId and tenant_user_id, so one employee can
// never address another employee's mailbox by guessing its id (Phase
// 16A Step 12: "Company A guessing another mailbox ID").
const getOwnMailbox = async (companyId, tenantUserId) => {
    const [rows] = await platformPool.query(
        `SELECT ${MAILBOX_COLUMNS} FROM mailboxes WHERE company_id = ? AND tenant_user_id = ? LIMIT 1`,
        [companyId, tenantUserId]
    );
    return rows[0] || null;
};

// ------------------------------------------
// LIFECYCLE (Phase 16A Step 10) -- status transitions only, never a
// silent data-destroying side effect of an unrelated action (e.g.
// deactivating an employee elsewhere in the app does NOT cascade into
// this table on its own; a company admin must explicitly act here).
// ------------------------------------------

const setMailboxStatus = async (mailboxId, companyId, status) => {
    const [rows] = await platformPool.query(
        `UPDATE mailboxes SET status = ? WHERE id = ? AND company_id = ?
         RETURNING ${MAILBOX_COLUMNS}`,
        [status, mailboxId, companyId]
    );
    return rows[0] || null;
};

// Explicit admin action only (Step 10: "mailbox deleted only through
// explicit admin action") -- deletes the METADATA row. The real
// message store, once a mail server is connected, is that server's
// own responsibility/retention policy, not this table's.
const deleteMailbox = async (mailboxId, companyId) => {
    const [rows] = await platformPool.query(
        `DELETE FROM mailboxes WHERE id = ? AND company_id = ? RETURNING id`,
        [mailboxId, companyId]
    );
    return rows.length > 0;
};

module.exports = {
    normalizeLocalPart,
    createMailbox,
    listMailboxesForCompany,
    getMailboxForCompany,
    getOwnMailbox,
    setMailboxStatus,
    deleteMailbox,
};
