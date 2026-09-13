import { useCallback, useEffect, useState } from "react";
import { FaSearch } from "react-icons/fa";
import { toast } from "react-toastify";

import platformApi from "../../services/platformApi";

// ==========================================
// PLATFORM EMAIL LOGS (Phase 13I/13J)
//
// Real delivery history only -- every row here was written by
// emailDeliveryService at the moment a lifecycle email was actually
// attempted (or explicitly skipped, e.g. no recipient / SMTP not
// configured). "Sent" means the SMTP server accepted the message, NOT
// that it was delivered to an inbox -- this codebase has no delivery-
// confirmation mechanism, so the UI is careful never to claim more
// than that (see emailDeliveryService.js's module header).
// ==========================================

const STATUS_FILTERS = ["all", "pending", "sent", "failed", "skipped"];
const EMAIL_TYPE_LABELS = {
  trial_ending_soon: "Trial Ending Soon",
  trial_expired: "Trial Expired",
  subscription_expiring_soon: "Subscription Expiring Soon",
  payment_failed: "Payment Failed",
  grace_period_started: "Grace Period Started",
  grace_period_ending: "Grace Period Ending",
  subscription_expired: "Subscription Expired",
  subscription_renewed: "Subscription Renewed",
};

function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function PlatformEmailLogs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [selectedLog, setSelectedLog] = useState(null);
  const [retryingId, setRetryingId] = useState(null);

  const loadLogs = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (typeFilter !== "all") params.set("emailType", typeFilter);
      if (search.trim()) params.set("search", search.trim());
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);

      const response = await platformApi.get(`/email-logs?${params.toString()}`);
      setLogs(response.data.logs || []);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || "Unable to load email logs.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, typeFilter, dateFrom, dateTo]);

  useEffect(() => {
    const timer = setTimeout(() => { loadLogs(); }, search ? 350 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, statusFilter, typeFilter, dateFrom, dateTo]);

  const handleRetry = async (log) => {
    try {
      setRetryingId(log.id);
      const response = await platformApi.post(`/email-logs/${log.id}/retry`);
      const updated = response.data.log;
      setLogs((current) => current.map((l) => (l.id === log.id ? updated : l)));
      setSelectedLog((current) => (current?.id === log.id ? updated : current));
      if (updated.status === "sent") toast.success("Retry succeeded — SMTP server accepted the email.");
      else toast.error(updated.errorMessage || "Retry failed again.");
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to retry this email.");
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <div className="platform-page">

      <div className="platform-page-header">
        <div>
          <h1>Email Logs</h1>
          <p>Real subscription lifecycle email delivery history. "Sent" means the SMTP server accepted it — not confirmed inbox delivery.</p>
        </div>
      </div>

      {error && <div className="platform-alert platform-alert-danger">{error}</div>}

      <div className="platform-toolbar">
        <div className="platform-search-input">
          <FaSearch />
          <input
            type="text"
            placeholder="Search by recipient, company, or subject…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>{s === "all" ? "All Statuses" : s.charAt(0).toUpperCase() + s.slice(1)}</option>
          ))}
        </select>

        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="all">All Email Types</option>
          {Object.entries(EMAIL_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>

        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} title="From date" />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} title="To date" />
      </div>

      <div className="platform-card">
        <div className="platform-table-wrap">
          <table className="platform-table">
            <thead>
              <tr>
                <th>Date/Time</th>
                <th>Company</th>
                <th>Recipient</th>
                <th>Type</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Retries</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={8} className="platform-empty-state">Loading email logs...</td></tr>
              )}

              {!loading && logs.length === 0 && (
                <tr><td colSpan={8} className="platform-empty-state">No email logs match your filters.</td></tr>
              )}

              {!loading && logs.map((log) => (
                <tr key={log.id} className="clickable" onClick={() => setSelectedLog(log)}>
                  <td>{formatDateTime(log.createdAt)}</td>
                  <td>{log.companyName || "—"}</td>
                  <td>{log.recipientEmail || "—"}</td>
                  <td>{EMAIL_TYPE_LABELS[log.emailType] || log.emailType}</td>
                  <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{log.subject}</td>
                  <td><span className={`platform-badge status-${log.status}`}>{log.status}</span></td>
                  <td>{log.retryCount}/{log.maxRetries}</td>
                  <td style={{ textAlign: "right" }}>
                    {log.status === "failed" && log.retryCount < log.maxRetries && (
                      <button
                        className="platform-btn platform-btn-outline platform-btn-sm"
                        onClick={(e) => { e.stopPropagation(); handleRetry(log); }}
                        disabled={retryingId === log.id}
                      >
                        {retryingId === log.id ? "Retrying…" : "Retry"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selectedLog && (
        <div className="platform-modal-backdrop" onClick={() => setSelectedLog(null)}>
          <div className="platform-modal" onClick={(event) => event.stopPropagation()}>
            <div className="platform-modal-header">
              <div>
                <h2>Email Log #{selectedLog.id}</h2>
                <p>{EMAIL_TYPE_LABELS[selectedLog.emailType] || selectedLog.emailType}</p>
              </div>
              <button className="platform-modal-close" onClick={() => setSelectedLog(null)} aria-label="Close">×</button>
            </div>
            <div className="platform-modal-body">
              <div className="platform-result-box">
                <div className="platform-result-row"><span>Company</span><span>{selectedLog.companyName || "—"}</span></div>
                <div className="platform-result-row"><span>Recipient</span><span>{selectedLog.recipientEmail || "—"}{selectedLog.recipientName ? ` (${selectedLog.recipientName})` : ""}</span></div>
                <div className="platform-result-row"><span>Subject</span><span>{selectedLog.subject}</span></div>
                <div className="platform-result-row"><span>Status</span><span><span className={`platform-badge status-${selectedLog.status}`}>{selectedLog.status}</span></span></div>
                <div className="platform-result-row"><span>Retry Count</span><span>{selectedLog.retryCount} / {selectedLog.maxRetries}</span></div>
                <div className="platform-result-row"><span>Last Attempt</span><span>{formatDateTime(selectedLog.lastAttemptAt)}</span></div>
                <div className="platform-result-row"><span>Sent At</span><span>{formatDateTime(selectedLog.sentAt)}</span></div>
                {selectedLog.errorMessage && (
                  <div className="platform-result-row"><span>Error</span><span style={{ color: "var(--p-danger)" }}>{selectedLog.errorMessage}</span></div>
                )}
              </div>
              {selectedLog.status === "failed" && selectedLog.retryCount < selectedLog.maxRetries && (
                <button
                  className="platform-btn platform-btn-primary platform-btn-sm"
                  style={{ marginTop: 16 }}
                  onClick={() => handleRetry(selectedLog)}
                  disabled={retryingId === selectedLog.id}
                >
                  {retryingId === selectedLog.id ? "Retrying…" : "Retry Now"}
                </button>
              )}
            </div>
            <div className="platform-modal-footer">
              <button className="platform-btn platform-btn-outline" onClick={() => setSelectedLog(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default PlatformEmailLogs;
