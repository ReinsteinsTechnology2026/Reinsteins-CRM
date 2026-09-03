import { useEffect, useMemo, useState } from "react";

import { useNavigate } from "react-router-dom";

import { FaTasks } from "react-icons/fa";

import { toast } from "react-toastify";

import { getTasks } from "../../services/taskManagementService";

import TagChips from "../../components/TagChips";

import TaskFilterBar from "../../components/TaskFilterBar";

import { DEFAULT_TASK_FILTERS, taskMatchesFilters } from "../../utils/taskFilter";

import {
    TASK_STATUS_LABELS,
    TASK_STATUS_CLASS,
    PRIORITY_CLASS,
    formatDate,
} from "../../utils/workItemStatus";

import "../../styles/workItems.css";
import "./EmployeeTasks.css";

const LEGACY_GROUP_KEY = "legacy";
const LEGACY_GROUP_LABEL = "Unassigned / Legacy Tasks";
const NO_STORY_KEY = "no-story";
const NO_STORY_LABEL = "No User Story";

function EmployeeTasks() {

    const navigate = useNavigate();

    // ==========================================
    // DATA
    // ==========================================

    const [tasks, setTasks] = useState([]);

    const [loading, setLoading] = useState(true);

    const loadTasks = async () => {

        try {

            setLoading(true);

            const response = await getTasks();

            const myTasks = (response.tasks || []).filter(
                (task) => Number(task.assigned_to) === Number(response.userId)
            );

            setTasks(myTasks);

        } catch (error) {

            console.error(error);

            toast.error("Unable to load your tasks");

        } finally {

            setLoading(false);

        }

    };

    useEffect(() => {

        loadTasks();

    }, []);

    // ==========================================
    // FILTERS
    // ==========================================

    const [filters, setFilters] = useState(DEFAULT_TASK_FILTERS);

    const [dueBeforeFilter, setDueBeforeFilter] = useState("");

    const filteredTasks = useMemo(() => {

        return tasks.filter((task) => {

            if (!taskMatchesFilters(task, filters, null)) {
                return false;
            }

            if (dueBeforeFilter && task.due_date) {
                if (new Date(task.due_date) > new Date(dueBeforeFilter)) {
                    return false;
                }
            }

            return true;

        });

    }, [tasks, filters, dueBeforeFilter]);

    // ==========================================
    // GROUP: PROJECT -> USER STORY -> TASKS
    // ==========================================

    const groupedProjects = useMemo(() => {

        const projectMap = new Map();

        filteredTasks.forEach((task) => {

            const projectKey = task.project_id || LEGACY_GROUP_KEY;

            const projectLabel = task.project_name || LEGACY_GROUP_LABEL;

            if (!projectMap.has(projectKey)) {
                projectMap.set(projectKey, {
                    key: projectKey,
                    label: projectLabel,
                    stories: new Map(),
                });
            }

            const project = projectMap.get(projectKey);

            const storyKey = task.user_story_id || NO_STORY_KEY;

            const storyLabel = task.user_story_title || NO_STORY_LABEL;

            if (!project.stories.has(storyKey)) {
                project.stories.set(storyKey, {
                    key: storyKey,
                    label: storyLabel,
                    tasks: [],
                });
            }

            project.stories.get(storyKey).tasks.push(task);

        });

        return Array.from(projectMap.values()).map((project) => ({
            ...project,
            stories: Array.from(project.stories.values()),
        }));

    }, [filteredTasks]);

    if (loading) {
        return <div className="wi-loading">Loading your tasks...</div>;
    }

    return (

        <div className="wi-page employee-tasks-page">

            <div className="wi-page-header">
                <div>
                    <h1>My Tasks</h1>
                    <p>Tasks assigned to you, grouped by project and user story.</p>
                </div>
            </div>

            {/* ==================================
                FILTERS
            ================================== */}

            <TaskFilterBar
                tasks={tasks}
                showProject
                showStory
                onFiltersChange={setFilters}
            />

            <div className="wi-filters-bar">
                <input
                    type="date"
                    title="Due on or before"
                    value={dueBeforeFilter}
                    onChange={(event) => setDueBeforeFilter(event.target.value)}
                />
            </div>

            {/* ==================================
                GROUPED TASK LIST
            ================================== */}

            {groupedProjects.length === 0 ? (

                <div className="wi-empty-state">
                    <FaTasks />
                    <h3>No tasks match these filters</h3>
                    <p>Try clearing a filter, or check back after your admin assigns work.</p>
                </div>

            ) : (

                groupedProjects.map((project) => (

                    <div key={project.key} className="employee-project-group">

                        <h2 className="employee-project-group-title">{project.label}</h2>

                        {project.stories.map((story) => (

                            <div key={story.key} className="employee-story-group">

                                <h3 className="employee-story-group-title">{story.label}</h3>

                                <div className="wi-story-list">

                                    {story.tasks.map((task) => (

                                        <div key={task.id} className="wi-story-row employee-task-row">

                                            <div className="wi-story-row-main">

                                                <span className="wi-code">
                                                    T-{String(task.task_number || task.id).padStart(3, "0")}
                                                </span>

                                                <div>
                                                    <h4>{task.task_title}</h4>
                                                    <p>Due {formatDate(task.due_date)}</p>
                                                    {task.taskTags?.length > 0 && (
                                                        <TagChips tags={task.taskTags} max={3} />
                                                    )}
                                                </div>

                                            </div>

                                            <div className="employee-task-progress">
                                                <div className="wi-progress-track">
                                                    <div
                                                        className="wi-progress-fill"
                                                        style={{ width: `${task.progress || 0}%` }}
                                                    />
                                                </div>
                                            </div>

                                            <div className="wi-story-row-meta">

                                                <span
                                                    className={
                                                        PRIORITY_CLASS[task.priority] ||
                                                        "priority-pill priority-medium"
                                                    }
                                                >
                                                    {task.priority}
                                                </span>

                                                <span
                                                    className={
                                                        TASK_STATUS_CLASS[task.status] ||
                                                        "status-pill status-neutral"
                                                    }
                                                >
                                                    {TASK_STATUS_LABELS[task.status] || task.status}
                                                </span>

                                                <span className="wi-story-progress-label">
                                                    {task.progress || 0}%
                                                </span>

                                                <button
                                                    type="button"
                                                    className="wi-primary-button employee-open-task-button"
                                                    onClick={() =>
                                                        navigate(`/employee/task-workspace/${task.id}`)
                                                    }
                                                >
                                                    Open Task
                                                </button>

                                            </div>

                                        </div>

                                    ))}

                                </div>

                            </div>

                        ))}

                    </div>

                ))

            )}

        </div>

    );

}

export default EmployeeTasks;
