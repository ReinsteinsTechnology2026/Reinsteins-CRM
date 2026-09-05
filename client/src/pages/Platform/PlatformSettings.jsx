// ==========================================
// PLATFORM SETTINGS (Phase 4 — placeholder only)
// Intentionally minimal per this phase's explicit scope: no
// subscriptions, payments, or AI features. Reserved for future
// platform-level configuration.
// ==========================================

function PlatformSettings() {
  return (
    <div className="platform-page">
      <div className="platform-page-header">
        <div>
          <h1>Settings</h1>
          <p>Platform-level configuration.</p>
        </div>
      </div>

      <div className="platform-card">
        <div className="platform-empty-state">
          Platform settings will be added in a future phase (billing, subscription plans, and platform-wide configuration).
        </div>
      </div>
    </div>
  );
}

export default PlatformSettings;
