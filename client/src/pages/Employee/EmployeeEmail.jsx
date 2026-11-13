import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { FaEnvelope } from "react-icons/fa";

import { connection, errorInfo } from "./email/emailApi";
import ConnectPanel from "./email/ConnectPanel";
import EmailClient from "./email/EmailClient";

import "./EmployeeEmail.css";
import "./email/emailClient.css";

// ==========================================
// EMAIL (company mailbox, Microsoft 365)
//
// One page for employees and for admins who have a mailbox of their own (the admin portal mounts the same component).
// It first asks the server for the employee's mailbox state and shows either the connect / reconnect / "ask your admin"
// screen or the full mail client. The state decision lives on the server (msEmailService.employeeStatus); nothing here
// is trusted for access -- every mail call is checked against the signed-in employee again.
//
// Coming back from Microsoft's sign-in the URL carries ?ms=connected or ?ms=error&reason=<code>. Only a short code is ever
// passed, never Microsoft's own error text.
// ==========================================

const REASONS = {
  denied: "The Microsoft sign-in was cancelled. You can try again.",
  wrong_account: "You signed in with a different Microsoft account than your company mailbox. Sign in with the mailbox address shown below.",
  wrong_organisation: "That Microsoft account belongs to a different organisation than your company's Microsoft 365.",
  invalid_state: "That sign-in link has expired or was already used. Start again.",
  invalid_code: "Microsoft did not complete the sign-in. Start again.",
  mailbox_unavailable: "Your mailbox is not available for connection. Ask your administrator.",
  company_not_ready: "Your company's Microsoft 365 connection is not ready. Ask your administrator.",
  no_refresh_token: "Microsoft did not grant ongoing access. Ask your administrator to check the app's permissions, then try again.",
  not_configured: "Microsoft sign-in is not set up on this server yet.",
  failed: "The Microsoft sign-in could not be completed. Try again, or ask your administrator.",
};

function EmployeeEmail() {
  const location = useLocation();
  const navigate = useNavigate();
  const portal = location.pathname.includes("/admin") ? "admin" : "employee";

  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [banner, setBanner] = useState(null);

  const loadStatus = useCallback(async () => {
    try {
      const result = await connection.status();
      setStatus(result);
      setMessage("");
    } catch (error) {
      const info = errorInfo(error);
      if (info.status === 401) setMessage("Business email is only available when signed in through your company's own login link.");
      else if (info.code === "FEATURE_NOT_ENABLED") setMessage("Company Email is not enabled for your organization.");
      else setMessage(info.message || "Unable to load your mailbox right now.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Read the result of a Microsoft sign-in once, then clean the URL so a refresh does not repeat the message.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const result = params.get("ms");
    if (result) {
      if (result === "connected") setBanner({ kind: "ok", text: "Microsoft account connected." });
      else setBanner({ kind: "error", text: REASONS[params.get("reason")] || REASONS.failed });
      navigate(location.pathname, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // The mail client calls this when Microsoft says the sign-in is gone, or the mailbox was disabled / unlinked.
  const handleProblem = useCallback(() => {
    loadStatus();
  }, [loadStatus]);

  const handleDisconnected = useCallback(() => {
    setBanner({ kind: "ok", text: "Your Microsoft account was disconnected." });
    loadStatus();
  }, [loadStatus]);

  return (
    <div className="employee-email-page em-page">
      <div className="employee-email-header">
        <FaEnvelope aria-hidden="true" />
        <h1>Email</h1>
      </div>

      {loading && <p className="employee-email-hint" role="status">Loading your mailbox...</p>}
      {!loading && message && <p className="employee-email-hint" role="alert">{message}</p>}

      {!loading && !message && status && status.state === "connected" && (
        <>
          {banner && <p className={`em-banner ${banner.kind === "ok" ? "em-banner-ok" : "em-banner-error"}`} role="status">{banner.text}</p>}
          <EmailClient status={status} onProblem={handleProblem} onDisconnected={handleDisconnected} />
        </>
      )}

      {!loading && !message && status && status.state !== "connected" && (
        <ConnectPanel status={status} portal={portal} onRefresh={loadStatus} banner={banner} />
      )}
    </div>
  );
}

export default EmployeeEmail;
