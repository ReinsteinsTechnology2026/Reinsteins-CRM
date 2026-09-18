import { useEffect, useState } from "react";

import { FaEnvelope, FaInfoCircle } from "react-icons/fa";

import { toast } from "react-toastify";

import api from "../../services/api";

import "./MyTeam.css";

// ==========================================
// MY EMAIL
//
// Read-only view of this employee's own auto-generated company
// email address (see server/utils/employeeEmailGenerator.js) --
// reuses the existing GET /api/employees/profile/me endpoint
// (getMyProfile in employeeController.js already selects `email`)
// rather than adding a second endpoint just to read the same column.
// Shows an explicit "not assigned yet" state when the company has no
// verified email domain, matching that the backend never fabricates
// a fake domain/email for this case.
// ==========================================

function EmployeeEmail() {

  const [email, setEmail] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {

    const load = async () => {
      try {
        const response = await api.get("/employees/profile/me");
        setEmail(response.data.profile?.email || null);
      } catch (error) {
        toast.error(error.response?.data?.message || "Unable to load your company email");
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
          <h2>My Email</h2>
          <p>Your company-assigned business email address.</p>
        </div>

        {loading ? (
          <div className="my-team-empty">Loading...</div>
        ) : !email ? (
          <div className="my-team-empty">
            <FaInfoCircle /> Your company has not set up a verified email domain yet, so no company email has been assigned to you.
          </div>
        ) : (
          <div className="reporting-manager-card">

            <div className="reporting-manager-avatar">
              <FaEnvelope />
            </div>

            <div className="reporting-manager-info">
              <h3>{email}</h3>
            </div>

          </div>
        )}

      </section>

    </div>

  );

}

export default EmployeeEmail;
