const pool = require("../config/db");
const { createNotification } = require("../services/notificationService");
const {
    taskDueSoonEmail,
    taskOverdueEmail,
} = require("../services/emailTemplates");

// ==========================================
// NOTIFICATION SWEEP — DUE SOON / OVERDUE
//
// The one notification path in this feature that
// isn't triggered by a single user action -- it's
// a small periodic job, deliberately kept out of
// app.js (per the approved architecture) and
// isolated in its own module so it's easy to find,
// disable, or reconfigure without touching request
// handling at all.
//
// Recipient is always the task's own assigned_to --
// never anything client-supplied, since this job
// has no request/client input at all. A task's
// assignee always has visibility into their own
// task regardless of project membership rules
// (they're the assignee), so no extra permission
// check is needed there; this job additionally
// skips tasks whose project is completed/cancelled
// and assignees who are no longer active, so it
// never nags about dead work.
//
// Duplicate prevention: before creating a
// task_due_soon or task_overdue notification for a
// given (user, task), it checks whether one of that
// exact type already exists for that task+user and
// skips if so -- so re-running the sweep every hour
// against a task that's still "due in 2 days"
// creates exactly one notification, not one per
// sweep tick. (Known limitation: if a task's due
// date is pushed out and then pulled back in, the
// old notification row still counts as "already
// notified" — documented, not fixed, to keep this
// change additive and simple.)
// ==========================================

const DUE_SOON_WINDOW_DAYS = Number(process.env.NOTIFICATION_DUE_SOON_DAYS) || 2;
const SWEEP_INTERVAL_MS = Number(process.env.NOTIFICATION_SWEEP_INTERVAL_MS) || 60 * 60 * 1000; // hourly
const SWEEP_ENABLED = process.env.NOTIFICATION_SWEEP_ENABLED !== "false"; // enabled unless explicitly disabled

let intervalHandle = null;

async function hasExistingNotification(userId, taskId, type) {

    const [rows] = await pool.query(
        `
        SELECT id FROM notifications
        WHERE user_id = ?
        AND reference_type = 'task'
        AND reference_id = ?
        AND type = ?
        LIMIT 1
        `,
        [userId, taskId, type]
    );

    return rows.length > 0;

}

function formatDueDate(dueDate) {
    return new Date(dueDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

// ==========================================
// RUN ONE SWEEP PASS
// Exported separately from the interval so it can
// be invoked directly (e.g. from a test script or a
// future manual "run now" admin action) without
// waiting for the timer.
// ==========================================

async function runSweepOnce(io) {

    const [candidates] = await pool.query(
        `
        SELECT
            t.id, t.task_number, t.task_title, t.assigned_to, t.due_date, t.project_id,
            p.name AS project_name, p.status AS project_status,
            u.employment_status AS assignee_status
        FROM tasks t
        LEFT JOIN projects p ON p.id = t.project_id
        LEFT JOIN users u ON u.id = t.assigned_to
        WHERE t.assigned_to IS NOT NULL
        AND t.status != 'closed'
        AND t.due_date IS NOT NULL
        `
    );

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dueSoonCutoff = new Date(today);
    dueSoonCutoff.setDate(dueSoonCutoff.getDate() + DUE_SOON_WINDOW_DAYS);

    let dueSoonCreated = 0;
    let overdueCreated = 0;

    for (const task of candidates) {

        if (task.project_id && ["completed", "cancelled"].includes(task.project_status)) {
            continue;
        }

        if (task.assignee_status !== "active") {
            continue;
        }

        const dueDate = new Date(task.due_date);
        dueDate.setHours(0, 0, 0, 0);

        const isOverdue = dueDate < today;
        const isDueSoon = !isOverdue && dueDate <= dueSoonCutoff;

        if (!isOverdue && !isDueSoon) {
            continue;
        }

        const type = isOverdue ? "task_overdue" : "task_due_soon";

        // eslint-disable-next-line no-await-in-loop
        if (await hasExistingNotification(task.assigned_to, task.id, type)) {
            continue;
        }

        const dueDateLabel = formatDueDate(task.due_date);

        const emailBuilder = isOverdue ? taskOverdueEmail : taskDueSoonEmail;

        const email = emailBuilder({
            taskTitle: task.task_title,
            taskNumber: task.task_number || task.id,
            projectName: task.project_name,
            dueDateLabel,
            taskId: task.id,
        });

        const title = isOverdue ? "Task overdue" : "Task due soon";

        const message = isOverdue
            ? `"${task.task_title}" was due on ${dueDateLabel} and is still open.`
            : `"${task.task_title}" is due on ${dueDateLabel}.`;

        // eslint-disable-next-line no-await-in-loop
        await createNotification({
            io,
            userId: task.assigned_to,
            title,
            message,
            type,
            referenceType: "task",
            referenceId: task.id,
            email,
        });

        if (isOverdue) {
            overdueCreated += 1;
        } else {
            dueSoonCreated += 1;
        }

    }

    if (dueSoonCreated > 0 || overdueCreated > 0) {
        console.log(`[notificationSweep] Created ${dueSoonCreated} due-soon and ${overdueCreated} overdue notification(s).`);
    }

    return { dueSoonCreated, overdueCreated };

}

// ==========================================
// START / STOP
// start(io) is called once from app.js. Safe to
// call multiple times (e.g. in tests) -- it clears
// any previous interval first.
// ==========================================

function start(io) {

    if (!SWEEP_ENABLED) {
        console.log("[notificationSweep] Disabled via NOTIFICATION_SWEEP_ENABLED=false.");
        return;
    }

    if (intervalHandle) {
        clearInterval(intervalHandle);
    }

    intervalHandle = setInterval(() => {
        runSweepOnce(io).catch((error) => {
            console.error("[notificationSweep] Sweep pass failed:", error.message);
        });
    }, SWEEP_INTERVAL_MS);

    // Unref so this timer never keeps the process alive on its own
    // (matches how the rest of this app already relies on the HTTP
    // server as the sole reason to stay running).
    if (intervalHandle.unref) {
        intervalHandle.unref();
    }

    console.log(`[notificationSweep] Started (interval: ${SWEEP_INTERVAL_MS}ms, due-soon window: ${DUE_SOON_WINDOW_DAYS} day(s)).`);

}

function stop() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
}

module.exports = {
    start,
    stop,
    runSweepOnce,
};
