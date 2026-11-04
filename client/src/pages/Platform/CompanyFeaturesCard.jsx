import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import platformApi from "../../services/platformApi";
import FeatureSelector from "./FeatureSelector";

// ==========================================
// COMPANY FEATURES CARD (Company Details page)
//
// View, enable and disable the CRM modules of an already-created company. Saving takes effect immediately -- no redeploy:
// the server refuses a disabled module's APIs on the next request and tells the company's open sessions, which replace the
// module with "This feature is not enabled for your organization.". Switching a module off never deletes its data;
// switching it back on restores it.
// ==========================================

function CompanyFeaturesCard({ companyId }) {
  const [catalog, setCatalog] = useState(null);
  const [saved, setSaved] = useState([]);
  const [selected, setSelected] = useState([]);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([platformApi.get("/companies/features/catalog"), platformApi.get(`/companies/${companyId}/features`)])
      .then(([catalogRes, featuresRes]) => {
        if (cancelled) return;
        setCatalog(catalogRes.data.features);
        setSaved(featuresRes.data.features);
        setSelected(featuresRes.data.features);
      })
      .catch((err) => !cancelled && setLoadError(err.response?.data?.message || "Failed to load the company's features."));
    return () => { cancelled = true; };
  }, [companyId]);

  const dirty = catalog !== null && (selected.length !== saved.length || selected.some((id) => !saved.includes(id)));
  const turnedOff = saved.filter((id) => !selected.includes(id));

  const handleSave = async () => {
    if (selected.length === 0) {
      toast.error("Select at least one feature.");
      return;
    }
    try {
      setSaving(true);
      const response = await platformApi.put(`/companies/${companyId}/features`, { features: selected });
      setSaved(response.data.features);
      setSelected(response.data.features);
      toast.success("Features updated. The change is live for this company's users.");
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to update features.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="platform-card" style={{ padding: 24, marginBottom: 20 }} data-testid="company-features-card">
      <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 6 }}>Features</h2>
      <p style={{ fontSize: 13, color: "var(--p-text-secondary)", marginTop: 0 }}>
        The CRM modules this company can use. Changes apply immediately. Turning a module off hides it and blocks access to it; its data is kept and
        comes back if the module is turned on again.
      </p>

      {loadError && <div className="platform-alert platform-alert-danger">{loadError}</div>}
      {!catalog && !loadError && <div className="platform-empty-state">Loading features…</div>}

      {catalog && (
        <>
          <FeatureSelector catalog={catalog} value={selected} onChange={setSelected} disabled={saving} />

          {turnedOff.length > 0 && (
            <p className="platform-form-hint" data-testid="features-turning-off">
              Saving will turn off: {turnedOff.map((id) => catalog.find((feature) => feature.id === id)?.name || id).join(", ")}. Users who have these open will
              be shown that the feature is not enabled.
            </p>
          )}

          <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
            <button type="button" className="platform-btn platform-btn-primary" onClick={handleSave} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save Features"}
            </button>
            <button type="button" className="platform-btn platform-btn-outline" onClick={() => setSelected(saved)} disabled={!dirty || saving}>
              Reset
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default CompanyFeaturesCard;
