import { useCallback, useEffect, useState } from "react";
import { FaMicrosoft, FaCheckCircle, FaExclamationTriangle, FaSync, FaLink, FaUnlink, FaBan, FaPlay, FaExternalLinkAlt } from "react-icons/fa";

import api from "../../services/api";

import "./AdminMicrosoftEmail.css";

// ==========================================
// ADMIN: MICROSOFT 365 CONNECTION AND MAILBOX LINKS
//
// What an administrator can do here, and what this screen is honest about:
//   * connect the company's Microsoft 365 organisation (found from one of its verified domains -- nothing is entered by hand,
//     and no DNS record, MX, SPF, DKIM or DMARC is ever changed);
//   * link an EXISTING Microsoft 365 mailbox to an employee. Linking does not create a Microsoft mailbox or a licence; the
//     mailbox must already exist in the company's Microsoft 365. The employee then signs in with Microsoft themselves;
//   * see each mailbox's connection state, disable it (stored tokens are deleted at once) or unlink it;
//   * read the audit log.
// An administrator cannot read an employee's mail from here: there is no such call.
// ==========================================

const CONNECTION_LABEL = { pending: "Not checked", ready: "Connected", error: "Needs attention", disabled: "Disabled" };
const LINK_LABEL = { unlinked: "Not linked", awaiting_user: "Waiting for employee to sign in", linked: "Connected" };
const ERROR_TEXT = {
  DOMAIN_NOT_IN_MICROSOFT: "Microsoft has no organisation for this domain",
  TENANT_CHANGED: "The domain now belongs to a different Microsoft organisation",
  MICROSOFT_UNREACHABLE: "Could not reach Microsoft",
};
const ACTION_LABEL = {
  company_connected: "Connected Microsoft 365",
  company_connect_failed: "Microsoft 365 connection failed",
  company_check_ok: "Connection checked: healthy",
  company_check_failed: "Connection check failed",
  company_check_tenant_changed: "Domain moved to another Microsoft organisation",
  company_disconnected: "Disconnected Microsoft 365",
  mailbox_link_started: "Linked a mailbox to Microsoft 365",
  mailbox_unlinked: "Unlinked a mailbox",
  mailbox_enabled: "Enabled a mailbox",
  mailbox_disabled: "Disabled a mailbox",
  connect_started: "Employee started signing in",
  connected: "Employee connected their account",
  connect_denied: "Employee cancelled the sign-in",
  connect_wrong_account: "Sign-in with the wrong account refused",
  connect_failed: "Sign-in failed",
  disconnected: "Employee disconnected",
  reauth_required: "Microsoft sign-in expired or revoked",
  message_sent: "Message sent",
  auto_reply_changed: "Automatic replies changed",
};

