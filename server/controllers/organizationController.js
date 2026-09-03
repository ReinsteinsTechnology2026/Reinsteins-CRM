const pool = require("../config/db");

const {
    validateDepartmentAssignment,
    validateReportingManagerAssignment,
    recordOrganizationHistory,
    getDirectReportRows,
} = require("../services/organizationService");

const { SYSTEM_ACCESS_LEVELS } = require("../middleware/accessMiddleware");

const { createNotification } = require("../services/notificationService");

// ==========================================
// NOTIFICATION HELPER
// Reuses the existing notifications table + the
// existing Socket.IO "notification:new" pattern
// (same convention already used by chat and task
// mentions) — no second notification system.
// ==========================================

async function notifyUser(req, userId, title, message, type) {

    await createNotification({ req, userId, title, message, type });

}

// ==========================================
// MY TEAM
// Direct reports only, enriched with today's
// attendance status and pending-leave count.
// Naturally self-scoped — any authenticated user
// can call this and only ever sees people who
// report directly to THEM (empty list otherwise).
// ==========================================

const getMyTeam = async (req, res) => {
    try {

        const rows = await getDirectReportRows(req.user.id);

        if (rows.length === 0) {
            return res.status(200).json({ success: true, team: [] });
        }

        const ids = rows.map((r) => r.id);
        const placeholders = ids.map(() => "?").join(",");

        const [attendanceRows] = await pool.query(
            `
            SELECT user_id, status
            FROM attendance
            WHERE user_id IN (${placeholders})
            AND DATE(login_time) = CURDATE()
            ORDER BY login_time DESC
            `,
            ids
        );

        const attendanceMap = {};
        attendanceRows.forEach((row) => {
            if (!(row.user_id in attendanceMap)) {
                attendanceMap[row.user_id] = row.status;
            }
        });

        const [leaveRows] = await pool.query(
            `
            SELECT user_id, COUNT(*) AS pending_count
            FROM leave_requests
            WHERE user_id IN (${placeholders})
            AND status IN ('pending_manager', 'pending_final')
            GROUP BY user_id
            `,
            ids
        );

        const leaveMap = {};
        leaveRows.forEach((row) => {
            leaveMap[row.user_id] = row.pending_count;
        });

        const team = rows.map((row) => ({
            ...row,
            attendance_today: attendanceMap[row.id] || "not_logged_in",
            pending_leave_count: leaveMap[row.id] || 0,
        }));

        return res.status(200).json({ success: true, team });

    } catch (error) {
        console.error("Get My Team Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load your team",
        });
    }
};

// ==========================================
// DIRECT REPORTS (lean list)
// Used e.g. before resigning/terminating a
// manager, to check whether they still have
// active direct reports that need reassignment.
// ==========================================

const getDirectReports = async (req, res) => {
    try {

        const managerId = req.query.managerId || req.user.id;

        const rows = await getDirectReportRows(managerId);

        return res.status(200).json({ success: true, reports: rows });

    } catch (error) {
        console.error("Get Direct Reports Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load direct reports",
        });
    }
};

// ==========================================
// MY REPORTING MANAGER
// Any user can see their own manager's basic
// public info — nothing sensitive is exposed.
// ==========================================

const getMyReportingManager = async (req, res) => {
    try {

        const [users] = await pool.query(
            `SELECT reporting_manager_id FROM users WHERE id = ? LIMIT 1`,
            [req.user.id]
        );

        if (users.length === 0 || !users[0].reporting_manager_id) {
            return res.status(200).json({ success: true, manager: null });
        }

        const [managers] = await pool.query(
            `
            SELECT
                u.id,
                u.employee_id,
                u.full_name,
                u.designation,
                u.department_id,
                d.name AS department_name
            FROM users u
            LEFT JOIN departments d ON d.id = u.department_id
            WHERE u.id = ?
            LIMIT 1
            `,
            [users[0].reporting_manager_id]
        );

        return res.status(200).json({
            success: true,
            manager: managers[0] || null,
        });

    } catch (error) {
        console.error("Get My Reporting Manager Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load your reporting manager",
        });
    }
};

// ==========================================
// DEPARTMENT MANAGERS
// People with elevated scope (department_head/
// manager/team_lead) inside a given department —
// useful when picking a valid reporting manager
// scoped to a department.
// ==========================================

