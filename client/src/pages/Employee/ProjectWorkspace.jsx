import { useEffect, useMemo, useState } from "react";

import { useLocation, useNavigate, useParams } from "react-router-dom";

import {
  FaArrowLeft,
  FaChevronDown,
  FaChevronRight,
  FaPlus,
  FaFolder,
  FaUserTie,
  FaPen,
  FaTrash,
} from "react-icons/fa";

import { toast } from "react-toastify";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";

import { CSS } from "@dnd-kit/utilities";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  ResponsiveContainer,
} from "recharts";

import { getProject, getProjectTasks, deleteProject } from "../../services/projectService";
import { getEpics, deleteEpic } from "../../services/epicService";
import { getFeatures, deleteFeature } from "../../services/featureService";
import { getUserStories, deleteUserStory } from "../../services/userStoryService";
import { getSprints, startSprint, completeSprint, deleteSprint, getSprintAnalytics } from "../../services/sprintService";
import { changeTaskStatus, assignTaskToSprint } from "../../services/taskManagementService";
import { getMyProjectPermissions } from "../../services/projectMemberService";

import CreateProjectModal from "../Projects/CreateProjectModal";
import CreateEpicModal from "../Projects/CreateEpicModal";
import CreateFeatureModal from "../Projects/CreateFeatureModal";
import CreateUserStoryModal from "../Projects/CreateUserStoryModal";
import CreateStoryTaskModal from "../Projects/CreateStoryTaskModal";
import CreateSprintModal from "../Projects/CreateSprintModal";
import ProjectSettings from "./ProjectSettings";
import TagChips from "../../components/TagChips";
import TaskFilterBar from "../../components/TaskFilterBar";

import { DEFAULT_TASK_FILTERS, isTaskFilterActive, taskMatchesFilters } from "../../utils/taskFilter";

import "./MyTeam.css";
import "./ProjectWorkspace.css";

// ==========================================
// PROJECT WORKSPACE
//
// Overview | Backlog | Board — built entirely on
// the existing Project/User Story/Task backend.
// Task detail (description, images, files,
// attachments, activity, work logs, mentions,
// transfer) is NEVER reimplemented here — every
// task row navigates to the existing, unmodified
// Task Workspace route.
//
// This ONE component is mounted at BOTH
// "/admin/projects/:id" and "/employee/projects/:id"
// (see App.jsx) — it is not duplicated. Internal
// navigation (back button, opening a task) is
// portal-aware via basePath below, so the same
// component behaves correctly under either prefix
// instead of hardcoding "/employee/...".
// ==========================================

const KANBAN_COLUMNS = [
  { key: "backlog", label: "Backlog" },
  { key: "todo", label: "To Do" },
  { key: "in_progress", label: "In Progress" },
  { key: "pending_review", label: "In Review" },
  { key: "closed", label: "Done" },
];

const STATUS_LABELS = {
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  pending_review: "In Review",
  closed: "Done",
};

const PROJECT_STATUS_LABELS = {
  planning: "Planning",
  active: "Active",
  on_hold: "On Hold",
  completed: "Completed",
  cancelled: "Cancelled",
};

const SPRINT_STATUS_LABELS = {
  planning: "Planning",
  active: "Active",
  completed: "Completed",
};

// ==========================================
// ANALYTICS CHART COLORS
// WorkHub theme tokens only (theme.css) -- the same
// status→color language already used by the
// status-pill classes in workItems.css (pending
// review = warning/amber, closed = success/green),
// just applied to chart bars instead of pills. No
// Azure DevOps colors, nothing hardcoded outside the
// existing palette.
// ==========================================

const STATUS_CHART_COLORS = {
  backlog: "#7A8780",
  todo: "#8ED9B7",
  inProgress: "#2878D8",
  pendingReview: "#D99A24",
  closed: "#16A66A",
};

const PRIORITY_CHART_COLORS = {
  Low: "#16A66A",
  Medium: "#2878D8",
  High: "#D99A24",
  Critical: "#D64545",
  "Not set": "#7A8780",
};

function getCurrentUserId() {
  try {
    return JSON.parse(sessionStorage.getItem("user"))?.id ?? null;
  } catch {
    return null;
  }
}

