import { useEffect, useState } from "react";
import { FaEnvelope, FaInbox } from "react-icons/fa";

import api from "../../services/api";

import "./EmployeeEmail.css";

// ==========================================
// EMPLOYEE EMAIL (Phase 16A foundation)
//
// Placeholder only, per Phase 16A Step 19 -- shows the employee's own
// mailbox status (if their company admin has created one for them);
// the real inbox/compose/threading UI arrives once mail
// infrastructure is connected (see the Phase 16A report).
// ==========================================

function EmployeeEmail() {
  const [mailbox, setMailbox] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  useEffect(() => {
    api.get("/email/mailboxes/me")
      .then((res) => setMailbox(res.data?.mailbox || null))
      .catch((err) => {
        if (err.response?.status === 404) {
          setMessage("You don't have a company mailbox yet. Ask your admin to set one up in Settings.");
        } else if (err.response?.status === 401) {
          setMessage("Business email is only available when signed in through your company's own login link.");
        } else {
          setMessage("Unable to load your mailbox right now.");
        }
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="employee-email-page">
      <div className="employee-email-header">
        <FaEnvelope />
        <h1>Email</h1>
      </div>

      {!loading && mailbox && (
        <div className="employee-email-card">
          <FaInbox />
          <div>
            <p className="employee-email-address">{mailbox.email_address}</p>
            <p className="employee-email-status">
              Status: {mailbox.status} &middot;{" "}
              {mailbox.provisioning_status === "provisioned"
                ? "Connected to mail server"
                : "Mail delivery is not connected yet -- coming in a later update."}
            </p>
          </div>
        </div>
      )}

      {!loading && !mailbox && <p className="employee-email-hint">{message}</p>}
    </div>
  );
}

export default EmployeeEmail;
