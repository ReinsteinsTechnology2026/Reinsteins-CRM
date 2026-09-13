import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import platformApi from "../../services/platformApi";

// ==========================================
// USERS (Platform Owner Dashboard)
//
// Deliberately a per-company headcount summary, NOT a cross-tenant
// directory of individual employee names/emails. Every other
// platform-layer view in this codebase (getCompanyDetails'
// firstAdminCreated, this same GET /companies response's
// employeeCount) has the same boundary: the Platform Owner sees
// COUNTS, never a row-level list of another company's people. A
// company's own admin/employee list already exists -- inside that
// company's own portal (Employees.jsx) -- which is where it belongs.
// ==========================================

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function PlatformUsers() {
  const navigate = useNavigate();

  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const response = await platformApi.get("/companies");
        setCompanies(response.data.companies);
        setError(null);
      } catch (err) {
        setError(err.response?.data?.message || "Unable to load users.");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const totalUsers = companies.reduce((sum, c) => sum + (c.employeeCount || 0), 0);

  return (
    <div className="platform-page">

      <div className="platform-page-header">
        <div>
          <h1>Users</h1>
          <p>Per-company user counts across ZioVenture. Individual employee records stay inside each company's own portal.</p>
        </div>
      </div>

      {error && <div className="platform-alert platform-alert-danger">{error}</div>}

      <div className="platform-stat-grid" style={{ marginBottom: 24 }}>
        <div className="platform-stat-card">
          <div className="platform-stat-icon tone-primary">Σ</div>
          <div>
            <span className="platform-stat-value">{loading ? "…" : totalUsers}</span>
            <span className="platform-stat-label">Total Users (all companies)</span>
          </div>
        </div>
      </div>

      <div className="platform-card">
        <div className="platform-table-wrap">
          <table className="platform-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Status</th>
                <th>Users</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={4} className="platform-empty-state">Loading users...</td></tr>
              )}

              {!loading && companies.length === 0 && (
                <tr><td colSpan={4} className="platform-empty-state">No companies yet.</td></tr>
              )}

              {!loading && companies.map((company) => (
                <tr
                  key={company.id}
                  className="clickable"
                  onClick={() => navigate(`/owner/companies/${company.id}`)}
                >
                  <td>
                    <div className="platform-company-name">{company.companyName}</div>
                    <div className="platform-company-slug">{company.companySlug}</div>
                  </td>
                  <td><span className={`platform-badge status-${company.status}`}>{company.status}</span></td>
                  <td>{company.employeeCount === null ? "—" : company.employeeCount}</td>
                  <td>{formatDate(company.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}

export default PlatformUsers;