function formatDate(value) {
  if (!value) return "--";
  return new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function ProjectWorkspace() {

  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  // Same component reused under both /admin and /employee — every
  // internal navigation call below is built from this instead of a
  // hardcoded "/employee/..." prefix.
  const basePath = location.pathname.startsWith("/admin") ? "/admin" : "/employee";

  // "/admin/*" is wrapped in ProtectedRoute allowedRole="admin" — a
  // non-admin literally cannot render this component under that
  // prefix, so basePath doubles as a reliable, zero-network-call
  // signal for the same role='admin' organization-admin exception
  // the backend now applies to GET /:id, GET /:id/my-permissions,
  // and DELETE /:id (see accessMiddleware.js's Or-Admin middlewares).
  const isOrgAdmin = basePath === "/admin";

  const [project, setProject] = useState(null);
  const [epics, setEpics] = useState([]);
  const [features, setFeatures] = useState([]);
  const [stories, setStories] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [sprints, setSprints] = useState([]);
  const [myPermissions, setMyPermissions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [activeTab, setActiveTab] = useState("backlog");

  const [showCreateStory, setShowCreateStory] = useState(false);
  const [createStoryForFeature, setCreateStoryForFeature] = useState(null);
  const [editingStory, setEditingStory] = useState(null);
  const [createTaskForStory, setCreateTaskForStory] = useState(null);
  const [showEditProject, setShowEditProject] = useState(false);
  const [showCreateSprint, setShowCreateSprint] = useState(false);
  const [editingSprint, setEditingSprint] = useState(null);

  const [showCreateEpic, setShowCreateEpic] = useState(false);
  const [editingEpic, setEditingEpic] = useState(null);
  const [showCreateFeature, setShowCreateFeature] = useState(false);
  const [createFeatureForEpic, setCreateFeatureForEpic] = useState(null);
  const [editingFeature, setEditingFeature] = useState(null);

  // Phase 1 — effective permissions for the current project,
  // resolved server-side (see projectPermissionService.js). Used
  // ONLY to show/hide buttons here; every action they gate is
  // independently re-checked by the backend regardless.
  const canEditProject = Boolean(myPermissions?.PROJECT_EDIT);
  const canCreateUserStory = Boolean(myPermissions?.USER_STORY_CREATE);
  const canCreateTask = Boolean(myPermissions?.TASK_CREATE);
  const canOpenSettings = Boolean(
    myPermissions?.PROJECT_MANAGE_MEMBERS || myPermissions?.PROJECT_MANAGE_SECURITY
  ) || isOrgAdmin;
  const canDeleteProject = Boolean(myPermissions?.PROJECT_DELETE) || isOrgAdmin;

  // Sprint entity lifecycle (create/edit/start/complete/delete) reuses
  // PROJECT_EDIT -- the same admin-tier permission that already governs
  // project-level structural changes. Assigning a task INTO/OUT OF a
  // sprint reuses TASK_EDIT with no ownership requirement, matching how
  // the generic Edit Task form already lets any TASK_EDIT holder touch
  // any task in the project (see Step 1 report for the full mapping).
  const canManageSprints = Boolean(myPermissions?.PROJECT_EDIT);
  const canAssignTaskToSprint = Boolean(myPermissions?.TASK_EDIT);

  // Epic/Feature hierarchy -- separate permission keys per the
  // approved architecture (not reusing USER_STORY_* or PROJECT_EDIT).
  const canCreateEpic = Boolean(myPermissions?.EPIC_CREATE);
  const canEditEpic = Boolean(myPermissions?.EPIC_EDIT);
  const canDeleteEpic = Boolean(myPermissions?.EPIC_DELETE);
  const canCreateFeature = Boolean(myPermissions?.FEATURE_CREATE);
  const canEditFeature = Boolean(myPermissions?.FEATURE_EDIT);
  const canDeleteFeature = Boolean(myPermissions?.FEATURE_DELETE);
  const canDeleteUserStory = Boolean(myPermissions?.USER_STORY_DELETE);

  // Shared by Backlog and Board (Kanban) -- both tabs read from the
  // same already-loaded, already permission-scoped `tasks` array
  // fetched once by loadAll() below, so filtering here only ever
  // narrows what this project member could already see.
  const currentUserId = getCurrentUserId();
  const [filters, setFilters] = useState(DEFAULT_TASK_FILTERS);
  const filtersActive = isTaskFilterActive(filters);

  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => taskMatchesFilters(task, filters, currentUserId));
  }, [tasks, filters, currentUserId]);

  const loadAll = async () => {
    try {
      setLoading(true);

      // getProject/getMyProjectPermissions are the only two REQUIRED
      // calls -- everything else (epics/features/stories/tasks/
      // sprints) is allowed to fail independently, e.g. an
      // organization admin viewing a project they are not a member
      // of still sees the Overview, with Backlog/Board/Sprints
      // rendering empty rather than the whole page failing. Those
      // endpoints (BACKLOG_VIEW/BOARD_VIEW) stay exactly as strict
      // as before -- only the two required calls got a backend
      // admin exception (see projectRoutes.js).
      const [projectRes, epicsRes, featuresRes, storiesRes, tasksRes, sprintsRes, permissionsRes] = await Promise.allSettled([
        getProject(id),
        getEpics(id),
        getFeatures(id),
        getUserStories(id),
        getProjectTasks(id),
        getSprints(id),
        getMyProjectPermissions(id),
      ]);

      if (projectRes.status === "rejected") {
        throw projectRes.reason;
      }

      if (permissionsRes.status === "rejected") {
        throw permissionsRes.reason;
      }

      setProject(projectRes.value.project);
      setEpics(epicsRes.status === "fulfilled" ? (epicsRes.value.epics || []) : []);
      setFeatures(featuresRes.status === "fulfilled" ? (featuresRes.value.features || []) : []);
      setStories(storiesRes.status === "fulfilled" ? (storiesRes.value.userStories || []) : []);
      setTasks(tasksRes.status === "fulfilled" ? (tasksRes.value.tasks || []) : []);
      setSprints(sprintsRes.status === "fulfilled" ? (sprintsRes.value.sprints || []) : []);
      setMyPermissions(permissionsRes.value.permissions || null);
    } catch (error) {
      console.error(error);
      const status = error.response?.status;
      if (status === 403 || status === 401 || status === 404) {
        setAccessDenied(true);
      } else {
        toast.error(error.response?.data?.message || "Unable to load this project");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const openTask = (taskId) => {
    navigate(`${basePath}/task-workspace/${taskId}`);
  };

  // ==========================================
  // STATUS CHANGE — shared by the Board's drag-
  // and-drop AND its "Move to" dropdown fallback.
  //
  // Optimistic: the task moves to the new column
  // immediately (before the network call resolves)
  // so dragging feels instant. Only the single
  // task's status field is ever touched locally —
  // title/description/assignee/etc. are never
  // re-derived or overwritten here. On failure, the
  // SAME task is rolled back to its previous status
  // via a functional update (not a full snapshot
  // restore), so a concurrent optimistic update to a
  // different task in flight is never clobbered.
  //
  // The actual persistence still goes through the
  // existing, dedicated changeTaskStatus() service
  // call -> PATCH /task-management/:id/status, which
  // only ever updates the status column server-side
  // (see taskService.updateTaskStatus). No other
  // task-update endpoint is used here.
  // ==========================================

  const handleStatusChange = async (taskId, newStatus) => {

    const current = tasks.find((task) => task.id === taskId);

    if (!current || current.status === newStatus) {
      // Same column (or task not found) — nothing to do,
      // no network request needed.
      return;
    }

    const previousStatus = current.status;

    setTasks((prev) =>
      prev.map((task) =>
        task.id === taskId ? { ...task, status: newStatus } : task
      )
    );

    try {
      await changeTaskStatus(taskId, newStatus);
      toast.success("Task status updated");
    } catch (error) {
      setTasks((prev) =>
        prev.map((task) =>
          task.id === taskId ? { ...task, status: previousStatus } : task
        )
      );
      toast.error(error.response?.data?.message || "Unable to update task status");
    }
  };

  // ==========================================
  // SPRINT ACTIONS — all simply re-fetch via
  // loadAll() on success rather than patching local
  // state (sprint task-counts, progress, and the
  // Backlog/Board task list all need to stay in sync
  // together, so one refetch is simpler and safer
  // than several partial local updates).
  // ==========================================

  const handleStartSprint = async (sprintId) => {
    try {
      await startSprint(sprintId);
      toast.success("Sprint started");
      await loadAll();
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to start sprint");
    }
  };

  const handleCompleteSprint = async (sprintId) => {

    const confirmed = window.confirm(
      "Complete this sprint? Any tasks that aren't Closed will be moved back to the Backlog. Closed tasks stay with this sprint for history."
    );

    if (!confirmed) return;

    try {
      const response = await completeSprint(sprintId);
      const movedCount = response.movedTaskCount || 0;
      toast.success(
        movedCount > 0
          ? `Sprint completed. ${movedCount} incomplete task${movedCount === 1 ? "" : "s"} moved back to Backlog.`
          : "Sprint completed"
      );
      await loadAll();
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to complete sprint");
    }
  };

  const handleDeleteSprint = async (sprintId, sprintName) => {

    const confirmed = window.confirm(
      `Delete "${sprintName}"? Any tasks still in it will be moved back to the Backlog. This cannot be undone.`
    );

    if (!confirmed) return;

    try {
      await deleteSprint(sprintId);
      toast.success("Sprint deleted");
      await loadAll();
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to delete sprint");
    }
  };

  const handleAssignTaskToSprint = async (taskId, sprintId) => {
    try {
      await assignTaskToSprint(taskId, sprintId);
      await loadAll();
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to update task's sprint");
    }
  };

  // ==========================================
  // EPIC / FEATURE DELETE
  // Deleting an Epic detaches (never deletes) its
  // Features back to "no Epic" -- and deleting a
  // Feature detaches its User Stories back to "no
  // Feature" -- both handled entirely by the
  // database's own ON DELETE SET NULL foreign keys
  // (see epicService.js/featureService.js), matching
  // the approved "opt-in at every level" design.
  // ==========================================

  const handleDeleteEpic = async (epicId, epicName) => {

    const confirmed = window.confirm(
      `Delete "${epicName}"? Its Features will move back to "No Epic" — they will not be deleted. This cannot be undone.`
    );

    if (!confirmed) return;

    try {
      await deleteEpic(epicId);
      toast.success("Epic deleted");
      await loadAll();
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to delete epic");
    }
  };

  const handleDeleteFeature = async (featureId, featureName) => {

    const confirmed = window.confirm(
      `Delete "${featureName}"? Its User Stories will move back to "No Feature" — they will not be deleted. This cannot be undone.`
    );

    if (!confirmed) return;

    try {
      await deleteFeature(featureId);
      toast.success("Feature deleted");
      await loadAll();
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to delete feature");
    }
  };

  const handleDeleteStory = async (storyId, storyName) => {

    const confirmed = window.confirm(
      `Delete "${storyName}"? Its Tasks will move back to "No User Story" — they will not be deleted. This cannot be undone.`
    );

    if (!confirmed) return;

    try {
      await deleteUserStory(storyId);
      toast.success("User story deleted");
      await loadAll();
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to delete user story");
    }
  };

  const handleDeleteProject = async () => {

    const confirmed = window.confirm(
      `Delete "${project?.name}"? This will permanently delete the project and everything in it — its Epics, Features, User Stories, Tasks, Sprints, Members, and Activity. This cannot be undone.`
    );

    if (!confirmed) return;

    try {
      await deleteProject(id);
      toast.success("Project deleted");
      navigate(`${basePath}/projects`);
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to delete project");
    }
  };

  if (loading) {
    return (
      <div className="employee-page-content">
        <div className="my-team-card">
          <div className="my-team-empty">Loading project...</div>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="employee-page-content">
        <div className="my-team-card">
          <div className="my-team-empty">
            {accessDenied
              ? "You no longer have access to this project."
              : "This project is not available."}
          </div>
          <button
            type="button"
            className="pw-back-button"
            onClick={() => navigate(`${basePath}/projects`)}
          >
            <FaArrowLeft /> All Projects
          </button>
        </div>
      </div>
    );
  }

  return (

    <div className="employee-page-content">

      <button type="button" className="pw-back-button" onClick={() => navigate(`${basePath}/projects`)}>
        <FaArrowLeft /> All Projects
      </button>

      <section className="my-team-card">

        <div className="pw-header">
          <div>
            <h2>{project.name}</h2>
            {project.description && <p>{project.description}</p>}
          </div>
          <div className="pw-header-actions">
            <span className={`exec-project-status ${project.status}`}>
              {PROJECT_STATUS_LABELS[project.status] || project.status}
            </span>
            {canEditProject && (
              <button
                type="button"
                className="pw-edit-button"
                onClick={() => setShowEditProject(true)}
              >
                <FaPen /> Edit
              </button>
            )}
          </div>
        </div>

        <div className="pw-header-meta">
          <span><FaUserTie /> {project.owner_name || "No owner assigned"}</span>
          <span>Due {formatDate(project.due_date)}</span>
          <span>{project.progress || 0}% complete</span>
        </div>

        <div className="exec-project-progress-track">
          <div
            className="exec-project-progress-fill"
            style={{ width: `${Math.min(100, Math.max(0, project.progress || 0))}%` }}
          />
        </div>

      </section>

      <div className="pw-tabs">
        {["overview", "backlog", "kanban", "sprints", "analytics", ...(canOpenSettings ? ["settings"] : [])].map((tab) => (
          <button
            key={tab}
            type="button"
            className={activeTab === tab ? "pw-tab active" : "pw-tab"}
            onClick={() => setActiveTab(tab)}
          >
            {tab === "overview" ? "Overview" : tab === "backlog" ? "Backlog" : tab === "kanban" ? "Board" : tab === "sprints" ? "Sprints" : tab === "analytics" ? "Analytics" : "Settings"}
          </button>
        ))}
      </div>

      {activeTab === "overview" && (
        <OverviewTab project={project} stories={stories} />
      )}

      {(activeTab === "backlog" || activeTab === "kanban") && (
        <TaskFilterBar
          tasks={tasks}
          showStory
          showSprint
          showAssignee
          onFiltersChange={setFilters}
        />
      )}

      {activeTab === "backlog" && (
        <BacklogTab
          epics={epics}
          features={features}
          stories={stories}
          tasks={filteredTasks}
          filtersActive={filtersActive}
          onOpenTask={openTask}
          onAddEpic={() => setShowCreateEpic(true)}
          onEditEpic={(epic) => setEditingEpic(epic)}
          onDeleteEpic={handleDeleteEpic}
          onAddFeature={(epicId) => {
            setCreateFeatureForEpic(epicId || null);
            setShowCreateFeature(true);
          }}
          onEditFeature={(feature) => setEditingFeature(feature)}
          onDeleteFeature={handleDeleteFeature}
          onAddStory={(featureId) => {
            setCreateStoryForFeature(featureId || null);
            setShowCreateStory(true);
          }}
          onEditStory={(story) => setEditingStory(story)}
          onDeleteStory={handleDeleteStory}
          onAddTask={(storyId) => setCreateTaskForStory(storyId)}
          canCreateEpic={canCreateEpic}
          canEditEpic={canEditEpic}
          canDeleteEpic={canDeleteEpic}
          canCreateFeature={canCreateFeature}
          canEditFeature={canEditFeature}
          canDeleteFeature={canDeleteFeature}
          canCreateUserStory={canCreateUserStory}
          canEditUserStory={Boolean(myPermissions?.USER_STORY_EDIT)}
          canDeleteUserStory={canDeleteUserStory}
          canCreateTask={canCreateTask}
        />
      )}

      {activeTab === "kanban" && (
        <KanbanTab
          tasks={filteredTasks}
          onOpenTask={openTask}
          onStatusChange={handleStatusChange}
          canChangeStatus={Boolean(myPermissions?.TASK_CHANGE_STATUS)}
        />
      )}

      {activeTab === "sprints" && (
        <SprintsTab
          sprints={sprints}
          tasks={tasks}
          onOpenTask={openTask}
          onAddSprint={() => setShowCreateSprint(true)}
          onEditSprint={(sprint) => setEditingSprint(sprint)}
          onStartSprint={handleStartSprint}
          onCompleteSprint={handleCompleteSprint}
          onDeleteSprint={handleDeleteSprint}
          onAssignTaskToSprint={handleAssignTaskToSprint}
          canManageSprints={canManageSprints}
          canAssignTaskToSprint={canAssignTaskToSprint}
        />
      )}

      {activeTab === "analytics" && (
        <AnalyticsTab sprints={sprints} />
      )}

      {activeTab === "settings" && canOpenSettings && (
        <ProjectSettings
          project={project}
          projectId={id}
          myPermissions={myPermissions}
          canDeleteProject={canDeleteProject}
          onDeleteProject={handleDeleteProject}
        />
      )}

      {showEditProject && (
        <CreateProjectModal
          project={project}
          onClose={() => setShowEditProject(false)}
          onUpdated={() => {
            setShowEditProject(false);
            loadAll();
          }}
        />
      )}

      {showCreateEpic && (
        <CreateEpicModal
          projectId={id}
          onClose={() => setShowCreateEpic(false)}
          onCreated={() => {
            setShowCreateEpic(false);
            loadAll();
          }}
        />
      )}

      {editingEpic && (
        <CreateEpicModal
          projectId={id}
          epic={editingEpic}
          onClose={() => setEditingEpic(null)}
          onUpdated={() => {
            setEditingEpic(null);
            loadAll();
          }}
        />
      )}

      {showCreateFeature && (
        <CreateFeatureModal
          projectId={id}
          epics={epics}
          defaultEpicId={createFeatureForEpic}
          onClose={() => {
            setShowCreateFeature(false);
            setCreateFeatureForEpic(null);
          }}
          onCreated={() => {
            setShowCreateFeature(false);
            setCreateFeatureForEpic(null);
            loadAll();
          }}
        />
      )}

      {editingFeature && (
        <CreateFeatureModal
          projectId={id}
          epics={epics}
          feature={editingFeature}
          onClose={() => setEditingFeature(null)}
          onUpdated={() => {
            setEditingFeature(null);
            loadAll();
          }}
        />
      )}

      {showCreateStory && (
        <CreateUserStoryModal
          projectId={id}
          features={features}
          defaultFeatureId={createStoryForFeature}
          onClose={() => {
            setShowCreateStory(false);
            setCreateStoryForFeature(null);
          }}
          onCreated={() => {
            setShowCreateStory(false);
            setCreateStoryForFeature(null);
            loadAll();
          }}
        />
      )}

      {editingStory && (
        <CreateUserStoryModal
          projectId={id}
          features={features}
          story={editingStory}
          onClose={() => setEditingStory(null)}
          onUpdated={() => {
            setEditingStory(null);
            loadAll();
          }}
        />
      )}

      {createTaskForStory && (
        <CreateStoryTaskModal
          storyId={createTaskForStory}
          projectId={id}
          onClose={() => setCreateTaskForStory(null)}
          onCreated={() => {
            setCreateTaskForStory(null);
            loadAll();
          }}
        />
      )}

      {showCreateSprint && (
        <CreateSprintModal
          projectId={id}
          onClose={() => setShowCreateSprint(false)}
          onCreated={() => {
            setShowCreateSprint(false);
            loadAll();
          }}
        />
      )}

      {editingSprint && (
        <CreateSprintModal
          projectId={id}
          sprint={editingSprint}
          onClose={() => setEditingSprint(null)}
          onUpdated={() => {
            setEditingSprint(null);
            loadAll();
          }}
        />
      )}

    </div>

  );

}

// ==========================================
// OVERVIEW TAB
// ==========================================

function OverviewTab({ project, stories }) {

  return (
    <section className="my-team-card">
      <div className="my-team-header">
        <h2>Overview</h2>
        <p>Real progress computed from task completion — nothing here is estimated.</p>
      </div>

      <div className="pw-overview-stats">
        <div className="pw-overview-stat"><span>Total Tasks</span><strong>{project.stats?.totalTasks || 0}</strong></div>
        <div className="pw-overview-stat"><span>Backlog</span><strong>{project.stats?.backlog || 0}</strong></div>
        <div className="pw-overview-stat"><span>To Do</span><strong>{project.stats?.todo || 0}</strong></div>
        <div className="pw-overview-stat"><span>In Progress</span><strong>{project.stats?.inProgress || 0}</strong></div>
        <div className="pw-overview-stat"><span>In Review</span><strong>{project.stats?.pendingReview || 0}</strong></div>
        <div className="pw-overview-stat"><span>Done</span><strong>{project.stats?.completed || 0}</strong></div>
        <div className="pw-overview-stat warning"><span>Overdue</span><strong>{project.stats?.overdue || 0}</strong></div>
      </div>

      <table className="pw-table">
        <thead>
          <tr>
            <th>User Story / Module</th>
            <th>Tasks</th>
            <th>Progress</th>
          </tr>
        </thead>
        <tbody>
          {stories.length === 0 ? (
            <tr><td colSpan={3} className="pw-empty-cell">No user stories yet.</td></tr>
          ) : stories.map((story) => (
            <tr key={story.id}>
              <td><FaFolder /> {story.title}</td>
              <td>{story.task_count}</td>
              <td>{story.progress || 0}%</td>
            </tr>
          ))}
        </tbody>
      </table>

    </section>
  );

}

// ==========================================
// BACKLOG TAB
// ==========================================

function BacklogTab({
  epics,
  features,
  stories,
  tasks,
  filtersActive,
  onOpenTask,
  onAddEpic,
  onEditEpic,
  onDeleteEpic,
  onAddFeature,
  onEditFeature,
  onDeleteFeature,
  onAddStory,
  onEditStory,
  onDeleteStory,
  onAddTask,
  canCreateEpic,
  canEditEpic,
  canDeleteEpic,
  canCreateFeature,
  canEditFeature,
  canDeleteFeature,
  canCreateUserStory,
  canEditUserStory,
  canDeleteUserStory,
  canCreateTask,
}) {

  // Grouped from the same already-loaded, already filtered project
  // task list the Board tab uses -- no per-story fetch, so search/
  // filter results are visible immediately even for a story that was
  // never manually expanded.
  const tasksByStory = useMemo(() => {
    const map = new Map();
    tasks.forEach((task) => {
      if (!task.user_story_id) return;
      if (!map.has(task.user_story_id)) map.set(task.user_story_id, []);
      map.get(task.user_story_id).push(task);
    });
    return map;
  }, [tasks]);

  const [expanded, setExpanded] = useState({});

  const toggle = (key) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // While a filter is active, every folder on the path to a matching
  // task opens automatically (a manual toggle click still works
  // normally once filters are cleared) -- this cascades up through
  // Feature and Epic the same way it already did for Story.
  const visibleStories = filtersActive
    ? stories.filter((story) => (tasksByStory.get(story.id)?.length || 0) > 0)
    : stories;

  const storiesByFeature = useMemo(() => {
    const map = new Map();
    visibleStories.forEach((story) => {
      const key = story.feature_id || "none";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(story);
    });
    return map;
  }, [visibleStories]);

  const visibleFeatures = filtersActive
    ? features.filter((feature) => (storiesByFeature.get(feature.id)?.length || 0) > 0)
    : features;

  const featuresByEpic = useMemo(() => {
    const map = new Map();
    visibleFeatures.forEach((feature) => {
      const key = feature.epic_id || "none";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(feature);
    });
    return map;
  }, [visibleFeatures]);

  const visibleEpics = filtersActive
    ? epics.filter((epic) => (featuresByEpic.get(epic.id)?.length || 0) > 0)
    : epics;

  // Features/Stories may exist directly under the Project, with no
  // Epic/Feature parent -- they render at the same top level as
  // Epics, keyed under the "none" bucket above.
  const topLevelFeatures = featuresByEpic.get("none") || [];
  const topLevelStories = storiesByFeature.get("none") || [];

  const renderTaskTable = (story, storyTasks) => (
    <>
      {storyTasks.length === 0 ? (
        <div className="pw-empty-cell">No tasks in this user story yet.</div>
      ) : (
        <table className="pw-table">
          <tbody>
            {storyTasks.map((task) => (
              <tr key={task.id} className="pw-task-row" onClick={() => onOpenTask(task.id)}>
                <td className="pw-task-title-cell">
                  {task.task_title}
                  {task.taskTags?.length > 0 && (
                    <TagChips tags={task.taskTags} max={3} />
                  )}
                </td>
                <td><span className={`pw-priority ${task.priority}`}>{task.priority}</span></td>
                <td>{task.assigned_to_name || "Unassigned"}</td>
                <td><span className={`pw-status ${task.status}`}>{STATUS_LABELS[task.status] || task.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canCreateTask && (
        <button
          type="button"
          className="pw-add-task-button"
          onClick={(event) => {
            event.stopPropagation();
            onAddTask(story.id);
          }}
        >
          <FaPlus /> Add Task
        </button>
      )}
    </>
  );

  const renderStoryFolder = (story) => {
    const key = `story-${story.id}`;
    const storyTasks = tasksByStory.get(story.id) || [];
    const isOpen = filtersActive || Boolean(expanded[key]);

    return (
      <div className="pw-story-folder" key={key}>

        <div className="pw-story-folder-header" onClick={() => toggle(key)}>
          {isOpen ? <FaChevronDown /> : <FaChevronRight />}
          <FaFolder />
          <span className="pw-story-title">{story.title}</span>
          <span className="pw-story-count">
            {storyTasks.length} Task{storyTasks.length === 1 ? "" : "s"}
            {filtersActive && story.task_count !== storyTasks.length ? ` of ${story.task_count}` : ""}
          </span>
          {(canEditUserStory || canDeleteUserStory) && (
            <div className="pw-row-actions">
              {canEditUserStory && (
                <button
                  type="button"
                  className="pw-icon-button"
                  title="Edit User Story"
                  onClick={(event) => {
                    event.stopPropagation();
                    onEditStory(story);
                  }}
                >
                  <FaPen />
                </button>
              )}
              {canDeleteUserStory && (
                <button
                  type="button"
                  className="pw-icon-button pw-icon-button-danger"
                  title="Delete User Story"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteStory(story.id, story.title);
                  }}
                >
                  <FaTrash />
                </button>
              )}
            </div>
          )}
        </div>

        {isOpen && (
          <div className="pw-story-tasks">
            {renderTaskTable(story, storyTasks)}
          </div>
        )}

      </div>
    );
  };

  const renderFeatureFolder = (feature) => {
    const key = `feature-${feature.id}`;
    const featureStories = storiesByFeature.get(feature.id) || [];
    const isOpen = filtersActive || Boolean(expanded[key]);

    return (
      <div className="pw-story-folder" key={key}>

        <div className="pw-story-folder-header" onClick={() => toggle(key)}>
          {isOpen ? <FaChevronDown /> : <FaChevronRight />}
          <FaFolder />
          <span className="pw-story-title">{feature.title}</span>
          <span className="pw-story-count">
            {featureStories.length} Stor{featureStories.length === 1 ? "y" : "ies"}
          </span>
          <div className="pw-row-actions">
            {canEditFeature && (
              <button
                type="button"
                className="pw-icon-button"
                title="Edit Feature"
                onClick={(event) => {
                  event.stopPropagation();
                  onEditFeature(feature);
                }}
              >
                <FaPen />
              </button>
            )}
            {canDeleteFeature && (
              <button
                type="button"
                className="pw-icon-button pw-icon-button-danger"
                title="Delete Feature"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteFeature(feature.id, feature.title);
                }}
              >
                <FaTrash />
              </button>
            )}
          </div>
        </div>

        {isOpen && (
          <div className="pw-nested-content">

            {featureStories.length === 0 ? (
              <div className="pw-empty-cell">No user stories in this feature yet.</div>
            ) : (
              featureStories.map((story) => renderStoryFolder(story))
            )}

            {canCreateUserStory && (
              <button
                type="button"
                className="pw-add-task-button"
                onClick={(event) => {
                  event.stopPropagation();
                  onAddStory(feature.id);
                }}
              >
                <FaPlus /> Add User Story
              </button>
            )}

          </div>
        )}

      </div>
    );
  };

  const renderEpicFolder = (epic) => {
    const key = `epic-${epic.id}`;
    const epicFeatures = featuresByEpic.get(epic.id) || [];
    const isOpen = filtersActive || Boolean(expanded[key]);

    return (
      <div className="pw-story-folder" key={key}>

        <div className="pw-story-folder-header" onClick={() => toggle(key)}>
          {isOpen ? <FaChevronDown /> : <FaChevronRight />}
          <FaFolder />
          <span className="pw-story-title">{epic.title}</span>
          <span className="pw-story-count">
            {epicFeatures.length} Feature{epicFeatures.length === 1 ? "" : "s"}
          </span>
          <div className="pw-row-actions">
            {canEditEpic && (
              <button
                type="button"
                className="pw-icon-button"
                title="Edit Epic"
                onClick={(event) => {
                  event.stopPropagation();
                  onEditEpic(epic);
                }}
              >
                <FaPen />
              </button>
            )}
            {canDeleteEpic && (
              <button
                type="button"
                className="pw-icon-button pw-icon-button-danger"
                title="Delete Epic"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteEpic(epic.id, epic.title);
                }}
              >
                <FaTrash />
              </button>
            )}
          </div>
        </div>

        {isOpen && (
          <div className="pw-nested-content">

            {epicFeatures.length === 0 ? (
              <div className="pw-empty-cell">No features in this epic yet.</div>
            ) : (
              epicFeatures.map((feature) => renderFeatureFolder(feature))
            )}

            {canCreateFeature && (
              <button
                type="button"
                className="pw-add-task-button"
                onClick={(event) => {
                  event.stopPropagation();
                  onAddFeature(epic.id);
                }}
              >
                <FaPlus /> Add Feature
              </button>
            )}

          </div>
        )}

      </div>
    );
  };

  const isCompletelyEmpty = epics.length === 0 && features.length === 0 && stories.length === 0;
  const hasVisibleContent =
    visibleEpics.length > 0 || topLevelFeatures.length > 0 || topLevelStories.length > 0;

  return (
    <section className="my-team-card">

      <div className="my-team-header pw-backlog-header">
        <div>
          <h2>Backlog</h2>
          <p>Epics, Features, and User Stories work like nested folders — expand one to see what's inside.</p>
        </div>
        <div className="pw-backlog-header-actions">
          {canCreateEpic && (
            <button type="button" className="exec-new-project-button" onClick={onAddEpic}>
              <FaPlus /> Add Epic
            </button>
          )}
          {canCreateFeature && (
            <button type="button" className="exec-new-project-button" onClick={() => onAddFeature(null)}>
              <FaPlus /> Add Feature
            </button>
          )}
          {canCreateUserStory && (
            <button type="button" className="exec-new-project-button" onClick={() => onAddStory(null)}>
              <FaPlus /> Add User Story
            </button>
          )}
        </div>
      </div>

      {isCompletelyEmpty ? (
        <div className="my-team-empty">No epics, features, or user stories yet. Break this project down to get started.</div>
      ) : !hasVisibleContent ? (
        <div className="my-team-empty">No tasks match these filters.</div>
      ) : (
        <div className="pw-backlog-list">
          {visibleEpics.map((epic) => renderEpicFolder(epic))}
          {topLevelFeatures.map((feature) => renderFeatureFolder(feature))}
          {topLevelStories.map((story) => renderStoryFolder(story))}
        </div>
      )}

    </section>
  );

}

// ==========================================
// KANBAN BOARD (Board tab)
//
// Dense, work-item-row style board — deliberately
// NOT a card grid. Status changes go through the
// existing PATCH /task-management/:id/status (via
// changeTaskStatus, called from onStatusChange up
// in ProjectWorkspace) — only the status column is
// ever touched, and that same handler now also
// does the optimistic update + rollback for drag-
// and-drop. Clicking a task still opens the
// existing, unmodified Task Workspace.
//
// Drag-and-drop is implemented with @dnd-kit/core.
// A PointerSensor with an 8px activation distance
// means a plain click/tap (no movement) never
// starts a drag at all — the item's own onClick
// (open task) fires completely normally. Only a
// real drag gesture is intercepted.
// ==========================================

function getInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  const initials = parts.length > 1
    ? `${parts[0][0]}${parts[parts.length - 1][0]}`
    : parts[0].slice(0, 2);
  return initials.toUpperCase();
}