const getDepartmentManagers = async (req, res) => {
    try {

        const { id } = req.params;

        const [rows] = await pool.query(
            `
            SELECT id, employee_id, full_name, designation, system_access
            FROM users
            WHERE department_id = ?
            AND employment_status = 'active'
            AND system_access IN ('department_head', 'manager', 'team_lead')
            ORDER BY full_name
            `,
            [id]
        );

        return res.status(200).json({ success: true, managers: rows });

    } catch (error) {
        console.error("Get Department Managers Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load department managers",
        });
    }
};

// ==========================================
// ORGANIZATION CHART — LAZY/EXPANDABLE NODES
//
// Never loads the whole organization at once.
// "roots" returns the top-of-org people (no
// reporting manager); each node also carries
// direct_report_count so the frontend knows
// whether to render an expand affordance, and
// fetches actual children only when a node is
// expanded via the node-children endpoint.
// ==========================================

async function fetchOrgNodes(whereClause, params) {

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
            d.name AS department_name,
            (
                SELECT COUNT(*) FROM users c
                WHERE c.reporting_manager_id = u.id
                AND c.employment_status = 'active'
            ) AS direct_report_count
        FROM users u
        LEFT JOIN departments d ON d.id = u.department_id
        WHERE ${whereClause}
        AND u.employment_status = 'active'
        ORDER BY u.full_name
        `,
        params
    );

    return rows;

}

const getOrgChartRoots = async (req, res) => {
    try {

        const { departmentId } = req.query;

        let whereClause = "u.reporting_manager_id IS NULL";
        const params = [];

        if (departmentId) {
            whereClause += " AND u.department_id = ?";
            params.push(departmentId);
        }

        const nodes = await fetchOrgNodes(whereClause, params);

        return res.status(200).json({ success: true, nodes });

    } catch (error) {
        console.error("Get Org Chart Roots Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load organization chart",
        });
    }
};

const getOrgChartNodeChildren = async (req, res) => {
    try {

        const { id } = req.params;

        const nodes = await fetchOrgNodes("u.reporting_manager_id = ?", [id]);

        return res.status(200).json({ success: true, nodes });

    } catch (error) {
        console.error("Get Org Chart Node Children Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load reporting chain",
        });
    }
};

const searchOrgUsers = async (req, res) => {
    try {

        const query = (req.query.q || "").trim();

        if (!query) {
            return res.status(200).json({ success: true, results: [] });
        }

        const like = `%${query}%`;

        const [results] = await pool.query(
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
            WHERE (u.full_name LIKE ? OR u.employee_id LIKE ?)
            AND u.role = 'employee'
            ORDER BY u.full_name
            LIMIT 25
            `,
            [like, like]
        );

        return res.status(200).json({ success: true, results });

    } catch (error) {
        console.error("Search Org Users Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to search",
        });
    }
};

// ==========================================
// TRANSFER (department + reporting manager
// together, one controlled operation)
// ==========================================

const transferUser = async (req, res) => {
    try {

        const { id } = req.params;
        const { departmentId, reportingManagerId } = req.body;

        const [users] = await pool.query(
            `
            SELECT id, full_name, employee_id, department_id, reporting_manager_id, employment_status
            FROM users
            WHERE id = ?
            AND role = 'employee'
            LIMIT 1
            `,
            [id]
        );

        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        const targetUser = users[0];

        if (targetUser.employment_status !== "active") {
            return res.status(400).json({
                success: false,
                message: "Only active employees/interns can be transferred",
            });
        }

        const deptValidation = await validateDepartmentAssignment(departmentId);

        if (!deptValidation.valid) {
            return res.status(400).json({
                success: false,
                message: deptValidation.message,
            });
        }

        const managerValidation = await validateReportingManagerAssignment(id, reportingManagerId);

        if (!managerValidation.valid) {
            return res.status(400).json({
                success: false,
                message: managerValidation.message,
            });
        }

        let oldDepartmentLabel = "Not assigned";

        if (targetUser.department_id) {
            const [oldDept] = await pool.query(
                `SELECT name FROM departments WHERE id = ?`,
                [targetUser.department_id]
            );
            if (oldDept.length > 0) oldDepartmentLabel = oldDept[0].name;
        }

        let oldManagerLabel = "Not assigned";

        if (targetUser.reporting_manager_id) {
            const [oldManager] = await pool.query(
                `SELECT full_name, employee_id FROM users WHERE id = ?`,
                [targetUser.reporting_manager_id]
            );
            if (oldManager.length > 0) {
                oldManagerLabel = `${oldManager[0].full_name} (${oldManager[0].employee_id})`;
            }
        }

        const newDepartmentLabel = deptValidation.department
            ? deptValidation.department.name
            : "Not assigned";

        const newManagerLabel = managerValidation.manager
            ? `${managerValidation.manager.full_name} (${managerValidation.manager.employee_id})`
            : "Not assigned";

        const connection = await pool.getConnection();

        try {

            await connection.beginTransaction();

            await connection.query(
                `
                UPDATE users
                SET department_id = ?, reporting_manager_id = ?
                WHERE id = ?
                AND role = 'employee'
                `,
                [deptValidation.departmentId, managerValidation.managerId, id]
            );

            if (oldDepartmentLabel !== newDepartmentLabel) {
                await recordOrganizationHistory(connection, {
                    userId: id,
                    changeType: "department",
                    oldValue: oldDepartmentLabel,
                    newValue: newDepartmentLabel,
                    changedBy: req.user.id,
                });
            }

            if (oldManagerLabel !== newManagerLabel) {
                await recordOrganizationHistory(connection, {
                    userId: id,
                    changeType: "reporting_manager",
                    oldValue: oldManagerLabel,
                    newValue: newManagerLabel,
                    changedBy: req.user.id,
                });
            }

            await connection.commit();

        } catch (transactionError) {
            await connection.rollback();
            throw transactionError;
        } finally {
            connection.release();
        }

        await notifyUser(
            req,
            id,
            "Organization Update",
            `Your department is now ${newDepartmentLabel} and your reporting manager is ${newManagerLabel}.`,
            "organization_change"
        );

        return res.status(200).json({
            success: true,
            message: "Transfer completed successfully",
        });

    } catch (error) {
        console.error("Transfer User Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to complete transfer",
        });
    }
};

