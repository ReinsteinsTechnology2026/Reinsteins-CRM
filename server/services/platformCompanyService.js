const platformPool = require("../config/platformDb");

// ==========================================
// PLATFORM COMPANY SERVICE (Phase 2B)
//
// Pure DB logic against groworgs_platform_db.companies ONLY.
// Not called from anywhere yet -- no existing route, controller,
// or the tenant login flow imports this file. It exists so a
// later phase has a ready, tested lookup layer instead of
// writing raw queries inline when tenant resolution is actually
// wired up.
// ==========================================

const COMPANY_COLUMNS = `
    id, company_name, company_slug, status, access_type,
    plan_id, subscription_status, trial_ends_at, subscription_started_at,
    subscription_expires_at,
    tenant_db_name, created_at, updated_at
`;

const getCompanyBySlug = async (slug) => {
    const [rows] = await platformPool.query(
        `SELECT ${COMPANY_COLUMNS} FROM companies WHERE company_slug = ? LIMIT 1`,
        [slug]
    );
    return rows[0] || null;
};

const getCompanyById = async (id) => {
    const [rows] = await platformPool.query(
        `SELECT ${COMPANY_COLUMNS} FROM companies WHERE id = ? LIMIT 1`,
        [id]
    );
    return rows[0] || null;
};

// Convenience wrapper for the common "resolve a slug, but only if
// the company is actually usable" case -- returns null (not just
// an inactive row) when status isn't 'active', so a caller can
// treat "not found" and "found but suspended/pending" the same
// way if that's all it needs, or call getCompanyBySlug directly
// when it needs to distinguish the two.

const getActiveCompanyBySlug = async (slug) => {
    const company = await getCompanyBySlug(slug);
    return company && company.status === "active" ? company : null;
};

// ==========================================
// COMPANY CREATION / PROVISIONING LIFECYCLE (Phase 2D)
//
// These three functions are the only writes this service performs.
// Each is guarded so it can only ever act on the specific row/state
// it was written for -- none of them can affect the Reinsteins
// company row or any other already-active company.
// ==========================================

// Step 1 of company creation: reserve the slug as a 'pending' row
// with no tenant_db_name yet. The UNIQUE constraint on company_slug
// is the real concurrency guard (a race between two requests for the
// same slug); the existence check below just produces a clean error
// instead of a raw duplicate-key SQL error in the common case.
const createPendingCompany = async ({ companyName, companySlug, accessType }) => {

    const existing = await getCompanyBySlug(companySlug);

    if (existing) {
        const error = new Error("A company with this slug already exists.");
        error.code = "COMPANY_SLUG_TAKEN";
        throw error;
    }

    try {

        const [result] = await platformPool.query(
            `INSERT INTO companies (company_name, company_slug, status, access_type, tenant_db_name)
             VALUES (?, ?, 'pending', ?, NULL)
             RETURNING id`,
            [companyName, companySlug, accessType]
        );

        return await getCompanyById(result[0].id);

    } catch (dbError) {

        if (dbError.code === "23505") {
            const error = new Error("A company with this slug already exists.");
            error.code = "COMPANY_SLUG_TAKEN";
            throw error;
        }

        throw dbError;

    }

};

// Step 3 of company creation: transition pending -> active and
// record the now-provisioned tenant database name, as one guarded
// UPDATE. WHERE status = 'pending' means this can never reactivate,
// rename, or reassign the tenant DB of an already-active or
// suspended company -- it only ever completes the specific
// pending->active transition it was written for. Returns null (not
// an error) if no row matched, so the caller can tell "nothing
// happened" apart from a thrown exception.
const activateCompany = async (id, tenantDbName) => {
    const [result] = await platformPool.query(
        `UPDATE companies SET status = 'active', tenant_db_name = ?
         WHERE id = ? AND status = 'pending'`,
        [tenantDbName, id]
    );
    if (result.rowCount === 0) {
        return null;
    }
    return await getCompanyById(id);
};

