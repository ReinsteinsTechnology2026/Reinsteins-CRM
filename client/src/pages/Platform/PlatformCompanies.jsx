import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FaPlus, FaSearch } from "react-icons/fa";
import { toast } from "react-toastify";

import platformApi from "../../services/platformApi";
import { computeSubscriptionBadge } from "../../utils/subscriptionStatusBadge";
import AddCompanyModal from "./AddCompanyModal";

// ==========================================
// COMPANIES MANAGEMENT
// GET /api/platform/companies?includeAdmin=1 -- the admin-email flag
// is only requested here (search-by-admin-email needs it); every
// other page keeps using the plain, cheaper GET /companies. Still
// platform metadata + one admin email per company -- never a tenant
// employee list, chat, file, or business record.
//
// Search/filter/sort all run CLIENT-SIDE over the already-fetched
// list. At this system's realistic company count that's simpler and
// faster than a paginated backend search API, and avoids adding
// query-building surface to an endpoint that doesn't need it yet.
// ==========================================

const STATUS_FILTERS = ["all", "active", "suspended", "pending"];
const SORT_OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "name", label: "Company Name" },
  { value: "employees", label: "Employee Count" },
];

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function PlatformCompanies() {
  const navigate = useNavigate();

  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [planFilter, setPlanFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");

  const loadCompanies = async () => {
    try {
      setLoading(true);
      const response = await platformApi.get("/companies?includeAdmin=1");
      setCompanies(response.data.companies);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || "Unable to load companies.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCompanies();
  }, []);

  const handleCompanyCreated = (company) => {
    setShowAddModal(false);
    toast.success(`"${company.companyName}" created and provisioned successfully.`);
    loadCompanies();
  };

  const handlePartialSuccess = () => {
    loadCompanies();
  };

  const planOptions = useMemo(() => {
    const names = new Set(companies.map((c) => c.subscription?.planName).filter(Boolean));
    return Array.from(names).sort();
  }, [companies]);

  const visibleCompanies = useMemo(() => {
    const term = search.trim().toLowerCase();

    let list = companies.filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (planFilter !== "all" && c.subscription?.planName !== planFilter) return false;
      if (!term) return true;
      return (
        c.companyName.toLowerCase().includes(term) ||
        c.companySlug.toLowerCase().includes(term) ||
        (c.adminEmail || "").toLowerCase().includes(term)
      );
    });

    list = [...list].sort((a, b) => {
      switch (sortBy) {
        case "oldest": return new Date(a.createdAt) - new Date(b.createdAt);
        case "name": return a.companyName.localeCompare(b.companyName);
        case "employees": return (b.employeeCount ?? -1) - (a.employeeCount ?? -1);
        case "newest":
        default: return new Date(b.createdAt) - new Date(a.createdAt);
      }
    });

    return list;
  }, [companies, search, statusFilter, planFilter, sortBy]);

  return (
    <div className="platform-page">

      <div className="platform-page-header">
        <div>
          <h1>Companies</h1>
          <p>Every company on ZioVenture and its provisioning status.</p>
        </div>
        <button className="platform-btn platform-btn-primary" onClick={() => setShowAddModal(true)}>
          <FaPlus /> Add Company
        </button>
      </div>

      {error && <div className="platform-alert platform-alert-danger">{error}</div>}

      <div className="platform-toolbar">
        <div className="platform-search-input">
          <FaSearch />
          <input
            type="text"
            placeholder="Search by name, slug, or admin email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>{s === "all" ? "All Statuses" : s.charAt(0).toUpperCase() + s.slice(1)}</option>
          ))}
        </select>

        <select value={planFilter} onChange={(e) => setPlanFilter(e.target.value)}>
          <option value="all">All Plans</option>
          {planOptions.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>

        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          {SORT_OPTIONS.map((s) => <option key={s.value} value={s.value}>Sort: {s.label}</option>)}
        </select>
      </div>

      <div className="platform-card">
        <div className="platform-table-wrap">
          <table className="platform-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Admin</th>
                <th>Plan</th>
                <th>Subscription</th>
                <th>Employees</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="platform-empty-state">Loading companies...</td></tr>
              )}

              {!loading && companies.length === 0 && (
                <tr><td colSpan={7} className="platform-empty-state">No companies yet.</td></tr>
              )}

              {!loading && companies.length > 0 && visibleCompanies.length === 0 && (
                <tr><td colSpan={7} className="platform-empty-state">No companies match your search/filters.</td></tr>
              )}

              {!loading && visibleCompanies.map((company) => (
                <tr
                  key={company.id}
                  className="clickable"
                  onClick={() => navigate(`/owner/companies/${company.id}`)}
                >
                  <td>
                    <div className="platform-company-name">{company.companyName}</div>
                    <div className="platform-company-slug">{company.companySlug}</div>
                  </td>
                  <td>{company.adminEmail || "—"}</td>
                  <td>{company.subscription?.planName || "—"}</td>
                  <td>
                    <span className={`platform-badge ${computeSubscriptionBadge(company.subscription).className}`}>
                      {computeSubscriptionBadge(company.subscription).label}
                    </span>
                  </td>
                  <td>{company.employeeCount === null ? "—" : company.employeeCount}</td>
                  <td>
                    <span className={`platform-badge status-${company.status}`}>{company.status}</span>
                  </td>
                  <td>{formatDate(company.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showAddModal && (
        <AddCompanyModal
          onClose={() => setShowAddModal(false)}
          onCreated={handleCompanyCreated}
          onPartialSuccess={handlePartialSuccess}
        />
      )}

    </div>
  );
}

export default PlatformCompanies;
