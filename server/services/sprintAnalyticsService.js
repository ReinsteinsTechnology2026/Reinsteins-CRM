const pool = require("../config/db");

// ==========================================
// SPRINT ANALYTICS SERVICE
//
// Deliberately separate from sprintService.js (one
// concern per service, matching this codebase's
// existing convention) -- read-only aggregation
// queries over the existing tasks/task_work_logs
// tables, scoped to a single sprint_id. No new
// tables, no new columns, no writes.
//
// Reliable metrics only (per the approved plan):
// progress %, completed/remaining, status
// distribution, priority distribution, overdue,
// pending review, assignee workload, hours logged.
// Burndown and tasks-added/removed-during-sprint are
// intentionally NOT implemented here -- the existing
// data (no daily snapshots, no structured sprint-
// membership history) cannot support them without
// either a misleading approximation or a schema
// change, both out of scope for this version.
// ==========================================

const getSprintAnalytics = async (sprintId) => {

    const [[sprint]] = await pool.query(
        `
        SELECT
            s.id, s.project_id, s.name, s.goal, s.start_date, s.end_date,
            s.status, s.created_at,
            p.name AS project_name
        FROM sprints s
        INNER JOIN projects p ON p.id = s.project_id
        WHERE s.id = ?
        LIMIT 1
        `,
        [sprintId]
    );

    if (!sprint) {
        return null;
    }

    // ======================================
    // STATUS DISTRIBUTION + OVERDUE + PENDING REVIEW
    // ======================================

    const [[statusCounts]] = await pool.query(
        `
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'backlog' THEN 1 ELSE 0 END) AS backlog,
            SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) AS todo,
            SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
            SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END) AS pending_review,
            SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed,
            SUM(CASE WHEN due_date < CURRENT_DATE AND status != 'closed' THEN 1 ELSE 0 END) AS overdue
        FROM tasks
        WHERE sprint_id = ?
        AND deleted_at IS NULL
        `,
        [sprintId]
    );

    const total = Number(statusCounts.total) || 0;
    const closed = Number(statusCounts.closed) || 0;

    // ======================================
    // PRIORITY DISTRIBUTION
    // ======================================

    const [priorityRows] = await pool.query(
        `
        SELECT
            COALESCE(priority, 'Not set') AS priority,
            COUNT(*) AS count
        FROM tasks
        WHERE sprint_id = ?
        AND deleted_at IS NULL
        GROUP BY COALESCE(priority, 'Not set')
        `,
        [sprintId]
    );

    // ======================================
    // ASSIGNEE WORKLOAD (task counts)
    // ======================================

    const [workloadRows] = await pool.query(
        `
        SELECT
            u.id AS user_id,
            u.full_name,
            COUNT(*) AS total_tasks,
            SUM(CASE WHEN t.status != 'closed' THEN 1 ELSE 0 END) AS open_tasks,
            SUM(CASE WHEN t.status = 'closed' THEN 1 ELSE 0 END) AS completed_tasks
        FROM tasks t
        INNER JOIN users u ON u.id = t.assigned_to
        WHERE t.sprint_id = ?
        AND t.deleted_at IS NULL
        GROUP BY u.id, u.full_name
        ORDER BY total_tasks DESC, u.full_name ASC
        `,
        [sprintId]
    );

    // ======================================
    // HOURS LOGGED PER ASSIGNEE
    // Kept as a separate query (rather than joined
    // into the workload query above) specifically to
    // avoid a join fan-out -- a task with multiple
    // task_work_logs rows would otherwise inflate
    // total_tasks/open_tasks/completed_tasks above.
    // Scoped to the task's CURRENT assignee (workload
    // is about who owns the work now, not historical
    // attribution of who logged which hours).
    // ======================================

    const [hoursRows] = await pool.query(
        `
        SELECT
            t.assigned_to AS user_id,
            SUM(wl.hours_worked) AS hours_logged
        FROM task_work_logs wl
        INNER JOIN tasks t ON t.id = wl.task_id
        WHERE t.sprint_id = ?
        AND t.assigned_to IS NOT NULL
        AND t.deleted_at IS NULL
        GROUP BY t.assigned_to
        `,
        [sprintId]
    );

    const hoursByUserId = new Map(
        hoursRows.map((row) => [Number(row.user_id), Number(row.hours_logged) || 0])
    );

    const assigneeWorkload = workloadRows.map((row) => ({
        userId: row.user_id,
        fullName: row.full_name,
        totalTasks: Number(row.total_tasks) || 0,
        openTasks: Number(row.open_tasks) || 0,
        completedTasks: Number(row.completed_tasks) || 0,
        hoursLogged: hoursByUserId.get(Number(row.user_id)) || 0,
    }));

    return {

        sprint: {
            id: sprint.id,
            projectId: sprint.project_id,
            projectName: sprint.project_name,
            name: sprint.name,
            goal: sprint.goal,
            startDate: sprint.start_date,
            endDate: sprint.end_date,
            status: sprint.status,
        },

        summary: {
            totalTasks: total,
            completedTasks: closed,
            remainingTasks: total - closed,
            progressPercent: total > 0 ? Math.round((closed / total) * 100) : 0,
            overdueTasks: Number(statusCounts.overdue) || 0,
            pendingReviewTasks: Number(statusCounts.pending_review) || 0,
        },

        statusDistribution: {
            backlog: Number(statusCounts.backlog) || 0,
            todo: Number(statusCounts.todo) || 0,
            inProgress: Number(statusCounts.in_progress) || 0,
            pendingReview: Number(statusCounts.pending_review) || 0,
            closed,
        },

        priorityDistribution: priorityRows.map((row) => ({
            priority: row.priority,
            count: Number(row.count) || 0,
        })),

        assigneeWorkload,

    };

};

module.exports = {
    getSprintAnalytics,
};
