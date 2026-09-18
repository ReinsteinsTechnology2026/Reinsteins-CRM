const pool = require("../config/db");

const { setTaskTags, attachTagsToTasks } = require("./tagService");

const { deleteLinksForItem } = require("./workItemLinkService");
const { generateNextTaskNumber, taskCode } = require("./workItemCodeService");

// ==========================================
// CROSS-PROJECT PARENT VALIDATION (Task)
// Same pattern as featureService.assertEpicBelongsToProject /
// userStoryService.assertFeatureBelongsToProject -- a User Story or
// Sprint id supplied for a Task is validated against its ACTUAL
// project_id, read fresh from the database, never trusted from the
// request body. This closes the one gap identified in the existing
// hierarchy validation: Task's user_story_id previously had no
// equivalent assertion at all (userStoryService.createTaskForUserStory
// sidesteps it by deriving project_id from the story row itself, and
// the legacy taskController.js never touches user_story_id at all --
// neither of those paths needed this, but the new Project-level and
// Sprint-level Task creation entry points below do).
// ==========================================

const CROSS_PROJECT_ERROR = "CrossProjectParentError";

async function assertUserStoryBelongsToProject(userStoryId, projectId) {

    if (userStoryId === null || userStoryId === undefined || userStoryId === "") {
        return;
    }

    const [[story]] = await pool.query(
        `SELECT project_id FROM user_stories WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [userStoryId]
    );

    if (!story) {
        const error = new Error("Selected User Story does not exist");
        error.name = CROSS_PROJECT_ERROR;
        throw error;
    }

    if (Number(story.project_id) !== Number(projectId)) {
        const error = new Error("Selected User Story belongs to a different project");
        error.name = CROSS_PROJECT_ERROR;
        throw error;
    }

}

async function assertSprintBelongsToProject(sprintId, projectId) {

    if (sprintId === null || sprintId === undefined || sprintId === "") {
        return;
    }

    const [[sprint]] = await pool.query(
        `SELECT project_id FROM sprints WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [sprintId]
    );

    if (!sprint) {
        const error = new Error("Selected Sprint does not exist");
        error.name = CROSS_PROJECT_ERROR;
        throw error;
    }

    if (Number(sprint.project_id) !== Number(projectId)) {
        const error = new Error("Selected Sprint belongs to a different project");
        error.name = CROSS_PROJECT_ERROR;
        throw error;
    }

}

// ==========================================
// GET ACTIVE EMPLOYEES
// ==========================================

const getActiveEmployees = async () => {

    const [employees] = await pool.query(`
        SELECT
            id,
            employee_id,
            full_name,
            role
        FROM users
        WHERE status='active'
        ORDER BY full_name
    `);

    return employees;

};

// ==========================================
// GET TRANSFER TARGETS
// Every active Employee/Intern (role='employee',
// employment_status='active') — unscoped, since
// a task's current assignee may transfer it to
// anyone active per the simplified transfer rule.
// Excludes the System Admin account (role='admin')
// deliberately, matching "active Employee or
// Intern".
// ==========================================

const getTransferTargets = async () => {

    const [rows] = await pool.query(`
        SELECT id, employee_id, full_name
        FROM users
        WHERE role = 'employee'
        AND employment_status = 'active'
        ORDER BY full_name
    `);

    return rows;

};

// ==========================================
// GET PROJECT MEMBER EMPLOYEES
// The eligible-assignee pool for a project-linked task —
// EXPLICIT project_members of this project only, never the
// org-wide reporting hierarchy getActiveEmployees/isWithinScope
// use for legacy (non-project) tasks.
// ==========================================

const getProjectMemberEmployees = async (projectId) => {

    const [rows] = await pool.query(`
        SELECT u.id, u.employee_id, u.full_name, u.role
        FROM project_members pm
        JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = ?
        AND u.employment_status = 'active'
        ORDER BY u.full_name
    `, [projectId]);

    return rows;

};

// ==========================================
// GET ALL TASKS
// ==========================================

// Project-linked tasks (t.project_id NOT NULL) are only ever
// included for a caller who is an explicit member of that project —
// this is the same "no project membership = no project access" rule
// enforced everywhere else, applied here as an additive filter so it
// can only ever remove rows, never add ones the pre-existing
// assigned_to/assigned_by (or admin) rule wouldn't already have
// returned. Non-project tasks (t.project_id IS NULL) are completely
// unaffected.
const PROJECT_MEMBERSHIP_FILTER = `
    AND (
        t.project_id IS NULL
        OR EXISTS (
            SELECT 1 FROM project_members pm
            WHERE pm.project_id = t.project_id
            AND pm.user_id = ?
        )
    )
`;

