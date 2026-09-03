import { useEffect, useState } from "react";

import { useNavigate } from "react-router-dom";

import { FaProjectDiagram, FaPlus, FaUserTie, FaCalendarAlt } from "react-icons/fa";

import { toast } from "react-toastify";

import { getProjects } from "../../services/projectService";

import CreateProjectModal from "../Projects/CreateProjectModal";

import "./MyTeam.css";
import "./ExecutiveProjects.css";

// ==========================================
// PROJECTS (Employee portal)
//
// This is the shared "Projects" page for BOTH
// Founder/Chairman (via their executive menu) and
// any other Project-Access user (CEO/CTO/Tech
// Lead/Manager/Software Engineer, or an
// Admin-granted Employee/Intern) — the sidebar
// just points both groups at the same
// "/employee/projects" route, so this component
// isn't duplicated per role. GET /projects already
// scopes which rows come back per-user server-side
// (see projectService.js), so this component just
// renders whatever it's given.
//
// Built on the exact same GET /projects endpoint
// the Admin Projects page uses (already returns
// owner name, progress %, task/story
// counts and due dates — nothing new computed
// here). Creating a project reuses the existing
// CreateProjectModal component unmodified. This
// does not touch, duplicate, or replace the Task
// Management system — task-level detail still
// lives only there.
// ==========================================

const STATUS_LABELS = {
  planning: "Planning",
  active: "Active",
  on_hold: "On Hold",
  completed: "Completed",
  cancelled: "Cancelled",
};

function formatDate(value) {
  if (!value) return "No deadline set";
  return new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function ExecutiveProjects() {

  const navigate = useNavigate();

  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);

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

  return (

    <div className="employee-page-content">

      <section className="my-team-card">

        <div className="my-team-header exec-projects-header">
          <div>
            <h2><FaProjectDiagram /> Projects</h2>
            <p>Company-wide project overview.</p>
          </div>
          <button
            type="button"
            className="exec-new-project-button"
            onClick={() => setShowCreateModal(true)}
          >
            <FaPlus /> New Project
          </button>
        </div>

        {loading ? (
          <div className="my-team-empty">Loading projects...</div>
        ) : projects.length === 0 ? (
          <div className="my-team-empty">No projects have been created yet.</div>
        ) : (
          <div className="exec-project-grid">
            {projects.map((project) => (
              <div
                className="exec-project-card"
                key={project.id}
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/employee/projects/${project.id}`)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") navigate(`/employee/projects/${project.id}`);
                }}
              >

                <div className="exec-project-card-top">
                  <strong>{project.name}</strong>
                  <span className={`exec-project-status ${project.status}`}>
                    {STATUS_LABELS[project.status] || project.status}
                  </span>
                </div>

                {project.description && (
                  <p className="exec-project-description">{project.description}</p>
                )}

                <div className="exec-project-progress-track">
                  <div
                    className="exec-project-progress-fill"
                    style={{ width: `${Math.min(100, Math.max(0, project.progress || 0))}%` }}
                  />
                </div>
                <span className="exec-project-progress-label">{project.progress || 0}% complete</span>

                <div className="exec-project-meta">
                  <span><FaUserTie /> {project.owner_name || "No owner assigned"}</span>
                  <span><FaCalendarAlt /> {formatDate(project.due_date)}</span>
                </div>

                <div className="exec-project-counts">
                  <span>{project.user_story_count} user stor{project.user_story_count === 1 ? "y" : "ies"}</span>
                  <span>{project.task_count} task{project.task_count === 1 ? "" : "s"}</span>
                </div>

              </div>
            ))}
          </div>
        )}

      </section>

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

export default ExecutiveProjects;
