import { useEffect, useState } from "react";

import { useNavigate, useParams } from "react-router-dom";

import { FaArrowLeft, FaTasks, FaPlus, FaPen } from "react-icons/fa";

import { toast } from "react-toastify";

import { getUserStory } from "../../services/userStoryService";

import CreateUserStoryModal from "./CreateUserStoryModal";

import CreateStoryTaskModal from "./CreateStoryTaskModal";

import {
    STORY_STATUS_LABELS,
    STORY_STATUS_CLASS,
    TASK_STATUS_LABELS,
    TASK_STATUS_CLASS,
    PRIORITY_CLASS,
    formatDate,
    formatDateTime,
} from "../../utils/workItemStatus";

import "../../styles/workItems.css";
import "./Projects.css";

function UserStoryDetail() {

    const { id } = useParams();

    const navigate = useNavigate();

    const [story, setStory] = useState(null);

    const [loading, setLoading] = useState(true);

    const [showEditModal, setShowEditModal] = useState(false);

    const [showCreateTaskModal, setShowCreateTaskModal] = useState(false);

    const loadData = async () => {

        try {

            setLoading(true);

            const response = await getUserStory(id);

            setStory(response.userStory);

        } catch (error) {

            console.error(error);

            toast.error("Unable to load user story");

        } finally {

            setLoading(false);

        }

    };

    useEffect(() => {

        loadData();

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    if (loading) {
        return <div className="wi-loading">Loading user story...</div>;
    }

    if (!story) {
        return (
            <div className="wi-empty-state">
                <h3>User story not found</h3>
            </div>
        );
    }

    return (

        <div className="wi-page">

            <div className="wi-breadcrumb">
                <button
                    type="button"
                    onClick={() => navigate(`/admin/projects/${story.project_id}`)}
                >
                    <FaArrowLeft /> {story.project_name}
                </button>
                <span className="current">User Story</span>
            </div>

            {/* ==================================
                USER STORY HEADER
            ================================== */}

            <div className="wi-project-header">

                <div className="wi-project-header-top">

                    <div>

                        <span className="wi-code">
                            US-{String(story.id).padStart(3, "0")}
                        </span>

                        <h1>{story.title}</h1>

                    </div>

                    <div className="wi-project-header-actions">

                        <span
                            className={
                                STORY_STATUS_CLASS[story.status] ||
                                "status-pill status-neutral"
                            }
                        >
                            {STORY_STATUS_LABELS[story.status] || story.status}
                        </span>

                        <button
                            type="button"
                            className="wi-secondary-button"
                            onClick={() => setShowEditModal(true)}
                        >
                            <FaPen /> Edit
                        </button>

                    </div>

                </div>

                <p className="wi-project-description">
                    {story.description || "No description provided."}
                </p>

                <div className="wi-project-header-meta">

                    <div>
                        <label>Project</label>
                        <span>{story.project_name}</span>
                    </div>

                    <div>
                        <label>Owner</label>
                        <span>{story.owner_name || "Unassigned"}</span>
                    </div>

                    <div>
                        <label>Priority</label>
                        <span
                            className={
                                PRIORITY_CLASS[story.priority] ||
                                "priority-pill priority-medium"
                            }
                        >
                            {story.priority}
                        </span>
                    </div>

                    <div>
                        <label>Due Date</label>
                        <span>{formatDate(story.due_date)}</span>
                    </div>

                    {story.tags && (
                        <div>
                            <label>Tags</label>
                            <span>{story.tags}</span>
                        </div>
                    )}

                </div>

                <div className="wi-project-progress-row">

                    <div className="wi-progress-track">
                        <div
                            className="wi-progress-fill"
                            style={{ width: `${story.progress || 0}%` }}
                        />
                    </div>

                    <span>{story.progress || 0}% Complete</span>

                </div>

            </div>

            {/* ==================================
                TASKS
            ================================== */}

            <div className="wi-section-header">

                <h2>Tasks</h2>

                <button
                    type="button"
                    className="wi-primary-button"
                    onClick={() => setShowCreateTaskModal(true)}
                >
                    <FaPlus /> Create Task
                </button>

            </div>

            {(!story.tasks || story.tasks.length === 0) ? (

                <div className="wi-empty-state">
                    <FaTasks />
                    <h3>No tasks yet</h3>
                    <p>Create tasks to start working on this user story.</p>
                    <button
                        type="button"
                        className="wi-primary-button"
                        onClick={() => setShowCreateTaskModal(true)}
                    >
                        <FaPlus /> Create Task
                    </button>
                </div>

            ) : (

                <div className="wi-table-wrapper">

                    <table className="wi-table">

                        <thead>
                            <tr>
                                <th>Task</th>
                                <th>Assigned To</th>
                                <th>Priority</th>
                                <th>Status</th>
                                <th>Progress</th>
                                <th>Due Date</th>
                                <th>Updated</th>
                            </tr>
                        </thead>

                        <tbody>

                            {story.tasks.map((task) => (

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
                                        </div>
                                    </td>

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

            {showEditModal && (

                <CreateUserStoryModal
                    story={story}
                    onClose={() => setShowEditModal(false)}
                    onUpdated={() => {
                        setShowEditModal(false);
                        loadData();
                    }}
                />

            )}

            {showCreateTaskModal && (

                <CreateStoryTaskModal
                    storyId={id}
                    onClose={() => setShowCreateTaskModal(false)}
                    onCreated={() => {
                        setShowCreateTaskModal(false);
                        loadData();
                    }}
                />

            )}

        </div>

    );

}

export default UserStoryDetail;