const getAllTasks = async (user) => {

    if (user.role === "admin") {

        const [tasks] = await pool.query(`
            SELECT
                t.*,
                u1.full_name AS assigned_to_name,
                u2.full_name AS assigned_by_name,
                p.name AS project_name,
                us.title AS user_story_title,
                sp.name AS sprint_name
            FROM tasks t
            LEFT JOIN users u1
                ON u1.id = t.assigned_to
            LEFT JOIN users u2
                ON u2.id = t.assigned_by
            LEFT JOIN projects p
                ON p.id = t.project_id
            LEFT JOIN user_stories us
                ON us.id = t.user_story_id
            LEFT JOIN sprints sp
                ON sp.id = t.sprint_id
            WHERE t.deleted_at IS NULL
            ${PROJECT_MEMBERSHIP_FILTER}
            ORDER BY t.id DESC
        `, [user.id]);

        return attachTaskDisplayData(tasks);

    }

    const [tasks] = await pool.query(`
        SELECT
            t.*,
            u1.full_name AS assigned_to_name,
            u2.full_name AS assigned_by_name,
            p.name AS project_name,
            us.title AS user_story_title,
            sp.name AS sprint_name
        FROM tasks t
        LEFT JOIN users u1
            ON u1.id = t.assigned_to
        LEFT JOIN users u2
            ON u2.id = t.assigned_by
        LEFT JOIN projects p
            ON p.id = t.project_id
        LEFT JOIN user_stories us
            ON us.id = t.user_story_id
        LEFT JOIN sprints sp
            ON sp.id = t.sprint_id
        WHERE
            (
                t.assigned_to = ?
                OR
                t.assigned_by = ?
            )
            AND t.deleted_at IS NULL
            ${PROJECT_MEMBERSHIP_FILTER}
        ORDER BY t.id DESC
    `, [

        user.id,
        user.id,
        user.id

    ]);

    return attachTaskDisplayData(tasks);

};

// ==========================================
// ATTACH TAGS + DISPLAY CODE
// taskCode() is display-only (see workItemCodeService.js) -- never
// changes the stored task_number, only what a project-linked task's
// row exposes as task_code for the frontend to show ("TASK-001").
// ==========================================

async function attachTaskDisplayData(tasks) {

    await attachTagsToTasks(tasks);

    for (const task of tasks) {
        task.task_code = taskCode(task);
    }

    return tasks;

}

// ==========================================
// GET ONE TASK'S project_id, IGNORING deleted_at
// Used only by the Recycle Bin restore/permanent-delete controller
// actions, which must be able to look up a SOFT-DELETED task's
// project (to check permission) -- getTaskDetailById deliberately
// excludes soft-deleted rows everywhere else.
// ==========================================

const getTaskProjectIdRaw = async (id) => {

    const [[row]] = await pool.query(
        `SELECT id, project_id FROM tasks WHERE id = ? LIMIT 1`,
        [id]
    );

    return row || null;

};

// ==========================================
// GET ONE TASK (with project/user story names)
// ==========================================

const getTaskDetailById = async (id) => {

    const [tasks] = await pool.query(`
        SELECT
            t.*,
            u1.full_name AS assigned_to_name,
            u2.full_name AS assigned_by_name,
            p.name AS project_name,
            us.title AS user_story_title,
            sp.name AS sprint_name
        FROM tasks t
        LEFT JOIN users u1
            ON u1.id = t.assigned_to
        LEFT JOIN users u2
            ON u2.id = t.assigned_by
        LEFT JOIN projects p
            ON p.id = t.project_id
        LEFT JOIN user_stories us
            ON us.id = t.user_story_id
        LEFT JOIN sprints sp
            ON sp.id = t.sprint_id
        WHERE t.id = ?
        AND t.deleted_at IS NULL
        LIMIT 1
    `, [id]);

    if (!tasks[0]) {
        return null;
    }

    await attachTaskDisplayData(tasks);

    return tasks[0];

};

// ==========================================
// CREATE TASK
// ==========================================

