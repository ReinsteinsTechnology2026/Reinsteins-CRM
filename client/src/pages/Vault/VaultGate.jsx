import { useEffect, useState } from "react";
import { FaLock, FaShieldAlt, FaKey, FaExclamationTriangle } from "react-icons/fa";

import { estimateStrength } from "../../vault/health";
import { getClipboard } from "../../vault/vaultRuntime";

// ==========================================
// ZIOVAULT -- setup, recovery key and unlock screens
//
// The master password is typed into a password field, handed to the Stage 1 key derivation in this tab, and forgotten: it is never
// stored, never sent, never logged. Wrong-password messages are the same whatever the reason, and repeated failures slow down locally.
// ==========================================

const LOCK_REASONS = {
  manual: "You locked the vault.",
  inactivity: "The vault locked after a period of inactivity.",
  logout: "The vault locked because you signed out of the CRM.",
  expired: "Your CRM session expired, so the vault locked. Sign in again to continue.",
  "other-tab": "The vault was locked in another tab.",
  "password-changed": "Your master password was changed in another tab. Unlock with the new password.",
};

export function StrengthMeter({ password, label = "Password strength" }) {
  if (!password) return <div className="zv-strength" aria-hidden="true" />;
  const { bits, score, label: text } = estimateStrength(password);
  return (
    <div className="zv-strength" data-testid="vault-strength" data-score={score}>
      <div className="zv-strength-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={4} aria-valuenow={score}>
        <span className={`zv-strength-fill s${score}`} style={{ width: `${(score + 1) * 20}%` }} />
      </div>
      <span className="zv-strength-text">{text} · about {Math.round(bits)} bits</span>
    </div>
  );
}

function Shell({ icon, title, intro, children }) {
  return (
    <div className="zv-gate">
      <div className="zv-gate-card">
        <div className="zv-gate-icon">{icon}</div>
        <h1>{title}</h1>
        {intro && <p className="zv-lead">{intro}</p>}
        {children}
      </div>
    </div>
  );
}

const ErrorLine = ({ error }) => (error ? <p className="zv-error" role="alert" data-testid="vault-error">{error}</p> : null);

export function VaultSetup({ session, state }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [understood, setUnderstood] = useState(false);

  const submit = (event) => {
    event.preventDefault();
    session.setup(password, confirm);
  };

  return (
    <Shell icon={<FaShieldAlt />} title="Set up your ZioVault" intro="Your passwords and notes are encrypted in this browser before they are saved. Even ZioVenture and your company's administrators cannot read them.">
      <ul className="zv-points">
        <li>Choose a <strong>master password</strong> that is different from your CRM password. It is the only thing that unlocks your vault.</li>
        <li>ZioVault <strong>cannot reset it</strong>. If you forget it, only your recovery key (shown next) can open the vault.</li>
        <li>The master password never leaves this device and is not stored anywhere.</li>
      </ul>
      <form onSubmit={submit} className="zv-form" autoComplete="off">
        <label htmlFor="zv-master">Master password</label>
        <input id="zv-master" data-testid="vault-setup-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} />
        <StrengthMeter password={password} label="Master password strength" />
        <p className="zv-hint">At least 12 characters. A passphrase of four or more random words is easy to remember and strong.</p>
        <label htmlFor="zv-master2">Confirm master password</label>
        <input id="zv-master2" data-testid="vault-setup-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <label className="zv-check">
          <input type="checkbox" data-testid="vault-setup-ack" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
          <span>I understand that if I lose both my master password and my recovery key, my vault <strong>cannot be recovered by anyone</strong>.</span>
        </label>
        <ErrorLine error={state.error} />
        <button type="submit" className="zv-btn zv-btn-primary" data-testid="vault-setup-submit" disabled={state.busy || !understood || !password || !confirm}>
          {state.busy ? "Creating your vault…" : "Create vault"}
        </button>
      </form>
    </Shell>
  );
}