// Compensation step, used ONLY when tenant DB provisioning fails
// immediately after createPendingCompany() inserted a row in this
// same request. Guarded to WHERE status = 'pending' AND
// tenant_db_name IS NULL, so this can never delete an active
// company or one that already has a real tenant database attached
// -- regardless of what id is passed in.
const deletePendingCompany = async (id) => {
    const [result] = await platformPool.query(
        `DELETE FROM companies WHERE id = ? AND status = 'pending' AND tenant_db_name IS NULL`,
        [id]
    );
    return result.rowCount > 0;
};

// ==========================================
// PLATFORM DASHBOARD / COMPANY MANAGEMENT (Phase 4)
//
// listCompanies / getCompanyStats are read-only and touch nothing
// but this same companies table -- no tenant database, no employee
// data, ever. suspendCompany / reactivateCompany / updateAccessType
// follow the exact same guarded-transition pattern as
// activateCompany above: each WHERE clause only ever matches the
// specific state transition it exists for, so none of them can act
// on a company that isn't in the expected starting state.
// ==========================================

const listCompanies = async () => {
    const [rows] = await platformPool.query(
        `SELECT ${COMPANY_COLUMNS} FROM companies ORDER BY created_at DESC`
    );
    return rows;
};

// Pure aggregation over the existing status/access_type enum columns
// -- no new schema, no invented fields. GROUP BY both columns in one
// query, then fold into flat counters the dashboard can render
// directly.
const getCompanyStats = async () => {
    const [rows] = await platformPool.query(
        `SELECT status, access_type, COUNT(*) AS c FROM companies GROUP BY status, access_type`
    );

    const stats = {
        total: 0,
        active: 0,
        suspended: 0,
        pending: 0,
        complimentary: 0,
        trial: 0,
        paid: 0,
    };

    for (const row of rows) {
        const count = Number(row.c);
        stats.total += count;
        stats[row.status] = (stats[row.status] || 0) + count;
        stats[row.access_type] = (stats[row.access_type] || 0) + count;
    }

    return stats;
};

// Guarded WHERE status = 'active' -- can only ever suspend a company
// that is currently active. A pending (not-yet-provisioned) or
// already-suspended company is untouched; returns null so the caller
// can distinguish "nothing happened" from a thrown error.
const suspendCompany = async (id) => {
    const [result] = await platformPool.query(
        `UPDATE companies SET status = 'suspended' WHERE id = ? AND status = 'active'`,
        [id]
    );
    if (result.rowCount === 0) {
        return null;
    }
    return await getCompanyById(id);
};

// Mirror of suspendCompany -- guarded WHERE status = 'suspended', so
// this can only ever reactivate a company this same function (or an
// operator) previously suspended, never a pending or already-active
// one.
const reactivateCompany = async (id) => {
    const [result] = await platformPool.query(
        `UPDATE companies SET status = 'active' WHERE id = ? AND status = 'suspended'`,
        [id]
    );
    if (result.rowCount === 0) {
        return null;
    }
    return await getCompanyById(id);
};

// access_type is a manual Platform Owner setting for now (no payment
// gateway yet) -- only meaningful for a company that has actually
// been provisioned (active or suspended), never a still-pending one.
const updateCompanyAccessType = async (id, accessType) => {
    const [result] = await platformPool.query(
        `UPDATE companies SET access_type = ? WHERE id = ? AND status IN ('active', 'suspended')`,
        [accessType, id]
    );
    if (result.rowCount === 0) {
        return null;
    }
    return await getCompanyById(id);
};

// ==========================================
// COMPANY STATUS CHECK FOUNDATION
// Pure, reusable helpers -- not enforced anywhere yet. A future
// phase's tenant-resolution middleware calls these instead of
// re-deriving the same status/access_type logic inline.
// ==========================================

const isCompanyUsable = (company) => Boolean(company) && company.status === "active";

const hasPaidAccess = (company) => Boolean(company) && company.access_type === "paid";

