import { useEffect, useState } from "react";

import platformApi from "../../services/platformApi";

// ==========================================
// ADD COMPANY MODAL
//
// A single form that orchestrates THREE existing, already-tested
// endpoints in sequence -- no new backend logic was written for this:
//   1. POST /companies            (create + provision the tenant DB)
//   2. POST /companies/:id/admin  (create the company's first admin)
//   3. PATCH /companies/:id/subscription (assign the chosen plan)
//
// If step 1 fails, nothing was created. If step 2 or 3 fails, the
// company (and, for a step-3 failure, its admin) already exist --
// this is surfaced clearly rather than silently swallowed, and the
// Platform Owner can finish the rest from the company's own Details
// page (Create First Admin / Subscription section), exactly as
// before this form existed.
// ==========================================

const ACCESS_TYPES = [
  { value: "complimentary", label: "Complimentary" },
  { value: "trial", label: "Trial" },
  { value: "paid", label: "Paid" },
];

function AddCompanyModal({ onClose, onCreated, onPartialSuccess }) {
  const [companyName, setCompanyName] = useState("");
  const [companySlug, setCompanySlug] = useState("");
  const [accessType, setAccessType] = useState("trial");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [planId, setPlanId] = useState("");

  const [plans, setPlans] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [step, setStep] = useState("form"); // "form" | "creating"

  useEffect(() => {
    platformApi.get("/plans")
      .then((response) => {
        const activePlans = response.data.plans.filter((p) => p.status === "active");
        setPlans(activePlans);
      })
      .catch(() => setPlans([]));
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);

    if (!companyName.trim() || !companySlug.trim()) {
      setError("Company name and slug are required.");
      return;
    }
    if (!adminName.trim() || !adminEmail.trim() || !adminPassword) {
      setError("Admin name, email, and password are required.");
      return;
    }
    if (adminPassword.length < 8) {
      setError("Admin password must be at least 8 characters.");
      return;
    }

    let createdCompanyId = null;

    try {
      setSubmitting(true);
      setStep("creating");

      // ---------- 1. Create company + provision tenant DB ----------
      const companyRes = await platformApi.post("/companies", {
        companyName: companyName.trim(),
        companySlug: companySlug.trim().toLowerCase(),
        accessType,
      });
      const company = companyRes.data.company;
      createdCompanyId = company.id;

      // ---------- 2. Create the first admin ----------
      try {
        await platformApi.post(`/companies/${company.id}/admin`, {
          name: adminName.trim(),
          email: adminEmail.trim(),
          password: adminPassword,
        });
      } catch (adminErr) {
        throw new Error(
          `Company "${company.companyName}" was created, but the admin account could not be created: ` +
          `${adminErr.response?.data?.message || "unknown error"}. ` +
          `Open the company's details page to create the admin manually.`
        );
      }

      // ---------- 3. Assign the chosen subscription plan (optional) ----------
      if (planId) {
        try {
          await platformApi.patch(`/companies/${company.id}/subscription`, {
            planId: Number(planId),
            subscriptionStatus: "active",
          });
        } catch (subErr) {
          throw new Error(
            `Company "${company.companyName}" and its admin were created, but the subscription plan ` +
            `could not be assigned: ${subErr.response?.data?.message || "unknown error"}. ` +
            `Assign it from the company's Subscription section.`
          );
        }
      }

      onCreated(company);

    } catch (err) {
      setStep("form");
      setError(err.message || err.response?.data?.message || "Failed to create company.");
      // If the company itself was created (step 1 succeeded) but a
      // later step failed, the modal stays open showing this error
      // (so the Platform Owner sees exactly what happened and what to
      // do next) -- but the company list behind it should still
      // reflect the new, partially-set-up company rather than staying
      // stale until they reload the page themselves.
      if (createdCompanyId) {
        onPartialSuccess?.();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="platform-modal-backdrop" onClick={onClose}>
      <div className="platform-modal" onClick={(event) => event.stopPropagation()}>

        <div className="platform-modal-header">
          <div>
            <h2>Add Company</h2>
            <p>Creates the company, provisions its tenant database, and creates its first admin.</p>
          </div>
          <button className="platform-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="platform-modal-body">

          {error && <div className="platform-alert platform-alert-danger">{error}</div>}

          {step === "creating" ? (
            <div className="platform-empty-state">Creating company, provisioning its tenant database, and setting up the admin account…</div>
          ) : (
            <form onSubmit={handleSubmit}>

              <div className="platform-form-group">
                <label htmlFor="company-name">Company Name</label>
                <input
                  id="company-name"
                  type="text"
                  placeholder="Arckenets Technologies"
                  value={companyName}
                  onChange={(event) => setCompanyName(event.target.value)}
                />
              </div>

              <div className="platform-form-group">
                <label htmlFor="company-slug">Company ID (slug)</label>
                <input
                  id="company-slug"
                  type="text"
                  placeholder="arckenets"
                  value={companySlug}
                  onChange={(event) => setCompanySlug(event.target.value)}
                />
                <p className="platform-form-hint">
                  Lowercase, letters/digits/underscore only. Determines the tenant login URL and database name — the actual database name is generated by the server, never chosen here.
                </p>
              </div>

              <div className="platform-form-group">
                <label htmlFor="admin-name">Admin Name</label>
                <input
                  id="admin-name"
                  type="text"
                  placeholder="Jane Doe"
                  value={adminName}
                  onChange={(event) => setAdminName(event.target.value)}
                />
              </div>

              <div className="platform-form-group">
                <label htmlFor="admin-email">Admin Email</label>
                <input
                  id="admin-email"
                  type="email"
                  placeholder="jane@company.com"
                  value={adminEmail}
                  onChange={(event) => setAdminEmail(event.target.value)}
                />
              </div>

              <div className="platform-form-group">
                <label htmlFor="admin-password">Admin Password</label>
                <input
                  id="admin-password"
                  type="password"
                  placeholder="At least 8 characters"
                  value={adminPassword}
                  onChange={(event) => setAdminPassword(event.target.value)}
                  autoComplete="new-password"
                />
                <p className="platform-form-hint">
                  The admin's login ID is generated automatically and shown after creation — share it and this password with the company directly.
                </p>
              </div>

              <div className="platform-form-group">
                <label htmlFor="subscription-plan">Subscription Plan</label>
                <select
                  id="subscription-plan"
                  value={planId}
                  onChange={(event) => setPlanId(event.target.value)}
                >
                  <option value="">No plan yet (assign later)</option>
                  {plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>{plan.name}</option>
                  ))}
                </select>
              </div>

              <div className="platform-form-group">
                <label htmlFor="access-type">Access Type</label>
                <select
                  id="access-type"
                  value={accessType}
                  onChange={(event) => setAccessType(event.target.value)}
                >
                  {ACCESS_TYPES.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>

              <div className="platform-form-group">
                <label>Company Status</label>
                <p className="platform-form-hint" style={{ marginTop: 0 }}>
                  Will be <strong>Active</strong> immediately after creation and provisioning succeed.
                </p>
              </div>

            </form>
          )}

        </div>

        {step === "form" && (
          <div className="platform-modal-footer">
            <button className="platform-btn platform-btn-outline" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button className="platform-btn platform-btn-primary" onClick={handleSubmit} disabled={submitting}>
              {submitting ? "Creating..." : "Create Company"}
            </button>
          </div>
        )}

      </div>
    </div>
  );
}

export default AddCompanyModal;
