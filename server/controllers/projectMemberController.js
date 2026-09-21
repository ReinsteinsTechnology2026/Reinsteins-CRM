const pool = require("../config/db");

const {
    PERMISSION_KEYS,
    getEffectivePermissions,
} = require("../services/projectPermissionService");

const { isOrganizationMember } = require("../services/organizationMemberService");

const { createNotification } = require("../services/notificationService");

// ==========================================
// NOTIFICATION HELPER
// Same insert + Socket.IO emit convention already
// used elsewhere in this codebase.
// ==========================================

async function notifyUser(req, userId, title, message, type) {

    await createNotification({ req, userId, title, message, type });

}

async function logProjectActivity(projectId, actorId, activityType, targetUserId, details) {

    await pool.query(
        `
        INSERT INTO project_activity (project_id, actor_id, activity_type, target_user_id, details)
        VALUES (?, ?, ?, ?, ?)
        `,
        [projectId, actorId, activityType, targetUserId || null, details || null]
    );

}

// ==========================================
// GET MY EFFECTIVE PERMISSIONS FOR A PROJECT
// Powers frontend UI-gating (show/hide buttons) —
// the backend independently re-checks every
// mutating action regardless of what this returns.
// ==========================================

const getMyPermissions = async (req, res) => {

    try {

        const result = await getEffectivePermissions(
            { id: req.user.id, accessLevel: req.userAccess?.accessLevel, isSystemAdministrator: req.userAccess?.isSystemAdministrator },
            req.params.id
        );

        return res.json({ success: true, ...result });

    } catch (error) {

        console.error("Get My Project Permissions Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load project permissions",
        });

    }

};

// ==========================================
// GET PROJECT MEMBERS
// ==========================================

const getMembers = async (req, res) => {

    try {

        const [members] = await pool.query(
            `
            SELECT
                pm.id,
                pm.user_id,
                u.full_name,
                u.email,
                u.employee_id,
                u.employment_status,
                pm.security_group_id,
                psg.name AS group_name,
                pm.added_by,
                adder.full_name AS added_by_name,
                pm.created_at
            FROM project_members pm
            JOIN users u ON u.id = pm.user_id
            JOIN project_security_groups psg ON psg.id = pm.security_group_id
            LEFT JOIN users adder ON adder.id = pm.added_by
            WHERE pm.project_id = ?
            ORDER BY u.full_name
            `,
            [req.params.id]
        );

        return res.json({ success: true, members });

    } catch (error) {

        console.error("Get Project Members Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load project members",
        });

    }

};

// ==========================================
// GET ELIGIBLE MEMBER CANDIDATES
// All active tenant users who can legitimately be added
// to a project -- deliberately NOT restricted by role,
// unlike task-management's getTransferTargets() (a
// different feature with its own narrower employee-only
// eligibility rule for legacy task reassignment that must
// stay untouched). Includes admin-role accounts -- e.g. a
// tenant's default System Administrator -- so they can
// actually be found and added through this modal.
// ==========================================

const getEligibleMembers = async (req, res) => {

    try {

        const [candidates] = await pool.query(
            `
            SELECT id, employee_id, full_name, role, email
            FROM users
            WHERE employment_status = 'active'
            ORDER BY full_name
            `
        );

        return res.json({ success: true, employees: candidates });

    } catch (error) {

        console.error("Get Eligible Project Members Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load eligible members",
        });

    }

};

// ==========================================
// ADD MEMBER(S)
// Accepts either a single userId or an array of
// userIds, plus a securityGroupId. Skips (rather
// than errors on) users already members — the
// caller may be adding a mixed batch.
// ==========================================

