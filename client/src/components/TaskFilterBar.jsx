import { useMemo, useState } from "react";

import { FaSearch } from "react-icons/fa";

import { DEFAULT_TASK_FILTERS, isTaskFilterActive } from "../utils/taskFilter";

import "./TaskFilterBar.css";

const LEGACY_KEY = "legacy";
const LEGACY_LABEL = "No Project (legacy)";

// ==========================================
// SHARED FILTER BAR
// Owns its own filter state + derives dropdown
// options from the tasks already loaded by the
// caller (no extra network calls). Emits the
// current filter values via onFiltersChange; the
// caller applies them with taskMatchesFilters
// against its own already-permission-scoped task
// list. Which optional filters render (project /
// story / assignee) is controlled per-page so a
// page never shows a filter that's meaningless for
// its own scope.
// ==========================================

function TaskFilterBar({
    tasks,
    showProject = false,
    showStory = false,
    showSprint = false,
    showAssignee = false,
    onFiltersChange,
}) {

    const [filters, setFilters] = useState(DEFAULT_TASK_FILTERS);

    const [tagsOpen, setTagsOpen] = useState(false);

    function update(patch) {
        const next = { ...filters, ...patch };
        setFilters(next);
        onFiltersChange(next);
    }

    function clearAll() {
        setFilters(DEFAULT_TASK_FILTERS);
        onFiltersChange(DEFAULT_TASK_FILTERS);
    }

    const projectOptions = useMemo(() => {

        if (!showProject) return [];

        const seen = new Map();

        (tasks || []).forEach((task) => {
            const key = task.project_id || LEGACY_KEY;
            if (!seen.has(key)) {
                seen.set(key, task.project_name || LEGACY_LABEL);
            }
        });

        return Array.from(seen.entries());

    }, [tasks, showProject]);

    const storyOptions = useMemo(() => {

        if (!showStory) return [];

        const seen = new Map();

        (tasks || []).forEach((task) => {

            if (!task.user_story_id) return;

            const projectKey = task.project_id || LEGACY_KEY;

            if (filters.project !== "all" && String(projectKey) !== filters.project) {
                return;
            }

            if (!seen.has(task.user_story_id)) {
                seen.set(task.user_story_id, task.user_story_title);
            }

        });

        return Array.from(seen.entries());

    }, [tasks, showStory, filters.project]);

    const sprintOptions = useMemo(() => {

        if (!showSprint) return [];

        const seen = new Map();

        (tasks || []).forEach((task) => {
            if (!task.sprint_id) return;
            if (!seen.has(task.sprint_id)) {
                seen.set(task.sprint_id, task.sprint_name || "Unnamed Sprint");
            }
        });

        return Array.from(seen.entries());

    }, [tasks, showSprint]);

    const assigneeOptions = useMemo(() => {

        if (!showAssignee) return [];

        const seen = new Map();

        (tasks || []).forEach((task) => {
            if (!task.assigned_to) return;
            if (!seen.has(task.assigned_to)) {
                seen.set(task.assigned_to, task.assigned_to_name || "Unknown");
            }
        });

        return Array.from(seen.entries());

    }, [tasks, showAssignee]);

    const tagOptions = useMemo(() => {

        const seen = new Map();

        (tasks || []).forEach((task) => {
            (task.taskTags || []).forEach((tag) => {
                if (!seen.has(tag.id)) {
                    seen.set(tag.id, tag.name);
                }
            });
        });

        return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]));

    }, [tasks]);

    function toggleTag(tagId) {

        const isSelected = filters.tagIds.includes(tagId);

        const nextTagIds = isSelected
            ? filters.tagIds.filter((id) => id !== tagId)
            : [...filters.tagIds, tagId];

        update({ tagIds: nextTagIds });

    }

    const active = isTaskFilterActive(filters);

    return (

        <div className="wi-filters-bar">

            <div className="wi-filters-search">
                <FaSearch />
                <input
                    type="text"
                    placeholder="Search tasks..."
                    value={filters.search}
                    onChange={(event) => update({ search: event.target.value })}
                />
            </div>

            {showProject && (
                <select
                    value={filters.project}
                    onChange={(event) => update({ project: event.target.value, story: "all" })}
                >
                    <option value="all">All Projects</option>
                    {projectOptions.map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                    ))}
                </select>
            )}

            {showStory && (
                <select
                    value={filters.story}
                    onChange={(event) => update({ story: event.target.value })}
                >
                    <option value="all">All User Stories</option>
                    {storyOptions.map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                    ))}
                </select>
            )}

            {showSprint && (
                <select
                    value={filters.sprint}
                    onChange={(event) => update({ sprint: event.target.value })}
                >
                    <option value="all">All Sprints</option>
                    <option value="backlog">Backlog</option>
                    {sprintOptions.map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                    ))}
                </select>
            )}

            {showAssignee && (
                <select
                    value={filters.assignee}
                    onChange={(event) => update({ assignee: event.target.value })}
                >
                    <option value="all">All Assignees</option>
                    <option value="me">Me</option>
                    <option value="unassigned">Unassigned</option>
                    {assigneeOptions.map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                    ))}
                </select>
            )}

            <select
                value={filters.status}
                onChange={(event) => update({ status: event.target.value })}
            >
                <option value="all">All Statuses</option>
                <option value="backlog">Backlog</option>
                <option value="todo">To Do</option>
                <option value="in_progress">In Progress</option>
                <option value="pending_review">Pending Review</option>
                <option value="closed">Closed</option>
            </select>

            <select
                value={filters.priority}
                onChange={(event) => update({ priority: event.target.value })}
            >
                <option value="all">All Priorities</option>
                <option value="Low">Low</option>
                <option value="Medium">Medium</option>
                <option value="High">High</option>
                <option value="Critical">Critical</option>
            </select>

            <details
                className="tfb-tags-dropdown"
                open={tagsOpen}
                onToggle={(event) => setTagsOpen(event.target.open)}
            >
                <summary>
                    Tags{filters.tagIds.length > 0 ? ` (${filters.tagIds.length})` : ""}
                </summary>

                <div className="tfb-tags-panel">
                    {tagOptions.length === 0 ? (
                        <p className="tfb-tags-empty">No tags on these tasks yet.</p>
                    ) : (
                        tagOptions.map(([id, name]) => (
                            <label key={id} className="tfb-tag-option">
                                <input
                                    type="checkbox"
                                    checked={filters.tagIds.includes(id)}
                                    onChange={() => toggleTag(id)}
                                />
                                {name}
                            </label>
                        ))
                    )}
                </div>
            </details>

            {active && (
                <button type="button" className="tfb-clear-button" onClick={clearAll}>
                    Clear filters
                </button>
            )}

        </div>

    );

}

export default TaskFilterBar;