const createTask = async (data) => {

let {

    title,
    description,
    assigned_to,
    assigned_by,
    priority,
    status,
    due_date,
    estimated_hours,
    tags

} = data;

// Convert UI status to DB status
switch ((status || "").toLowerCase()) {

    case "new":
        status = "todo";
        break;

    case "active":
    case "in progress":
        status = "in_progress";
        break;

    case "on hold":
        status = "todo";
        break;

    case "pending review":
        status = "pending_review";
        break;

    case "completed":
    case "closed":
        status = "closed";
        break;

    default:
        status = "in_progress";
}

    // ==========================================
    // GET NEXT TASK NUMBER
    // ==========================================

    const [rows] = await pool.query(`
        SELECT task_number
        FROM tasks
        ORDER BY id DESC
        LIMIT 1
    `);

    let nextTaskNumber = 1;

    if (rows.length > 0 && rows[0].task_number != null) {

        const current = String(rows[0].task_number);

        const number = parseInt(
            current.replace(/\D/g, ""),
            10
        );

        nextTaskNumber = Number.isNaN(number)
            ? 1
            : number + 1;
    }

    // ==========================================
    // INSERT TASK
    // ==========================================

    await pool.query(

        `
        INSERT INTO tasks(

            task_number,
            user_id,
            assigned_to,
            assigned_by,
            task_title,
            task_description,
            priority,
            status,
            due_date,
            estimated_hours,
            tags,
            progress

        )

        VALUES(

            ?,?,?,?,?,?,?,?,?,?,?,?

        )
        `,

        [

            nextTaskNumber,

            Number(assigned_by),

            Number(assigned_to),

            Number(assigned_by),

            title,

            description,

            priority,

            status,

            due_date || null,

            estimated_hours || null,

            tags || null,

            0

        ]

    );

};

// ==========================================
// CREATE PROJECT-LINKED TASK (direct)
//
// Powers two new entry points that didn't exist before:
//   - Project -> "Create Task" (Part 5 of the spec) -- user_story_id
//     is OPTIONAL here (a task may belong to a Project without going
//     through a User Story at all).
//   - Sprint -> "Create Task" (Part 8) -- sprint_id is forced by the
//     caller, user_story_id remains optional.
//
// Both user_story_id and sprint_id, if supplied, are validated
// against the SAME project_id server-side (never trusted from the
// client) -- this is the Task-level equivalent of
// featureService.assertEpicBelongsToProject /
// userStoryService.assertFeatureBelongsToProject, closing the one gap
// identified during investigation (Task's user_story_id previously had
// no such assertion anywhere).
//
// Deliberately separate from the legacy createTask() above (which
// stays untouched for the non-project "My Tasks" flow) and from
// userStoryService.createTaskForUserStory (which stays untouched for
// its existing User Story -> "Create Task" entry point) -- this is a
// THIRD, new call site, not a replacement for either.
// ==========================================

const createProjectLinkedTask = async (projectId, data, assignedBy) => {

    const {
        title,
        description,
        assigned_to,
        priority,
        due_date,
        estimated_hours,
        tags,
        tagNames,
        user_story_id,
        sprint_id
    } = data;

    await assertUserStoryBelongsToProject(user_story_id, projectId);
    await assertSprintBelongsToProject(sprint_id, projectId);

    const nextTaskNumber = await generateNextTaskNumber();

    const [result] = await pool.query(`
        INSERT INTO tasks(
            task_number,
            user_id,
            project_id,
            user_story_id,
            sprint_id,
            assigned_to,
            assigned_by,
            task_title,
            task_description,
            priority,
            status,
            due_date,
            estimated_hours,
            tags,
            progress
        )
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        RETURNING id
    `, [

        nextTaskNumber,
        Number(assignedBy),
        projectId,
        user_story_id || null,
        sprint_id || null,
        Number(assigned_to),
        Number(assignedBy),
        title,
        description,
        priority || "Medium",
        "backlog",
        due_date || null,
        estimated_hours || null,
        tags || null,
        0

    ]);

    await setTaskTags(result[0].id, tagNames);

    return result[0].id;

};

// ==========================================
// UPDATE TASK
// ==========================================

// Normalizes due_date to MySQL DATE format (YYYY-MM-DD).
// The tasks.due_date column is DATE, but callers (e.g. the employee
// status-update flow) may resend the task's due_date as the ISO
// datetime string the API returned it as (e.g. from Date/JSON), which
// MySQL's DATE column rejects.
const normalizeDueDate = (value) => {

    if (!value) return null;

    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return value;
    }

    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
        return null;
    }

    return parsed.toISOString().slice(0, 10);

};

