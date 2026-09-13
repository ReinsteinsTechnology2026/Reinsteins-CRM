import { useEffect, useState } from "react";
import { toast } from "react-toastify";
import { FaCheckCircle, FaTimesCircle } from "react-icons/fa";

import platformApi from "../../services/platformApi";
import PlatformTwoFactorSettings from "./PlatformTwoFactorSettings";

// ==========================================
// PLATFORM SETTINGS
//
// Password change is fully real -- PATCH /api/platform/auth/password,
// reusing the exact same bcrypt verify/hash pipeline as login (see
// platformAuthController.js). Everything else on this page (platform
// name/logo, default plan, maintenance mode, notification toggles) is
// deliberately left as an honest "not yet implemented" note rather
// than a toggle that doesn't actually do anything -- none of those
// currently have anywhere to be stored or read from (no
// platform_settings table exists), and building one just to hold
// unused values would be exactly the kind of fake-functionality this
// phase was told not to add.
// ==========================================

const MIN_PASSWORD_LENGTH = 10;

function formatDateTime(value) {
  if (!value) return "Never";
  return new Date(value).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function PlatformSettings() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const [emailStatus, setEmailStatus] = useState(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const loadEmailStatus = () => {
    platformApi.get("/email-logs/status").then((res) => setEmailStatus(res.data.status)).catch(() => setEmailStatus(null));
  };

  useEffect(() => { loadEmailStatus(); }, []);

  const handleTestConnection = async () => {
    try {
      setTestingConnection(true);
      setTestResult(null);
      const res = await platformApi.post("/email-logs/test-connection");
      setTestResult(res.data);
      if (res.data.connected) toast.success("SMTP connection succeeded.");
      else toast.error(res.data.reason || "SMTP connection failed.");
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to test SMTP connection.");
    } finally {
      setTestingConnection(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);

    if (!currentPassword || !newPassword) {
      setError("Current password and new password are required.");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      setError("New password must include an uppercase letter, a lowercase letter, and a number.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match.");
      return;
    }

    try {
      setSubmitting(true);
      await platformApi.patch("/auth/password", { currentPassword, newPassword });
      toast.success("Password updated successfully.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(err.response?.data?.message || "Failed to update password.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="platform-page">
      <div className="platform-page-header">
        <div>
          <h1>Settings</h1>
          <p>Platform-level configuration.</p>
        </div>
      </div>

      <div className="platform-card" style={{ padding: 24, marginBottom: 20, maxWidth: 480 }}>
        <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 6 }}>Security</h2>
        <p style={{ fontSize: 13, color: "var(--p-text-secondary)", marginTop: 0, marginBottom: 18 }}>
          Change the password for your Platform Owner account.
        </p>

        {error && <div className="platform-alert platform-alert-danger">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="platform-form-group">
            <label htmlFor="current-password">Current Password</label>
            <input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div className="platform-form-group">
            <label htmlFor="new-password">New Password</label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters, with upper/lowercase and a number`}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div className="platform-form-group">
            <label htmlFor="confirm-password">Confirm New Password</label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
          <button type="submit" className="platform-btn platform-btn-primary" disabled={submitting}>
            {submitting ? "Updating…" : "Update Password"}
          </button>
        </form>
      </div>

      <PlatformTwoFactorSettings />

      <div className="platform-card" style={{ padding: 24, marginBottom: 20, maxWidth: 480 }}>
        <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 6 }}>Email / SMTP</h2>
        <p style={{ fontSize: 13, color: "var(--p-text-secondary)", marginTop: 0, marginBottom: 18 }}>
          Status of the SMTP connection used for subscription lifecycle emails. Never shows credentials.
        </p>

        <div className="platform-result-box" style={{ marginBottom: 16 }}>
          <div className="platform-result-row">
            <span>Email Service</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {emailStatus?.configured ? (
                <><FaCheckCircle style={{ color: "var(--p-success)" }} /> Configured</>
              ) : (
                <><FaTimesCircle style={{ color: "var(--p-text-muted)" }} /> Not Configured</>
              )}
            </span>
          </div>
          <div className="platform-result-row"><span>Sending Enabled</span><span>{emailStatus?.sendingEnabled ? "Yes" : "No"}</span></div>
          <div className="platform-result-row"><span>From Address</span><span>{emailStatus?.fromAddress || "—"}</span></div>
          <div className="platform-result-row"><span>Last Successful Send</span><span>{formatDateTime(emailStatus?.lastSuccessfulSendAt)}</span></div>
          <div className="platform-result-row"><span>Max Retries per Email</span><span>{emailStatus?.maxRetries ?? "—"}</span></div>
        </div>

        <button className="platform-btn platform-btn-outline" onClick={handleTestConnection} disabled={testingConnection}>
          {testingConnection ? "Testing…" : "Test Connection"}
        </button>
        {testResult && (
          <p style={{ fontSize: 12.5, marginTop: 10, color: testResult.connected ? "var(--p-success)" : "var(--p-danger)" }}>
            {testResult.connected ? "Connection succeeded — SMTP server is reachable." : (testResult.reason || "Connection failed.")}
          </p>
        )}
        <p style={{ fontSize: 11.5, color: "var(--p-text-muted)", marginTop: 10, marginBottom: 0 }}>
          "Test Connection" only verifies the SMTP handshake — it never sends an email. See <a href="/owner/email-logs">Email Logs</a> for real delivery history.
        </p>
      </div>

      <div className="platform-card" style={{ padding: 24 }}>
        <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 6 }}>Platform Information &amp; System Defaults</h2>
        <p style={{ fontSize: 13, color: "var(--p-text-secondary)", marginTop: 0 }}>
          Platform name/logo, support contact, default subscription plan, maintenance mode, and notification
          preferences aren't connected to a backend store yet. Adding them for real (not just as UI that doesn't
          persist) would need a small platform-level settings table plus wiring each value into the flow that
          reads it (e.g. a default plan actually pre-selecting itself when creating a company). Not built this
          phase to avoid shipping controls that look functional but silently do nothing.
        </p>
      </div>
    </div>
  );
}

export default PlatformSettings;
