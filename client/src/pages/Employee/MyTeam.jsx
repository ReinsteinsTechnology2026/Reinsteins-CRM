import { useEffect, useState } from "react";

import { FaUsers, FaIdBadge } from "react-icons/fa";

import { toast } from "react-toastify";

import api from "../../services/api";

import "./MyTeam.css";

// ==========================================
// MY TEAM
//
// Direct reports only — naturally self-scoped
// by the backend (GET /organization/my-team only
// ever returns people whose reporting_manager_id
// is the requester's own id). A normal employee
// with no direct reports simply sees an empty
// team; nothing here can expose unrelated
// employee data.
// ==========================================

function MyTeam() {

  const [team, setTeam] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {

    const load = async () => {
      try {
        const response = await api.get("/organization/my-team");
        setTeam(response.data.team || []);
      } catch (error) {
        toast.error(error.response?.data?.message || "Unable to load your team");
      } finally {
        setLoading(false);
      }
    };

    load();

  }, []);

  return (

    <div className="employee-page-content">

      <section className="my-team-card">

        <div className="my-team-header">
          <h2><FaUsers /> My Team</h2>
          <p>People who currently report directly to you.</p>
        </div>

        {loading ? (
          <div className="my-team-empty">Loading your team...</div>
        ) : team.length === 0 ? (
          <div className="my-team-empty">
            You do not currently have any direct reports.
          </div>
        ) : (
          <div className="my-team-list">
            {team.map((member) => (
              <div className="my-team-member-row" key={member.id}>

                <div className="my-team-member-avatar">
                  {member.full_name?.charAt(0).toUpperCase() || "U"}
                </div>

                <div className="my-team-member-info">
                  <strong>{member.full_name}</strong>
                  <span><FaIdBadge /> {member.employee_id} · {member.designation || "No designation"}</span>
                  <span>{member.department_name || "No department"}</span>
                </div>

                <span className={`employment-type-badge ${member.employment_type}`}>
                  {member.employment_type}
                </span>

                <span className={`my-team-attendance ${member.attendance_today}`}>
                  {member.attendance_today === "not_logged_in"
                    ? "Not logged in"
                    : member.attendance_today}
                </span>

                {member.pending_leave_count > 0 && (
                  <span className="my-team-pending-leave">
                    {member.pending_leave_count} pending leave
                  </span>
                )}

              </div>
            ))}
          </div>
        )}

      </section>

    </div>

  );

}

export default MyTeam;
