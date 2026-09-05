import { useEffect, useState } from "react";
import { FaPlus, FaPauseCircle, FaPlayCircle, FaEdit } from "react-icons/fa";
import { toast } from "react-toastify";

import platformApi from "../../services/platformApi";
import PlatformPlanModal from "./PlatformPlanModal";

// ==========================================
// SUBSCRIPTION PLANS (Phase 8)
// GET /api/platform/plans -- platform-level plan metadata only.
// Never touches `companies` or any tenant database.
// ==========================================

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function formatLimit(value) {
  return value === null || value === undefined ? "Unlimited" : value.toLocaleString();
}

function PlatformPlans() {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoadingId, setActionLoadingId] = useState(null);
  const [modalPlan, setModalPlan] = useState(undefined); // undefined = closed, null = create, object = edit

  const loadPlans = async () => {
    try {
      setLoading(true);
      const response = await platformApi.get("/plans");
      setPlans(response.data.plans);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || "Unable to load plans.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPlans();
  }, []);

  const handleSaved = (plan) => {
    setModalPlan(undefined);
    toast.success(`Plan "${plan.name}" saved.`);
    loadPlans();
  };

  const handleToggleStatus = async (plan) => {
    const action = plan.status === "active" ? "disable" : "enable";
    try {
      setActionLoadingId(plan.id);
      await platformApi.patch(`/plans/${plan.id}/status`, { action });
      toast.success(`Plan "${plan.name}" ${action === "enable" ? "enabled" : "disabled"}.`);
      loadPlans();
    } catch (err) {
      toast.error(err.response?.data?.message || "Action failed.");
    } finally {
      setActionLoadingId(null);
    }
  };

  return (
    <div className="platform-page">

      <div className="platform-page-header">
        <div>
          <h1>Subscription Plans</h1>
          <p>Manage the plans companies can be assigned to. No payment processing yet — internal management only.</p>
        </div>
        <button className="platform-btn platform-btn-primary" onClick={() => setModalPlan(null)}>
          <FaPlus /> Create Plan
        </button>
      </div>

      {error && <div className="platform-alert platform-alert-danger">{error}</div>}

      <div className="platform-card">
        <div className="platform-table-wrap">
          <table className="platform-table">
            <thead>
              <tr>
                <th>Plan</th>
                <th>Employee Limit</th>
                <th>Storage Limit</th>
                <th>Status</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={6} className="platform-empty-state">Loading plans...</td></tr>
              )}

              {!loading && plans.length === 0 && (
                <tr><td colSpan={6} className="platform-empty-state">No plans yet.</td></tr>
              )}

              {!loading && plans.map((plan) => (
                <tr key={plan.id}>
                  <td>
                    <div className="platform-company-name">{plan.name}</div>
                    <div className="platform-company-slug">{plan.slug}</div>
                  </td>
                  <td>{formatLimit(plan.employeeLimit)}</td>
                  <td>{formatLimit(plan.storageLimitMb)}{plan.storageLimitMb !== null ? " MB" : ""}</td>
                  <td>
                    <span className={`platform-badge status-${plan.status}`}>{plan.status}</span>
                  </td>
                  <td>{formatDate(plan.createdAt)}</td>
                  <td>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button
                        type="button"
                        className="platform-btn platform-btn-outline platform-btn-sm"
                        onClick={() => setModalPlan(plan)}
                      >
                        <FaEdit /> Edit
                      </button>
                      <button
                        type="button"
                        className={`platform-btn platform-btn-sm ${plan.status === "active" ? "platform-btn-danger" : "platform-btn-success"}`}
                        onClick={() => handleToggleStatus(plan)}
                        disabled={actionLoadingId === plan.id}
                      >
                        {plan.status === "active" ? <><FaPauseCircle /> Disable</> : <><FaPlayCircle /> Enable</>}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modalPlan !== undefined && (
        <PlatformPlanModal
          plan={modalPlan}
          onClose={() => setModalPlan(undefined)}
          onSaved={handleSaved}
        />
      )}

    </div>
  );
}

export default PlatformPlans;
