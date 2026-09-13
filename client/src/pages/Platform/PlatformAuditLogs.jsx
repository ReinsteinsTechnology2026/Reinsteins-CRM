import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FaSearch } from "react-icons/fa";

import platformApi from "../../services/platformApi";

// ==========================================
// PLATFORM AUDIT LOGS (Phase 12K)
//
// Read-only view over GET /api/platform/audit-logs. Every row was
// written at the moment the real action happened (company created/
// suspended/deleted, plan changed, subscription changed, payment
// recorded/status changed, password changed) -- see
// platformAuditService.js and its call sites. `metadata` is rendered
// as a plain safe summary; the backend already scrubs anything
// password/token/secret-shaped before it's ever stored, so nothing
// extra needs to be hidden here.
// ==========================================

const ACTION_LABELS = {
  company_created: "Company created",
  company_suspended: "Company suspended",
  company_reactivated: "Company reactivated",
  company_deleted: "Company deleted",
  plan_created: "Plan created",
  plan_updated: "Plan updated",
  plan_disabled: "Plan disabled",
  plan_enabled: "Plan enabled",
  subscription_changed: "Subscription changed",
  payment_recorded: "Payment recorded",
  payment_status_changed: "Payment status changed",
  platform_password_changed: "Password changed",
};

function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function summarizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return "—";
  const parts = Object.entries(metadata)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
  return parts.length ? parts.join(", ") : "—";
}

function PlatformAuditLogs() {
  const [logs, setLogs] = useState([]);
  const [actionTypes, setActionTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const loadLogs = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (actionFilter !== "all") params.set("actionType", actionFilter);
      if (search.trim()) params.set("search", search.trim());
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);

      const response = await platformApi.get(`/audit-logs?${params.toString()}`);
      setLogs(response.data.logs || []);
      setActionTypes(response.data.actionTypes || []);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || "Unable to load audit logs.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionFilter, dateFrom, dateTo]);

  useEffect(() => {
    const timer = setTimeout(() => { loadLogs(); }, search ? 350 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, actionFilter, dateFrom, dateTo]);

  return (
    <div className="platform-page">

      <div className="platform-page-header">
        <div>
          <h1>Audit Logs</h1>
          <p>A record of every significant Platform Owner action -- who did what, when, and to which company.</p>
        </div>
      </div>

      {error && <div className="platform-alert platform-alert-danger">{error}</div>}

      <div className="platform-toolbar">
        <div className="platform-search-input">
          <FaSearch />
          <input
            type="text"
            placeholder="Search by owner name, email, or company…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
          <option value="all">All Actions</option>
          {actionTypes.map((a) => <option key={a} value={a}>{ACTION_LABELS[a] || a}</option>)}
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
                <th>Platform Owner</th>
                <th>Action</th>
                <th>Company</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={5} className="platform-empty-state">Loading audit logs...</td></tr>
              )}

              {!loading && logs.length === 0 && (
                <tr><td colSpan={5} className="platform-empty-state">No audit log entries match your filters.</td></tr>
              )}

              {!loading && logs.map((log) => (
                <tr key={log.id}>
                  <td>{formatDateTime(log.createdAt)}</td>
                  <td>{log.platformUserName || "—"}<div className="platform-company-slug">{log.platformUserEmail || ""}</div></td>
                  <td>{ACTION_LABELS[log.actionType] || log.actionType}</td>
                  <td>
                    {log.companyId ? (
                      <Link to={`/owner/companies/${log.companyId}`}>{log.companyName || `#${log.companyId}`}</Link>
                    ) : "—"}
                  </td>
                  <td style={{ fontSize: 12.5, color: "var(--p-text-secondary)" }}>{summarizeMetadata(log.metadata)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}

export default PlatformAuditLogs;
