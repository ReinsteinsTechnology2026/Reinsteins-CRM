import { useState } from "react";

import { AUTO_LOCK_CHOICES } from "../../vault/vaultSession";
import { StrengthMeter } from "./VaultGate";

export default function SettingsPanel({ session, state }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);

  const change = async (event) => {
    event.preventDefault();
    setDone(false);
    const ok = await session.changePassword(current, next, confirm);
    if (ok) {
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    }
  };

  return (
    <section className="zv-panel" data-testid="vault-settings">
      <h2>Settings</h2>

      <h3>Security</h3>
      <label className="zv-field">Lock automatically after
        <select data-testid="vault-setting-autolock" value={state.prefs.autoLockMinutes} onChange={(e) => session.setPrefs({ autoLockMinutes: Number(e.target.value) })}>
          {AUTO_LOCK_CHOICES.map((m) => <option key={m} value={m}>{m} minute{m === 1 ? "" : "s"} of inactivity</option>)}
          <option value={0}>Never (not recommended)</option>
        </select>
      </label>
      <label className="zv-field">Clear copied passwords after
        <select data-testid="vault-setting-clipboard" value={state.prefs.clipboardClearSeconds} onChange={(e) => session.setPrefs({ clipboardClearSeconds: Number(e.target.value) })}>
          {[15, 30, 60, 120].map((s) => <option key={s} value={s}>{s} seconds</option>)}
          <option value={0}>Do not clear</option>
        </select>
      </label>
      <p className="zv-hint">Clearing the clipboard is best effort: another application or a clipboard-history tool may keep a copy, and a closed tab cannot clear anything.</p>
      <label className="zv-field">Flag passwords as old after
        <select value={state.prefs.oldPasswordDays} onChange={(e) => session.setPrefs({ oldPasswordDays: Number(e.target.value) })}>
          {[90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
        </select>
      </label>

      <label className="zv-field">Warn about rotations
        <select data-testid="vault-setting-rotation-warn" value={state.prefs.rotationWarnDays} onChange={(e) => session.setPrefs({ rotationWarnDays: Number(e.target.value) })}>
          {[7, 14, 30, 60].map((d) => <option key={d} value={d}>{d} days before they are due</option>)}
        </select>
      </label>

      <h3>Master password</h3>
      <form className="zv-form" onSubmit={change} autoComplete="off">
        <label htmlFor="zv-cur">Current master password</label>
        <input id="zv-cur" data-testid="vault-change-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <label htmlFor="zv-nxt">New master password</label>
        <input id="zv-nxt" data-testid="vault-change-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        <StrengthMeter password={next} label="New master password strength" />
        <label htmlFor="zv-cnf">Confirm new master password</label>
        <input id="zv-cnf" data-testid="vault-change-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {state.error && <p className="zv-error" role="alert" data-testid="vault-error">{state.error}</p>}
        {done && <p className="zv-notice" role="status" data-testid="vault-change-done">Master password changed. Other open tabs will lock and ask for the new one.</p>}
        <button type="submit" className="zv-btn" data-testid="vault-change-submit" disabled={state.busy || !current || !next}>{state.busy ? "Working…" : "Change master password"}</button>
      </form>

      <h3>Recovery key</h3>
      <p className="zv-hint">{state.recoveryConfirmed ? "Your recovery key is confirmed." : "You have not confirmed your recovery key."} Creating a new one makes the old one stop working.</p>
      <button type="button" className="zv-btn" data-testid="vault-new-recovery" onClick={() => session.regenerateRecovery()} disabled={state.busy}>Create a new recovery key</button>
    </section>
  );
}
