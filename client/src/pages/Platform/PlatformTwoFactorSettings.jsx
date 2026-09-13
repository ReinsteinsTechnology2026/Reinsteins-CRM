import { useEffect, useState } from "react";
import { toast } from "react-toastify";
import { FaShieldAlt, FaCheckCircle, FaExclamationTriangle } from "react-icons/fa";

import platformApi from "../../services/platformApi";

// ==========================================
// PLATFORM OWNER TWO-FACTOR AUTHENTICATION (Phase 14D)
//
// Every step here calls the real backend -- nothing is simulated.
// The TOTP secret is shown ONLY in the setup step's response (never
// again afterward, not even to this same component on a later
// render); backup codes are shown ONLY once, immediately after they
// are generated (initial enrollment or an explicit regenerate). Both
// facts are enforced server-side (platformAuthController.js never
// returns either value from any other endpoint), not just hidden by
// this UI.
// ==========================================

const STAGE = {
  IDLE: "idle",
  SETUP_PASSWORD: "setup_password",
  SETUP_SCAN: "setup_scan",
  SETUP_BACKUP_CODES: "setup_backup_codes",
  DISABLE: "disable",
  REGENERATE_PASSWORD: "regenerate_password",
  REGENERATE_CODES: "regenerate_codes",
};

function PlatformTwoFactorSettings() {
  const [status, setStatus] = useState(null);
  const [stage, setStage] = useState(STAGE.IDLE);
  const [submitting, setSubmitting] = useState(false);

  // Setup flow state
  const [setupPassword, setSetupPassword] = useState("");
  const [setupData, setSetupData] = useState(null); // { secret, qrCodeDataUrl }
  const [confirmCode, setConfirmCode] = useState("");
  const [newBackupCodes, setNewBackupCodes] = useState(null);
  const [savedConfirmed, setSavedConfirmed] = useState(false);

  // Disable flow state
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");

  // Regenerate flow state
  const [regeneratePassword, setRegeneratePassword] = useState("");

  const loadStatus = () => {
    platformApi.get("/auth/2fa/status").then((res) => setStatus(res.data)).catch(() => setStatus(null));
  };

  useEffect(() => { loadStatus(); }, []);

  const resetToIdle = () => {
    setStage(STAGE.IDLE);
    setSetupPassword(""); setSetupData(null); setConfirmCode(""); setNewBackupCodes(null); setSavedConfirmed(false);
    setDisablePassword(""); setDisableCode(""); setRegeneratePassword("");
    loadStatus();
  };

  const handleStartSetup = async (event) => {
    event.preventDefault();
    if (!setupPassword) return;
    try {
      setSubmitting(true);
      const res = await platformApi.post("/auth/2fa/setup", { password: setupPassword });
      setSetupData({ secret: res.data.secret, qrCodeDataUrl: res.data.qrCodeDataUrl });
      setStage(STAGE.SETUP_SCAN);
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to start 2FA setup.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmSetup = async (event) => {
    event.preventDefault();
    if (!confirmCode.trim()) return;
    try {
      setSubmitting(true);
      const res = await platformApi.post("/auth/2fa/confirm", { code: confirmCode.trim() });
      setNewBackupCodes(res.data.backupCodes);
      setStage(STAGE.SETUP_BACKUP_CODES);
      toast.success("Two-factor authentication enabled.");
    } catch (err) {
      toast.error(err.response?.data?.message || "Invalid verification code.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDisable = async (event) => {
    event.preventDefault();
    if (!disablePassword || !disableCode.trim()) return;
    try {
      setSubmitting(true);
      await platformApi.post("/auth/2fa/disable", { password: disablePassword, code: disableCode.trim() });
      toast.success("Two-factor authentication disabled.");
      resetToIdle();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to disable 2FA.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegenerate = async (event) => {
    event.preventDefault();
    if (!regeneratePassword) return;
    try {
      setSubmitting(true);
      const res = await platformApi.post("/auth/2fa/backup-codes/regenerate", { password: regeneratePassword });
      setNewBackupCodes(res.data.backupCodes);
      setStage(STAGE.REGENERATE_CODES);
      toast.success("Backup codes regenerated. Your old codes no longer work.");
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to regenerate backup codes.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="platform-card" style={{ padding: 24, marginBottom: 20, maxWidth: 480 }}>
      <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 6 }}><FaShieldAlt style={{ marginRight: 6, verticalAlign: -2 }} />Two-Factor Authentication</h2>
      <p style={{ fontSize: 13, color: "var(--p-text-secondary)", marginTop: 0, marginBottom: 18 }}>
        Require an authenticator app code (in addition to your password) when signing in to the Platform Owner account.
      </p>

      {stage === STAGE.IDLE && (
        <>
          <div className="platform-result-box" style={{ marginBottom: 16 }}>
            <div className="platform-result-row">
              <span>Status</span>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {status?.enabled ? (
                  <><FaCheckCircle style={{ color: "var(--p-success)" }} /> Enabled</>
                ) : "Not Enabled"}
              </span>
            </div>
            {status?.enabled && (
              <div className="platform-result-row"><span>Backup Codes Remaining</span><span>{status.backupCodesRemaining}</span></div>
            )}
          </div>

          {!status?.enabled && (
            <button className="platform-btn platform-btn-primary" onClick={() => setStage(STAGE.SETUP_PASSWORD)}>
              Enable Two-Factor Authentication
            </button>
          )}
          {status?.enabled && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="platform-btn platform-btn-outline" onClick={() => setStage(STAGE.REGENERATE_PASSWORD)}>
                Regenerate Backup Codes
              </button>
              <button className="platform-btn platform-btn-danger" onClick={() => setStage(STAGE.DISABLE)}>
                Disable 2FA
              </button>
            </div>
          )}
        </>
      )}

      {stage === STAGE.SETUP_PASSWORD && (
        <form onSubmit={handleStartSetup}>
          <p style={{ fontSize: 13, marginTop: 0 }}>Confirm your password to begin setup.</p>
          <div className="platform-form-group">
            <label htmlFor="tfa-setup-password">Current Password</label>
            <input id="tfa-setup-password" type="password" autoComplete="current-password" value={setupPassword} onChange={(e) => setSetupPassword(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="submit" className="platform-btn platform-btn-primary" disabled={submitting || !setupPassword}>
              {submitting ? "Starting…" : "Continue"}
            </button>
            <button type="button" className="platform-btn platform-btn-outline" onClick={resetToIdle}>Cancel</button>
          </div>
        </form>
      )}

      {stage === STAGE.SETUP_SCAN && setupData && (
        <form onSubmit={handleConfirmSetup}>
          <p style={{ fontSize: 13, marginTop: 0 }}>Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.), then enter the 6-digit code it shows.</p>
          <div style={{ textAlign: "center", margin: "14px 0" }}>
            <img src={setupData.qrCodeDataUrl} alt="2FA setup QR code" style={{ width: 180, height: 180, border: "1px solid var(--p-border)", borderRadius: "var(--p-radius-sm)" }} />
          </div>
          <p style={{ fontSize: 11.5, color: "var(--p-text-muted)", wordBreak: "break-all" }}>
            Can't scan? Enter this key manually: <strong>{setupData.secret}</strong>
          </p>
          <div className="platform-form-group">
            <label htmlFor="tfa-confirm-code">6-Digit Code</label>
            <input id="tfa-confirm-code" type="text" placeholder="123456" value={confirmCode} onChange={(e) => setConfirmCode(e.target.value)} autoFocus />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="submit" className="platform-btn platform-btn-primary" disabled={submitting || !confirmCode.trim()}>
              {submitting ? "Verifying…" : "Verify & Enable"}
            </button>
            <button type="button" className="platform-btn platform-btn-outline" onClick={resetToIdle}>Cancel</button>
          </div>
        </form>
      )}

      {(stage === STAGE.SETUP_BACKUP_CODES || stage === STAGE.REGENERATE_CODES) && newBackupCodes && (
        <div>
          <div className="platform-alert platform-alert-danger" style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <FaExclamationTriangle style={{ marginTop: 2, flexShrink: 0 }} />
            <span>Save these backup codes somewhere safe now. Each one can only be used once, and they will not be shown again after you leave this page.</span>
          </div>
          <div className="platform-result-box" style={{ fontFamily: "monospace", fontSize: 14, marginTop: 12, marginBottom: 16 }}>
            {newBackupCodes.map((c) => (
              <div key={c} className="platform-result-row"><span>{c}</span><span></span></div>
            ))}
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 14, cursor: "pointer" }}>
            <input type="checkbox" checked={savedConfirmed} onChange={(e) => setSavedConfirmed(e.target.checked)} style={{ width: "auto" }} />
            I have saved these backup codes in a safe place.
          </label>
          <button className="platform-btn platform-btn-primary" disabled={!savedConfirmed} onClick={resetToIdle}>
            Done
          </button>
        </div>
      )}

      {stage === STAGE.DISABLE && (
        <form onSubmit={handleDisable}>
          <p style={{ fontSize: 13, marginTop: 0 }}>Confirm your password and a current verification code to disable 2FA.</p>
          <div className="platform-form-group">
            <label htmlFor="tfa-disable-password">Current Password</label>
            <input id="tfa-disable-password" type="password" autoComplete="current-password" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} />
          </div>
          <div className="platform-form-group">
            <label htmlFor="tfa-disable-code">Verification Code</label>
            <input id="tfa-disable-code" type="text" placeholder="123456 or backup code" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="submit" className="platform-btn platform-btn-danger" disabled={submitting || !disablePassword || !disableCode.trim()}>
              {submitting ? "Disabling…" : "Disable 2FA"}
            </button>
            <button type="button" className="platform-btn platform-btn-outline" onClick={resetToIdle}>Cancel</button>
          </div>
        </form>
      )}

      {stage === STAGE.REGENERATE_PASSWORD && (
        <form onSubmit={handleRegenerate}>
          <p style={{ fontSize: 13, marginTop: 0 }}>Confirm your password to generate a new set of backup codes. Your existing codes will stop working.</p>
          <div className="platform-form-group">
            <label htmlFor="tfa-regen-password">Current Password</label>
            <input id="tfa-regen-password" type="password" autoComplete="current-password" value={regeneratePassword} onChange={(e) => setRegeneratePassword(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="submit" className="platform-btn platform-btn-primary" disabled={submitting || !regeneratePassword}>
              {submitting ? "Generating…" : "Regenerate Codes"}
            </button>
            <button type="button" className="platform-btn platform-btn-outline" onClick={resetToIdle}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

export default PlatformTwoFactorSettings;