// ==========================================
// CHANGE REPORTING MANAGER ONLY
// ==========================================

const setReportingManager = async (req, res) => {
    try {

        const { id } = req.params;
        const { reportingManagerId } = req.body;

        const [users] = await pool.query(
            `
            SELECT id, reporting_manager_id, employment_status
            FROM users
            WHERE id = ?
            AND role = 'employee'
            LIMIT 1
            `,
            [id]
        );

        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        if (users[0].employment_status !== "active") {
            return res.status(400).json({
                success: false,
                message: "Only active employees/interns can have their reporting manager changed",
            });
        }

        const validation = await validateReportingManagerAssignment(id, reportingManagerId);

        if (!validation.valid) {
            return res.status(400).json({
                success: false,
                message: validation.message,
            });
        }

        let oldManagerLabel = "Not assigned";

        if (users[0].reporting_manager_id) {
            const [oldManager] = await pool.query(
                `SELECT full_name, employee_id FROM users WHERE id = ?`,
                [users[0].reporting_manager_id]
            );
            if (oldManager.length > 0) {
                oldManagerLabel = `${oldManager[0].full_name} (${oldManager[0].employee_id})`;
            }
        }

        const newManagerLabel = validation.manager
            ? `${validation.manager.full_name} (${validation.manager.employee_id})`
            : "Not assigned";

        await pool.query(
            `UPDATE users SET reporting_manager_id = ? WHERE id = ? AND role = 'employee'`,
            [validation.managerId, id]
        );

        await recordOrganizationHistory(pool, {
            userId: id,
            changeType: "reporting_manager",
            oldValue: oldManagerLabel,
            newValue: newManagerLabel,
            changedBy: req.user.id,
        });

        await notifyUser(
            req,
            id,
            "Reporting Manager Changed",
            `Your reporting manager has been changed to ${newManagerLabel}.`,
            "organization_change"
        );

        return res.status(200).json({
            success: true,
            message: "Reporting manager updated successfully",
        });

    } catch (error) {
        console.error("Set Reporting Manager Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to update reporting manager",
        });
    }
};

// ==========================================
// SYSTEM ACCESS CHANGE
// Route is gated to requireAccess('super_admin',
// 'admin'), but Super Admin protection is
// additionally enforced here: only a Super Admin
// may grant super_admin, or change anyone who
// currently holds it — an ordinary Admin cannot
// touch Super Admin access either direction.
// ==========================================

