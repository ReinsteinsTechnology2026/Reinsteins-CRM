import { useCallback, useEffect, useState } from "react";
import { FaGoogle, FaMicrosoft, FaCheckCircle, FaExclamationTriangle, FaUnlink, FaShieldAlt } from "react-icons/fa";

import api from "../../services/api";

import "./AdminEmailConnections.css";

// ==========================================
// ADMIN: EMAIL CONNECTIONS (status only)
//
// Employees connect their OWN existing Gmail / Google Workspace / Outlook.com / Microsoft 365 accounts from the Email page. What an
// administrator can see here is CONNECTION STATUS: who has which kind of account connected, whether it is healthy, and when it was
// last checked. Addresses are masked, and there is no way to open, search or count anyone's mail from this screen -- the server has no
// such call. An administrator can disconnect an account (for example when someone leaves); that deletes the stored sign-in.
// ==========================================

const ACTION_LABEL = {
  account_connect_started: "Employee started connecting an account",
  account_reconnect_started: "Employee started reconnecting an account",
  account_connected: "Employee connected an account",
  account_connect_denied: "Employee cancelled the sign-in",
  account_connect_failed: "Connecting an account failed",
  account_connect_wrong_account: "Reconnect with a different account refused",
  account_connect_insufficient_scopes: "Sign-in refused: mail permission was not granted",
  account_disconnected: "Employee disconnected an account",
  account_disconnected_by_admin: "Administrator disconnected an account",
  account_reauth_required: "Provider sign-in expired or was revoked",
  account_sync_failing: "Checking for new mail keeps failing",
  message_sent: "Message sent",
  auto_reply_changed: "Automatic replies changed",
};
const errorMessage = (err, fallback) => err?.response?.data?.message || fallback;
const when = (value) => (value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

function AdminEmailConnections() {
  const [overview, setOverview] = useState(null);
  const [audit, setAudit] = useState([]);
  const [showAudit, setShowAudit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get("/email/accounts/admin/overview");
      setOverview(result.data);
      setError("");
    } catch (err) {
      setError(errorMessage(err, "Unable to load email connections."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!showAudit) return;
    api.get("/email/accounts/admin/audit", { params: { limit: 50 } }).then((r) => setAudit(r.data.entries || [])).catch((err) => setError(errorMessage(err, "Unable to load the audit log.")));
  }, [showAudit]);

  async function disconnect(account, employee) {
    if (!window.confirm(`Disconnect ${account.kindLabel} account ${account.address} of ${employee.name}? The stored sign-in is deleted. Their mail is not touched and they can connect again.`)) return;
    setBusy(account.id);
    setNotice("");
    try {
      await api.delete(`/email/accounts/admin/${account.id}`);
      setNotice("Account disconnected.");
      await load();
    } catch (err) {
      setError(errorMessage(err, "That could not be completed."));
    } finally {
      setBusy(null);
    }
  }

  const providers = overview && overview.providers;
  const totals = (overview && overview.totals) || {};

  return (
    <div className="admin-ms">
      <h3><FaShieldAlt aria-hidden="true" /> Email connections</h3>
      <p className="admin-settings-hint">
        Every employee can connect their own existing Gmail, Google Workspace, Outlook.com / Hotmail or Microsoft 365 account from the Email page. Nothing is
        hosted or licensed by ZioVenture and no company domain is needed. You can see who is connected and whether it is healthy, but you can never read
        anyone&apos;s email.
      </p>

      {loading && <p className="admin-settings-hint" role="status">Loading...</p>}
      {error && <p className="admin-settings-error" role="alert">{error}</p>}
      {notice && <p className="admin-ms-ok" role="status"><FaCheckCircle /> {notice}</p>}

      {providers && (
        <div className="admin-ms-card">
          {["google", "microsoft"].map((p) => (
            <div key={p} className="admin-ms-status">
              {p === "google" ? <FaGoogle aria-hidden="true" /> : <FaMicrosoft aria-hidden="true" />}
              <strong>{p === "google" ? "Google (Gmail, Workspace)" : "Microsoft (Outlook.com, Hotmail, Microsoft 365)"}</strong>
              <span className={`admin-ms-pill ${providers[p].configured ? "admin-ms-pill-ready" : "admin-ms-pill-pending"}`}>{providers[p].configured ? "Set up" : "Not set up on this server"}</span>
              {providers[p].configured && <span className="admin-settings-hint">{providers[p].pushConfigured ? "Instant new-mail notifications" : "New mail is checked every couple of minutes"}</span>}
              {!providers[p].configured && <span className="admin-settings-hint">The platform owner must register the app (missing: {providers[p].missing.join(", ")}).</span>}
            </div>
          ))}
        </div>
      )}

      {overview && (
        <>
          <p className="admin-settings-hint">
            {overview.employees.length} employee{overview.employees.length === 1 ? "" : "s"} with connected accounts - {totals.connected || 0} working, {totals.reauth_required || 0} need to reconnect.
          </p>
          {overview.employees.length === 0 && <p className="admin-settings-hint">Nobody has connected an account yet.</p>}
          <div className="admin-ms-table-wrap">
            {overview.employees.length > 0 && (
              <table className="admin-ms-table">
                <thead><tr><th>Employee</th><th>Account</th><th>State</th><th>Last checked</th><th>Actions</th></tr></thead>
                <tbody>
                  {overview.employees.flatMap((employee) => employee.accounts.map((a, index) => (
                    <tr key={a.id}>
                      <td data-label="Employee">{index === 0 ? employee.name : ""}</td>
                      <td data-label="Account">
                        {a.provider === "google" ? <FaGoogle aria-hidden="true" /> : <FaMicrosoft aria-hidden="true" />} {a.kindLabel}
                        <div className="admin-settings-hint">{a.address}</div>
                      </td>
                      <td data-label="State">
                        <span className={`admin-ms-pill ${a.status === "connected" ? "admin-ms-pill-ready" : "admin-ms-pill-error"}`}>{a.status === "connected" ? "Connected" : "Needs reconnect"}</span>
                        {a.syncError && a.status === "connected" && <div className="admin-settings-error"><FaExclamationTriangle aria-hidden="true" /> Sync problem</div>}
                      </td>
                      <td data-label="Last checked">{when(a.lastSyncAt) || "-"}</td>
                      <td data-label="Actions" className="admin-ms-row-actions">
                        <button type="button" className="admin-ms-danger" disabled={busy === a.id} onClick={() => disconnect(a, employee)}><FaUnlink /> Disconnect</button>
                      </td>
                    </tr>
                  )))}
                </tbody>
              </table>
            )}
          </div>

          <h4>
            Audit log{" "}
            <button type="button" className="admin-ms-linkbtn" aria-expanded={showAudit} onClick={() => setShowAudit((v) => !v)}>{showAudit ? "Hide" : "Show"}</button>
          </h4>
          {showAudit && (
            <ul className="admin-ms-audit">
              {audit.length === 0 && <li className="admin-settings-hint">Nothing recorded yet.</li>}
              {audit.map((entry) => (
                <li key={entry.id}>
                  <span>{ACTION_LABEL[entry.action] || entry.action}</span>
                  <span className="admin-settings-hint">{entry.actor_user_id ? `by user ${entry.actor_user_id}` : ""}</span>
                  <time className="admin-settings-hint" dateTime={entry.created_at}>{when(entry.created_at)}</time>
                </li>
              ))}
            </ul>
          )}
          <p className="admin-settings-hint">The audit log records who connected, disconnected or sent, and when. It never contains message content or sign-in tokens.</p>
        </>
      )}
    </div>
  );
}

export default AdminEmailConnections;
