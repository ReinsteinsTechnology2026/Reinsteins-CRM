const pool = require("../config/db");

const { attachTagsToTasks } = require("./tagService");
const { PERMISSION_KEYS } = require("./projectPermissionService");

// ==========================================
// GET PROJECTS FOR ONE ORGANIZATION (Phase 2C)
// Unlike getAllProjects (membership/role-scoped),
// this is purely organization-scoped -- every project
// belonging to the organization, matching how
// getOrganizationMembers already shows every member
// regardless of the caller's own project membership.
// The caller (route) is responsible for authorizing
// access to the organization itself (adminOnly).
// ==========================================

const getProjectsByOrganization = async (organizationId) => {

    const [projects] = await pool.query(`
        SELECT
            p.*,
            owner.full_name AS owner_name,
            creator.full_name AS created_by_name,

            (
                SELECT COUNT(*)
                FROM project_members pm
                WHERE pm.project_id = p.id
            ) AS member_count,

            (
                SELECT COUNT(*)
                FROM user_stories us
                WHERE us.project_id = p.id
            ) AS user_story_count,

            (
                SELECT COUNT(*)
                FROM tasks t
                WHERE t.project_id = p.id
            ) AS task_count

        FROM projects p
        LEFT JOIN users owner
            ON owner.id = p.owner_id
        LEFT JOIN users creator
            ON creator.id = p.created_by
        WHERE p.organization_id = ?
        ORDER BY p.id DESC
    `, [organizationId]);

    // member_count/user_story_count/task_count come back from
    // PostgreSQL as strings (COUNT(*) is bigint) -- normalize to
    // numbers so frontend numeric comparisons (e.g. `=== 1` for
    // singular/plural labels) keep working as they did on MySQL.
    return projects.map((p) => ({
        ...p,
        member_count: Number(p.member_count),
        user_story_count: Number(p.user_story_count),
        task_count: Number(p.task_count),
    }));

};

// ==========================================
// GET ALL PROJECTS (with rollup stats)
//
// VISIBILITY SCOPING — membership-based, with
// exactly ONE narrow, explicitly-approved exception:
// role='admin' (the literal System Administrator
// account type, never a system_access tier like
// super_admin/executive) sees every organization
// project regardless of membership, for the
// organization-level Projects listing experience.
// Every other user, including every system_access
// tier short of role='admin', still sees ONLY
// projects where they have an explicit
// project_members row — this is unchanged from the
// original fix (Super Admin/Executive/Founder could
// previously see every project without a membership
// row; that defect is not reintroduced here, only a
// single deliberately-scoped admin exception is).
// This exception is visibility-only — it does not
// touch hasProjectPermission/canUserAccessProject, so
// every other project route (Backlog, Board,
// Sprints, Settings, task mutations, etc.) remains
// exactly as strict as before.
// ==========================================

const getAllProjects = async (user) => {

    const isOrgAdmin = user.role === "admin";

    const [projects] = await pool.query(`
        SELECT
            p.*,
            owner.full_name AS owner_name,
            creator.full_name AS created_by_name,

            (
                SELECT COUNT(*)
                FROM user_stories us
                WHERE us.project_id = p.id
            ) AS user_story_count,

            (
                SELECT COUNT(*)
                FROM tasks t
                WHERE t.project_id = p.id
            ) AS task_count,

            (
                SELECT ROUND(AVG(us_progress.progress))
                FROM (
                    SELECT
                        COALESCE(AVG(t.progress), 0) AS progress
                    FROM user_stories us
                    LEFT JOIN tasks t
                        ON t.user_story_id = us.id
                    WHERE us.project_id = p.id
                    GROUP BY us.id
                ) AS us_progress
            ) AS progress

        FROM projects p
        LEFT JOIN users owner
            ON owner.id = p.owner_id
        LEFT JOIN users creator
            ON creator.id = p.created_by
        ${isOrgAdmin ? "" : `
        WHERE EXISTS (
            SELECT 1 FROM project_members pm
            WHERE pm.project_id = p.id
            AND pm.user_id = ?
        )
        `}
        ORDER BY p.id DESC
    `, isOrgAdmin ? [] : [user.id]);

    // Same bigint-as-string normalization as getProjectsByOrganization.
    // `progress` is ROUND(AVG(...)) -- also numeric/string from pg.
    return projects.map((p) => ({
        ...p,
        user_story_count: Number(p.user_story_count),
        task_count: Number(p.task_count),
        progress: p.progress === null ? null : Number(p.progress),
    }));

};

