const pool = require("../config/db");

const { setTaskTags, attachTagsToTasks } = require("./tagService");

const { deleteLinksForItem } = require("./workItemLinkService");

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
            WHERE 1=1
            ${PROJECT_MEMBERSHIP_FILTER}
            ORDER BY t.id DESC
        `, [user.id]);

        return attachTagsToTasks(tasks);

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
            ${PROJECT_MEMBERSHIP_FILTER}
        ORDER BY t.id DESC
    `, [

        user.id,
        user.id,
        user.id

    ]);

    return attachTagsToTasks(tasks);

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
        LIMIT 1
    `, [id]);

    if (!tasks[0]) {
        return null;
    }

    await attachTagsToTasks(tasks);

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

    case "in progress":
        status = "in_progress";
        break;

    case "pending review":
        status = "pending_review";
        break;

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

    getActiveEmployees,
    getTransferTargets,
    getProjectMemberEmployees,
    getAllTasks,
    getTaskDetailById,
    createTask,
    updateTask,
    updateTaskStatus,
    assignTaskToSprint,
    transferTask,
    assignTask,
    approveAndCloseTask,
    sendBackTask,
    deleteTask

};