const errorMessage = (err, fallback) => err?.response?.data?.message || fallback;
const when = (value) => (value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

function AdminMicrosoftEmail({ domains, onMailboxChange }) {
  const [state, setState] = useState(null);
  const [mailboxes, setMailboxes] = useState([]);
  const [audit, setAudit] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [domainId, setDomainId] = useState("");
  const [showAudit, setShowAudit] = useState(false);

  const verified = (domains || []).filter((d) => d.verification_status === "verified" && d.status === "active");

  const load = useCallback(async () => {
    setError("");
    try {
      const [company, boxes] = await Promise.all([api.get("/email/ms/company"), api.get("/email/ms/mailboxes")]);
      setState(company.data);
      setMailboxes(boxes.data.mailboxes || []);
    } catch (err) {
      setError(errorMessage(err, "Unable to load the Microsoft 365 connection."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function loadAudit() {
    try {
      const result = await api.get("/email/ms/audit", { params: { limit: 50 } });
      setAudit(result.data.entries || []);
    } catch (err) {
      setError(errorMessage(err, "Unable to load the audit log."));
    }
  }

  useEffect(() => { if (showAudit) loadAudit(); }, [showAudit]);

  async function run(label, action, success) {
    setBusy(label);
    setNotice("");
    setError("");
    try {
      await action();
      if (success) setNotice(success);
      await load();
      if (showAudit) loadAudit();
      onMailboxChange && onMailboxChange();
    } catch (err) {
      setError(errorMessage(err, "That action could not be completed."));
    } finally {
      setBusy("");
    }
  }

  const connection = state?.connection;
  const configured = state?.server?.configured;
  const health = state?.health || {};
  const ready = connection?.status === "ready";

  return (
    <div className="admin-ms">
      <h3><FaMicrosoft aria-hidden="true" /> Microsoft 365</h3>
      <p className="admin-settings-hint">
        Employees read and send company email inside ZioVenture using their own Microsoft 365 mailbox. Each employee signs in on
        Microsoft&apos;s own page; ZioVenture never sees or stores a Microsoft password. Connecting does not change your domain&apos;s
        mail routing (MX, SPF, DKIM, DMARC) and does not create Microsoft mailboxes or licences.
      </p>

      {loading && <p className="admin-settings-hint" role="status">Loading...</p>}
      {error && <p className="admin-settings-error" role="alert">{error}</p>}
      {notice && <p className="admin-ms-ok" role="status"><FaCheckCircle /> {notice}</p>}

      {!loading && state && !configured && (
        <div className="admin-ms-card admin-ms-warn" role="alert">
          <FaExclamationTriangle aria-hidden="true" />
          <div>
            <strong>Microsoft sign-in is not set up on this server.</strong>
            <p>
              A platform administrator must register ZioVenture&apos;s Microsoft application and set the server settings before
              companies can connect. Missing: {(state.server.missing || []).join(", ")}.
            </p>
          </div>
        </div>
      )}

      {!loading && state && (
        <div className="admin-ms-card">
          <div className="admin-ms-status">
            <span className={`admin-ms-pill admin-ms-pill-${connection?.status || "none"}`}>{connection ? CONNECTION_LABEL[connection.status] : "Not connected"}</span>
            {connection?.ms_tenant_id && <span className="admin-settings-hint">Organisation {connection.ms_tenant_id.slice(0, 8)}...</span>}
            {connection?.last_checked_at && <span className="admin-settings-hint">Checked {when(connection.last_checked_at)}</span>}
          </div>
          {connection?.last_error && <p className="admin-settings-error">{ERROR_TEXT[connection.last_error] || connection.last_error}</p>}

          {!ready && (
            <div className="admin-email-inline-form">
              <select value={domainId} onChange={(e) => setDomainId(e.target.value)} aria-label="Verified domain to connect">
                <option value="">Choose a verified domain</option>
                {verified.map((d) => <option key={d.id} value={d.id}>{d.domain}</option>)}
              </select>
              <button
                type="button"
                disabled={!configured || !domainId || Boolean(busy)}
                onClick={() => run("connect", () => api.post("/email/ms/company/connect", { domainId: Number(domainId) }), "Microsoft 365 organisation found and connected.")}
              >
                <FaLink /> {busy === "connect" ? "Connecting..." : "Connect Microsoft 365"}
              </button>
            </div>
          )}
          {!ready && verified.length === 0 && <p className="admin-settings-hint">Verify a domain above first. The domain must also be added to your Microsoft 365 organisation.</p>}

          {connection && (
            <div className="admin-ms-actions">
              <button type="button" disabled={Boolean(busy) || !configured} onClick={() => run("check", () => api.post("/email/ms/company/check", {}), "Connection checked.")}>
                <FaSync /> Check connection
              </button>
              {connection.status !== "disabled" && (
                <button
                  type="button"
                  className="admin-ms-danger"
                  disabled={Boolean(busy)}
                  onClick={() => window.confirm("Disconnect Microsoft 365? This removes every employee's stored Microsoft connection. Their mail stays in Microsoft 365.") && run("disconnect", () => api.post("/email/ms/company/disconnect", {}), "Microsoft 365 disconnected.")}
                >
                  <FaUnlink /> Disconnect
                </button>
              )}
              {state.adminConsentUrl && (
                <a className="admin-ms-link" href={state.adminConsentUrl} target="_blank" rel="noopener noreferrer">
                  Grant organisation-wide consent <FaExternalLinkAlt />
                </a>
              )}
            </div>
          )}

          {connection && (
            <p className="admin-settings-hint">
              Employees: {health.connected || 0} connected, {health.reauth_required || 0} need to sign in again. If your Microsoft 365
              blocks employees from approving apps, a Microsoft 365 administrator must approve ZioVenture once using the consent
              link above; nothing is granted until they accept.
            </p>
          )}
        </div>
      )}

      {!loading && state && (
        <>
          <h4>Mailbox links</h4>
          {mailboxes.length === 0 && <p className="admin-settings-hint">No mailboxes yet. Create a mailbox record above, then link it.</p>}
          <div className="admin-ms-table-wrap">
            {mailboxes.length > 0 && (
              <table className="admin-ms-table">
                <thead>
                  <tr><th>Mailbox</th><th>Employee</th><th>Status</th><th>Microsoft 365</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {mailboxes.map((m) => {
                    const needsAttention = m.connection_status === "reauth_required";
                    return (
                      <tr key={m.id}>
                        <td data-label="Mailbox">{m.email_address}</td>
                        <td data-label="Employee">{m.employeeName || `#${m.tenant_user_id}`}</td>
                        <td data-label="Status"><span className={`admin-email-status admin-email-status-${m.status}`}>{m.status}</span></td>
                        <td data-label="Microsoft 365">
                          {m.provider !== "microsoft365" ? <span className="admin-settings-hint">Not linked</span> : (
                            <>
                              <span className={`admin-ms-pill ${needsAttention ? "admin-ms-pill-error" : m.link_state === "linked" ? "admin-ms-pill-ready" : "admin-ms-pill-pending"}`}>
                                {needsAttention ? "Employee must sign in again" : LINK_LABEL[m.link_state]}
                              </span>
                              {m.ms_account && <div className="admin-settings-hint">{m.ms_account}</div>}
                              {m.connection_error && <div className="admin-settings-error">{m.connection_error}</div>}
                            </>
                          )}
                        </td>
                        <td data-label="Actions" className="admin-ms-row-actions">
                          {m.provider !== "microsoft365" && m.status === "active" && (
                            <button type="button" disabled={!ready || Boolean(busy)} title={ready ? "" : "Connect Microsoft 365 first"} onClick={() => run(`link-${m.id}`, () => api.post(`/email/ms/mailboxes/${m.id}/link`, {}), `${m.email_address} is ready: ask the employee to open Email and sign in.`)}>
                              <FaLink /> Link
                            </button>
                          )}
                          {m.provider === "microsoft365" && (
                            <button type="button" disabled={Boolean(busy)} onClick={() => window.confirm(`Unlink ${m.email_address}? The employee's stored Microsoft connection is removed.`) && run(`unlink-${m.id}`, () => api.post(`/email/ms/mailboxes/${m.id}/unlink`, {}), "Mailbox unlinked.")}>
                              <FaUnlink /> Unlink
                            </button>
                          )}
                          {m.status === "active" ? (
                            <button type="button" className="admin-ms-danger" disabled={Boolean(busy)} onClick={() => window.confirm(`Disable ${m.email_address}? The employee loses access immediately.`) && run(`off-${m.id}`, () => api.post(`/email/ms/mailboxes/${m.id}/enabled`, { enabled: false }).then(() => api.patch(`/email/mailboxes/${m.id}/status`, { status: "disabled" })), "Mailbox disabled.")}>
                              <FaBan /> Disable
                            </button>
                          ) : (
                            <button type="button" disabled={Boolean(busy)} onClick={() => run(`on-${m.id}`, () => api.patch(`/email/mailboxes/${m.id}/status`, { status: "active" }), "Mailbox enabled.")}>
                              <FaPlay /> Enable
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
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
                  <span className="admin-settings-hint">{entry.target_type ? `${entry.target_type} ${entry.target_id || ""}` : ""}{entry.actor_user_id ? ` by user ${entry.actor_user_id}` : ""}</span>
                  <time className="admin-settings-hint" dateTime={entry.created_at}>{when(entry.created_at)}</time>
                </li>
              ))}
            </ul>
          )}
          <p className="admin-settings-hint">The audit log records who connected, linked, disabled or sent, and when. It never contains message content or Microsoft sign-in tokens.</p>
        </>
      )}
    </div>
  );
}

export default AdminMicrosoftEmail;