export function RecoveryStep({ session, state }) {
  const [typed, setTyped] = useState("");
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await getClipboard().copy(state.recoverySecret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Shell icon={<FaKey />} title="Save your recovery key" intro="This key is shown once. It is the only way back into your vault if you forget your master password.">
      <div className="zv-warning" role="note">
        <FaExclamationTriangle />
        <p><strong>Write it down or store it somewhere safe and private</strong> (a printed copy in a locked drawer, or another password manager). If you lose your master password <em>and</em> this key, your data is gone for good: nobody, including ZioVenture, can recover it.</p>
      </div>
      <div className="zv-secret-box" data-testid="vault-recovery-secret" aria-label="Recovery key">{state.recoverySecret}</div>
      <div className="zv-row">
        <button type="button" className="zv-btn" onClick={copy} data-testid="vault-recovery-copy">Copy</button>
        {copied && <span className="zv-hint" role="status">Copied. We will try to clear it from the clipboard shortly, but clipboards cannot be guaranteed to forget.</span>}
      </div>
      <form className="zv-form" onSubmit={(event) => { event.preventDefault(); session.confirmRecovery(typed); }} autoComplete="off">
        <label htmlFor="zv-retype">Type the recovery key to confirm you have it</label>
        <input id="zv-retype" data-testid="vault-recovery-retype" type="text" autoComplete="off" spellCheck="false" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="XXXX-XXXX-XXXX-…" />
        <label className="zv-check">
          <input type="checkbox" data-testid="vault-recovery-ack" checked={stored} onChange={(e) => setStored(e.target.checked)} />
          <span>I have stored my recovery key safely.</span>
        </label>
        <ErrorLine error={state.error} />
        <button type="submit" className="zv-btn zv-btn-primary" data-testid="vault-recovery-confirm" disabled={state.busy || !stored || typed.trim().length < 20}>
          {state.busy ? "Confirming…" : "I have saved it — open my vault"}
        </button>
      </form>
    </Shell>
  );
}

export function VaultUnlock({ session, state }) {
  const [password, setPassword] = useState("");
  const [forgot, setForgot] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [fresh, setFresh] = useState("");
  const [freshConfirm, setFreshConfirm] = useState("");
  const [, tick] = useState(0);

  // the wrong-password cool-down counts down on screen
  useEffect(() => {
    if (!state.retryAfterMs) return undefined;
    const timer = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [state.retryAfterMs]);

  const unlock = async (event) => {
    event.preventDefault();
    const outcome = await session.unlock(password);
    if (outcome === "unlocked") setPassword("");
  };

  const recover = async (event) => {
    event.preventDefault();
    const ok = await session.recover(recoveryKey, fresh, freshConfirm);
    if (ok) {
      setRecoveryKey("");
      setFresh("");
      setFreshConfirm("");
    }
  };

  const reason = state.lockReason ? LOCK_REASONS[state.lockReason] : null;

  return (
    <Shell icon={<FaLock />} title={forgot ? "Recover your vault" : "Your vault is locked"} intro={forgot ? "Enter your recovery key and choose a new master password." : "Enter your master password to unlock."}>
      {reason && !forgot && <p className="zv-notice" role="status" data-testid="vault-lock-reason">{reason}</p>}
      {state.draftAvailable && !forgot && <p className="zv-notice" role="status" data-testid="vault-draft-notice">You had unsaved changes. They were kept encrypted and will be offered after you unlock.</p>}
      {!forgot ? (
        <form onSubmit={unlock} className="zv-form" autoComplete="off">
          <label htmlFor="zv-unlock">Master password</label>
          <input id="zv-unlock" data-testid="vault-unlock-password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          <ErrorLine error={state.error} />
          <button type="submit" className="zv-btn zv-btn-primary" data-testid="vault-unlock-submit" disabled={state.busy || !password}>
            {state.busy ? "Unlocking…" : "Unlock"}
          </button>
          <button type="button" className="zv-link" data-testid="vault-forgot" onClick={() => setForgot(true)}>I forgot my master password</button>
        </form>
      ) : (
        <form onSubmit={recover} className="zv-form" autoComplete="off">
          <label htmlFor="zv-rk">Recovery key</label>
          <input id="zv-rk" data-testid="vault-recover-key" type="text" autoComplete="off" spellCheck="false" value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} />
          <label htmlFor="zv-new">New master password</label>
          <input id="zv-new" data-testid="vault-recover-password" type="password" autoComplete="new-password" value={fresh} onChange={(e) => setFresh(e.target.value)} />
          <StrengthMeter password={fresh} label="New master password strength" />
          <label htmlFor="zv-new2">Confirm new master password</label>
          <input id="zv-new2" data-testid="vault-recover-confirm-password" type="password" autoComplete="new-password" value={freshConfirm} onChange={(e) => setFreshConfirm(e.target.value)} />
          <ErrorLine error={state.error} />
          <button type="submit" className="zv-btn zv-btn-primary" data-testid="vault-recover-submit" disabled={state.busy || !recoveryKey || !fresh}>
            {state.busy ? "Recovering…" : "Recover and unlock"}
          </button>
          <button type="button" className="zv-link" onClick={() => setForgot(false)}>Back to unlock</button>
        </form>
      )}
    </Shell>
  );
}
