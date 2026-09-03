import { useEffect, useMemo, useState } from "react";

import { useNavigate } from "react-router-dom";

import { FaProjectDiagram, FaPlus, FaSearch, FaArrowRight } from "react-icons/fa";

import { toast } from "react-toastify";

import { getProjects } from "../../services/projectService";

import CreateProjectModal from "./CreateProjectModal";

import {
    PROJECT_STATUS_LABELS,
    PROJECT_STATUS_CLASS,
    PRIORITY_CLASS,
    formatDate,
} from "../../utils/workItemStatus";

import "../../styles/workItems.css";
import "./Projects.css";

function ProjectsList() {

    const navigate = useNavigate();

    const [projects, setProjects] = useState([]);

    const [loading, setLoading] = useState(true);

    const [showCreateModal, setShowCreateModal] = useState(false);

    const [searchTerm, setSearchTerm] = useState("");

    const [statusFilter, setStatusFilter] = useState("all");

    const [ownerFilter, setOwnerFilter] = useState("all");

    const [priorityFilter, setPriorityFilter] = useState("all");

    const loadProjects = async () => {

        try {

            setLoading(true);

            const response = await getProjects();

            setProjects(response.projects || []);

        } catch (error) {

            console.error(error);

            toast.error("Unable to load projects");

        } finally {

            setLoading(false);

        }

    };

    useEffect(() => {

        loadProjects();

    }, []);

    const ownerOptions = useMemo(() => {

        const seen = new Map();

        projects.forEach((project) => {
            if (!project.owner_id) return;
            if (!seen.has(project.owner_id)) {
                seen.set(project.owner_id, project.owner_name || "Unknown");
            }
        });

        return Array.from(seen.entries());

    }, [projects]);

    const filteredProjects = useMemo(() => {

        return projects.filter((project) => {

            if (statusFilter !== "all" && project.status !== statusFilter) {
                return false;
            }

            if (ownerFilter !== "all" && String(project.owner_id) !== ownerFilter) {
                return false;
            }

            if (priorityFilter !== "all" && project.priority !== priorityFilter) {
                return false;
            }

            if (
                searchTerm.trim() &&
                !project.name?.toLowerCase().includes(searchTerm.trim().toLowerCase())
            ) {
                return false;
            }

            return true;

        });

    }, [projects, statusFilter, ownerFilter, priorityFilter, searchTerm]);

    return (

        <div className="wi-page">

            <div className="wi-page-header">

                <div>

                    <h1>Projects</h1>

                    <p>
                        Every piece of work starts here &mdash; create a
                        project, break it into user stories, then assign tasks.
                    </p>

                </div>

                <button
                    type="button"
                    className="wi-primary-button"
                    onClick={() => setShowCreateModal(true)}
                >
                    <FaPlus /> New Project
                </button>

            </div>

            <div className="wi-filters-bar">

                <div className="wi-filters-search">
                    <FaSearch />
                    <input
                        type="text"
                        placeholder="Search projects..."
                        value={searchTerm}
                        onChange={(event) => setSearchTerm(event.target.value)}
                    />
                </div>

                <select
                    value={statusFilter}
                    onChange={(event) => setStatusFilter(event.target.value)}
                >
                    <option value="all">All Statuses</option>
                    <option value="planning">Planning</option>
                    <option value="active">Active</option>
                    <option value="on_hold">On Hold</option>
                    <option value="completed">Completed</option>
                    <option value="cancelled">Cancelled</option>
                </select>

                <select
                    value={ownerFilter}
                    onChange={(event) => setOwnerFilter(event.target.value)}
                >
                    <option value="all">All Owners</option>
                    {ownerOptions.map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                    ))}
                </select>

                <select
                    value={priorityFilter}
                    onChange={(event) => setPriorityFilter(event.target.value)}
                >
                    <option value="all">All Priorities</option>
                    <option value="Low">Low</option>
                    <option value="Medium">Medium</option>
                    <option value="High">High</option>
                    <option value="Critical">Critical</option>
                </select>

            </div>

            {loading ? (

                <div className="wi-loading">Loading projects...</div>

            ) : projects.length === 0 ? (

                <div className="wi-empty-state">
                    <FaProjectDiagram />
                    <h3>No projects yet</h3>
                    <p>Click <b>+ New Project</b> to create your first project.</p>
                </div>

            ) : filteredProjects.length === 0 ? (

                <div className="wi-empty-state">
                    <FaProjectDiagram />
                    <h3>No projects match these filters</h3>
                    <p>Try clearing a filter to see more projects.</p>
                </div>

            ) : (

                <div className="wi-project-grid">

                    {filteredProjects.map((project) => (

                        <div
                            key={project.id}
                            className="wi-project-card"
                            onClick={() => navigate(`/admin/projects/${project.id}`)}
                        >

                            <div className="wi-project-card-top">

                                <span className="wi-code">
                                    PR-{String(project.id).padStart(3, "0")}
                                </span>

                                <span
                                    className={
                                        PROJECT_STATUS_CLASS[project.status] ||
                                        "status-pill status-neutral"
                                    }
                                >
                                    {PROJECT_STATUS_LABELS[project.status] || project.status}
                                </span>

                            </div>

                            <h3>{project.name}</h3>

                            <p className="wi-project-description">
                                {project.description || "No description provided."}
                            </p>

                            <div className="wi-project-meta">

                                <div>
                                    <label>Owner</label>
                                    <span>{project.owner_name || "Unassigned"}</span>
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
                                    <label>Due</label>
                                    <span>{formatDate(project.due_date)}</span>
                                </div>

                            </div>

                            <div className="wi-project-card-footer">

                                <span>{project.user_story_count} User {project.user_story_count === 1 ? "Story" : "Stories"}</span>

                                <span>{project.task_count} {project.task_count === 1 ? "Task" : "Tasks"}</span>

                                <span className="wi-project-progress-label">
                                    {project.progress || 0}%
                                </span>

                            </div>

                            <div className="wi-progress-track">
                                <div
                                    className="wi-progress-fill"
                                    style={{ width: `${project.progress || 0}%` }}
                                />
                            </div>

                            <button
                                type="button"
                                className="wi-secondary-button wi-open-project-button"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    navigate(`/admin/projects/${project.id}`);
                                }}
                            >
                                Open Project <FaArrowRight />
                            </button>

                        </div>

                    ))}

                </div>

            )}

            {showCreateModal && (

                <CreateProjectModal
                    onClose={() => setShowCreateModal(false)}
                    onCreated={() => {
                        setShowCreateModal(false);
                        loadProjects();
                    }}
                />

            )}

        </div>

    );

}

export default ProjectsList;
