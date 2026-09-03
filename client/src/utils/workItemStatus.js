// ==========================================
// TASK STATUS
// ==========================================

export const TASK_STATUS_LABELS = {
    backlog: "Backlog",
    todo: "To Do",
    in_progress: "In Progress",
    pending_review: "Pending Review",
    closed: "Closed",
};

export const TASK_STATUS_CLASS = {
    backlog: "status-pill status-neutral",
    todo: "status-pill status-neutral",
    in_progress: "status-pill status-in-progress",
    pending_review: "status-pill status-pending-review",
    closed: "status-pill status-closed",
};

// ==========================================
// PROJECT STATUS
// ==========================================

export const PROJECT_STATUS_LABELS = {
    planning: "Planning",
    active: "Active",
    on_hold: "On Hold",
    completed: "Completed",
    cancelled: "Cancelled",
};

export const PROJECT_STATUS_CLASS = {
    planning: "status-pill status-neutral",
    active: "status-pill status-in-progress",
    on_hold: "status-pill status-pending-review",
    completed: "status-pill status-closed",
    cancelled: "status-pill status-cancelled",
};

// ==========================================
// USER STORY STATUS
// ==========================================

export const STORY_STATUS_LABELS = {
    new: "New",
    active: "Active",
    on_hold: "On Hold",
    completed: "Completed",
    cancelled: "Cancelled",
};

export const STORY_STATUS_CLASS = {
    new: "status-pill status-neutral",
    active: "status-pill status-in-progress",
    on_hold: "status-pill status-pending-review",
    completed: "status-pill status-closed",
    cancelled: "status-pill status-cancelled",
};

// ==========================================
// ORGANIZATION STATUS
// ==========================================

export const ORGANIZATION_STATUS_LABELS = {
    active: "Active",
    inactive: "Inactive",
};

export const ORGANIZATION_STATUS_CLASS = {
    active: "status-pill status-in-progress",
    inactive: "status-pill status-neutral",
};

// ==========================================
// PRIORITY
// ==========================================

export const PRIORITY_CLASS = {
    Low: "priority-pill priority-low",
    Medium: "priority-pill priority-medium",
    High: "priority-pill priority-high",
    Critical: "priority-pill priority-critical",
};

// ==========================================
// MEETING STATUS
// ==========================================

export const MEETING_STATUS_LABELS = {
    scheduled: "Scheduled",
    live: "Live",
    ended: "Ended",
    cancelled: "Cancelled",
};

export const MEETING_STATUS_CLASS = {
    scheduled: "status-pill status-neutral",
    live: "status-pill status-live",
    ended: "status-pill status-closed",
    cancelled: "status-pill status-cancelled",
};

// ==========================================
// DATE FORMAT (matches existing convention
// used across TaskManagement/Employee pages)
// ==========================================

export const formatDate = (value) => {

    if (!value) {
        return "--";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "--";
    }

    return date.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    });

};

export const formatDateTime = (value) => {

    if (!value) {
        return "--";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "--";
    }

    return date.toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });

};
