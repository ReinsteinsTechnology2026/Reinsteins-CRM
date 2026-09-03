// ==========================================
// SHARED TASK FILTER PREDICATE
// Operates entirely on tasks already fetched by the
// caller's own (already permission-scoped) endpoint
// -- this only ever narrows what's already loaded,
// never widens it. Reused by AdminTasksList,
// EmployeeTasks, and ProjectWorkspace so the
// filtering rules stay identical across all three
// instead of drifting.
//
// Multi-tag selection is OR: a task matches if it
// has ANY of the selected tags (see Step 1 report --
// tags here are largely orthogonal categories, so AND
// would frequently return zero results).
// ==========================================

export const DEFAULT_TASK_FILTERS = {
    search: "",
    status: "all",
    priority: "all",
    assignee: "all", // "all" | "me" | "unassigned" | <userId>
    story: "all",
    project: "all",
    sprint: "all", // "all" | "backlog" | <sprintId>
    tagIds: [],
};

export function isTaskFilterActive(filters) {

    return (
        Boolean(filters.search?.trim()) ||
        filters.status !== "all" ||
        filters.priority !== "all" ||
        filters.assignee !== "all" ||
        filters.story !== "all" ||
        filters.project !== "all" ||
        filters.sprint !== "all" ||
        (filters.tagIds?.length || 0) > 0
    );

}

export function taskMatchesFilters(task, filters, currentUserId) {

    if (filters.status !== "all" && task.status !== filters.status) {
        return false;
    }

    if (filters.priority !== "all" && task.priority !== filters.priority) {
        return false;
    }

    if (filters.assignee === "me") {
        if (Number(task.assigned_to) !== Number(currentUserId)) {
            return false;
        }
    } else if (filters.assignee === "unassigned") {
        if (task.assigned_to) {
            return false;
        }
    } else if (filters.assignee !== "all") {
        if (String(task.assigned_to) !== String(filters.assignee)) {
            return false;
        }
    }

    if (filters.story !== "all" && String(task.user_story_id) !== String(filters.story)) {
        return false;
    }

    if (filters.sprint === "backlog") {
        if (task.sprint_id) {
            return false;
        }
    } else if (filters.sprint !== "all") {
        if (String(task.sprint_id) !== String(filters.sprint)) {
            return false;
        }
    }

    if (filters.project !== "all") {
        const taskProjectKey = task.project_id || "legacy";
        if (String(taskProjectKey) !== String(filters.project)) {
            return false;
        }
    }

    if (filters.tagIds?.length > 0) {
        const taskTagIds = (task.taskTags || []).map((tag) => tag.id);
        const matchesAny = filters.tagIds.some((id) => taskTagIds.includes(id));
        if (!matchesAny) {
            return false;
        }
    }

    const trimmedSearch = filters.search?.trim().toLowerCase();

    if (trimmedSearch) {

        const haystack = [
            task.task_title,
            task.task_description,
            task.user_story_title,
        ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

        if (!haystack.includes(trimmedSearch)) {
            return false;
        }

    }

    return true;

}