// ==========================================
// GET ONE PROJECT (with rollup stats)
// ==========================================

const getProjectById = async (id, user) => {

    const [projects] = await pool.query(`
        SELECT
            p.*,
            owner.full_name AS owner_name,
            creator.full_name AS created_by_name
        FROM projects p
        LEFT JOIN users owner
            ON owner.id = p.owner_id
        LEFT JOIN users creator
            ON creator.id = p.created_by
        WHERE p.id = ?
        LIMIT 1
    `, [id]);

    if (projects.length === 0) {
        return null;
    }

    const project = projects[0];

    // Same membership-based visibility rule as the list, with the
    // same single narrow exception: role='admin' skips this check
    // (organization-level Project Overview visibility — see
    // getAllProjects above). Every other caller still needs an
    // explicit project_members row — a project not in the list must
    // not be reachable by guessing its id in the URL either. (This
    // mirrors canUserAccessProject() in projectPermissionService.js;
    // kept as a direct query here since this function already has the
    // project row loaded.)

    if (user?.role !== "admin") {

        const [[access]] = await pool.query(`
            SELECT EXISTS (
                SELECT 1 FROM project_members pm
                WHERE pm.project_id = ?
                AND pm.user_id = ?
            ) AS allowed
        `, [id, user.id]);

        if (!access?.allowed) {
            return null;
        }

    }

    const [taskStats] = await pool.query(`
        SELECT
            COUNT(*) AS total_tasks,
            SUM(CASE WHEN status = 'backlog' THEN 1 ELSE 0 END) AS backlog_count,
            SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) AS todo_count,
            SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
            SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END) AS pending_review_count,
            SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_count,
            SUM(
                CASE
                    WHEN status != 'closed'
                        AND due_date IS NOT NULL
                        AND due_date < CURRENT_DATE
                    THEN 1
                    ELSE 0
                END
            ) AS overdue_count
        FROM tasks
        WHERE project_id = ?
    `, [id]);

    const [storyCount] = await pool.query(`
        SELECT COUNT(*) AS total_user_stories
        FROM user_stories
        WHERE project_id = ?
    `, [id]);

    const [progressRow] = await pool.query(`
        SELECT ROUND(AVG(us_progress.progress)) AS progress
        FROM (
            SELECT
                COALESCE(AVG(t.progress), 0) AS progress
            FROM user_stories us
            LEFT JOIN tasks t
                ON t.user_story_id = us.id
            WHERE us.project_id = ?
            GROUP BY us.id
        ) AS us_progress
    `, [id]);

    return {

        ...project,

        user_story_count: Number(storyCount[0].total_user_stories),

        progress: Number(progressRow[0].progress) || 0,

        stats: {

            totalTasks: Number(taskStats[0].total_tasks),
            backlog: Number(taskStats[0].backlog_count),
            todo: Number(taskStats[0].todo_count),
            inProgress: Number(taskStats[0].in_progress_count),
            pendingReview: Number(taskStats[0].pending_review_count),
            completed: Number(taskStats[0].closed_count),
            overdue: Number(taskStats[0].overdue_count)

        }

    };

};

// ==========================================
// GET ALL TASKS FOR A PROJECT (flat, for Kanban)
// Same visibility rule as getProjectById — the
// caller is expected to have already confirmed
// access to this project before calling this.
// ==========================================