const addMembers = async (req, res) => {

    try {

        const { userIds, securityGroupId } = req.body;

        const ids = Array.isArray(userIds) ? userIds : [userIds];

        if (ids.length === 0 || ids.some((id) => !id)) {
            return res.status(400).json({
                success: false,
                message: "Select at least one user to add",
            });
        }

        const [groupRows] = await pool.query(
            `SELECT id, name FROM project_security_groups WHERE id = ? AND (project_id IS NULL OR project_id = ?) LIMIT 1`,
            [securityGroupId, req.params.id]
        );

        if (groupRows.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid security group",
            });
        }

        // A project's real organization is re-read from the DB here,
        // never trusted from the client -- same pattern as every
        // other project-id resolver in this codebase. A project with
        // no organization_id yet (shouldn't happen after the
        // migration/createProject backfill, but defensive) imposes no
        // organization constraint, so this never blocks membership
        // additions for an edge-case project.
        const [[projectRow]] = await pool.query(
            `SELECT organization_id FROM projects WHERE id = ? LIMIT 1`,
            [req.params.id]
        );

        const projectOrganizationId = projectRow?.organization_id || null;

        const placeholders = ids.map(() => "?").join(",");

        const [userRows] = await pool.query(
            `SELECT id, full_name, employment_status FROM users WHERE id IN (${placeholders})`,
            ids
        );

        const added = [];
        const skipped = [];

        for (const targetId of ids) {

            const targetUser = userRows.find((u) => Number(u.id) === Number(targetId));

            if (!targetUser || targetUser.employment_status !== "active") {
                skipped.push({ userId: targetId, reason: "not an active user" });
                continue;
            }

            if (projectOrganizationId && !(await isOrganizationMember(projectOrganizationId, targetId))) {
                skipped.push({ userId: targetId, reason: "not a member of this project's organization" });
                continue;
            }

            const [existing] = await pool.query(
                `SELECT id FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1`,
                [req.params.id, targetId]
            );

            if (existing.length > 0) {
                skipped.push({ userId: targetId, reason: "already a member" });
                continue;
            }

            await pool.query(
                `INSERT INTO project_members (project_id, user_id, security_group_id, added_by) VALUES (?, ?, ?, ?)`,
                [req.params.id, targetId, securityGroupId, req.user.id]
            );

            await logProjectActivity(
                req.params.id,
                req.user.id,
                "member_added",
                targetId,
                `Added to "${groupRows[0].name}"`
            );

            await notifyUser(
                req,
                targetId,
                "Added to a project",
                `You were added to a project as ${groupRows[0].name}.`,
                "project"
            );

            added.push(targetUser.full_name);

        }

        return res.json({
            success: true,
            message: added.length > 0
                ? `Added ${added.length} member(s)`
                : "No members were added",
            added,
            skipped,
        });

    } catch (error) {

        console.error("Add Project Members Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to add members",
        });

    }

};

// ==========================================
// CHANGE MEMBER'S SECURITY GROUP
// ==========================================

const changeMemberGroup = async (req, res) => {

    try {

        const { securityGroupId } = req.body;

        const [groupRows] = await pool.query(
            `SELECT id, name FROM project_security_groups WHERE id = ? AND (project_id IS NULL OR project_id = ?) LIMIT 1`,
            [securityGroupId, req.params.id]
        );

        if (groupRows.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid security group",
            });
        }

        const [existing] = await pool.query(
            `SELECT id, security_group_id FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1`,
            [req.params.id, req.params.userId]
        );

        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: "This user is not a member of this project",
            });
        }

        await pool.query(
            `UPDATE project_members SET security_group_id = ? WHERE project_id = ? AND user_id = ?`,
            [securityGroupId, req.params.id, req.params.userId]
        );

        await logProjectActivity(
            req.params.id,
            req.user.id,
            "member_group_changed",
            req.params.userId,
            `Changed to "${groupRows[0].name}"`
        );

        await notifyUser(
            req,
            req.params.userId,
            "Project role changed",
            `Your project role was changed to ${groupRows[0].name}.`,
            "project"
        );

        return res.json({ success: true, message: "Member group updated" });

    } catch (error) {

        console.error("Change Member Group Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to change member group",
        });

    }

};

// ==========================================
// REMOVE MEMBER
// ==========================================

const removeMember = async (req, res) => {

    try {

        const [existing] = await pool.query(
            `SELECT id FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1`,
            [req.params.id, req.params.userId]
        );

        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: "This user is not a member of this project",
            });
        }

        await pool.query(
            `DELETE FROM project_members WHERE project_id = ? AND user_id = ?`,
            [req.params.id, req.params.userId]
        );

        await logProjectActivity(
            req.params.id,
            req.user.id,
            "member_removed",
            req.params.userId,
            null
        );

        return res.json({ success: true, message: "Member removed from the project" });

    } catch (error) {

        console.error("Remove Project Member Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to remove member",
        });

    }

};

// ==========================================
// GET SECURITY GROUPS (with member counts)
// Phase 1: the 4 global default groups only —
// project_id-scoped custom groups are supported by
// the schema but not yet creatable from the UI.
// ==========================================

const getSecurityGroups = async (req, res) => {

    try {

        const [groups] = await pool.query(
            `
            SELECT
                psg.id,
                psg.name,
                psg.description,
                psg.is_default,
                (
                    SELECT COUNT(*) FROM project_members pm
                    WHERE pm.project_id = ? AND pm.security_group_id = psg.id
                ) AS member_count
            FROM project_security_groups psg
            WHERE psg.project_id IS NULL OR psg.project_id = ?
            ORDER BY psg.id
            `,
            [req.params.id, req.params.id]
        );

        // member_count is bigint (COUNT(*)) -- pg returns it as a
        // string; the frontend does a strict `=== 1` singular/plural
        // check on it, so it must be a real number.
        const normalizedGroups = groups.map((g) => ({
            ...g,
            member_count: Number(g.member_count),
        }));

        return res.json({ success: true, groups: normalizedGroups });

    } catch (error) {

        console.error("Get Security Groups Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load security groups",
        });

    }

};

