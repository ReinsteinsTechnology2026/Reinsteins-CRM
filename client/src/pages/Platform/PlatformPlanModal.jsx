import { useState } from "react";

import platformApi from "../../services/platformApi";

// ==========================================
// PLATFORM PLAN MODAL (Phase 8)
//
// One modal, two modes: `plan` prop absent -> create
// (POST /api/platform/plans), `plan` prop present -> edit
// (PATCH /api/platform/plans/:id). Slug is only editable at create
// time -- it is immutable afterward (mirrors company_slug), so the
// field is simply not rendered in edit mode.
//
// `features` is a small raw-JSON textarea rather than a bespoke
// key/value UI -- nothing in this codebase consumes plan features
// yet, so a flexible free-form JSON object is the right amount of
// structure for "can later support billing/payment integration"
// without inventing feature flags nobody uses today.
// ==========================================

function PlatformPlanModal({ plan, onClose, onSaved }) {
  const isEdit = Boolean(plan);

  const [name, setName] = useState(plan?.name || "");
  const [slug, setSlug] = useState(plan?.slug || "");
  const [description, setDescription] = useState(plan?.description || "");
  const [employeeLimit, setEmployeeLimit] = useState(
    plan?.employeeLimit === null || plan?.employeeLimit === undefined ? "" : String(plan.employeeLimit)
  );
  const [storageLimitMb, setStorageLimitMb] = useState(
    plan?.storageLimitMb === null || plan?.storageLimitMb === undefined ? "" : String(plan.storageLimitMb)
  );
  const [featuresText, setFeaturesText] = useState(
    JSON.stringify(plan?.features || {}, null, 2)
  );

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Plan name is required.");
      return;
    }

    if (!isEdit && !slug.trim()) {
      setError("Plan slug is required.");
      return;
    }

    let features;
    try {
      features = featuresText.trim() ? JSON.parse(featuresText) : {};
      if (typeof features !== "object" || Array.isArray(features)) {
        throw new Error("not an object");
      }
    } catch {
      setError("Feature configuration must be valid JSON (an object).");
      return;
    }

    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      employeeLimit: employeeLimit.trim() === "" ? undefined : Number(employeeLimit),
      storageLimitMb: storageLimitMb.trim() === "" ? undefined : Number(storageLimitMb),
      features,
    };

    if (!isEdit) {
      payload.slug = slug.trim().toLowerCase();
    }

    try {
      setSubmitting(true);

      const response = isEdit
        ? await platformApi.patch(`/plans/${plan.id}`, payload)
        : await platformApi.post("/plans", payload);

      onSaved(response.data.plan);

    } catch (err) {
      setError(err.response?.data?.message || "Failed to save plan.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="platform-modal-backdrop" onClick={onClose}>
      <div className="platform-modal" onClick={(event) => event.stopPropagation()}>

        <div className="platform-modal-header">
          <div>
            <h2>{isEdit ? "Edit Plan" : "Create Plan"}</h2>
            <p>{isEdit ? plan.name : "New subscription plan"}</p>
          </div>
          <button className="platform-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="platform-modal-body">

          {error && <div className="platform-alert platform-alert-danger">{error}</div>}

          <form onSubmit={handleSubmit}>

            <div className="platform-form-group">
              <label htmlFor="plan-name">Plan Name</label>
              <input
                id="plan-name"
                type="text"
                placeholder="Professional"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            {!isEdit && (
              <div className="platform-form-group">
                <label htmlFor="plan-slug">Slug</label>
                <input
                  id="plan-slug"
                  type="text"
                  placeholder="professional"
                  value={slug}
                  onChange={(event) => setSlug(event.target.value)}
                />
                <p className="platform-form-hint">Lowercase letters, digits, hyphens. Cannot be changed later.</p>
              </div>
            )}

            <div className="platform-form-group">
              <label htmlFor="plan-description">Description</label>
              <input
                id="plan-description"
                type="text"
                placeholder="Short description shown to the Platform Owner"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>

            <div className="platform-form-group">
              <label htmlFor="plan-employee-limit">Employee Limit</label>
              <input
                id="plan-employee-limit"
                type="number"
                min="0"
                placeholder="Leave blank for unlimited"
                value={employeeLimit}
                onChange={(event) => setEmployeeLimit(event.target.value)}
              />
            </div>

            <div className="platform-form-group">
              <label htmlFor="plan-storage-limit">Storage Limit (MB)</label>
              <input
                id="plan-storage-limit"
                type="number"
                min="0"
                placeholder="Leave blank for unlimited"
                value={storageLimitMb}
                onChange={(event) => setStorageLimitMb(event.target.value)}
              />
            </div>

            <div className="platform-form-group">
              <label htmlFor="plan-features">Feature Configuration (JSON)</label>
              <textarea
                id="plan-features"
                rows={4}
                value={featuresText}
                onChange={(event) => setFeaturesText(event.target.value)}
                style={{
                  width: "100%", padding: "10px 12px", borderRadius: "var(--p-radius-sm)",
                  border: "1px solid var(--p-border)", fontSize: 13, fontFamily: "ui-monospace, monospace",
                  background: "var(--p-surface-secondary)", color: "var(--p-text)", resize: "vertical",
                }}
              />
              <p className="platform-form-hint">Reserved for future feature flags/billing integration. Optional -- leave as {"{}"} if unused.</p>
            </div>

          </form>

        </div>

        <div className="platform-modal-footer">
          <button className="platform-btn platform-btn-outline" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button className="platform-btn platform-btn-primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Saving..." : isEdit ? "Save Changes" : "Create Plan"}
          </button>
        </div>

      </div>
    </div>
  );
}

export default PlatformPlanModal;
