import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FaPlus } from "react-icons/fa";
import { toast } from "react-toastify";

import platformApi from "../../services/platformApi";
import AddCompanyModal from "./AddCompanyModal";

// ==========================================
// COMPANIES MANAGEMENT (Phase 4)
// GET /api/platform/companies -- platform metadata only. Never
// requests, receives, or renders anything from a tenant database.
// ==========================================

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

  const loadCompanies = async () => {
    try {
      setLoading(true);
      const response = await platformApi.get("/companies");
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

  return (
    <div className="platform-page">

      <div className="platform-page-header">
        <div>
          <h1>Companies</h1>
          <p>Every company on GrowOrgs and its provisioning status.</p>
        </div>
        <button className="platform-btn platform-btn-primary" onClick={() => setShowAddModal(true)}>
          <FaPlus /> Add Company
        </button>
      </div>

      {error && <div className="platform-alert platform-alert-danger">{error}</div>}

      <div className="platform-card">
        <div className="platform-table-wrap">
          <table className="platform-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Status</th>
                <th>Access Type</th>
                <th>Tenant Database</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={5} className="platform-empty-state">Loading companies...</td></tr>
              )}

              {!loading && companies.length === 0 && (
                <tr><td colSpan={5} className="platform-empty-state">No companies yet.</td></tr>
              )}

              {!loading && companies.map((company) => (
                <tr
                  key={company.id}
                  className="clickable"
                  onClick={() => navigate(`/platform/companies/${company.id}`)}
                >
                  <td>
                    <div className="platform-company-name">{company.companyName}</div>
                    <div className="platform-company-slug">{company.companySlug}</div>
                  </td>
                  <td>
                    <span className={`platform-badge status-${company.status}`}>{company.status}</span>
                  </td>
                  <td>
                    <span className={`platform-badge access-${company.accessType}`}>{company.accessType}</span>
                  </td>
                  <td className="platform-company-slug">{company.tenantDbName || "—"}</td>
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
        />
      )}

    </div>
  );
}

export default PlatformCompanies;
