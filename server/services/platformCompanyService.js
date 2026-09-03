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
             VALUES (?, ?, 'pending', ?, NULL)`,
            [companyName, companySlug, accessType]
        );

        return await getCompanyById(result.insertId);

    } catch (dbError) {

        if (dbError.code === "ER_DUP_ENTRY") {
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
    if (result.affectedRows === 0) {
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
    return result.affectedRows > 0;
};

// ==========================================
// COMPANY STATUS CHECK FOUNDATION
// Pure, reusable helpers -- not enforced anywhere yet. A future
// phase's tenant-resolution middleware calls these instead of
// re-deriving the same status/access_type logic inline.
// ==========================================

const isCompanyUsable = (company) => Boolean(company) && company.status === "active";

const hasPaidAccess = (company) => Boolean(company) && company.access_type === "paid";

module.exports = {
    getCompanyBySlug,
    getCompanyById,
    getActiveCompanyBySlug,
    isCompanyUsable,
    hasPaidAccess,
    createPendingCompany,
    activateCompany,
    deletePendingCompany,
};