function taskCode(task) {
  return `T-${String(task.task_number || task.id).padStart(3, "0")}`;
}

// ==========================================
// TASK ITEM CONTENT (shared by the normal
// draggable item and the DragOverlay preview)
// ==========================================

function TaskItemContent({ task }) {
  return (
    <>
      <div className="kb-item-top">
        <span className="kb-item-id">{taskCode(task)}</span>
        <span className="kb-item-title" title={task.task_title}>
          {task.task_title}
        </span>
      </div>

      {task.user_story_title && (
        <div className="kb-item-story">
          <FaFolder /> {task.user_story_title}
        </div>
      )}

      {task.taskTags?.length > 0 && (
        <div className="kb-item-tags">
          <TagChips tags={task.taskTags} max={2} />
        </div>
      )}

      <div className="kb-item-bottom">

        <span className={`kb-priority-dot ${task.priority}`} title={`${task.priority} priority`} />

        <span className="kb-avatar" title={task.assigned_to_name || "Unassigned"}>
          {task.assigned_to_name ? getInitials(task.assigned_to_name) : "—"}
        </span>

        <span className="kb-assignee-name">
          {task.assigned_to_name || "Unassigned"}
        </span>

        {task.due_date && (
          <span className="kb-due">{formatDate(task.due_date)}</span>
        )}

      </div>
    </>
  );
}

