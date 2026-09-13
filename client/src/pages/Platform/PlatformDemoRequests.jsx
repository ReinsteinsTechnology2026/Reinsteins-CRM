import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FaSearch } from "react-icons/fa";

import platformApi from "../../services/platformApi";

// ==========================================
// DEMO REQUEST MANAGEMENT
// GET /api/platform/demo-requests -- leads submitted from the public
// website only. Never creates a company or tenant database; turning
// a lead into a company remains the separate "Add Company" action
// on the Companies page. Search/filter run client-side over the
// already-fetched list, same convention as the Companies page.
// ==========================================

const STATUS_FILTERS = ["all", "new", "contacted", "closed"];

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function PlatformDemoRequests() {
  const navigate = useNavigate();

  const [demoRequests, setDemoRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const response = await platformApi.get("/demo-requests");
        setDemoRequests(response.data.demoRequests);
        setError(null);
      } catch (err) {
        setError(err.response?.data?.message || "Unable to load demo requests.");
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return demoRequests.filter((d) => {
      if (statusFilter !== "all" && d.status !== statusFilter) return false;
      if (!term) return true;
      return (
        d.name.toLowerCase().includes(term) ||
        d.companyName.toLowerCase().includes(term) ||
        d.email.toLowerCase().includes(term)
      );
    });
  }, [demoRequests, search, statusFilter]);

  return (
    <div className="platform-page">

      <div className="platform-page-header">
        <div>
          <h1>Demo Requests</h1>
          <p>Leads submitted from the ZioVenture public website.</p>
        </div>
      </div>

      {error && <div className="platform-alert platform-alert-danger">{error}</div>}

      <div className="platform-toolbar">
        <div className="platform-search-input">
          <FaSearch />
          <input
            type="text"
            placeholder="Search by name, company, or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>{s === "all" ? "All Statuses" : s.charAt(0).toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
      </div>

      <div className="platform-card">
        <div className="platform-table-wrap">
          <table className="platform-table">
            <thead>
              <tr>
                <th>Client Name</th>
                <th>Company Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Employee Count</th>
                <th>Status</th>
                <th>Requested</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="platform-empty-state">Loading demo requests...</td></tr>
              )}

              {!loading && demoRequests.length === 0 && (
                <tr><td colSpan={7} className="platform-empty-state">No demo requests yet.</td></tr>
              )}

              {!loading && demoRequests.length > 0 && visible.length === 0 && (
                <tr><td colSpan={7} className="platform-empty-state">No demo requests match your search/filters.</td></tr>
              )}

              {!loading && visible.map((demoRequest) => (
                <tr
                  key={demoRequest.id}
                  className="clickable"
                  onClick={() => navigate(`/owner/demo-requests/${demoRequest.id}`)}
                >
                  <td className="platform-company-name">{demoRequest.name}</td>
                  <td>{demoRequest.companyName}</td>
                  <td className="platform-company-slug">{demoRequest.email}</td>
                  <td>{demoRequest.phone || "—"}</td>
                  <td>{demoRequest.employeeCount || "—"}</td>
                  <td>
                    <span className={`platform-badge status-${demoRequest.status}`}>{demoRequest.status}</span>
                  </td>
                  <td>{formatDate(demoRequest.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}

export default PlatformDemoRequests;
