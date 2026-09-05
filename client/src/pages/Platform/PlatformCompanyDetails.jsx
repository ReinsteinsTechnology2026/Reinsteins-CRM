import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { FaArrowLeft, FaPauseCircle, FaPlayCircle, FaUserPlus } from "react-icons/fa";
import { toast } from "react-toastify";

import platformApi from "../../services/platformApi";
import CreateAdminModal from "./CreateAdminModal";

// ==========================================
// COMPANY DETAILS (Phase 4)
//
// GET /api/platform/companies/:id -- platform-level metadata plus a
// single derived boolean (firstAdminCreated, from an admin ROW COUNT
// against the tenant DB, never a list). Nothing here can render an
// employee list, chat, file, meeting, or attendance record -- those
// fields simply don't exist anywhere in this response.
// ==========================================

const ACCESS_TYPES = [
  { value: "complimentary", label: "Complimentary" },
  { value: "trial", label: "Trial" },
  { value: "paid", label: "Paid" },
];

const SUBSCRIPTION_STATUSES = [
  { value: "active", label: "Active" },
  { value: "trial", label: "Trial" },
  { value: "expired", label: "Expired" },
  { value: "cancelled", label: "Cancelled" },
];

// Converts a stored datetime (or null) into the value a
// <input type="datetime-local"> expects (YYYY-MM-DDTHH:mm), and back.
function toDatetimeLocalValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function PlatformCompanyDetails() {
  const { id } = useParams();

  const [company, setCompany] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);

  const [plans, setPlans] = useState([]);
  const [subPlanId, setSubPlanId] = useState("");
  const [subStatus, setSubStatus] = useState("active");
  const [subTrialEndsAt, setSubTrialEndsAt] = useState("");
  const [subExpiresAt, setSubExpiresAt] = useState("");
  const [subSaving, setSubSaving] = useState(false);

  const loadCompany = async () => {
    try {
      setLoading(true);
      const response = await platformApi.get(`/companies/${id}`);
      setCompany(response.data.company);
      const sub = response.data.company.subscription;
      setSubPlanId(sub.planId ? String(sub.planId) : "");
      setSubStatus(sub.subscriptionStatus || "active");
      setSubTrialEndsAt(toDatetimeLocalValue(sub.trialEndsAt));
      setSubExpiresAt(toDatetimeLocalValue(sub.subscriptionExpiresAt));
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || "Unable to load company.");
    } finally {
      setLoading(false);
    }
  };

  const loadPlans = async () => {
    try {
      const response = await platformApi.get("/plans");
      setPlans(response.data.plans);
    } catch {
      // Non-fatal -- the subscription section below shows its own
      // "unable to load plans" fallback if this stays empty.
    }
  };

  useEffect(() => {
    loadCompany();
    loadPlans();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleSaveSubscription = async (event) => {
    event.preventDefault();
    try {
      setSubSaving(true);
      const response = await platformApi.patch(`/companies/${id}/subscription`, {
        planId: Number(subPlanId),
        subscriptionStatus: subStatus,
        trialEndsAt: subTrialEndsAt || null,
        subscriptionExpiresAt: subExpiresAt || null,
      });
      setCompany((current) => ({ ...current, ...response.data.company }));
      toast.success("Subscription updated.");
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to update subscription.");
    } finally {
      setSubSaving(false);
    }
  };

  const handleStatusAction = async (action) => {
    try {
      setActionLoading(true);
      const response = await platformApi.patch(`/companies/${id}/status`, { action });
      setCompany((current) => ({ ...current, ...response.data.company }));
      toast.success(action === "suspend" ? "Company suspended." : "Company reactivated.");
    } catch (err) {
      toast.error(err.response?.data?.message || "Action failed.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleAccessTypeChange = async (event) => {
    const accessType = event.target.value;
    try {
      setActionLoading(true);
      const response = await platformApi.patch(`/companies/${id}/access-type`, { accessType });
      setCompany((current) => ({ ...current, ...response.data.company }));
      toast.success(`Access type updated to ${accessType}.`);
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to update access type.");
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return <div className="platform-page"><div className="platform-empty-state">Loading company...</div></div>;
  }

  if (error || !company) {
    return (
      <div className="platform-page">
        <div className="platform-alert platform-alert-danger">{error || "Company not found."}</div>
      </div>
    );
  }

  const canSuspend = company.status === "active";
  const canReactivate = company.status === "suspended";
  const canManageAccessType = company.status === "active" || company.status === "suspended";

  return (
    <div className="platform-page">

      <Link to="/platform/companies" className="platform-back-link">
        <FaArrowLeft /> Back to Companies
      </Link>

      <div className="platform-page-header">
        <div>
          <h1>{company.companyName}</h1>
          <p className="platform-company-slug">{company.companySlug}</p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {canSuspend && (
            <button
              className="platform-btn platform-btn-danger"
              onClick={() => handleStatusAction("suspend")}
              disabled={actionLoading}
            >
              <FaPauseCircle /> Suspend
            </button>
          )}
          {canReactivate && (
            <button
              className="platform-btn platform-btn-success"
              onClick={() => handleStatusAction("reactivate")}
              disabled={actionLoading}
            >
              <FaPlayCircle /> Reactivate
            </button>
          )}
        </div>
      </div>

      <div className="platform-card" style={{ padding: 24, marginBottom: 20 }}>
        <div className="platform-result-box" style={{ background: "transparent", border: "none", padding: 0 }}>
          <div className="platform-result-row"><span>Status</span><span><span className={`platform-badge status-${company.status}`}>{company.status}</span></span></div>
          <div className="platform-result-row"><span>Access Type</span><span><span className={`platform-badge access-${company.accessType}`}>{company.accessType}</span></span></div>
          <div className="platform-result-row"><span>Tenant Database</span><span>{company.tenantDbName || "Not yet provisioned"}</span></div>
          <div className="platform-result-row"><span>Created</span><span>{formatDate(company.createdAt)}</span></div>
          <div className="platform-result-row"><span>Last Updated</span><span>{formatDate(company.updatedAt)}</span></div>
          <div className="platform-result-row">
            <span>First Admin</span>
            <span>
              {company.firstAdminCreated === null && "Unknown (tenant DB not ready)"}
              {company.firstAdminCreated === true && "Created"}
              {company.firstAdminCreated === false && "Not created yet"}
            </span>
          </div>
        </div>
      </div>

      <div className="platform-card" style={{ padding: 24, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 6 }}>Subscription</h2>
        <p style={{ fontSize: 13, color: "var(--p-text-secondary)", marginTop: 0, marginBottom: 14 }}>
          Internal plan/subscription management — no billing integration yet. Changing these fields never affects the tenant database.
        </p>

        <div className="platform-result-box" style={{ marginBottom: 16 }}>
          <div className="platform-result-row"><span>Current Plan</span><span>{company.subscription.planName || "—"}</span></div>
          <div className="platform-result-row"><span>Subscription Status</span><span><span className={`platform-badge status-${company.subscription.subscriptionStatus}`}>{company.subscription.subscriptionStatus}</span></span></div>
          <div className="platform-result-row"><span>Access Currently Allowed</span><span>{company.subscription.accessAllowed ? "Yes" : "No — login blocked"}</span></div>
          <div className="platform-result-row"><span>Started</span><span>{formatDate(company.subscription.subscriptionStartedAt)}</span></div>
          <div className="platform-result-row"><span>Trial Ends</span><span>{formatDate(company.subscription.trialEndsAt)}</span></div>
          <div className="platform-result-row"><span>Subscription Expires</span><span>{formatDate(company.subscription.subscriptionExpiresAt)}</span></div>
        </div>

        <form onSubmit={handleSaveSubscription}>
          <div className="platform-form-group">
            <label htmlFor="sub-plan">Plan</label>
            <select
              id="sub-plan"
              value={subPlanId}
              onChange={(event) => setSubPlanId(event.target.value)}
              disabled={!canManageAccessType}
            >
              <option value="" disabled>Select a plan</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id} disabled={p.status !== "active" && String(p.id) !== subPlanId}>
                  {p.name}{p.status !== "active" ? " (disabled)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="platform-form-group">
            <label htmlFor="sub-status">Subscription Status</label>
            <select
              id="sub-status"
              value={subStatus}
              onChange={(event) => setSubStatus(event.target.value)}
              disabled={!canManageAccessType}
            >
              {SUBSCRIPTION_STATUSES.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>

          <div className="platform-form-group">
            <label htmlFor="sub-trial-ends">Trial Ends At</label>
            <input
              id="sub-trial-ends"
              type="datetime-local"
              value={subTrialEndsAt}
              onChange={(event) => setSubTrialEndsAt(event.target.value)}
              disabled={!canManageAccessType}
            />
          </div>

          <div className="platform-form-group">
            <label htmlFor="sub-expires">Subscription Expires At</label>
            <input
              id="sub-expires"
              type="datetime-local"
              value={subExpiresAt}
              onChange={(event) => setSubExpiresAt(event.target.value)}
              disabled={!canManageAccessType}
            />
          </div>

          <button
            type="submit"
            className="platform-btn platform-btn-primary"
            disabled={subSaving || !canManageAccessType || !subPlanId}
          >
            {subSaving ? "Saving..." : "Save Subscription"}
          </button>
        </form>
      </div>

      <div className="platform-card" style={{ padding: 24, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 6 }}>Access Type</h2>
        <p style={{ fontSize: 13, color: "var(--p-text-secondary)", marginTop: 0 }}>
          Manual for now — no billing/payment integration yet. Complimentary and trial companies continue to work normally.
        </p>
        <select
          value={company.accessType}
          onChange={handleAccessTypeChange}
          disabled={actionLoading || !canManageAccessType}
          style={{
            padding: "9px 12px", borderRadius: "var(--p-radius-sm)",
            border: "1px solid var(--p-border-strong)", fontSize: 13.5,
          }}
        >
          {ACCESS_TYPES.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>

      <div className="platform-card" style={{ padding: 24 }}>
        <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 6 }}>Company Administrator</h2>
        <p style={{ fontSize: 13, color: "var(--p-text-secondary)", marginTop: 0, marginBottom: 14 }}>
          {company.firstAdminCreated
            ? "This company already has an administrator."
            : "Create the first Admin account so this company can start using its tenant portal."}
        </p>
        {!company.firstAdminCreated && company.status === "active" && (
          <button className="platform-btn platform-btn-primary" onClick={() => setShowAdminModal(true)}>
            <FaUserPlus /> Create First Admin
          </button>
        )}
      </div>

      {showAdminModal && (
        <CreateAdminModal
          companyId={company.id}
          companyName={company.companyName}
          onClose={() => setShowAdminModal(false)}
          onCreated={() => {
            setCompany((current) => ({ ...current, firstAdminCreated: true }));
          }}
        />
      )}

    </div>
  );
}

export default PlatformCompanyDetails;
