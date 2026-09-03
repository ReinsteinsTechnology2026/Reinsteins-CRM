import { useEffect, useState } from "react";

import { useNavigate } from "react-router-dom";

import {
  FaUsers,
  FaUserCheck,
  FaUserClock,
  FaTasks,
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

import "../../styles/workItems.css";
import "./AdminHome.css";

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

      }

    };

    const loadTasks = async () => {
      try {
        const response = await getTasks();
        setAllTasks(response.tasks || []);
      } catch (error) {
        console.error("Unable to load dashboard tasks:", error);
      }
    };

    const loadSprints = async () => {
      try {
        const response = await getMyActiveSprints();
        setActiveSprints(response.sprints || []);
      } catch (error) {
        console.error("Unable to load dashboard sprints:", error);
      }
    };

    loadDashboard();
    loadTasks();
    loadSprints();

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

      <div className="stats-grid">

        <div className="stat-card">

          <div className="stat-icon">

            <FaUsers />

          </div>

          <div>

            <p>Total Employees</p>

            <h2>{stats.totalEmployees}</h2>

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

            <h2>{stats.presentToday}</h2>

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

            <h2>{stats.onLeave}</h2>

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

            <h2>{statusBreakdown.in_progress}</h2>

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
          <button
            type="button"
            className="admin-panel-link"
            onClick={() => navigate("/admin/tasks")}
          >
            View all
          </button>
        </div>

        {pendingReviewTasks.length === 0 ? (

          <div className="empty-state">
            <p>Nothing is currently pending review.</p>
          </div>

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

            recentEmployees.length === 0

            ?

            (

              <div className="empty-state">

                <p>

                  No employees available.

                </p>

              </div>

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

                      <span

                        className={`employee-status ${employee.status}`}

                      >

                        {employee.status}

                      </span>

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

          {overdueTasks.length === 0 ? (

            <div className="empty-state">
              <p>No overdue tasks.</p>
            </div>

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

          {activeSprints.length === 0 ? (

            <div className="empty-state">
              <p>No active sprints right now.</p>
            </div>

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

          {totalVisibleTasks === 0 ? (

            <div className="empty-state">
              <p>No tasks to summarize yet.</p>
            </div>

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
