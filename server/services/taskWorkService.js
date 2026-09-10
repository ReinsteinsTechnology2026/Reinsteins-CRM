const pool = require("../config/db");

// ==========================================
// STATUS TRANSLATION
//
// tasks.status and task_work_logs.status are two
// separate, non-overlapping ENUM vocabularies:
//
//   tasks.status:          backlog | todo | in_progress | pending_review | closed
//   task_work_logs.status: New | Assigned | In Progress | On Hold | Review | Completed | Closed
//
// stopWork's incoming `status` argument is always one
// of the task_work_logs values (see WorkLogModal.jsx's
// dropdown, the only caller) -- task_work_logs.status
// keeps receiving it unchanged below (it's already
// valid there). This map translates the SAME value
// into the closest EXISTING tasks.status value for the
// task row's own workflow status, so both writes stay
// within their table's real schema. No new status is
// introduced on either side.
// ==========================================

const WORK_LOG_TO_TASK_STATUS = {
    "New": "todo",
    "Assigned": "todo",
    "In Progress": "in_progress",
    "On Hold": "in_progress",
    "Review": "pending_review",
    "Completed": "closed",
    "Closed": "closed",
};

function toTaskStatus(workLogStatus) {
    return WORK_LOG_TO_TASK_STATUS[workLogStatus] || "in_progress";
}

// ==========================================
// START WORK
// ==========================================

const startWork = async (taskId) => {

    await pool.query(

        `
        UPDATE tasks
        SET
            current_working = TRUE,
            work_started_at = NOW(),
            status = 'in_progress'
        WHERE id = ?
        `,

        [taskId]

    );

};

// ==========================================
// STOP WORK
// ==========================================

const stopWork = async (

    taskId,

    employeeId,

    workDescription,

    progress,

    status

) => {

    const [[task]] = await pool.query(

        `
        SELECT
            work_started_at
        FROM tasks
        WHERE id = ?
        `,

        [taskId]

    );

    const [[hours]] = await pool.query(

        `
        SELECT
            ROUND(
                FLOOR(
                    EXTRACT(EPOCH FROM (NOW() - ?::timestamp)) / 60
                ) / 60,
                2
            ) AS worked
        `,

        [

            task.work_started_at

        ]

    );

    await pool.query(

        `
        INSERT INTO task_work_logs(

            task_id,

            employee_id,

            work_description,

            hours_worked,

            progress,

            status

        )

        VALUES(

            ?,?,?,?,?,?

        )
        `,

        [

            taskId,

            employeeId,

            workDescription,

            hours.worked,

            progress,

            status

        ]

    );

    await pool.query(

        `
        UPDATE tasks
        SET

            progress=?,

            status=?,

            current_working=FALSE,

            work_started_at=NULL

        WHERE id=?

        `,

        [

            progress,

            toTaskStatus(status),

            taskId

        ]

    );

};

module.exports = {

    startWork,

    stopWork

};