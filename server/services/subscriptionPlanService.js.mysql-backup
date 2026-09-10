const platformPool = require("../config/platformDb");

// ==========================================
// SUBSCRIPTION PLAN SERVICE (Phase 8)
//
// Pure DB logic against groworgs_platform_db.subscription_plans ONLY
// -- never touches `companies`, `platform_users`, `demo_requests`, or
// any tenant database. Same layering convention as
// platformCompanyService.js / demoRequestService.js.
//
// There is deliberately no deletePlan() here -- the phase spec is
// explicit that a plan must never be removable if it could break a
// company already assigned to it. That's enforced two ways: (1) this
// file simply never exposes a delete operation, and (2) the
// fk_companies_plan_id foreign key (see _migrate_add_subscriptions.js)
// would reject a DELETE at the database level even if some other code
// tried. setPlanStatus (enable/disable) is the only lifecycle action
// after creation.
// ==========================================

const PLAN_COLUMNS = `
    id, name, slug, description, status, employee_limit, storage_limit_mb,
    features, created_at, updated_at
`;

const listPlans = async () => {
    const [rows] = await platformPool.query(
        `SELECT ${PLAN_COLUMNS} FROM subscription_plans ORDER BY created_at ASC, id ASC`
    );
    return rows;
};

const getPlanById = async (id) => {
    const [rows] = await platformPool.query(
        `SELECT ${PLAN_COLUMNS} FROM subscription_plans WHERE id = ? LIMIT 1`,
        [id]
    );
    return rows[0] || null;
};

const getPlanBySlug = async (slug) => {
    const [rows] = await platformPool.query(
        `SELECT ${PLAN_COLUMNS} FROM subscription_plans WHERE slug = ? LIMIT 1`,
        [slug]
    );
    return rows[0] || null;
};

const createPlan = async ({ name, slug, description, employeeLimit, storageLimitMb, features }) => {
    try {

        const [result] = await platformPool.query(
            `INSERT INTO subscription_plans
                (name, slug, description, status, employee_limit, storage_limit_mb, features)
             VALUES (?, ?, ?, 'active', ?, ?, ?)`,
            [name, slug, description || null, employeeLimit, storageLimitMb, JSON.stringify(features)]
        );

        return await getPlanById(result.insertId);

    } catch (dbError) {
        if (dbError.code === "ER_DUP_ENTRY") {
            const error = new Error("A plan with this slug already exists.");
            error.code = "PLAN_SLUG_TAKEN";
            throw error;
        }
        throw dbError;
    }
};

// Updates the plan's descriptive/limit fields only -- never its id or
// slug (slug is immutable after creation, exactly like company_slug,
// so nothing that already references a plan by slug can be silently
// repointed at a different plan's identity).
const updatePlan = async (id, { name, description, employeeLimit, storageLimitMb, features }) => {
    const [result] = await platformPool.query(
        `UPDATE subscription_plans
         SET name = ?, description = ?, employee_limit = ?, storage_limit_mb = ?, features = ?
         WHERE id = ?`,
        [name, description || null, employeeLimit, storageLimitMb, JSON.stringify(features), id]
    );
    if (result.affectedRows === 0) {
        return null;
    }
    return await getPlanById(id);
};

// Soft enable/disable only -- see the module header for why there is
// no hard delete. A disabled plan is NOT retroactively removed from
// any company already assigned to it (see platformCompanyService's
// updateCompanySubscription for the "already-assigned exception").
const setPlanStatus = async (id, status) => {
    const [result] = await platformPool.query(
        `UPDATE subscription_plans SET status = ? WHERE id = ?`,
        [status, id]
    );
    if (result.affectedRows === 0) {
        return null;
    }
    return await getPlanById(id);
};

module.exports = {
    listPlans,
    getPlanById,
    getPlanBySlug,
    createPlan,
    updatePlan,
    setPlanStatus,
};