// ==========================================
// DRAGGABLE TASK ITEM
// ==========================================

function DraggableTaskItem({ task, onOpenTask, onStatusChange, canChangeStatus }) {

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: String(task.id),
    data: { status: task.status },
    disabled: !canChangeStatus,
  });

  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={isDragging ? "kb-item kb-item-dragging" : "kb-item"}
      onClick={() => onOpenTask(task.id)}
      {...listeners}
      {...attributes}
    >

      <TaskItemContent task={task} />

      {canChangeStatus && (
        <div
          className="kb-move-wrapper"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <select
            className="kb-move-select"
            value={task.status}
            onChange={(event) => onStatusChange(task.id, event.target.value)}
          >
            {KANBAN_COLUMNS.map((col) => (
              <option key={col.key} value={col.key}>Move to: {col.label}</option>
            ))}
          </select>
        </div>
      )}

    </div>
  );

}

// ==========================================
// DROPPABLE COLUMN BODY
// ==========================================

function DroppableColumnBody({ columnKey, children }) {

  const { setNodeRef, isOver } = useDroppable({ id: columnKey });

  return (
    <div
      ref={setNodeRef}
      className={isOver ? "kb-column-body kb-column-body-over" : "kb-column-body"}
    >
      {children}
    </div>
  );

}

