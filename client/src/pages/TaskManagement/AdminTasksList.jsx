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
    formatDateTime,
} from "../../utils/workItemStatus";

import "../../styles/workItems.css";

function getCurrentUserId() {
    try {
        return JSON.parse(sessionStorage.getItem("user"))?.id ?? null;
    } catch {
        return null;
    }
}

function AdminTasksList() {

    const navigate = useNavigate();

    const currentUserId = getCurrentUserId();

    const [tasks, setTasks] = useState([]);

    const [loading, setLoading] = useState(true);

    const [filters, setFilters] = useState(DEFAULT_TASK_FILTERS);

    const [dueBeforeFilter, setDueBeforeFilter] = useState("");

    const loadTasks = async () => {

        try {

            setLoading(true);

            const response = await getTasks();

            setTasks(response.tasks || []);

        } catch (error) {

            console.error(error);

            toast.error("Unable to load tasks");

        } finally {

            setLoading(false);

        }

    };

    useEffect(() => {

        loadTasks();

    }, []);

    const filteredTasks = useMemo(() => {

        return tasks.filter((task) => {

            if (!taskMatchesFilters(task, filters, currentUserId)) {
                return false;
            }

            if (dueBeforeFilter && task.due_date) {
                if (new Date(task.due_date) > new Date(dueBeforeFilter)) {
                    return false;
                }
            }

            return true;

        });

    }, [tasks, filters, currentUserId, dueBeforeFilter]);

    return (

        <div className="wi-page">

            <div className="wi-page-header">
                <div>
                    <h1>All Tasks</h1>
                    <p>Search and filter every task across all projects. To create a task, open a User Story and use Create Task there.</p>
                </div>
            </div>

            <TaskFilterBar
                tasks={tasks}
                showProject
                showStory
                showAssignee
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

            {loading ? (

                <div className="wi-loading">Loading tasks...</div>

            ) : filteredTasks.length === 0 ? (

                <div className="wi-empty-state">
                    <FaTasks />
                    <h3>No tasks match these filters</h3>
                    <p>Try clearing a filter, or create tasks from inside a User Story.</p>
                </div>

            ) : (

                <div className="wi-table-wrapper">

                    <table className="wi-table">

                        <thead>
                            <tr>
                                <th>Task</th>
                                <th>Project</th>
                                <th>User Story</th>
                                <th>Assigned To</th>
                                <th>Priority</th>
                                <th>Status</th>
                                <th>Progress</th>
                                <th>Due Date</th>
                                <th>Updated</th>
                            </tr>
                        </thead>

                        <tbody>

                            {filteredTasks.map((task) => (

                                <tr
                                    key={task.id}
                                    onClick={() => navigate(`/admin/task-workspace/${task.id}`)}
                                >

                                    <td>
                                        <div className="wi-table-task-cell">
                                            <strong>{task.task_title}</strong>
                                            <span>
                                                T-{String(task.task_number || task.id).padStart(3, "0")}
                                            </span>
                                            {task.taskTags?.length > 0 && (
                                                <TagChips tags={task.taskTags} max={3} />
                                            )}
                                        </div>
                                    </td>

                                    <td>{task.project_name || "-"}</td>

                                    <td>{task.user_story_title || "-"}</td>

                                    <td>{task.assigned_to_name || "Unassigned"}</td>

                                    <td>
                                        <span
                                            className={
                                                PRIORITY_CLASS[task.priority] ||
                                                "priority-pill priority-medium"
                                            }
                                        >
                                            {task.priority}
                                        </span>
                                    </td>

                                    <td>
                                        <span
                                            className={
                                                TASK_STATUS_CLASS[task.status] ||
                                                "status-pill status-neutral"
                                            }
                                        >
                                            {TASK_STATUS_LABELS[task.status] || task.status}
                                        </span>
                                    </td>

                                    <td>
                                        <div className="wi-table-progress-cell">
                                            <div className="wi-progress-track">
                                                <div
                                                    className="wi-progress-fill"
                                                    style={{ width: `${task.progress || 0}%` }}
                                                />
                                            </div>
                                            <span>{task.progress || 0}%</span>
                                        </div>
                                    </td>

                                    <td>{formatDate(task.due_date)}</td>

                                    <td>{formatDateTime(task.updated_at)}</td>

                                </tr>

                            ))}

                        </tbody>

                    </table>

                </div>

            )}

        </div>

    );

}

export default AdminTasksList;
