const pool = require("../config/db");

// ==========================================
// ORGANIZATION SERVICE
//
// Shared helpers used by departmentController,
// designationController, organizationController,
// leaveController, and the task-management
// authorization scoping. Nothing here touches
// employment_history — organizational
// relationships (department/designation/
// reporting_manager/system_access) are tracked
// separately in organization_history via
// recordOrganizationHistory below.
// ==========================================

// ==========================================
// REPORTING MANAGER VALIDATION
// Prevents: invalid/missing manager, self-
// reporting, an inactive/former user as manager,
// and circular reporting chains.
// ==========================================

async function wouldCreateCycle(userId, candidateManagerId) {

    // Walking UP the chain starting at the candidate manager: if we
    // ever reach userId, then making userId report to
    // candidateManagerId would close a loop somewhere in the chain.

    let currentId = candidateManagerId;
    const visited = new Set();
    let steps = 0;

    while (currentId && steps < 50) {

        if (Number(currentId) === Number(userId)) {
            return true;
        }

        if (visited.has(currentId)) {
            // Pre-existing corrupt data safety net — should be
            // unreachable since this same check prevents cycles
            // from ever being written in the first place.
            break;
        }

        visited.add(currentId);

        const [rows] = await pool.query(
            `SELECT reporting_manager_id FROM users WHERE id = ? LIMIT 1`,
            [currentId]
        );

        if (rows.length === 0) break;

        currentId = rows[0].reporting_manager_id;
        steps += 1;

    }

    return false;

}

async function validateReportingManagerAssignment(userId, candidateManagerId) {

    if (
        candidateManagerId === null ||
        candidateManagerId === undefined ||
        candidateManagerId === ""
    ) {
        return { valid: true, managerId: null };
    }

    const managerId = Number(candidateManagerId);

    if (!Number.isInteger(managerId) || managerId <= 0) {
        return { valid: false, message: "Invalid reporting manager" };
    }

    if (managerId === Number(userId)) {
        return { valid: false, message: "A user cannot report to themselves" };
    }

    const [rows] = await pool.query(
        `SELECT id, full_name, employee_id, employment_status FROM users WHERE id = ? LIMIT 1`,
        [managerId]
    );

    if (rows.length === 0) {
        return { valid: false, message: "Reporting manager not found" };
    }

    if (rows[0].employment_status !== "active") {
        return { valid: false, message: "Reporting manager must be an active user" };
    }

    const cycle = await wouldCreateCycle(userId, managerId);

    if (cycle) {
        return {
            valid: false,
            message: "This assignment would create a circular reporting relationship",
        };
    }

    return { valid: true, managerId, manager: rows[0] };

}

// ==========================================
// DEPARTMENT VALIDATION
// ==========================================

async function validateDepartmentAssignment(departmentId) {

    if (
        departmentId === null ||
        departmentId === undefined ||
        departmentId === ""
    ) {
        return { valid: true, departmentId: null };
    }

    const id = Number(departmentId);

    if (!Number.isInteger(id) || id <= 0) {
        return { valid: false, message: "Invalid department" };
    }

    const [rows] = await pool.query(
        `SELECT id, name, status FROM departments WHERE id = ? LIMIT 1`,
        [id]
    );

    if (rows.length === 0) {
        return { valid: false, message: "Department not found" };
    }

    if (rows[0].status !== "active") {
        return { valid: false, message: "Department is not active" };
    }

    return { valid: true, departmentId: id, department: rows[0] };

}

// ==========================================
// ORGANIZATION HISTORY
// `runner` may be the pool or an open
// transaction connection — both expose .query().
// ==========================================

async function recordOrganizationHistory(runner, {
    userId,
    changeType,
    oldValue,
    newValue,
    changedBy,
}) {

    await runner.query(
        `
        INSERT INTO organization_history
        (user_id, change_type, old_value, new_value, changed_by)
        VALUES (?, ?, ?, ?, ?)
        `,
        [
            userId,
            changeType,
            oldValue === undefined ? null : oldValue,
            newValue === undefined ? null : newValue,
            changedBy,
        ]
    );

}

// ==========================================
// DIRECT / ALL REPORTS
// ==========================================

async function getDirectReportRows(managerId) {

    // Only ACTIVE direct reports — this is what "My Team" and the
    // manager-exit safety check both need: a manager's current team,
    // not everyone who has ever reported to them.

    const [rows] = await pool.query(
        `
        SELECT
            u.id,
            u.employee_id,
            u.full_name,
            u.designation,
            u.employment_type,
            u.employment_status,
            u.department_id,
            d.name AS department_name
        FROM users u
        LEFT JOIN departments d ON d.id = u.department_id
        WHERE u.reporting_manager_id = ?
        AND u.employment_status = 'active'
        ORDER BY u.full_name
        `,
        [managerId]
    );

    return rows;

}

async function getAllReportIds(managerId, maxDepth = 20) {

    const collected = new Set();
    let frontier = [managerId];
    let depth = 0;

    while (frontier.length > 0 && depth < maxDepth) {

        const placeholders = frontier.map(() => "?").join(",");

        const [rows] = await pool.query(
            `
            SELECT id FROM users
            WHERE reporting_manager_id IN (${placeholders})
            AND employment_status = 'active'
            `,
            frontier
        );

        const newIds = rows
            .map((row) => row.id)
            .filter((id) => !collected.has(id));

        newIds.forEach((id) => collected.add(id));

        frontier = newIds;
        depth += 1;

    }

    return [...collected];

}

// ==========================================
// TASK ASSIGNMENT SCOPE
// Determines which users a given requester is
// allowed to assign tasks to. This is the fix
// for the pre-existing gap where
// POST /task-management/create had no scoping
// at all.
// ==========================================

async function getAssignableScope(user) {

    // user = { id, role, systemAccess }

    if (
        user.role === "admin" ||
        ["super_admin", "admin"].includes(user.systemAccess)
    ) {
        return { type: "all" };
    }

    if (user.systemAccess === "department_head") {

        const [depts] = await pool.query(
            `SELECT id FROM departments WHERE department_head_id = ?`,
            [user.id]
        );

        if (depts.length === 0) {
            return { type: "self", selfId: user.id };
        }

        const deptIds = depts.map((d) => d.id);
        const placeholders = deptIds.map(() => "?").join(",");

        const [members] = await pool.query(
            `
            SELECT id FROM users
            WHERE department_id IN (${placeholders})
            AND employment_status = 'active'
            `,
            deptIds
        );

        return {
            type: "list",
            ids: [user.id, ...members.map((m) => m.id)],
        };

    }

    if (user.systemAccess === "manager") {

        const ids = await getAllReportIds(user.id);
        return { type: "list", ids: [user.id, ...ids] };

    }

    if (user.systemAccess === "team_lead") {

        const rows = await getDirectReportRows(user.id);
        return { type: "list", ids: [user.id, ...rows.map((r) => r.id)] };

    }

    return { type: "self", selfId: user.id };

}

function isWithinScope(scope, targetUserId) {

    const target = Number(targetUserId);

    if (scope.type === "all") return true;

    if (scope.type === "list") {
        return scope.ids.map(Number).includes(target);
    }

    if (scope.type === "self") {
        return Number(scope.selfId) === target;
    }

    return false;

}

module.exports = {
    wouldCreateCycle,
    validateReportingManagerAssignment,
    validateDepartmentAssignment,
    recordOrganizationHistory,
    getDirectReportRows,
    getAllReportIds,
    getAssignableScope,
    isWithinScope,
};
