import { useState } from "react";
import { FaMicrosoft, FaEnvelope, FaExclamationTriangle, FaCheckCircle, FaSyncAlt } from "react-icons/fa";

import { connection, errorInfo } from "./emailApi";

// ==========================================
// CONNECT PANEL -- what an employee sees until their company mailbox is usable.
//
// One clear message per state (the server decides the state, see msEmailService.employeeStatus):
//   no_mailbox / not_linked / company_not_connected / mailbox_disabled / server_not_configured  -> a person has to act (the admin)
//   disconnected  -> "Connect your Microsoft account"
//   reauth_required -> "Reconnect" (the Microsoft sign-in expired or was revoked)
// The employee signs in on MICROSOFT's own page. ZioVenture never sees or stores a Microsoft password, and a ZioVenture
// password is never used for the mailbox.
// ==========================================

const COPY = {
  no_mailbox: {
    title: "You don't have a company mailbox yet",
    body: "Ask your administrator to set one up for you in Settings > Business Email.",
  },
  not_linked: {
    title: "Your mailbox is not linked to Microsoft 365 yet",
    body: "Your administrator needs to link your mailbox to your company's Microsoft 365 organisation first.",
  },
  company_not_connected: {
    title: "Your company has not connected Microsoft 365 yet",
    body: "Ask your administrator to connect your company's Microsoft 365 organisation in Settings > Business Email.",
  },
  mailbox_disabled: {
    title: "Your mailbox is disabled",
    body: "Your administrator has turned this mailbox off. Contact them if you need it back.",
  },
  server_not_configured: {
    title: "Microsoft sign-in is not set up on this server",
    body: "A platform administrator must register the ZioVenture app with Microsoft before email can be connected. Nothing is wrong with your account.",
  },
};

function ConnectPanel({ status, portal, onRefresh, banner }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const state = status?.state;
  const address = status?.mailbox?.address;

  async function connect() {
    setBusy(true);
    setError("");
    try {
      const result = await connection.begin(portal);
      // Hand the browser to Microsoft. The sign-in (and any consent prompt) happens entirely on microsoft's own page.
      window.location.assign(result.authorizationUrl);
    } catch (err) {
      setError(errorInfo(err).message);
      setBusy(false);
    }
  }

  const info = COPY[state];
  return (
    <div className="em-connect">
      {banner && (
        <p className={`em-banner ${banner.kind === "ok" ? "em-banner-ok" : "em-banner-error"}`} role={banner.kind === "ok" ? "status" : "alert"}>
          {banner.kind === "ok" ? <FaCheckCircle /> : <FaExclamationTriangle />} {banner.text}
        </p>
      )}

      <div className="em-connect-card">
        <div className="em-connect-icon" aria-hidden="true">{info ? <FaEnvelope /> : <FaMicrosoft />}</div>

        {info && (
          <>
            <h2>{info.title}</h2>
            <p>{info.body}</p>
            {address && <p className="em-muted">Mailbox: <strong>{address}</strong></p>}
            <button type="button" className="em-btn" onClick={onRefresh}><FaSyncAlt /> Check again</button>
          </>
        )}

        {(state === "disconnected" || state === "reauth_required") && (
          <>
            <h2>{state === "reauth_required" ? "Reconnect your Microsoft account" : "Connect your Microsoft account"}</h2>
            <p>
              {state === "reauth_required"
                ? "Your Microsoft sign-in expired or was removed, so your mail is paused. Sign in again to continue where you left off."
                : "Sign in with your Microsoft 365 work account to read and send company email here."}
            </p>
            {address && <p className="em-muted">You will be asked to sign in as <strong>{address}</strong>.</p>}
            <button type="button" className="em-btn em-btn-primary" onClick={connect} disabled={busy}>
              <FaMicrosoft /> {busy ? "Opening Microsoft..." : state === "reauth_required" ? "Reconnect with Microsoft" : "Connect with Microsoft"}
            </button>
            <p className="em-muted em-fineprint">
              You sign in on Microsoft&apos;s own page. ZioVenture never sees or stores your Microsoft password, and your ZioVenture password is
              separate. You can disconnect at any time.
            </p>
            {status?.connection?.lastError && state === "reauth_required" && <p className="em-muted em-fineprint">Last problem: {status.connection.lastError}</p>}
          </>
        )}

        {error && <p className="em-compose-error" role="alert"><FaExclamationTriangle /> {error}</p>}
      </div>
    </div>
  );
}

export default ConnectPanel;