// ==========================================
// GET PERMISSION MATRIX FOR A PROJECT
// One row per permission key, one column per
// group — project-specific overrides win over the
// group's global default (same resolution as
// getEffectivePermissions).
// ==========================================

const getPermissionMatrix = async (req, res) => {

    try {

        const [groups] = await pool.query(
            `SELECT id, name FROM project_security_groups WHERE project_id IS NULL OR project_id = ? ORDER BY id`,
            [req.params.id]
        );

        const [rows] = await pool.query(
            `
            SELECT security_group_id, project_id, permission_key, value
            FROM project_permissions
            WHERE (project_id IS NULL OR project_id = ?)
            AND security_group_id IN (${groups.map(() => "?").join(",") || "0"})
            `,
            [req.params.id, ...groups.map((g) => g.id)]
        );

        const matrix = {};

        for (const key of PERMISSION_KEYS) {

            matrix[key] = {};

            for (const group of groups) {

                const groupRows = rows.filter(
                    (r) => r.security_group_id === group.id && r.permission_key === key
                );

                const override = groupRows.find((r) => r.project_id !== null);
                const globalDefault = groupRows.find((r) => r.project_id === null);

                matrix[key][group.id] = (override || globalDefault)?.value || "not_set";

            }

        }

        return res.json({ success: true, groups, permissionKeys: PERMISSION_KEYS, matrix });

    } catch (error) {

        console.error("Get Permission Matrix Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load the permission matrix",
        });

    }

};

// ==========================================
// UPDATE ONE PERMISSION CELL
// Writes a PROJECT-SPECIFIC override row (never
// mutates the group's global default) — so
// customizing permissions on one project never
// silently changes another project's behavior.
// ==========================================

const updatePermission = async (req, res) => {

    try {

        const { securityGroupId, permissionKey, value } = req.body;

        if (!PERMISSION_KEYS.includes(permissionKey)) {
            return res.status(400).json({
                success: false,
                message: "Invalid permission key",
            });
        }

        if (!["allow", "deny", "not_set"].includes(value)) {
            return res.status(400).json({
                success: false,
                message: "Invalid permission value",
            });
        }

        const [groupRows] = await pool.query(
            `SELECT id, name FROM project_security_groups WHERE id = ? AND (project_id IS NULL OR project_id = ?) LIMIT 1`,
            [securityGroupId, req.params.id]
        );

        if (groupRows.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid security group",
            });
        }

        const [existing] = await pool.query(
            `SELECT id FROM project_permissions WHERE security_group_id = ? AND project_id = ? AND permission_key = ? LIMIT 1`,
            [securityGroupId, req.params.id, permissionKey]
        );

        if (existing.length > 0) {
            await pool.query(
                `UPDATE project_permissions SET value = ? WHERE id = ?`,
                [value, existing[0].id]
            );
        } else {
            await pool.query(
                `INSERT INTO project_permissions (security_group_id, project_id, permission_key, value) VALUES (?, ?, ?, ?)`,
                [securityGroupId, req.params.id, permissionKey, value]
            );
        }

        await logProjectActivity(
            req.params.id,
            req.user.id,
            "permission_changed",
            null,
            `${groupRows[0].name} — ${permissionKey} set to ${value}`
        );

        return res.json({ success: true, message: "Permission updated" });

    } catch (error) {

        console.error("Update Permission Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to update permission",
        });

    }

};

// ==========================================
// GET PROJECT ACTIVITY (membership/permission
// audit trail for this project)
// ==========================================

const getProjectActivity = async (req, res) => {

    try {

        const [activity] = await pool.query(
            `
            SELECT
                pa.id,
                pa.activity_type,
                pa.details,
                pa.created_at,
                actor.full_name AS actor_name,
                target.full_name AS target_name
            FROM project_activity pa
            JOIN users actor ON actor.id = pa.actor_id
            LEFT JOIN users target ON target.id = pa.target_user_id
            WHERE pa.project_id = ?
            ORDER BY pa.created_at DESC
            LIMIT 100
            `,
            [req.params.id]
        );

        return res.json({ success: true, activity });

    } catch (error) {

        console.error("Get Project Activity Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load project activity",
        });

    }

};

module.exports = {
    getMyPermissions,
    getMembers,
    getEligibleMembers,
    addMembers,
    changeMemberGroup,
    removeMember,
    getSecurityGroups,
    getPermissionMatrix,
    updatePermission,
    getProjectActivity,
};