function KanbanTab({ tasks, onOpenTask, onStatusChange, canChangeStatus }) {

  const [activeTask, setActiveTask] = useState(null);

  // 8px of movement required before a drag starts — a plain click
  // never triggers dnd-kit at all, so onOpenTask fires normally.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const handleDragStart = (event) => {
    const task = tasks.find((t) => String(t.id) === String(event.active.id));
    setActiveTask(task || null);
  };

  const handleDragEnd = (event) => {

    const { active, over } = event;

    setActiveTask(null);

    if (!over) {
      // Dropped outside any column — nothing changes.
      return;
    }

    const taskId = Number(active.id);
    const newStatus = String(over.id);
    const previousStatus = active.data.current?.status;

    if (newStatus === previousStatus) {
      // Dropped back into its own column — no API call.
      return;
    }

    onStatusChange(taskId, newStatus);

  };

  return (
    <section className="kb-board-section">

      <div className="kb-board-heading">
        <h2>Board</h2>
        <p>Drag a task to another column, or use its status control — changes save immediately.</p>
      </div>

      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveTask(null)}
      >

        <div className="kb-board-scroll">
          <div className="kb-board">
            {KANBAN_COLUMNS.map((column) => {

              const columnTasks = tasks.filter((task) => task.status === column.key);

              return (
                <div className="kb-column" key={column.key}>

                  <div className="kb-column-header">
                    <span className="kb-column-name">{column.label}</span>
                    <span className="kb-column-count">{columnTasks.length}</span>
                  </div>

                  <DroppableColumnBody columnKey={column.key}>
                    {columnTasks.length === 0 ? (
                      <div className="kb-column-empty">No tasks</div>
                    ) : columnTasks.map((task) => (
                      <DraggableTaskItem
                        key={task.id}
                        task={task}
                        onOpenTask={onOpenTask}
                        onStatusChange={onStatusChange}
                        canChangeStatus={canChangeStatus}
                      />
                    ))}
                  </DroppableColumnBody>

                </div>
              );

            })}
          </div>
        </div>

        <DragOverlay>
          {activeTask ? (
            <div className="kb-item kb-item-overlay">
              <TaskItemContent task={activeTask} />
            </div>
          ) : null}
        </DragOverlay>

      </DndContext>

    </section>
  );

}

