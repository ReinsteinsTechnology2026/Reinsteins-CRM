import { useEffect, useState } from "react";

import { useNavigate } from "react-router-dom";

import {
  FaUsers,
  FaUserCheck,
  FaUserClock,
  FaTasks,
  FaCheckCircle,
  FaChartBar,
} from "react-icons/fa";

import api from "../../services/api";

import { getTasks } from "../../services/taskManagementService";
import { getMyActiveSprints } from "../../services/sprintService";

import {
  TASK_STATUS_LABELS,
  TASK_STATUS_CLASS,
  formatDate,
} from "../../utils/workItemStatus";

import {
  getOverdueTasks,
  getPendingReviewTasks,
  getStatusBreakdown,
} from "../../utils/dashboardStats";

import { Badge, Button, EmptyState, Skeleton } from "../../components/UI";

import "../../styles/workItems.css";
import "./AdminHome.css";

// Mirrors the existing loadError convention from AdminEmailSettings.jsx
// (plain string, shown as a dismiss-free inline notice) rather than
// inventing a new error-handling pattern for this one page.
function capitalize(value) {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function AdminHome() {

  const navigate = useNavigate();

  const [stats, setStats] = useState({

    totalEmployees: 0,

    presentToday: 0,

    onLeave: 0,

    activeTasks: 0,

  });

  const [recentEmployees, setRecentEmployees] = useState([]);

  // ==========================================
  // TASK / SPRINT STATE
  // Sourced from the same membership-scoped
  // GET /task-management/tasks (admin branch)
  // already used by AdminTasksList -- this widget
  // only ever sees what an admin can already see
  // there, nothing new is exposed.
  // ==========================================

  const [allTasks, setAllTasks] = useState([]);

  const [activeSprints, setActiveSprints] = useState([]);

  // ==========================================
  // LOADING / ERROR STATE
  // Presentational only -- does not change what is
  // fetched or how; it only tracks whether the
  // initial load is still in flight, and whether any
  // of the three independent calls below failed, so
  // the dashboard can show a skeleton instead of
  // silently rendering zeros, and a notice instead of
  // silently swallowing a failure (console.error
  // alone, as before, stays for each individual
  // failure).
  // ==========================================

  const [loading, setLoading] = useState(true);

  const [loadError, setLoadError] = useState("");

  useEffect(() => {

    const loadDashboard = async () => {

      try {

        const response = await api.get("/dashboard/stats");

        setStats(response.data.stats);

        setRecentEmployees(

          response.data.recentEmployees || []

        );

      }

      catch (error) {

        console.error(

          "Unable to load dashboard:",

          error

        );

        setLoadError("Some dashboard data could not be loaded. Showing what's available.");

      }

    };

    const loadTasks = async () => {
      try {
        const response = await getTasks();
        setAllTasks(response.tasks || []);
      } catch (error) {
        console.error("Unable to load dashboard tasks:", error);
        setLoadError("Some dashboard data could not be loaded. Showing what's available.");
      }
    };

    const loadSprints = async () => {
      try {
        const response = await getMyActiveSprints();
        setActiveSprints(response.sprints || []);
      } catch (error) {
        console.error("Unable to load dashboard sprints:", error);
        setLoadError("Some dashboard data could not be loaded. Showing what's available.");
      }
    };

    Promise.allSettled([loadDashboard(), loadTasks(), loadSprints()]).then(() => {
      setLoading(false);
    });

  }, []);

  // ==========================================
  // TASK DERIVATIONS (org-wide, already
  // membership-scoped by the backend -- no
  // assignee filter here, unlike EmployeeHome)
  // ==========================================

  const pendingReviewTasks = getPendingReviewTasks(allTasks);

  const overdueTasks = getOverdueTasks(allTasks);

  const statusBreakdown = getStatusBreakdown(allTasks);

  const totalVisibleTasks = allTasks.length;

  return (

    <div className="dashboard-content">

      {loadError && (
        <div className="dashboard-load-error">{loadError}</div>
      )}

      <div className="stats-grid">

        <div className="stat-card">

          <div className="stat-icon">

            <FaUsers />

          </div>

          <div>

            <p>Total Employees</p>

            <h2>{loading ? <Skeleton width="48px" height="26px" /> : stats.totalEmployees}</h2>

            <span>

              Active registered employees

            </span>

          </div>

        </div>

        <div className="stat-card">

          <div className="stat-icon">

            <FaUserCheck />

          </div>

          <div>

            <p>Present Today</p>

            <h2>{loading ? <Skeleton width="48px" height="26px" /> : stats.presentToday}</h2>

            <span>

              Employees logged in today

            </span>

          </div>

        </div>

        <div className="stat-card">

          <div className="stat-icon">

            <FaUserClock />

          </div>

          <div>

            <p>On Leave</p>

            <h2>{loading ? <Skeleton width="48px" height="26px" /> : stats.onLeave}</h2>

            <span>

              Employees on leave

            </span>

          </div>

        </div>

        <div className="stat-card">

          <div className="stat-icon">

            <FaTasks />

          </div>

          <div>

            <p>Active Tasks</p>

            <h2>{loading ? <Skeleton width="48px" height="26px" /> : statusBreakdown.in_progress}</h2>

            <span>

              Tasks in progress

            </span>

          </div>

        </div>

      </div>

      {/* ==================================
          PENDING REVIEW — full width, the
          single most actionable admin widget.
          Reuses the same wi-table/status-pill
          pattern as AdminTasksList.
      ================================== */}

      <section className="dashboard-panel dashboard-panel-wide">

        <div className="panel-header panel-header-row">
          <div>
            <h3>Pending Review</h3>
            <span>Tasks awaiting an approval decision across your projects</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate("/admin/tasks")}
          >
            View all
          </Button>
        </div>

        {loading ? (

          <div className="dashboard-skeleton-rows">
            <Skeleton height="38px" />
            <Skeleton height="38px" />
            <Skeleton height="38px" />
          </div>

        ) : pendingReviewTasks.length === 0 ? (

          <EmptyState icon={<FaCheckCircle />} description="Nothing is currently pending review." />

        ) : (

          <div className="wi-table-wrapper admin-dashboard-table">
            <table className="wi-table">
              <tbody>
                {pendingReviewTasks.slice(0, 8).map((task) => (
                  <tr
                    key={task.id}
                    onClick={() => navigate(`/admin/task-workspace/${task.id}`)}
                  >
                    <td>
                      <div className="wi-table-task-cell">
                        <strong>{task.task_title}</strong>
                      </div>
                    </td>
                    <td>{task.project_name || "No Project"}</td>
                    <td>{task.assigned_to_name || "Unassigned"}</td>
                    <td>
                      <span className="status-pill status-pending-review">
                        Pending Review
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

        )}

      </section>

      <div className="dashboard-panels">

        <section className="dashboard-panel">

          <div className="panel-header">

            <h3>

              Recent Employees

            </h3>

            <span>

              Recently registered employee accounts

            </span>

          </div>

          {

            loading

            ?

            (

              <div className="dashboard-skeleton-rows">
                <Skeleton height="48px" />
                <Skeleton height="48px" />
                <Skeleton height="48px" />
              </div>

            )

            :

            recentEmployees.length === 0

            ?

            (

              <EmptyState icon={<FaUsers />} description="No employees available." />

            )

            :

            (

              <div className="recent-employee-list">

                {

                  recentEmployees.map((employee) => (

                    <div

                      key={employee.id}

                      className="recent-employee"

                    >

                      <div className="employee-avatar">

                        {

                          employee.full_name

                            ?.charAt(0)

                            .toUpperCase()

                        }

                      </div>

                      <div className="employee-info">

                        <h4>

                          {employee.full_name}

                        </h4>

                        <p>

                          {employee.employee_id}

                        </p>

                      </div>

                      <Badge tone={employee.status === "active" ? "success" : "danger"}>

                        {capitalize(employee.status)}

                      </Badge>

                    </div>

                  ))

                }

              </div>

            )

          }

        </section>

        {/* ==================================
            OVERDUE — replaces the previous dead
            "Today's Attendance" placeholder panel.
        ================================== */}

        <section className="dashboard-panel">

          <div className="panel-header">
            <h3>Overdue Tasks</h3>
            <span>Past due date and not yet closed</span>
          </div>

          {loading ? (

            <div className="dashboard-skeleton-rows">
              <Skeleton height="38px" />
              <Skeleton height="38px" />
            </div>

          ) : overdueTasks.length === 0 ? (

            <EmptyState icon={<FaCheckCircle />} description="No overdue tasks." />

          ) : (

            <div className="admin-list">
              {overdueTasks.slice(0, 6).map((task) => (
                <div
                  key={task.id}
                  className="admin-list-item"
                  onClick={() => navigate(`/admin/task-workspace/${task.id}`)}
                >
                  <div>
                    <strong>{task.task_title}</strong>
                    <span>{task.assigned_to_name || "Unassigned"} · {task.project_name || "No Project"}</span>
                  </div>
                  <span className="admin-due-overdue">
                    {formatDate(task.due_date)}
                  </span>
                </div>
              ))}
            </div>

          )}

        </section>

      </div>

      <div className="dashboard-panels">

        {/* ==================================
            ACTIVE SPRINTS
        ================================== */}

        <section className="dashboard-panel">

          <div className="panel-header">
            <h3>Active Sprints</h3>
            <span>Sprints currently in progress across your projects</span>
          </div>

          {loading ? (

            <div className="dashboard-skeleton-rows">
              <Skeleton height="48px" />
              <Skeleton height="48px" />
            </div>

          ) : activeSprints.length === 0 ? (

            <EmptyState icon={<FaTasks />} description="No active sprints right now." />

          ) : (

            <div className="admin-sprint-list">
              {activeSprints.map((sprint) => {

                const pct = sprint.task_count > 0
                  ? Math.round((sprint.closed_task_count / sprint.task_count) * 100)
                  : 0;

                return (
                  <div key={sprint.id} className="admin-sprint-item">
                    <div className="admin-sprint-item-top">
                      <strong>{sprint.name}</strong>
                      <span>{sprint.project_name}</span>
                    </div>
                    <div className="admin-sprint-progress-track">
                      <div
                        className="admin-sprint-progress-fill"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="admin-sprint-item-meta">
                      {sprint.closed_task_count} / {sprint.task_count} tasks closed
                      {sprint.end_date ? ` · Ends ${formatDate(sprint.end_date)}` : ""}
                    </span>
                  </div>
                );

              })}
            </div>

          )}

        </section>

        {/* ==================================
            TEAM TASK STATUS SUMMARY
        ================================== */}

        <section className="dashboard-panel">

          <div className="panel-header">
            <h3>Team Task Status</h3>
            <span>All tasks visible to you, by status</span>
          </div>

          {loading ? (

            <div className="dashboard-skeleton-rows">
              <Skeleton height="24px" />
              <Skeleton height="24px" />
              <Skeleton height="24px" />
            </div>

          ) : totalVisibleTasks === 0 ? (

            <EmptyState icon={<FaChartBar />} description="No tasks to summarize yet." />

          ) : (

            <div className="admin-status-breakdown">
              {Object.entries(statusBreakdown).map(([status, count]) => {

                const pct = totalVisibleTasks > 0
                  ? Math.round((count / totalVisibleTasks) * 100)
                  : 0;

                return (
                  <div key={status} className="admin-status-row">
                    <span className={TASK_STATUS_CLASS[status] || "status-pill status-neutral"}>
                      {TASK_STATUS_LABELS[status] || status}
                    </span>
                    <div className="admin-status-track">
                      <div
                        className="admin-status-fill"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="admin-status-count">{count}</span>
                  </div>
                );

              })}
            </div>

          )}

        </section>

      </div>

    </div>

  );

}

export default AdminHome;