const setSystemAccess = async (req, res) => {
    try {

        const { id } = req.params;
        const { systemAccess } = req.body;

        if (!SYSTEM_ACCESS_LEVELS.includes(systemAccess)) {
            return res.status(400).json({
                success: false,
                message: "Invalid system access level",
            });
        }

        const [users] = await pool.query(
            `SELECT id, full_name, employee_id, system_access FROM users WHERE id = ? LIMIT 1`,
            [id]
        );

        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        const targetUser = users[0];

        const requesterIsSuperAdmin = req.userAccess?.systemAccess === "super_admin";

        if (
            (systemAccess === "super_admin" || targetUser.system_access === "super_admin") &&
            !requesterIsSuperAdmin
        ) {
            return res.status(403).json({
                success: false,
                message: "Only a Super Admin can grant or modify Super Admin access",
            });
        }

        if (targetUser.system_access === systemAccess) {
            return res.status(200).json({
                success: true,
                message: "No change — this user already has that access level",
            });
        }

        await pool.query(
            `UPDATE users SET system_access = ? WHERE id = ?`,
            [systemAccess, id]
        );

        await recordOrganizationHistory(pool, {
            userId: id,
            changeType: "system_access",
            oldValue: targetUser.system_access,
            newValue: systemAccess,
            changedBy: req.user.id,
        });

        return res.status(200).json({
            success: true,
            message: "System access updated successfully",
        });

    } catch (error) {
        console.error("Set System Access Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to update system access",
        });
    }
};

// ==========================================
// SET PROJECT ACCESS OVERRIDE
// Grants/revokes explicit Project Access
// independent of designation — see
// projectAccessService.js for the full
// resolution rule (system_access executive/
// admin/super_admin always has access
// regardless of this override; a default-access
// designation can still be explicitly revoked
// here). Touches ONLY project_access_override —
// department, designation, reporting_manager,
// mentor and system_access are all untouched.
// ==========================================

const setProjectAccess = async (req, res) => {
    try {

        const { id } = req.params;
        let { projectAccess } = req.body;

        // Accept null/"default" to clear the override back to the
        // designation-based rule, or the two explicit override values.

        if (projectAccess === "default" || projectAccess === undefined) {
            projectAccess = null;
        }

        if (
            projectAccess !== null &&
            !["granted", "revoked"].includes(projectAccess)
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid project access value",
            });
        }

        const [users] = await pool.query(
            `SELECT id, project_access_override FROM users WHERE id = ? LIMIT 1`,
            [id]
        );

        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        const targetUser = users[0];

        if (targetUser.project_access_override === projectAccess) {
            return res.status(200).json({
                success: true,
                message: "No change — this user already has that project access setting",
            });
        }

        await pool.query(
            `UPDATE users SET project_access_override = ? WHERE id = ?`,
            [projectAccess, id]
        );

        return res.status(200).json({
            success: true,
            message: "Project access updated successfully",
        });

    } catch (error) {
        console.error("Set Project Access Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to update project access",
        });
    }
};

// ==========================================
// SET PROJECT ACCESS LEVEL
// An organization-level entitlement (basic/
// stakeholder) that acts as a ceiling on what a
// user can ever do inside ANY project, regardless
// of their security group there — see
// projectPermissionService.js's ACCESS_LEVEL_CEILINGS.
// Distinct from project_access_override (module
// grant/revoke) and from project_members/security
// groups (per-project membership/role).
// ==========================================

const setProjectAccessLevel = async (req, res) => {
    try {

        const { id } = req.params;
        const { accessLevel } = req.body;

        if (!["basic", "stakeholder"].includes(accessLevel)) {
            return res.status(400).json({
                success: false,
                message: "Invalid project access level",
            });
        }

        const [users] = await pool.query(
            `SELECT id, project_access_level FROM users WHERE id = ? LIMIT 1`,
            [id]
        );

        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        if (users[0].project_access_level === accessLevel) {
            return res.status(200).json({
                success: true,
                message: "No change — this user already has that access level",
            });
        }

        await pool.query(
            `UPDATE users SET project_access_level = ? WHERE id = ?`,
            [accessLevel, id]
        );

        return res.status(200).json({
            success: true,
            message: "Project access level updated successfully",
        });

    } catch (error) {
        console.error("Set Project Access Level Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to update project access level",
        });
    }
};

// ==========================================
// ORGANIZATION HISTORY FOR ONE USER (audit view)
// ==========================================

const getOrganizationHistory = async (req, res) => {
    try {

        const { id } = req.params;

        const [history] = await pool.query(
            `
            SELECT
                h.id,
                h.change_type,
                h.old_value,
                h.new_value,
                h.changed_at,
                changer.full_name AS changed_by_name
            FROM organization_history h
            LEFT JOIN users changer ON changer.id = h.changed_by
            WHERE h.user_id = ?
            ORDER BY h.changed_at DESC
            `,
            [id]
        );

        return res.status(200).json({ success: true, history });

    } catch (error) {
        console.error("Get Organization History Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load organization history",
        });
    }
};

