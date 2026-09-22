import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { FaArrowLeft, FaPauseCircle, FaPlayCircle, FaUserPlus, FaTrash, FaPlus } from "react-icons/fa";
import { toast } from "react-toastify";

import platformApi from "../../services/platformApi";
import { API_ORIGIN } from "../../config";
import { formatMoney } from "../../utils/formatMoney";
import { computeSubscriptionBadge } from "../../utils/subscriptionStatusBadge";
import CreateAdminModal from "./CreateAdminModal";
import DeleteCompanyModal from "./DeleteCompanyModal";
import RecordPaymentModal from "./RecordPaymentModal";
import PaymentDetailsModal from "./PaymentDetailsModal";
import RazorpayCheckoutModal from "./RazorpayCheckoutModal";

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
  const navigate = useNavigate();

  const [company, setCompany] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const [payments, setPayments] = useState([]);
  const [paymentsLoading, setPaymentsLoading] = useState(true);
  const [showRecordPaymentModal, setShowRecordPaymentModal] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState(null);
  const [checkoutBillingCycle, setCheckoutBillingCycle] = useState("monthly");
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);

  const [plans, setPlans] = useState([]);
  const [subPlanId, setSubPlanId] = useState("");
  const [subStatus, setSubStatus] = useState("active");
  const [subTrialEndsAt, setSubTrialEndsAt] = useState("");
  const [subExpiresAt, setSubExpiresAt] = useState("");
  const [subSaving, setSubSaving] = useState(false);

  const [billingName, setBillingName] = useState("");
  const [billingEmail, setBillingEmail] = useState("");
  const [billingPhone, setBillingPhone] = useState("");
  const [billingSaving, setBillingSaving] = useState(false);

  const [logoSaving, setLogoSaving] = useState(false);
  const [logoCacheBust, setLogoCacheBust] = useState(0);

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
      const billing = response.data.company.billingContact;
      setBillingName(billing?.name || "");
      setBillingEmail(billing?.email || "");
      setBillingPhone(billing?.phone || "");
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || "Unable to load company.");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveBillingContact = async (event) => {
    event.preventDefault();
    try {
      setBillingSaving(true);
      const response = await platformApi.patch(`/companies/${id}/billing-contact`, {
        name: billingName.trim() || undefined,
        email: billingEmail.trim(),
        phone: billingPhone.trim() || undefined,
      });
      setCompany((current) => ({ ...current, ...response.data.company }));
      toast.success("Billing contact saved.");
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to save billing contact.");
    } finally {
      setBillingSaving(false);
    }
  };

  const handleRemoveBillingContact = async () => {
    try {
      setBillingSaving(true);
      const response = await platformApi.delete(`/companies/${id}/billing-contact`);
      setCompany((current) => ({ ...current, ...response.data.company }));
      setBillingName(""); setBillingEmail(""); setBillingPhone("");
      toast.success("Billing contact removed.");
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to remove billing contact.");
    } finally {
      setBillingSaving(false);
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

  const loadPayments = async () => {
    try {
      setPaymentsLoading(true);
      const response = await platformApi.get(`/payments?companyId=${id}`);
      setPayments(response.data.payments || []);
    } catch {
      // Non-fatal -- the Payment History section shows its own
      // "unable to load" fallback if this stays empty.
      setPayments([]);
    } finally {
      setPaymentsLoading(false);
    }
  };

  useEffect(() => {
    loadCompany();
    loadPlans();
    loadPayments();
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

  const handleLogoUpload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file next time
    if (!file) return;

    try {
      setLogoSaving(true);
      const uploadData = new FormData();
      uploadData.append("logo", file);

      const response = await platformApi.post(`/companies/${id}/logo`, uploadData, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      setCompany((current) => ({ ...current, ...response.data.company }));
      setLogoCacheBust((current) => current + 1);
      toast.success("Company logo updated.");
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to upload company logo.");
    } finally {
      setLogoSaving(false);
    }
  };

  const handleLogoRemove = async () => {
    try {
      setLogoSaving(true);
      const response = await platformApi.delete(`/companies/${id}/logo`);
      setCompany((current) => ({ ...current, ...response.data.company }));
      setLogoCacheBust((current) => current + 1);
      toast.success("Company logo removed.");
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to remove company logo.");
    } finally {
      setLogoSaving(false);
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

  // Phase 11K -- drives the "Charge via Razorpay" section below the
  // subscription form. Uses the PLAN CURRENTLY SELECTED in that form
  // (subPlanId), not the company's already-active plan, so a Platform
  // Owner can pick a plan and immediately charge for it in one flow.
  const selectedPlanForCheckout = plans.find((p) => String(p.id) === subPlanId) || null;
  const checkoutBillingCycleValid = selectedPlanForCheckout
    ? (checkoutBillingCycle === "yearly" ? selectedPlanForCheckout.yearlyPrice != null : selectedPlanForCheckout.monthlyPrice != null)
    : false;
  const effectiveCheckoutBillingCycle = checkoutBillingCycleValid
    ? checkoutBillingCycle
    : (selectedPlanForCheckout?.monthlyPrice != null ? "monthly" : "yearly");

  return (
    <div className="platform-page">

      <Link to="/owner/companies" className="platform-back-link">
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
          {company.companySlug !== "reinsteins" && (
            <button
              className="platform-btn platform-btn-danger"
              onClick={() => setShowDeleteModal(true)}
              disabled={actionLoading}
            >
              <FaTrash /> Delete
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
        </div>
      </div>

      <div className="platform-card" style={{ padding: 24, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 14 }}>Branding</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 90, height: 90, borderRadius: 12, background: "#111816",
              display: "flex", alignItems: "center", justifyContent: "center",
              overflow: "hidden", flexShrink: 0,
            }}
          >
            {company.hasLogo ? (
              <img
                src={`${API_ORIGIN}/api/tenant-auth/${company.companySlug}/logo?preview=${logoCacheBust}`}
                alt={`${company.companyName} logo`}
                width={90}
                height={90}
                style={{ objectFit: "contain" }}
              />
            ) : (
              <span style={{ color: "#16A66A", fontSize: 28, fontWeight: 800 }}>Zi</span>
            )}
          </div>
          <div>
            <p style={{ margin: "0 0 10px", color: "var(--text-secondary, #53615A)", fontSize: 13.5 }}>
              {company.hasLogo
                ? "This company's login page shows its own logo."
                : "No logo uploaded yet -- this company's login page shows the default ZioVenture fallback mark."}
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <label className="platform-btn platform-btn-secondary" style={{ cursor: logoSaving ? "not-allowed" : "pointer", opacity: logoSaving ? 0.6 : 1 }}>
                {company.hasLogo ? "Replace Logo" : "Upload Logo"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleLogoUpload}
                  disabled={logoSaving}
                  style={{ display: "none" }}
                />
              </label>
              {company.hasLogo && (
                <button
                  type="button"
                  className="platform-btn platform-btn-danger"
                  onClick={handleLogoRemove}
                  disabled={logoSaving}
                >
                  Remove Logo
                </button>
              )}
            </div>
            <p style={{ margin: "10px 0 0", color: "var(--text-secondary, #53615A)", fontSize: 12 }}>
              JPG, PNG, or WEBP. Max 2 MB.
            </p>
          </div>
        </div>
      </div>

      <div className="platform-card" style={{ padding: 24, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 14 }}>Admin Information</h2>
        <div className="platform-result-box" style={{ background: "transparent", border: "none", padding: 0 }}>
          <div className="platform-result-row">
            <span>First Admin</span>
            <span>
              {company.firstAdminCreated === null && "Unknown (tenant DB not ready)"}
              {company.firstAdminCreated === true && "Created"}
              {company.firstAdminCreated === false && "Not created yet"}
            </span>
          </div>
          {company.firstAdminCreated && (
            <>
              <div className="platform-result-row"><span>Admin Name</span><span>{company.adminName || "—"}</span></div>
              <div className="platform-result-row"><span>Admin Email</span><span>{company.adminEmail || "—"}</span></div>
            </>
          )}
        </div>
      </div>

      <div className="platform-card" style={{ padding: 24, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 14 }}>Usage Overview</h2>
        <div className="platform-result-box" style={{ background: "transparent", border: "none", padding: 0 }}>
          <div className="platform-result-row"><span>Total Employees</span><span>{company.employeeCount === null || company.employeeCount === undefined ? "Unknown" : company.employeeCount}</span></div>
          <div className="platform-result-row"><span>New Users This Month</span><span>{company.newUsersThisMonth === null || company.newUsersThisMonth === undefined ? "Unknown" : company.newUsersThisMonth}</span></div>
          <div className="platform-result-row"><span>Storage Usage</span><span>Not tracked yet</span></div>
        </div>
      </div>

      <div className="platform-card" style={{ padding: 24, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 6 }}>Subscription</h2>
        <p style={{ fontSize: 13, color: "var(--p-text-secondary)", marginTop: 0, marginBottom: 14 }}>
          Internal plan/subscription management — no billing integration yet. Changing these fields never affects the tenant database.
        </p>

        <div className="platform-result-box" style={{ marginBottom: 16 }}>
          <div className="platform-result-row"><span>Current Plan</span><span>{company.subscription.planName || "—"}</span></div>
          <div className="platform-result-row"><span>Monthly Price</span><span>{company.subscription.planMonthlyPrice === null || company.subscription.planMonthlyPrice === undefined ? "Not set" : `$${company.subscription.planMonthlyPrice.toFixed(2)}`}</span></div>
          <div className="platform-result-row"><span>Yearly Price</span><span>{company.subscription.planYearlyPrice === null || company.subscription.planYearlyPrice === undefined ? "Not set" : `$${company.subscription.planYearlyPrice.toFixed(2)}`}</span></div>
          <div className="platform-result-row"><span>Employee Limit</span><span>{company.subscription.planEmployeeLimit === null || company.subscription.planEmployeeLimit === undefined ? "Unlimited" : company.subscription.planEmployeeLimit}</span></div>
          <div className="platform-result-row"><span>Subscription Status</span><span><span className={`platform-badge ${computeSubscriptionBadge(company.subscription).className}`}>{computeSubscriptionBadge(company.subscription).label}</span></span></div>
          {company.subscription.gracePeriodEndsAt && new Date(company.subscription.gracePeriodEndsAt) >= new Date() && (
            <div className="platform-result-row"><span>Grace Period Ends</span><span>{formatDate(company.subscription.gracePeriodEndsAt)}</span></div>
          )}
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

        {canManageAccessType && selectedPlanForCheckout && (selectedPlanForCheckout.monthlyPrice || selectedPlanForCheckout.yearlyPrice) && (
          <div style={{ marginTop: 20, paddingTop: 20, borderTop: "1px solid var(--p-border)" }}>
            <h3 style={{ fontSize: 13.5, marginTop: 0, marginBottom: 4 }}>Charge via Razorpay (Test Mode)</h3>
            <p style={{ fontSize: 12.5, color: "var(--p-text-secondary)", marginTop: 0, marginBottom: 12 }}>
              Starts a real Razorpay Test Mode checkout for <strong>{selectedPlanForCheckout.name}</strong>. The subscription activates automatically once the payment is verified — this does not replace manual payment recording below, which still works exactly as before.
            </p>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <select
                value={effectiveCheckoutBillingCycle}
                onChange={(event) => setCheckoutBillingCycle(event.target.value)}
                style={{ padding: "9px 12px", borderRadius: "var(--p-radius-sm)", border: "1px solid var(--p-border-strong)", fontSize: 13.5 }}
              >
                {selectedPlanForCheckout.monthlyPrice != null && <option value="monthly">Monthly — {formatMoney(selectedPlanForCheckout.monthlyPrice, "INR")}</option>}
                {selectedPlanForCheckout.yearlyPrice != null && <option value="yearly">Yearly — {formatMoney(selectedPlanForCheckout.yearlyPrice, "INR")}</option>}
              </select>
              <button className="platform-btn platform-btn-primary platform-btn-sm" onClick={() => setShowCheckoutModal(true)}>
                Pay with Razorpay
              </button>
            </div>
          </div>
        )}
      </div>

      {showCheckoutModal && selectedPlanForCheckout && (
        <RazorpayCheckoutModal
          mode="new"
          companyId={company.id}
          companyName={company.companyName}
          planId={selectedPlanForCheckout.id}
          planName={selectedPlanForCheckout.name}
          billingCycle={effectiveCheckoutBillingCycle}
          onClose={() => setShowCheckoutModal(false)}
          onSuccess={() => {
            setShowCheckoutModal(false);
            loadCompany();
            loadPayments();
          }}
        />
      )}

      <div className="platform-card" style={{ padding: 24, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 6 }}>Billing Contact</h2>
        <p style={{ fontSize: 13, color: "var(--p-text-secondary)", marginTop: 0, marginBottom: 14 }}>
          Subscription lifecycle emails (trial/renewal/payment reminders) go here first. Falls back to this company's first Admin if no billing contact is set.
        </p>

        {company.billingContact?.email ? (
          <div className="platform-result-box" style={{ marginBottom: 14 }}>
            <div className="platform-result-row"><span>Name</span><span>{company.billingContact.name || "—"}</span></div>
            <div className="platform-result-row"><span>Email</span><span>{company.billingContact.email}</span></div>
            <div className="platform-result-row"><span>Phone</span><span>{company.billingContact.phone || "—"}</span></div>
          </div>
        ) : (
          <div className="platform-empty-state" style={{ marginBottom: 14 }}>
            No billing contact set — lifecycle emails currently fall back to this company's first Admin.
          </div>
        )}

        <form onSubmit={handleSaveBillingContact}>
          <div className="platform-form-group">
            <label htmlFor="billing-name">Name</label>
            <input id="billing-name" type="text" value={billingName} onChange={(e) => setBillingName(e.target.value)} disabled={!canManageAccessType} />
          </div>
          <div className="platform-form-group">
            <label htmlFor="billing-email">Email</label>
            <input id="billing-email" type="email" value={billingEmail} onChange={(e) => setBillingEmail(e.target.value)} disabled={!canManageAccessType} placeholder="billing@company.com" />
          </div>
          <div className="platform-form-group">
            <label htmlFor="billing-phone">Phone (optional)</label>
            <input id="billing-phone" type="text" value={billingPhone} onChange={(e) => setBillingPhone(e.target.value)} disabled={!canManageAccessType} />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="submit" className="platform-btn platform-btn-primary" disabled={billingSaving || !canManageAccessType || !billingEmail.trim()}>
              {billingSaving ? "Saving..." : company.billingContact?.email ? "Update Billing Contact" : "Add Billing Contact"}
            </button>
            {company.billingContact?.email && (
              <button type="button" className="platform-btn platform-btn-outline" onClick={handleRemoveBillingContact} disabled={billingSaving || !canManageAccessType}>
                Remove
              </button>
            )}
          </div>
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

      <div className="platform-card" style={{ padding: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 6 }}>Payment History</h2>
            <p style={{ fontSize: 13, color: "var(--p-text-secondary)", margin: 0 }}>
              Real recorded payments for this company only.
            </p>
          </div>
          {(company.status === "active" || company.status === "suspended") && (
            <button className="platform-btn platform-btn-primary platform-btn-sm" onClick={() => setShowRecordPaymentModal(true)}>
              <FaPlus /> Record Payment
            </button>
          )}
        </div>

        {paymentsLoading && <div className="platform-empty-state">Loading payments...</div>}

        {!paymentsLoading && payments.length === 0 && (
          <div className="platform-empty-state">No payments have been recorded for this company yet.</div>
        )}

        {!paymentsLoading && payments.length > 0 && (
          <div className="platform-table-wrap">
            <table className="platform-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Plan</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Payment Date</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id} className="clickable" onClick={() => setSelectedPayment(payment)}>
                    <td>{payment.invoiceNumber || `#${payment.id}`}</td>
                    <td>{payment.planName || "—"}</td>
                    <td>{formatMoney(payment.amount, payment.currency)}</td>
                    <td><span className={`platform-badge status-${payment.paymentStatus}`}>{payment.paymentStatus}</span></td>
                    <td>{formatDate(payment.paidAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showRecordPaymentModal && (
        <RecordPaymentModal
          companies={[{ id: company.id, companyName: company.companyName }]}
          fixedCompanyId={company.id}
          onClose={() => setShowRecordPaymentModal(false)}
          onCreated={() => {
            setShowRecordPaymentModal(false);
            loadPayments();
            toast.success("Payment recorded.");
          }}
        />
      )}

      {selectedPayment && (
        <PaymentDetailsModal
          payment={selectedPayment}
          onClose={() => setSelectedPayment(null)}
          onUpdated={() => loadPayments()}
        />
      )}

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

      {showDeleteModal && (
        <DeleteCompanyModal
          company={company}
          onClose={() => setShowDeleteModal(false)}
          onDeleted={() => {
            toast.success(`"${company.companyName}" deleted.`);
            navigate("/owner/companies", { replace: true });
          }}
        />
      )}

    </div>
  );
}

export default PlatformCompanyDetails;