const getProjectTasks = async (projectId) => {

    const [tasks] = await pool.query(`
        SELECT
            t.id,
            t.task_number,
            t.task_title,
            t.task_description,
            t.priority,
            t.status,
            t.due_date,
            t.progress,
            t.user_story_id,
            us.title AS user_story_title,
            t.sprint_id,
            sp.name AS sprint_name,
            t.assigned_to,
            assignee.full_name AS assigned_to_name
        FROM tasks t
        LEFT JOIN user_stories us ON us.id = t.user_story_id
        LEFT JOIN sprints sp ON sp.id = t.sprint_id
        LEFT JOIN users assignee ON assignee.id = t.assigned_to
        WHERE t.project_id = ?
        ORDER BY t.id DESC
    `, [projectId]);

    return attachTagsToTasks(tasks);

};

// ==========================================
// CREATE PROJECT
//
// The creator (and the selected owner, if a
// different person) are automatically added as
// Project Administrators — otherwise, under the
// new membership-based visibility rule, a newly
// created project would be invisible to the very
// person who just created it. Nobody else gets
// access automatically; every other member must be
// added explicitly via the Members page.
// ==========================================

const createProject = async (data, createdBy, forcedOrganizationId) => {

    const {

        name,
        description,
        owner_id,
        status,
        priority,
        start_date,
        due_date

    } = data;

    // organizationId resolution -- two paths, in priority order:
    //
    // 1. forcedOrganizationId (Phase 2C): the caller already resolved
    //    a real organization from the route (e.g. POST
    //    /organizations/:id/projects) and is telling this function
    //    exactly which organization the new project belongs to,
    //    authoritatively -- never a client-supplied value, always
    //    re-derived server-side by the controller from req.params.id.
    //    Used as-is, no further lookup needed.
    //
    // 2. Fallback (original, unchanged behavior): the standalone
    //    POST /projects endpoint has no organization context at all,
    //    so the project inherits the creator's own organization --
    //    read from the denormalized users.organization_id (kept in
    //    sync by organizationMemberService.js; this is a plain
    //    scoping lookup, not an authorization decision, so reading
    //    the convenience column here is fine). NULL if the creator
    //    somehow has no organization yet -- addMembers' organization
    //    check treats a NULL project organization_id as "no
    //    constraint yet" rather than blocking every membership
    //    addition, so this never breaks project creation for an
    //    edge-case account.

    let organizationId = forcedOrganizationId || null;

    if (!organizationId) {

        const [[creatorRow]] = await pool.query(
            `SELECT organization_id FROM users WHERE id = ? LIMIT 1`,
            [createdBy]
        );

        organizationId = creatorRow?.organization_id || null;

    }

    const [result] = await pool.query(`
        INSERT INTO projects(
            name,
            description,
            owner_id,
            created_by,
            status,
            priority,
            start_date,
            due_date,
            organization_id
        )
        VALUES(?,?,?,?,?,?,?,?,?)
        RETURNING id
    `, [

        name,
        description || null,
        owner_id || null,
        createdBy,
        status || "planning",
        priority || "Medium",
        start_date || null,
        due_date || null,
        organizationId

    ]);

    const projectId = result[0].id;

    const adminGroupId = await ensureDefaultProjectAdministratorsGroupId();

    const membersToAdd = new Set([Number(createdBy)]);

    if (owner_id) {
        membersToAdd.add(Number(owner_id));
    }

    for (const userId of membersToAdd) {
        await pool.query(
            `
            INSERT INTO project_members (project_id, user_id, security_group_id, added_by)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (project_id, user_id) DO NOTHING
            `,
            [projectId, userId, adminGroupId, createdBy]
        );
    }

    return projectId;

};