const updateTask = async (id, data) => {

    const {

        title,
        description,
        assigned_to,
        priority,
        status,
        due_date,
        estimated_hours,
        tags,
        tagNames

    } = data;

    await pool.query(

        `
        UPDATE tasks
        SET
            task_title=?,
            task_description=?,
            assigned_to=?,
            priority=?,
            status=?,
            due_date=?,
            estimated_hours=?,
            tags=?
        WHERE id=?
        `,

        [

            title,
            description,
            assigned_to,
            priority,
            status,
            normalizeDueDate(due_date),
            estimated_hours || null,
            tags || null,
            id

        ]

    );

    // tagNames is only present when the Edit Task form actually
    // submitted it -- callers that update a task for an unrelated
    // reason (e.g. Submit for Review) never include this field, and
    // must never have their existing tags silently wiped as a side
    // effect. An explicit [] (all chips removed and saved) is a real,
    // intentional "clear all tags" and is still honored.
    if (tagNames !== undefined) {
        await setTaskTags(id, tagNames);
    }

};

// ==========================================
// UPDATE TASK STATUS ONLY (Kanban move)
// Deliberately touches ONLY the status column —
// updateTask() above does a full-field UPDATE and
// would null out title/description/assignee/etc.
// if called with a partial {status} payload, so
// Kanban must never use it for this.
// ==========================================

const VALID_STATUSES = ["backlog", "todo", "in_progress", "pending_review", "closed"];

const updateTaskStatus = async (id, status) => {

    if (!VALID_STATUSES.includes(status)) {
        throw new Error("Invalid task status");
    }

    await pool.query(
        `UPDATE tasks SET status = ? WHERE id = ?`,
        [status, id]
    );

};

// ==========================================
// ASSIGN TASK TO SPRINT (or back to Backlog when
// sprintId is null) — deliberately touches ONLY
// the sprint_id column, same reasoning as
// updateTaskStatus above.
// ==========================================

const assignTaskToSprint = async (id, sprintId) => {

    await pool.query(
        `UPDATE tasks SET sprint_id = ? WHERE id = ?`,
        [sprintId, id]
    );

};

// ==========================================
// TRANSFER TASK
// ==========================================

const transferTask = async (

    taskId,

    assignedBy,

    assignedTo,

    remarks

) => {

    await pool.query(

        `
        UPDATE tasks
        SET assigned_to=?
        WHERE id=?
        `,

        [

            assignedTo,

            taskId

        ]

    );

    await pool.query(

        `
        INSERT INTO task_assignments(

            task_id,
            assigned_by,
            assigned_to,
            remarks

        )

        VALUES(?,?,?,?)
        `,

        [

            taskId,

            assignedBy,

            assignedTo,

            remarks

        ]

    );

};

// ==========================================
// ADMIN - APPROVE & CLOSE TASK
// ==========================================

const approveAndCloseTask = async (id) => {

    await pool.query(

        `
        UPDATE tasks
        SET
            status='closed',
            progress=100
        WHERE id=?
        `,

        [id]

    );

};

// ==========================================
// ADMIN - SEND TASK BACK TO EMPLOYEE
// ==========================================

const sendBackTask = async (id) => {

    await pool.query(

        `
        UPDATE tasks
        SET status='in_progress'
        WHERE id=?
        `,

        [id]

    );

};

// ==========================================
// ASSIGN / REASSIGN TASK (project management
// action, distinct from transferTask above).
// Touches only tasks.assigned_to -- history is
// logged by the caller via task_activity, not
// task_assignments, which is transfer-specific
// (see transferTask above).
// ==========================================

const assignTask = async (taskId, assignedTo) => {

    await pool.query(
        `UPDATE tasks SET assigned_to=? WHERE id=?`,
        [assignedTo, taskId]
    );

};

// ==========================================
// DELETE TASK
// ==========================================

const deleteTask = async (id) => {

    // See epicService.deleteEpic -- same explicit cleanup, same reason
    // (no DB-level FK can span 4 target tables).
    await deleteLinksForItem("task", id);

    await pool.query(

        `
        DELETE FROM tasks
        WHERE id=?
        `,

        [id]

    );

};

module.exports = {

    CROSS_PROJECT_ERROR,
    getActiveEmployees,
    getTransferTargets,
    getProjectMemberEmployees,
    getAllTasks,
    getTaskDetailById,
    getTaskProjectIdRaw,
    createTask,
    createProjectLinkedTask,
    updateTask,
    updateTaskStatus,
    assignTaskToSprint,
    transferTask,
    assignTask,
    approveAndCloseTask,
    sendBackTask,
    deleteTask

};