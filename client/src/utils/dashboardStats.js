// ==========================================
// SHARED DASHBOARD DERIVATION HELPERS
// Pure functions over the SAME already-loaded,
// already permission-scoped task list every other
// page already fetches via taskManagementService.
// getTasks() (see AdminTasksList/EmployeeTasks) --
// this only ever groups/counts what's already
// visible to the caller, never widens it and never
// calls a new endpoint. Mirrors the client-side
// filtering approach already established by
// utils/taskFilter.js.
// ==========================================

const DUE_SOON_DAYS = 7;

function startOfToday() {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now;
}

function isMine(task, userId) {
    return userId === undefined || userId === null
        ? true
        : Number(task.assigned_to) === Number(userId);
}

// ==========================================
// ACTIVE TASKS
// Assigned + not yet submitted/closed -- the
// work the assignee is actively responsible for
// moving forward right now.
// ==========================================

export function getActiveTasks(tasks, userId) {

    return (tasks || []).filter((task) =>
        isMine(task, userId) &&
        (task.status === "todo" || task.status === "in_progress")
    );

}

// ==========================================
// DUE SOON
// Not closed, has a due date within the next
// DUE_SOON_DAYS days (today included), not
// already overdue.
// ==========================================

export function getDueSoonTasks(tasks, userId, days = DUE_SOON_DAYS) {

    const today = startOfToday();
    const horizon = new Date(today);
    horizon.setDate(horizon.getDate() + days);

    return (tasks || []).filter((task) => {

        if (!isMine(task, userId)) return false;
        if (task.status === "closed") return false;
        if (!task.due_date) return false;

        const due = new Date(task.due_date);
        if (Number.isNaN(due.getTime())) return false;

        return due >= today && due <= horizon;

    });

}

// ==========================================
// OVERDUE
// Not closed, due date strictly before today.
// ==========================================

export function getOverdueTasks(tasks, userId) {

    const today = startOfToday();

    return (tasks || []).filter((task) => {

        if (!isMine(task, userId)) return false;
        if (task.status === "closed") return false;
        if (!task.due_date) return false;

        const due = new Date(task.due_date);
        if (Number.isNaN(due.getTime())) return false;

        return due < today;

    });

}

// ==========================================
// PENDING REVIEW
// Pass userId to scope to "my submissions awaiting
// approval"; omit it for an org-wide/admin view of
// everything currently pending_review that this
// caller can already see.
// ==========================================

export function getPendingReviewTasks(tasks, userId) {

    return (tasks || []).filter((task) =>
        isMine(task, userId) &&
        task.status === "pending_review"
    );

}

// ==========================================
// RECENTLY UPDATED
// Simple recency sort on the existing updated_at
// column -- not a true activity feed (no
// task_activity join), just "what changed lately"
// among tasks already visible to the caller.
// ==========================================

export function getRecentlyUpdatedTasks(tasks, userId, limit = 5) {

    return (tasks || [])
        .filter((task) => isMine(task, userId))
        .slice()
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
        .slice(0, limit);

}

// ==========================================
// STATUS BREAKDOWN (admin "team status summary")
// ==========================================

export function getStatusBreakdown(tasks) {

    const counts = {
        backlog: 0,
        todo: 0,
        in_progress: 0,
        pending_review: 0,
        closed: 0,
    };

    (tasks || []).forEach((task) => {
        if (counts[task.status] !== undefined) {
            counts[task.status] += 1;
        }
    });

    return counts;

}
