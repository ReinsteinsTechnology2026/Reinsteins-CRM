import { useEffect, useState } from "react";

import {
  FaUsers,
  FaUserGraduate,
  FaBuilding,
  FaProjectDiagram,
  FaTasks,
  FaExclamationTriangle,
  FaClipboardCheck,
  FaUserClock,
} from "react-icons/fa";

import { toast } from "react-toastify";

import api from "../../services/api";

import "./MyTeam.css";
import "./ExecutiveDashboard.css";

// ==========================================
// EXECUTIVE DASHBOARD
//
// Company overview for Founder/Chairman, backed
// entirely by GET /organization/executive-summary
// — every number is a real COUNT/aggregate from
// existing tables (users, departments, projects,
// tasks, leave_requests, attendance,
// organization_history). Nothing here is
// estimated or fabricated; a metric that cannot
// be computed accurately is simply not shown.
// ==========================================

const STATUS_LABELS = {
  planning: "Planning",
  active: "Active",
  on_hold: "On Hold",
  completed: "Completed",
  cancelled: "Cancelled",
};

const CHANGE_TYPE_LABELS = {
  department: "Department changed",
  designation: "Designation changed",
  reporting_manager: "Reporting manager changed",
  system_access: "System access changed",
  department_head: "Department head changed",
};

function formatDateTime(value) {
  if (!value) return "--";
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ExecutiveDashboard() {

  const storedUser = sessionStorage.getItem("user");
  const user = storedUser ? JSON.parse(storedUser) : null;

  const [summary, setSummary] = useState(null);
  const [recentActivity, setRecentActivity] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const response = await api.get("/organization/executive-summary");
        setSummary(response.data.summary || null);
        setRecentActivity(response.data.recentActivity || []);
      } catch (error) {
        toast.error(error.response?.data?.message || "Unable to load the executive dashboard");
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  if (loading) {
    return (
      <div className="employee-page-content">
        <div className="my-team-card">
          <div className="my-team-empty">Loading dashboard...</div>
        </div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="employee-page-content">
        <div className="my-team-card">
          <div className="my-team-empty">Unable to load the dashboard right now.</div>
        </div>
      </div>
    );
  }

  return (

    <div className="employee-page-content">

      <section className="my-team-card">
        <div className="my-team-header">
          <h2>Welcome, {user?.fullName}</h2>
          <p>Company-wide overview of WorkHub activity.</p>
        </div>
      </section>

      <div className="exec-stats-grid">

        <div className="exec-stat-card">
          <div className="exec-stat-icon"><FaUsers /></div>
          <div>
            <p>Active Employees</p>
            <h3>{summary.activeEmployees}</h3>
          </div>
        </div>

        <div className="exec-stat-card">
          <div className="exec-stat-icon"><FaUserGraduate /></div>
          <div>
            <p>Active Interns</p>
            <h3>{summary.activeInterns}</h3>
          </div>
        </div>

        <div className="exec-stat-card">
          <div className="exec-stat-icon"><FaBuilding /></div>
          <div>
            <p>Departments</p>
            <h3>{summary.departmentCount}</h3>
          </div>
        </div>

        <div className="exec-stat-card">
          <div className="exec-stat-icon"><FaProjectDiagram /></div>
          <div>
            <p>Total Projects</p>
            <h3>{summary.totalProjects}</h3>
          </div>
        </div>

        <div className="exec-stat-card">
          <div className="exec-stat-icon"><FaTasks /></div>
          <div>
            <p>Pending Tasks</p>
            <h3>{summary.pendingTasks}</h3>
          </div>
        </div>

        <div className="exec-stat-card">
          <div className="exec-stat-icon warning"><FaExclamationTriangle /></div>
          <div>
            <p>Overdue Tasks</p>
            <h3>{summary.overdueTasks}</h3>
          </div>
        </div>

        <div className="exec-stat-card">
          <div className="exec-stat-icon"><FaClipboardCheck /></div>
          <div>
            <p>Pending Approvals</p>
            <h3>{summary.pendingLeaveApprovals}</h3>
          </div>
        </div>

        <div className="exec-stat-card">
          <div className="exec-stat-icon"><FaUserClock /></div>
          <div>
            <p>Present Today</p>
            <h3>{summary.presentToday}</h3>
          </div>
        </div>

      </div>

      <div className="exec-dashboard-panels">

        <section className="my-team-card">
          <div className="my-team-header">
            <h2>Project Status</h2>
            <p>Distribution of all projects by current status.</p>
          </div>

          {summary.projectsByStatus.length === 0 ? (
            <div className="my-team-empty">No projects have been created yet.</div>
          ) : (
            <div className="exec-status-breakdown">
              {summary.projectsByStatus.map((row) => (
                <div className="exec-status-row" key={row.status}>
                  <span>{STATUS_LABELS[row.status] || row.status}</span>
                  <strong>{row.count}</strong>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="my-team-card">
          <div className="my-team-header">
            <h2>Recent Activity</h2>
            <p>Latest organization changes recorded across the company.</p>
          </div>

          {recentActivity.length === 0 ? (
            <div className="my-team-empty">No recent organization activity.</div>
          ) : (
            <div className="exec-activity-list">
              {recentActivity.map((entry) => (
                <div className="exec-activity-row" key={entry.id}>
                  <span className="exec-activity-type">
                    {CHANGE_TYPE_LABELS[entry.change_type] || entry.change_type}
                  </span>
                  <span className="exec-activity-detail">
                    {entry.user_name || "A user"}
                    {entry.old_value || entry.new_value
                      ? ` — ${entry.old_value || "none"} → ${entry.new_value || "none"}`
                      : ""}
                  </span>
                  <span className="exec-activity-meta">
                    by {entry.changed_by_name || "system"} · {formatDateTime(entry.changed_at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

      </div>

    </div>

  );

}

export default ExecutiveDashboard;
