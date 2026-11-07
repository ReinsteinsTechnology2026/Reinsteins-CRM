import { useEffect, useMemo } from "react";
import { FaLock } from "react-icons/fa";

import { getVaultSession } from "../../vault/vaultRuntime";
import { useActivityTouch, useVaultState } from "../../vault/useVault";
import { RecoveryStep, VaultSetup, VaultUnlock } from "./VaultGate";
import VaultApp from "./VaultApp";
import "./Vault.css";

// The route component for /<portal>/ziovault. The session itself is app-wide (see vault/vaultRuntime.js), so leaving this page does
// not lock the vault; the inactivity timer, "Lock vault" and signing out do.
export default function VaultPage() {
  const session = useMemo(() => getVaultSession(), []);
  const state = useVaultState(session);

  useEffect(() => {
    if (state.status === "idle" && !state.error) session.init();
  }, [session, state.status, state.error]);

  useActivityTouch(session, state.status === "unlocked");

  let body;
  if (state.status === "loading" || (state.status === "idle" && !state.error)) body = <div className="zv-gate"><p className="zv-lead" role="status">Loading your vault…</p></div>;
  else if (state.status === "disabled") body = <div className="zv-gate"><div className="zv-gate-card"><div className="zv-gate-icon"><FaLock /></div><h1>ZioVault is not enabled</h1><p className="zv-lead">Ask your administrator to enable ZioVault for your company.</p></div></div>;
  else if (state.status === "idle") body = <div className="zv-gate"><div className="zv-gate-card"><h1>ZioVault could not load</h1><p className="zv-error" role="alert" data-testid="vault-error">{state.error}</p><button type="button" className="zv-btn" onClick={() => session.init()}>Try again</button></div></div>;
  else if (state.status === "no-account") body = <VaultSetup session={session} state={state} />;
  else if (state.status === "setup-recovery") body = <RecoveryStep session={session} state={state} />;
  else if (state.status === "locked") body = <VaultUnlock session={session} state={state} />;
  else body = <VaultApp session={session} state={state} />;

  return <div className="zv-page" data-testid="vault-page" data-status={state.status}>{body}</div>;
}