// ==========================================
// SUBSCRIPTION ENFORCEMENT (Phase 8)
//
// Pure function, no DB access -- called from the four existing places
// that already gate tenant access on `company.status === 'active'`
// (tenant login, tenantProtect middleware, Socket.IO auth, the
// authenticated file-serving route in app.js), extending each one's
// existing check rather than introducing a new central layer. This
// deliberately does NOT gate platformProtect/Platform Owner actions --
// a Platform Owner must always be able to manage an expired company
// (renew it, reassign its plan) regardless of that company's own
// subscription state.
//
// Dates are evaluated dynamically on every call (against `new Date()`
// at call time), not just against whatever `subscription_status`
// currently says -- this is what makes an already-issued tenant JWT
// stop working the moment a trial/expiry date passes, with no cron
// job required, mirroring exactly how a suspended company's existing
// tokens already stop working immediately today.
// ==========================================

const isCompanyAccessAllowed = (company) => {

    if (!company || company.status !== "active") {
        return false;
    }

    if (company.subscription_status === "cancelled" || company.subscription_status === "expired") {
        return false;
    }

    if (company.subscription_expires_at && new Date(company.subscription_expires_at) < new Date()) {
        return false;
    }

    if (
        company.subscription_status === "trial" &&
        company.trial_ends_at &&
        new Date(company.trial_ends_at) < new Date()
    ) {
        return false;
    }

    return true;

};

// ==========================================
// COMPANY SUBSCRIPTION MANAGEMENT (Phase 8)
//
// Platform Owner action only -- assigns/changes a company's plan and
// subscription metadata. Guarded exactly like updateCompanyAccessType:
// only a company that has actually been provisioned (active or
// suspended) can have its subscription managed, and this UPDATE only
// ever touches these five columns on the companies row itself -- it
// never creates/drops a tenant database, never touches tenant_db_name,
// and never reaches into any tenant database's own tables.
// ==========================================

const updateCompanySubscription = async (id, { planId, subscriptionStatus, trialEndsAt, subscriptionExpiresAt }) => {
    const [result] = await platformPool.query(
        `UPDATE companies
         SET plan_id = ?, subscription_status = ?, trial_ends_at = ?, subscription_expires_at = ?,
             subscription_started_at = COALESCE(subscription_started_at, NOW())
         WHERE id = ? AND status IN ('active', 'suspended')`,
        [planId, subscriptionStatus, trialEndsAt, subscriptionExpiresAt, id]
    );
    if (result.rowCount === 0) {
        return null;
    }
    return await getCompanyById(id);
};

// Pure aggregation over the new subscription columns -- same
// GROUP BY-then-fold pattern as getCompanyStats above, kept as a
// separate function so the existing dashboard stats query/shape is
// untouched and this is simply merged alongside it by the caller.
const getSubscriptionStats = async () => {
    const [statusRows] = await platformPool.query(
        `SELECT subscription_status, COUNT(*) AS c FROM companies GROUP BY subscription_status`
    );

    const [planRows] = await platformPool.query(
        `SELECT sp.id, sp.name, COUNT(c.id) AS c
         FROM subscription_plans sp
         LEFT JOIN companies c ON c.plan_id = sp.id
         GROUP BY sp.id, sp.name
         ORDER BY sp.id ASC`
    );

    const stats = {
        active: 0,
        trial: 0,
        expired: 0,
        cancelled: 0,
        planDistribution: planRows.map((row) => ({
            planId: row.id,
            planName: row.name,
            companyCount: Number(row.c),
        })),
    };

    for (const row of statusRows) {
        stats[row.subscription_status] = Number(row.c);
    }

    return stats;
};

module.exports = {
    getCompanyBySlug,
    getCompanyById,
    getActiveCompanyBySlug,
    isCompanyUsable,
    hasPaidAccess,
    isCompanyAccessAllowed,
    createPendingCompany,
    activateCompany,
    deletePendingCompany,
    listCompanies,
    getCompanyStats,
    getSubscriptionStats,
    suspendCompany,
    reactivateCompany,
    updateCompanyAccessType,
    updateCompanySubscription,
};