// ==========================================
// DEFAULT "PROJECT ADMINISTRATORS" SECURITY GROUP
//
// createProject (above) has always assumed this global
// (project_id IS NULL), full-access security group
// already exists so it can grant it to a new project's
// creator/owner -- but nothing ever seeded it (no schema
// seed data, no provisioning step), so on a tenant where
// it was never created by chance, EVERY project's
// creator ended up with a project_members row pointing
// at a security group that doesn't exist, and every
// permission check for them then correctly (per the
// strict no-bypass model in projectPermissionService.js)
// denied everything. Self-healing here -- create it once,
// with every permission key granted -- means no separate
// migration/seed script is needed and existing tenants
// fix themselves on their very next project creation.
// ==========================================

const ensureDefaultProjectAdministratorsGroupId = async () => {

    const [[existing]] = await pool.query(
        `SELECT id FROM project_security_groups WHERE project_id IS NULL AND name = 'Project Administrators' AND is_default = TRUE LIMIT 1`
    );

    if (existing) {
        return existing.id;
    }

    const [inserted] = await pool.query(
        `
        INSERT INTO project_security_groups (project_id, name, description, is_default)
        VALUES (NULL, 'Project Administrators', 'Full access to every project -- automatically granted to a project''s creator and owner.', TRUE)
        RETURNING id
        `
    );
    const groupId = inserted[0].id;

    for (const permissionKey of PERMISSION_KEYS) {
        await pool.query(
            `
            INSERT INTO project_permissions (security_group_id, project_id, permission_key, value)
            VALUES (?, NULL, ?, 'allow')
            `,
            [groupId, permissionKey]
        );
    }

    return groupId;

};

// ==========================================
// UPDATE PROJECT
// ==========================================

const updateProject = async (id, data, actingUserId) => {

    const {

        name,
        description,
        owner_id,
        status,
        priority,
        start_date,
        due_date

    } = data;

    await pool.query(`
        UPDATE projects
        SET
            name=?,
            description=?,
            owner_id=?,
            status=?,
            priority=?,
            start_date=?,
            due_date=?
        WHERE id=?
    `, [

        name,
        description || null,
        owner_id || null,
        status,
        priority,
        start_date || null,
        due_date || null,
        id

    ]);

    // Same reasoning as createProject: a newly assigned owner must be
    // able to see/act on the project, not just be named on it. Without
    // this, reassigning ownership through Edit Project silently left
    // the new owner with no project_members row -- 403 on everything
    // beyond bare read, despite the UI showing them as Owner.
    if (owner_id) {

        const adminGroupId = await ensureDefaultProjectAdministratorsGroupId();

        await pool.query(
            `
            INSERT INTO project_members (project_id, user_id, security_group_id, added_by)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (project_id, user_id) DO NOTHING
            `,
            [id, Number(owner_id), adminGroupId, actingUserId]
        );

    }

};

// ==========================================
// DELETE PROJECT
//
// tasks.project_id is ON DELETE SET NULL (unlike
// every other project-owned table below, which is
// CASCADE) — left alone, a plain `DELETE FROM
// projects` would silently strand this project's
// tasks as detached "legacy" tasks instead of
// removing them. So tasks are deleted explicitly
// FIRST, which cascades (existing FKs, unchanged)
// to task_activity, task_attachments, task_mentions,
// task_work_logs, task_assignments, task_tags, and
// task_transfer_requests.
//
// Deleting the project row second then cascades
// (existing FKs, unchanged) to epics, features,
// user_stories, project_members, project_permissions,
// project_activity, project_security_groups, sprints,
// and work_item_links — work_item_links included,
// since every link's project_id always matches the
// shared project of both its endpoints (createLink
// only ever allows same-project links), so this
// project's rows are guaranteed to be exactly the
// rows this cascade removes, regardless of which
// item type (epic/feature/story/task) each link
// pointed at.
// ==========================================

const deleteProject = async (id) => {

    await pool.query(`DELETE FROM tasks WHERE project_id = ?`, [id]);

    await pool.query(`DELETE FROM projects WHERE id = ?`, [id]);

};

module.exports = {

    getAllProjects,
    getProjectsByOrganization,
    getProjectById,
    getProjectTasks,
    createProject,
    updateProject,
    deleteProject

};
