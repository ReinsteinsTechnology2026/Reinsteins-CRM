import { useEffect, useState } from "react";

import { useNavigate, useParams } from "react-router-dom";

import { FaArrowLeft, FaBookOpen, FaPlus, FaPen, FaArrowRight } from "react-icons/fa";

import { toast } from "react-toastify";

import { getProject } from "../../services/projectService";

import { getUserStories } from "../../services/userStoryService";

import CreateProjectModal from "./CreateProjectModal";

import CreateUserStoryModal from "./CreateUserStoryModal";

import {
    PROJECT_STATUS_LABELS,
    PROJECT_STATUS_CLASS,
    STORY_STATUS_LABELS,
    STORY_STATUS_CLASS,
    PRIORITY_CLASS,
    formatDate,
} from "../../utils/workItemStatus";

import "../../styles/workItems.css";
import "./Projects.css";

function ProjectDetail() {

    const { id } = useParams();

    const navigate = useNavigate();

    const [project, setProject] = useState(null);

    const [stories, setStories] = useState([]);

    const [loading, setLoading] = useState(true);

    const [showEditModal, setShowEditModal] = useState(false);

    const [showCreateStoryModal, setShowCreateStoryModal] = useState(false);

    const loadData = async () => {

        try {

            setLoading(true);

            const [projectResponse, storiesResponse] = await Promise.all([
                getProject(id),
                getUserStories(id),
            ]);

            setProject(projectResponse.project);

            setStories(storiesResponse.userStories || []);

        } catch (error) {

            console.error(error);

            toast.error("Unable to load project");

        } finally {

            setLoading(false);

        }

    };

    useEffect(() => {

        loadData();

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    if (loading) {
        return <div className="wi-loading">Loading project...</div>;
    }

    if (!project) {
        return (
            <div className="wi-empty-state">
                <h3>Project not found</h3>
            </div>
        );
    }

    const stats = project.stats || {};

    return (

        <div className="wi-page">

            <div className="wi-breadcrumb">
                <button type="button" onClick={() => navigate("/admin/projects")}>
                    <FaArrowLeft /> Projects
                </button>
            </div>

            {/* ==================================
                PROJECT HEADER
            ================================== */}

            <div className="wi-project-header">

                <div className="wi-project-header-top">

                    <div>

                        <span className="wi-code">
                            PR-{String(project.id).padStart(3, "0")}
                        </span>

                        <h1>{project.name}</h1>

                    </div>

                    <div className="wi-project-header-actions">

                        <span
                            className={
                                PROJECT_STATUS_CLASS[project.status] ||
                                "status-pill status-neutral"
                            }
                        >
                            {PROJECT_STATUS_LABELS[project.status] || project.status}
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
                    {project.description || "No description provided."}
                </p>

                <div className="wi-project-header-meta">

                    <div>
                        <label>Owner</label>
                        <span>{project.owner_name || "Unassigned"}</span>
                    </div>

                    <div>
                        <label>Created By</label>
                        <span>{project.created_by_name || "-"}</span>
                    </div>

                    <div>
                        <label>Priority</label>
                        <span
                            className={
                                PRIORITY_CLASS[project.priority] ||
                                "priority-pill priority-medium"
                            }
                        >
                            {project.priority}
                        </span>
                    </div>

                    <div>
                        <label>Start Date</label>
                        <span>{formatDate(project.start_date)}</span>
                    </div>

                    <div>
                        <label>Due Date</label>
                        <span>{formatDate(project.due_date)}</span>
                    </div>

                </div>

                <div className="wi-project-progress-row">

                    <div className="wi-progress-track">
                        <div
                            className="wi-progress-fill"
                            style={{ width: `${project.progress || 0}%` }}
                        />
                    </div>

                    <span>{project.progress || 0}% Complete</span>

                </div>

            </div>

            {/* ==================================
                SUMMARY STATS
            ================================== */}

            <div className="wi-stats-grid">

                <div className="wi-stat-card">
                    <label>User Stories</label>
                    <h3>{project.user_story_count || 0}</h3>
                </div>

                <div className="wi-stat-card">
                    <label>Total Tasks</label>
                    <h3>{stats.totalTasks || 0}</h3>
                </div>

                <div className="wi-stat-card">
                    <label>In Progress</label>
                    <h3>{stats.inProgress || 0}</h3>
                </div>

                <div className="wi-stat-card">
                    <label>Pending Review</label>
                    <h3>{stats.pendingReview || 0}</h3>
                </div>

                <div className="wi-stat-card">
                    <label>Completed</label>
                    <h3>{stats.completed || 0}</h3>
                </div>

                <div className="wi-stat-card wi-stat-card-danger">
                    <label>Overdue</label>
                    <h3>{stats.overdue || 0}</h3>
                </div>

            </div>

            {/* ==================================
                USER STORIES
            ================================== */}

            <div className="wi-section-header">

                <h2>User Stories</h2>

                <button
                    type="button"
                    className="wi-primary-button"
                    onClick={() => setShowCreateStoryModal(true)}
                >
                    <FaPlus /> New User Story
                </button>

            </div>

            {stories.length === 0 ? (

                <div className="wi-empty-state">
                    <FaBookOpen />
                    <h3>No user stories yet</h3>
                    <p>Break this project into user stories first. Tasks are created inside each user story.</p>
                </div>

            ) : (

                <div className="wi-story-list">

                    {stories.map((story) => (

                        <div
                            key={story.id}
                            className="wi-story-row"
                            onClick={() => navigate(`/admin/user-stories/${story.id}`)}
                        >

                            <div className="wi-story-row-main">

                                <span className="wi-code">
                                    US-{String(story.id).padStart(3, "0")}
                                </span>

                                <div>
                                    <h4>{story.title}</h4>
                                    <p>{story.description || "No description provided."}</p>
                                </div>

                            </div>

                            <div className="wi-story-row-meta">

                                <span
                                    className={
                                        STORY_STATUS_CLASS[story.status] ||
                                        "status-pill status-neutral"
                                    }
                                >
                                    {STORY_STATUS_LABELS[story.status] || story.status}
                                </span>

                                <span className="wi-story-task-count">
                                    {story.task_count} {story.task_count === 1 ? "Task" : "Tasks"}
                                </span>

                                <span className="wi-story-progress-label">
                                    {story.progress || 0}%
                                </span>

                                <button
                                    type="button"
                                    className="wi-secondary-button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        navigate(`/admin/user-stories/${story.id}`);
                                    }}
                                >
                                    Open User Story <FaArrowRight />
                                </button>

                            </div>

                        </div>

                    ))}

                </div>

            )}

            {showEditModal && (

                <CreateProjectModal
                    project={project}
                    onClose={() => setShowEditModal(false)}
                    onUpdated={() => {
                        setShowEditModal(false);
                        loadData();
                    }}
                />

            )}

            {showCreateStoryModal && (

                <CreateUserStoryModal
                    projectId={id}
                    onClose={() => setShowCreateStoryModal(false)}
                    onCreated={() => {
                        setShowCreateStoryModal(false);
                        loadData();
                    }}
                />

            )}

        </div>

    );

}

export default ProjectDetail;