// ==========================================
// SPRINTS TAB
// Reuses the same folder/table visual pattern as
// BacklogTab (pw-story-folder / pw-table) rather
// than introducing a new card design. Each sprint
// expands to show its own task list plus, for
// planning/active sprints, a simple "Add from
// Backlog" picker — no drag-and-drop, matching the
// approved smallest-safe-change plan.
// ==========================================

function SprintProgressBar({ closed, total }) {

  const pct = total > 0 ? Math.round((closed / total) * 100) : 0;

  return (
    <div className="pw-sprint-progress">
      <div className="exec-project-progress-track">
        <div
          className="exec-project-progress-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span>{closed} / {total} tasks closed</span>
    </div>
  );

}

function SprintsTab({
  sprints,
  tasks,
  onOpenTask,
  onAddSprint,
  onEditSprint,
  onStartSprint,
  onCompleteSprint,
  onDeleteSprint,
  onAssignTaskToSprint,
  canManageSprints,
  canAssignTaskToSprint,
}) {

  const [expanded, setExpanded] = useState({});
  const [pickerValue, setPickerValue] = useState({});

  const toggleSprint = (sprintId) => {
    setExpanded((prev) => ({ ...prev, [sprintId]: !prev[sprintId] }));
  };

  const tasksBySprint = useMemo(() => {
    const map = new Map();
    tasks.forEach((task) => {
      if (!task.sprint_id) return;
      if (!map.has(task.sprint_id)) map.set(task.sprint_id, []);
      map.get(task.sprint_id).push(task);
    });
    return map;
  }, [tasks]);

  const backlogTasks = useMemo(
    () => tasks.filter((task) => !task.sprint_id),
    [tasks]
  );

  return (
    <section className="my-team-card">

      <div className="my-team-header pw-backlog-header">
        <div>
          <h2>Sprints</h2>
          <p>Plan fixed windows of work — a task belongs to the Backlog or to one Sprint at a time.</p>
        </div>
        {canManageSprints && (
          <button type="button" className="exec-new-project-button" onClick={onAddSprint}>
            <FaPlus /> Add Sprint
          </button>
        )}
      </div>

      {sprints.length === 0 ? (
        <div className="my-team-empty">No sprints yet. Create one to start planning.</div>
      ) : (
        <div className="pw-backlog-list">
          {sprints.map((sprint) => {

            const sprintTasks = tasksBySprint.get(sprint.id) || [];
            const isOpen = Boolean(expanded[sprint.id]);
            const isCompleted = sprint.status === "completed";

            return (
              <div className="pw-story-folder" key={sprint.id}>

                <div className="pw-story-folder-header" onClick={() => toggleSprint(sprint.id)}>
                  {isOpen ? <FaChevronDown /> : <FaChevronRight />}
                  <FaFolder />
                  <span className="pw-story-title">{sprint.name}</span>
                  <span className={`pw-sprint-status-badge pw-sprint-status-${sprint.status}`}>
                    {SPRINT_STATUS_LABELS[sprint.status] || sprint.status}
                  </span>
                  <span className="pw-story-count">
                    {sprint.task_count} Task{sprint.task_count === 1 ? "" : "s"}
                  </span>
                </div>

                {isOpen && (
                  <div className="pw-story-tasks">

                    <div className="pw-sprint-meta">
                      {sprint.goal && <p className="pw-sprint-goal">{sprint.goal}</p>}
                      <div className="pw-sprint-dates">
                        <span>Start {formatDate(sprint.start_date)}</span>
                        <span>End {formatDate(sprint.end_date)}</span>
                      </div>
                      <SprintProgressBar closed={sprint.closed_task_count} total={sprint.task_count} />
                    </div>

                    {canManageSprints && (
                      <div
                        className="pw-sprint-actions"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {sprint.status === "planning" && (
                          <button type="button" className="wi-secondary-button" onClick={() => onEditSprint(sprint)}>
                            <FaPen /> Edit
                          </button>
                        )}
                        {sprint.status === "active" && (
                          <button type="button" className="wi-secondary-button" onClick={() => onEditSprint(sprint)}>
                            <FaPen /> Edit
                          </button>
                        )}
                        {sprint.status === "planning" && (
                          <button type="button" className="wi-primary-button" onClick={() => onStartSprint(sprint.id)}>
                            Start Sprint
                          </button>
                        )}
                        {sprint.status === "active" && (
                          <button type="button" className="wi-primary-button" onClick={() => onCompleteSprint(sprint.id)}>
                            Complete Sprint
                          </button>
                        )}
                        {!isCompleted && (
                          <button
                            type="button"
                            className="pw-sprint-delete-button"
                            onClick={() => onDeleteSprint(sprint.id, sprint.name)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    )}

                    {sprintTasks.length === 0 ? (
                      <div className="pw-empty-cell">No tasks in this sprint yet.</div>
                    ) : (
                      <table className="pw-table">
                        <tbody>
                          {sprintTasks.map((task) => (
                            <tr key={task.id} className="pw-task-row" onClick={() => onOpenTask(task.id)}>
                              <td className="pw-task-title-cell">
                                {task.task_title}
                                {task.taskTags?.length > 0 && (
                                  <TagChips tags={task.taskTags} max={3} />
                                )}
                              </td>
                              <td><span className={`pw-priority ${task.priority}`}>{task.priority}</span></td>
                              <td>{task.assigned_to_name || "Unassigned"}</td>
                              <td><span className={`pw-status ${task.status}`}>{STATUS_LABELS[task.status] || task.status}</span></td>
                              {canAssignTaskToSprint && !isCompleted && (
                                <td onClick={(event) => event.stopPropagation()}>
                                  <button
                                    type="button"
                                    className="wi-secondary-button"
                                    onClick={() => onAssignTaskToSprint(task.id, null)}
                                  >
                                    Remove
                                  </button>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}

                    {canAssignTaskToSprint && !isCompleted && (
                      <div className="pw-sprint-add-from-backlog" onClick={(event) => event.stopPropagation()}>
                        {backlogTasks.length === 0 ? (
                          <p className="pw-empty-cell">No tasks in the Backlog to add.</p>
                        ) : (
                          <>
                            <select
                              value={pickerValue[sprint.id] || ""}
                              onChange={(event) =>
                                setPickerValue((prev) => ({ ...prev, [sprint.id]: event.target.value }))
                              }
                            >
                              <option value="">Select a Backlog task...</option>
                              {backlogTasks.map((task) => (
                                <option key={task.id} value={task.id}>{task.task_title}</option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="pw-add-task-button"
                              disabled={!pickerValue[sprint.id]}
                              onClick={() => {
                                onAssignTaskToSprint(Number(pickerValue[sprint.id]), sprint.id);
                                setPickerValue((prev) => ({ ...prev, [sprint.id]: "" }));
                              }}
                            >
                              <FaPlus /> Add to Sprint
                            </button>
                          </>
                        )}
                      </div>
                    )}

                  </div>
                )}

              </div>
            );

          })}
        </div>
      )}

    </section>
  );

}

// ==========================================
// ANALYTICS TAB
//
// Sprint-scoped rollups over the same tasks/
// task_work_logs data already visible via Backlog/
// Board -- not a duplicate of the Overview tab
// (which is project-wide, not sprint-scoped, and
// has no charts/workload/history). Fetches lazily
// (only once this tab is opened, and again whenever
// the selected sprint changes) via the read-only
// GET /sprints/:id/analytics endpoint.
//
// Deliberately does NOT include a burndown chart or
// "tasks added/removed during sprint" metrics -- the
// existing data can't support either reliably (no
// daily snapshots, no structured sprint-membership
// history), and an approximation would be misleading
// rather than useful. Sprint History below shows
// tasks *currently* closed per sprint, not a
// historical completion percentage, for the same
// reason.
// ==========================================

function AnalyticsTab({ sprints }) {

  const [selectedSprintId, setSelectedSprintId] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Default to the project's active sprint; if none, the most
  // recently created sprint (sprints is already ordered
  // active-first-then-by-id-desc by the backend).
  useEffect(() => {

    if (selectedSprintId || sprints.length === 0) {
      return;
    }

    const defaultSprint = sprints.find((sprint) => sprint.status === "active") || sprints[0];

    setSelectedSprintId(defaultSprint.id);

  }, [sprints, selectedSprintId]);

  useEffect(() => {

    if (!selectedSprintId) {
      return;
    }

    let cancelled = false;

    setLoading(true);
    setError("");

    getSprintAnalytics(selectedSprintId)
      .then((data) => {
        if (!cancelled) setAnalytics(data.analytics);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error(err);
          setError(err.response?.data?.message || "Unable to load sprint analytics");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };

  }, [selectedSprintId]);

  if (sprints.length === 0) {
    return (
      <section className="my-team-card">
        <div className="my-team-header">
          <div>
            <h2>Analytics</h2>
            <p>Sprint progress, distribution, and workload — computed from real task data.</p>
          </div>
        </div>
        <div className="my-team-empty">No sprints yet. Create a sprint to see analytics.</div>
      </section>
    );
  }

  const statusChartData = analytics ? [
    { key: "backlog", label: "Backlog", value: analytics.statusDistribution.backlog },
    { key: "todo", label: "To Do", value: analytics.statusDistribution.todo },
    { key: "inProgress", label: "In Progress", value: analytics.statusDistribution.inProgress },
    { key: "pendingReview", label: "In Review", value: analytics.statusDistribution.pendingReview },
    { key: "closed", label: "Done", value: analytics.statusDistribution.closed },
  ] : [];

  const priorityChartData = analytics
    ? analytics.priorityDistribution.map((row) => ({ key: row.priority, label: row.priority, value: row.count }))
    : [];

  return (
    <section className="my-team-card pw-analytics">

      <div className="my-team-header pw-backlog-header">
        <div>
          <h2>Analytics</h2>
          <p>Sprint progress, distribution, and workload — computed from real task data.</p>
        </div>

        <select
          className="pw-analytics-sprint-select"
          value={selectedSprintId || ""}
          onChange={(event) => setSelectedSprintId(Number(event.target.value))}
        >
          {sprints.map((sprint) => (
            <option key={sprint.id} value={sprint.id}>
              {sprint.name} ({SPRINT_STATUS_LABELS[sprint.status] || sprint.status})
            </option>
          ))}
        </select>
      </div>

      {loading && <div className="pw-empty-cell">Loading analytics...</div>}

      {!loading && error && <div className="pw-empty-cell">{error}</div>}

      {!loading && !error && analytics && (
        <>
          <div className="pw-analytics-sprint-summary">
            <h3>{analytics.sprint.name}</h3>
            {analytics.sprint.goal && <p className="pw-sprint-goal">{analytics.sprint.goal}</p>}
            <div className="pw-sprint-dates">
              <span>Start {formatDate(analytics.sprint.startDate)}</span>
              <span>End {formatDate(analytics.sprint.endDate)}</span>
              <span className={`pw-sprint-status-badge pw-sprint-status-${analytics.sprint.status}`}>
                {SPRINT_STATUS_LABELS[analytics.sprint.status] || analytics.sprint.status}
              </span>
            </div>
          </div>

          <div className="pw-overview-stats">
            <div className="pw-overview-stat"><span>Progress</span><strong>{analytics.summary.progressPercent}%</strong></div>
            <div className="pw-overview-stat"><span>Completed</span><strong>{analytics.summary.completedTasks}</strong></div>
            <div className="pw-overview-stat"><span>Remaining</span><strong>{analytics.summary.remainingTasks}</strong></div>
            <div className="pw-overview-stat warning"><span>Overdue</span><strong>{analytics.summary.overdueTasks}</strong></div>
            <div className="pw-overview-stat"><span>Pending Review</span><strong>{analytics.summary.pendingReviewTasks}</strong></div>
          </div>

          {analytics.summary.totalTasks === 0 ? (

            <div className="my-team-empty">This sprint has no tasks yet.</div>

          ) : (
            <>
              <div className="pw-analytics-charts">

                <div className="pw-analytics-chart-card">
                  <h4>Status Distribution</h4>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={statusChartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="label" stroke="var(--text-secondary)" fontSize={12} />
                      <YAxis allowDecimals={false} stroke="var(--text-secondary)" fontSize={12} />
                      <Tooltip
                        contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)" }}
                      />
                      <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                        {statusChartData.map((entry) => (
                          <Cell key={entry.key} fill={STATUS_CHART_COLORS[entry.key]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="pw-analytics-chart-card">
                  <h4>Priority Distribution</h4>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={priorityChartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="label" stroke="var(--text-secondary)" fontSize={12} />
                      <YAxis allowDecimals={false} stroke="var(--text-secondary)" fontSize={12} />
                      <Tooltip
                        contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)" }}
                      />
                      <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                        {priorityChartData.map((entry) => (
                          <Cell key={entry.key} fill={PRIORITY_CHART_COLORS[entry.key] || "var(--primary)"} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

              </div>

              <div className="pw-analytics-table-block">
                <h4>Assignee Workload</h4>
                {analytics.assigneeWorkload.length === 0 ? (
                  <div className="pw-empty-cell">No tasks in this sprint are assigned yet.</div>
                ) : (
                  <div className="pw-table-scroll">
                    <table className="pw-table">
                      <thead>
                        <tr>
                          <th>Assignee</th>
                          <th>Total Tasks</th>
                          <th>Open Tasks</th>
                          <th>Completed Tasks</th>
                          <th>Hours Logged</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analytics.assigneeWorkload.map((row) => (
                          <tr key={row.userId}>
                            <td>{row.fullName}</td>
                            <td>{row.totalTasks}</td>
                            <td>{row.openTasks}</td>
                            <td>{row.completedTasks}</td>
                            <td>{row.hoursLogged}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}

      <div className="pw-analytics-table-block">
        <h4>Sprint History</h4>
        <div className="pw-table-scroll">
          <table className="pw-table">
            <thead>
              <tr>
                <th>Sprint</th>
                <th>Dates</th>
                <th>Status</th>
                <th>Tasks Completed</th>
              </tr>
            </thead>
            <tbody>
              {sprints.map((sprint) => (
                <tr key={sprint.id}>
                  <td>{sprint.name}</td>
                  <td>{formatDate(sprint.start_date)} – {formatDate(sprint.end_date)}</td>
                  <td>
                    <span className={`pw-sprint-status-badge pw-sprint-status-${sprint.status}`}>
                      {SPRINT_STATUS_LABELS[sprint.status] || sprint.status}
                    </span>
                  </td>
                  <td>{sprint.closed_task_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

    </section>
  );

}

export default ProjectWorkspace;
