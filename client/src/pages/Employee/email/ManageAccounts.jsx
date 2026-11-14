import { useState } from "react";
import { FaTimes, FaGoogle, FaMicrosoft, FaExclamationTriangle, FaSyncAlt, FaUnlink, FaPen } from "react-icons/fa";
import { toast } from "react-toastify";

import { accounts as accountsApi, errorInfo } from "./emailApi";
import { ProviderChoices, ConsentNotes, startConnect } from "./AddAccountPanel";
import { formatFullDate } from "./emailUtils";

// ==========================================
// MANAGE ACCOUNTS -- see every connected account's state, reconnect, rename, disconnect, or add another.
//
//   Connected        working normally; "last checked" shows the most recent synchronisation
//   Reconnect        the provider says the sign-in expired or was revoked (a password change, removed access, a long gap): one click
//   Sync problem     the account is connected but checking for new mail keeps failing (the message is shown)
// Disconnect removes ZioVenture's access: the stored sign-in is deleted here and, for Google, revoked at Google. Your mail is not
// touched; it stays in Gmail / Outlook.
// ==========================================

function ManageAccounts({ accounts, providers, portal, onClose, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [adding, setAdding] = useState(false);
  const [busyProvider, setBusyProvider] = useState(null);
  const [error, setError] = useState("");

  async function reconnect(account) {
    setBusy(account.id);
    setError("");
    try {
      await startConnect({ provider: account.provider, portal, accountId: account.id });
    } catch (err) {
      setError(errorInfo(err).message);
      setBusy(null);
    }
  }

  async function disconnect(account) {
    const detail = account.provider === "google"
      ? "ZioVenture's access is removed and revoked at Google."
      : "ZioVenture's stored sign-in is deleted (you can also remove the app in your Microsoft account's privacy settings).";
    if (!window.confirm(`Disconnect ${account.address}? ${detail} Your mail stays where it is and keeps working in Gmail / Outlook.`)) return;
    setBusy(account.id);
    try {
      await accountsApi.disconnect(account.id);
      toast.success("Account disconnected");
      onChanged && onChanged();
    } catch (err) {
      setError(errorInfo(err).message);
    } finally {
      setBusy(null);
    }
  }

  async function rename(account) {
    const name = window.prompt("Display name for this account", account.displayName || "");
    if (name === null) return;
    try {
      await accountsApi.update(account.id, { displayName: name });
      onChanged && onChanged();
    } catch (err) {
      setError(errorInfo(err).message);
    }
  }

  return (
    <div className="em-compose-backdrop" role="presentation">
      <div className="em-settings em-manage" role="dialog" aria-modal="true" aria-label="Manage email accounts">
        <header className="em-compose-header">
          <h2>Email accounts</h2>
          <button type="button" className="em-icon-btn" aria-label="Close" onClick={onClose}><FaTimes /></button>
        </header>
        <div className="em-settings-body">
          {accounts.length === 0 && <p className="em-muted">No accounts connected yet.</p>}
          <ul className="em-manage-list">
            {accounts.map((a) => {
              const Icon = a.provider === "google" ? FaGoogle : FaMicrosoft;
              const reconnectNeeded = a.status !== "connected";
              return (
                <li key={a.id} className="em-manage-item">
                  <span className="em-account-dot" style={{ background: a.color }} aria-hidden="true" />
                  <Icon aria-hidden="true" />
                  <div className="em-manage-text">
                    <strong>{a.address}</strong>
                    <span className="em-muted">{a.kindLabel}{a.displayName ? ` - ${a.displayName}` : ""}</span>
                    {reconnectNeeded ? (
                      <span className="em-state-line em-state-bad"><FaExclamationTriangle aria-hidden="true" /> Needs to be reconnected. {a.lastError ? "Your sign-in expired or was revoked." : ""}</span>
                    ) : a.syncError ? (
                      <span className="em-state-line em-state-bad"><FaExclamationTriangle aria-hidden="true" /> Checking for new mail is failing ({a.syncError}). It will keep retrying.</span>
                    ) : (
                      <span className="em-state-line em-state-ok">Connected{a.lastSyncAt ? ` - last checked ${formatFullDate(a.lastSyncAt)}` : ""}</span>
                    )}
                  </div>
                  <div className="em-manage-actions">
                    <button type="button" className={`em-btn em-btn-small ${reconnectNeeded ? "em-btn-primary" : ""}`} disabled={busy === a.id} onClick={() => reconnect(a)}><FaSyncAlt /> {reconnectNeeded ? "Reconnect" : "Re-authorise"}</button>
                    <button type="button" className="em-btn em-btn-small" disabled={busy === a.id} onClick={() => rename(a)}><FaPen /> Rename</button>
                    <button type="button" className="em-btn em-btn-small em-btn-danger" disabled={busy === a.id} onClick={() => disconnect(a)}><FaUnlink /> Disconnect</button>
                  </div>
                </li>
              );
            })}
          </ul>

          <div>
            <button type="button" className="em-btn" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>{adding ? "Cancel" : "Add another account"}</button>
            {adding && (
              <div className="em-manage-add">
                <ProviderChoices providers={providers} portal={portal} onError={setError} busyProvider={busyProvider} setBusyProvider={setBusyProvider} />
              </div>
            )}
          </div>
          {error && <p className="em-compose-error" role="alert"><FaExclamationTriangle /> {error}</p>}
          <ConsentNotes />
        </div>
      </div>
    </div>
  );
}

export default ManageAccounts;
