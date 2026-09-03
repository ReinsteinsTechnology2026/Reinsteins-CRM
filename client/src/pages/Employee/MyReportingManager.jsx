import { useEffect, useState } from "react";

import { FaUserTie, FaIdBadge, FaBuilding, FaBriefcase } from "react-icons/fa";

import { toast } from "react-toastify";

import api from "../../services/api";

import "./MyTeam.css";

// ==========================================
// MY REPORTING MANAGER
//
// Any employee/intern can see their own
// manager's basic public info — never anyone
// else's. A direct "chat with manager" shortcut
// was deliberately left out: the existing Chat
// page only opens a conversation it's already
// given an id for, not create a new one from a
// user id — adding that would mean touching the
// Chat system, which is explicitly out of scope
// for this feature.
// ==========================================

function MyReportingManager() {

  const [manager, setManager] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {

    const load = async () => {
      try {
        const response = await api.get("/organization/my-reporting-manager");
        setManager(response.data.manager);
      } catch (error) {
        toast.error(error.response?.data?.message || "Unable to load your reporting manager");
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
          <h2>My Reporting Manager</h2>
          <p>The person you currently report to in the organization.</p>
        </div>

        {loading ? (
          <div className="my-team-empty">Loading...</div>
        ) : !manager ? (
          <div className="my-team-empty">
            You do not currently have a reporting manager assigned.
          </div>
        ) : (
          <div className="reporting-manager-card">

            <div className="reporting-manager-avatar">
              <FaUserTie />
            </div>

            <div className="reporting-manager-info">
              <h3>{manager.full_name}</h3>

              <div className="reporting-manager-detail">
                <FaIdBadge /> {manager.employee_id}
              </div>

              <div className="reporting-manager-detail">
                <FaBriefcase /> {manager.designation || "Not provided"}
              </div>

              <div className="reporting-manager-detail">
                <FaBuilding /> {manager.department_name || "No department"}
              </div>
            </div>

          </div>
        )}

      </section>

    </div>

  );

}

export default MyReportingManager;
