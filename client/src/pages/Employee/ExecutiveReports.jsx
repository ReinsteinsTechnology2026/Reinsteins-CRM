import { useEffect, useState } from "react";

import { FaChartBar } from "react-icons/fa";

import { toast } from "react-toastify";

import api from "../../services/api";

import "./MyTeam.css";
import "./ExecutiveDashboard.css";

// ==========================================
// EXECUTIVE REPORTS
//
// A fuller breakdown of the same real data the
// Executive Dashboard summarizes — same
// GET /organization/executive-summary endpoint,
// no separate report-generation logic. Founder/
// Chairman can view company attendance/leave
// information here without ever being required
// to clock in/out themselves — nothing on this
// page writes attendance data.
// ==========================================

const LEAVE_STATUS_LABELS = {
  pending_manager: "Pending Manager Approval",
  pending_final: "Pending Final Approval",
  manager_rejected: "Rejected by Manager",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

const TASK_STATUS_LABELS = {
  in_progress: "In Progress",
  pending_review: "Pending Review",
  closed: "Closed",
};

function ExecutiveReports() {

  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const response = await api.get("/organization/executive-summary");
        setSummary(response.data.summary || null);
      } catch (error) {
        toast.error(error.response?.data?.message || "Unable to load reports");
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
          <div className="my-team-empty">Loading reports...</div>
        </div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="employee-page-content">
        <div className="my-team-card">
          <div className="my-team-empty">Unable to load reports right now.</div>
        </div>
      </div>
    );
  }

  return (

    <div className="employee-page-content">

      <section className="my-team-card">
        <div className="my-team-header">
          <h2><FaChartBar /> Company Reports</h2>
          <p>Real-time summaries drawn from live WorkHub data.</p>
        </div>
      </section>

      <div className="exec-dashboard-panels">

        <section className="my-team-card">
          <div className="my-team-header">
            <h2>Headcount</h2>
            <p>Active people currently in the system.</p>
          </div>
          <div className="exec-status-breakdown">
            <div className="exec-status-row">
              <span>Active Employees</span>
              <strong>{summary.activeEmployees}</strong>
            </div>
            <div className="exec-status-row">
              <span>Active Interns</span>
              <strong>{summary.activeInterns}</strong>
            </div>
            <div className="exec-status-row">
              <span>Active Departments</span>
              <strong>{summary.departmentCount}</strong>
            </div>
          </div>
        </section>

        <section className="my-team-card">
          <div className="my-team-header">
            <h2>Attendance Today</h2>
            <p>Company-wide attendance snapshot for today.</p>
          </div>
          <div className="exec-status-breakdown">
            <div className="exec-status-row">
              <span>Present Today</span>
              <strong>{summary.presentToday}</strong>
            </div>
            <div className="exec-status-row">
              <span>On Approved Leave Today</span>
              <strong>{summary.onLeaveToday}</strong>
            </div>
          </div>
        </section>

        <section className="my-team-card">
          <div className="my-team-header">
            <h2>Department Distribution</h2>
            <p>Active members per department.</p>
          </div>
          {summary.departmentDistribution.length === 0 ? (
            <div className="my-team-empty">No active departments yet.</div>
          ) : (
            <div className="exec-status-breakdown">
              {summary.departmentDistribution.map((row) => (
                <div className="exec-status-row" key={row.id}>
                  <span>{row.name}</span>
                  <strong>{row.memberCount}</strong>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="my-team-card">
          <div className="my-team-header">
            <h2>Leave Summary</h2>
            <p>All leave requests, by current status.</p>
          </div>
          {summary.leaveByStatus.length === 0 ? (
            <div className="my-team-empty">No leave requests recorded yet.</div>
          ) : (
            <div className="exec-status-breakdown">
              {summary.leaveByStatus.map((row) => (
                <div className="exec-status-row" key={row.status}>
                  <span>{LEAVE_STATUS_LABELS[row.status] || row.status}</span>
                  <strong>{row.count}</strong>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="my-team-card">
          <div className="my-team-header">
            <h2>Task Completion</h2>
            <p>All tasks, by current status.</p>
          </div>
          {summary.taskByStatus.length === 0 ? (
            <div className="my-team-empty">No tasks recorded yet.</div>
          ) : (
            <div className="exec-status-breakdown">
              {summary.taskByStatus.map((row) => (
                <div className="exec-status-row" key={row.status}>
                  <span>{TASK_STATUS_LABELS[row.status] || row.status}</span>
                  <strong>{row.count}</strong>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="my-team-card">
          <div className="my-team-header">
            <h2>Project Status</h2>
            <p>All projects, by current status.</p>
          </div>
          {summary.projectsByStatus.length === 0 ? (
            <div className="my-team-empty">No projects have been created yet.</div>
          ) : (
            <div className="exec-status-breakdown">
              {summary.projectsByStatus.map((row) => (
                <div className="exec-status-row" key={row.status}>
                  <span>{row.status}</span>
                  <strong>{row.count}</strong>
                </div>
              ))}
            </div>
          )}
        </section>

      </div>

    </div>

  );

}

export default ExecutiveReports;