// ==========================================
// EXECUTIVE SUMMARY
// Company-wide overview for the Executive
// Dashboard/Reports pages (Founder/Chairman).
// Every number here is a direct COUNT/aggregate
// against real existing tables — nothing is
// estimated or invented. Read-only, no writes.
// ==========================================

const getExecutiveSummary = async (req, res) => {
    try {

        const [[employeeRow]] = await pool.query(
            `SELECT COUNT(*) AS count FROM users
             WHERE employment_type = 'employee' AND employment_status = 'active'`
        );

        const [[internRow]] = await pool.query(
            `SELECT COUNT(*) AS count FROM users
             WHERE employment_type = 'intern' AND employment_status = 'active'`
        );

        const [[departmentRow]] = await pool.query(
            `SELECT COUNT(*) AS count FROM departments WHERE status = 'active'`
        );

        const [projectStatusRows] = await pool.query(
            `SELECT status, COUNT(*) AS count FROM projects GROUP BY status`
        );

        const [[projectTotalRow]] = await pool.query(
            `SELECT COUNT(*) AS count FROM projects`
        );

        const [[taskRow]] = await pool.query(
            `SELECT
                SUM(CASE WHEN status != 'closed' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status != 'closed' AND due_date IS NOT NULL AND due_date < CURDATE() THEN 1 ELSE 0 END) AS overdue
             FROM tasks`
        );

        const [[pendingLeaveRow]] = await pool.query(
            `SELECT COUNT(*) AS count FROM leave_requests
             WHERE status IN ('pending_manager', 'pending_final')`
        );

        const [[attendanceRow]] = await pool.query(
            `SELECT COUNT(DISTINCT user_id) AS count FROM attendance
             WHERE DATE(login_time) = CURDATE()`
        );

        const [[onLeaveTodayRow]] = await pool.query(
            `SELECT COUNT(DISTINCT user_id) AS count FROM leave_requests
             WHERE status = 'approved' AND CURDATE() BETWEEN from_date AND to_date`
        );

        const [departmentDistribution] = await pool.query(
            `
            SELECT d.id, d.name, COUNT(u.id) AS memberCount
            FROM departments d
            LEFT JOIN users u ON u.department_id = d.id AND u.employment_status = 'active'
            WHERE d.status = 'active'
            GROUP BY d.id, d.name
            ORDER BY d.name
            `
        );

        const [leaveByStatus] = await pool.query(
            `SELECT status, COUNT(*) AS count FROM leave_requests GROUP BY status`
        );

        const [taskByStatus] = await pool.query(
            `SELECT status, COUNT(*) AS count FROM tasks GROUP BY status`
        );

        const [recentActivity] = await pool.query(
            `
            SELECT
                h.id,
                h.change_type,
                h.old_value,
                h.new_value,
                h.changed_at,
                target.full_name AS user_name,
                changer.full_name AS changed_by_name
            FROM organization_history h
            LEFT JOIN users target ON target.id = h.user_id
            LEFT JOIN users changer ON changer.id = h.changed_by
            ORDER BY h.changed_at DESC
            LIMIT 8
            `
        );

        return res.status(200).json({
            success: true,
            summary: {
                activeEmployees: employeeRow.count,
                activeInterns: internRow.count,
                departmentCount: departmentRow.count,
                totalProjects: projectTotalRow.count,
                projectsByStatus: projectStatusRows,
                pendingTasks: taskRow.pending || 0,
                overdueTasks: taskRow.overdue || 0,
                pendingLeaveApprovals: pendingLeaveRow.count,
                presentToday: attendanceRow.count,
                onLeaveToday: onLeaveTodayRow.count,
                departmentDistribution,
                leaveByStatus,
                taskByStatus,
            },
            recentActivity,
        });

    } catch (error) {
        console.error("Get Executive Summary Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load executive summary",
        });
    }
};

module.exports = {
    getMyTeam,
    getDirectReports,
    getMyReportingManager,
    getDepartmentManagers,
    getOrgChartRoots,
    getOrgChartNodeChildren,
    searchOrgUsers,
    transferUser,
    setReportingManager,
    setSystemAccess,
    setProjectAccess,
    setProjectAccessLevel,
    getOrganizationHistory,
    getExecutiveSummary,
};
