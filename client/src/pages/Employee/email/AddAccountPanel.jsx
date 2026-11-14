import { useState } from "react";
import { FaGoogle, FaMicrosoft, FaExclamationTriangle, FaCheckCircle, FaShieldAlt } from "react-icons/fa";

import { accounts, errorInfo } from "./emailApi";

// ==========================================
// ADD AN EMAIL ACCOUNT -- the employee connects their OWN existing Gmail, Google Workspace, Outlook.com / Hotmail or Microsoft 365
// account. Nothing is created, licensed or hosted by ZioVenture and no company domain is needed.
//
// The employee signs in on GOOGLE's or MICROSOFT's own page and chooses what to allow. ZioVenture never sees a password; it receives
// a token that can be revoked at any time (here with "Disconnect", or in the Google / Microsoft account settings). Administrators
// can see that an account is connected, never its mail. This is separate from the ZioVenture password, which keeps its own
// temporary-password / first-login flow.
// ==========================================

// Starts the provider sign-in (a new account, or a reconnect when `accountId` is given) by handing the browser to the provider.
export async function startConnect({ provider, portal, accountId }) {
  const result = await accounts.connect(provider, portal, accountId);
  window.location.assign(result.authorizationUrl);
}

const CHOICES = [
  {
    provider: "google",
    icon: FaGoogle,
    title: "Gmail or Google Workspace",
    body: "A personal Gmail account, or a work or school account that uses Google Workspace.",
    button: "Connect with Google",
  },
  {
    provider: "microsoft",
    icon: FaMicrosoft,
    title: "Outlook.com, Hotmail or Microsoft 365",
    body: "A personal Outlook.com / Hotmail / Live account, or a Microsoft 365 work or school account.",
    button: "Connect with Microsoft",
  },
];

export function ProviderChoices({ providers, portal, onError, accountId, only, busyProvider, setBusyProvider }) {
  async function go(provider) {
    setBusyProvider(provider);
    try {
      await startConnect({ provider, portal, accountId });
    } catch (error) {
      onError(errorInfo(error).message);
      setBusyProvider(null);
    }
  }
  return (
    <div className="em-choices">
      {CHOICES.filter((c) => !only || c.provider === only).map(({ provider, icon: Icon, title, body, button }) => {
        const status = providers && providers[provider];
        const ready = !status || status.configured;
        return (
          <div key={provider} className="em-choice">
            <span className="em-connect-icon" aria-hidden="true"><Icon /></span>
            <h3>{title}</h3>
            <p>{body}</p>
            <button type="button" className="em-btn em-btn-primary" disabled={!ready || Boolean(busyProvider)} onClick={() => go(provider)}>
              <Icon aria-hidden="true" /> {busyProvider === provider ? "Opening sign-in..." : button}
            </button>
            {!ready && <p className="em-muted em-fineprint" role="note">Not available yet: {provider === "google" ? "Google" : "Microsoft"} sign-in has not been set up on this server. Your administrator or the platform owner needs to finish that setup.</p>}
          </div>
        );
      })}
    </div>
  );
}

export function ConsentNotes() {
  return (
    <>
      <p className="em-muted em-fineprint">
        <FaShieldAlt aria-hidden="true" /> You sign in on Google&apos;s or Microsoft&apos;s own page and choose what to allow. ZioVenture never sees your password.
        Your mail stays with your provider; your Gmail or Outlook keeps working and notifying you as usual. Your administrator can see that an account is connected, but cannot read your mail.
        You can disconnect at any time. Your ZioVenture password is separate.
      </p>
      <details className="em-help">
        <summary>Having trouble connecting?</summary>
        <ul>
          <li><strong>Google says the app is not verified:</strong> while ZioVenture&apos;s Google app is in testing, Google shows a warning and only approved test users can continue. Ask your platform owner to add you or finish Google&apos;s verification.</li>
          <li><strong>A Google Workspace or Microsoft 365 work account is blocked:</strong> your organisation&apos;s administrator may restrict third-party apps. They need to allow ZioVenture once, then you can try again.</li>
          <li><strong>You unticked a permission:</strong> reading and sending mail needs the mail permission. Connect again and keep the mail permission ticked.</li>
          <li><strong>Gmail cannot delete forever from here:</strong> deleted Gmail messages move to Trash and Gmail empties it after 30 days.</li>
        </ul>
      </details>
    </>
  );
}

function AddAccountPanel({ providers, portal, banner, hasAccounts = false }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");
  return (
    <div className="em-connect">
      {banner && (
        <p className={`em-banner ${banner.kind === "ok" ? "em-banner-ok" : "em-banner-error"}`} role={banner.kind === "ok" ? "status" : "alert"}>
          {banner.kind === "ok" ? <FaCheckCircle /> : <FaExclamationTriangle />} {banner.text}
        </p>
      )}
      <div className="em-connect-card em-connect-wide">
        <h2>{hasAccounts ? "Add another email account" : "Connect your email"}</h2>
        <p>Read and send mail from your own Gmail, Outlook or Microsoft 365 account inside ZioVenture, all in one place. You can connect several accounts and switch between them.</p>
        <ProviderChoices providers={providers} portal={portal} onError={setError} busyProvider={busy} setBusyProvider={setBusy} />
        {error && <p className="em-compose-error" role="alert"><FaExclamationTriangle /> {error}</p>}
        <ConsentNotes />
      </div>
    </div>
  );
}

export default AddAccountPanel;
