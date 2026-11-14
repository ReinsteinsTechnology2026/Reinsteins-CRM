import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { FaEnvelope } from "react-icons/fa";

import { accounts as accountsApi, errorInfo } from "./email/emailApi";
import { subscribeEmailEvents } from "../../services/emailEvents";
import AddAccountPanel from "./email/AddAccountPanel";
import EmailClient from "./email/EmailClient";

import "./EmployeeEmail.css";
import "./email/emailClient.css";

// ==========================================
// EMAIL -- one place for ALL of the employee's own email accounts.
//
// Every employee (and every admin who wants it) connects their EXISTING Gmail, Google Workspace, Outlook.com / Hotmail or
// Microsoft 365 account; nothing is created, licensed or hosted by ZioVenture and no company domain is needed. The page asks the
// server for the employee's own connected accounts and shows either "connect your email" (none yet) or the mail client (one or more).
// Access is checked on the server for every call; nothing here is trusted for access.
//
// Coming back from Google / Microsoft sign-in the URL carries ?ea=connected or ?ea=error&reason=<code>. Only a short code is ever
// passed, never the provider's own error text.
// ==========================================

const REASONS = {
  denied: "The sign-in was cancelled. You can try again whenever you like.",
  admin_consent_required: "Your organisation requires an administrator to approve ZioVenture before it can connect. Ask your IT administrator to approve it, then try again.",
  insufficient_scopes: "Reading and sending mail needs the mail permission. Connect again and keep the mail permission ticked.",
  wrong_account: "You signed in with a different account than the one you are reconnecting. Sign in with the same account.",
  identity_failed: "The provider did not confirm a verified email address for this account.",
  invalid_state: "That sign-in link has expired or was already used. Start again.",
  invalid_code: "The provider did not complete the sign-in. Start again.",
  no_refresh_token: "The provider did not grant ongoing access. Connect again and accept the permissions.",
  account_limit: "You have reached the maximum number of connected accounts. Disconnect one to add another.",
  not_configured: "This provider's sign-in has not been set up on this server yet.",
  failed: "The sign-in could not be completed. Try again, or ask your administrator.",
};

function EmployeeEmail() {
  const location = useLocation();
  const navigate = useNavigate();
  const portal = location.pathname.includes("/admin") ? "admin" : "employee";

  const [state, setState] = useState({ accounts: [], providers: null });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [banner, setBanner] = useState(null);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const result = await accountsApi.list();
      setState({ accounts: result.accounts || [], providers: result.providers || null });
      setMessage("");
    } catch (error) {
      const info = errorInfo(error);
      if (info.status === 401) setMessage("Business email is only available when signed in through your company's own login link.");
      else if (info.code === "FEATURE_NOT_ENABLED") setMessage("Company Email is not enabled for your organization.");
      else setMessage(info.message || "Unable to load your email accounts right now.");
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  // Read the result of a provider sign-in once, then clean the URL so a refresh does not repeat the message.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const result = params.get("ea");
    if (result) {
      if (result === "connected") setBanner({ kind: "ok", text: "Account connected." });
      else setBanner({ kind: "error", text: REASONS[params.get("reason")] || REASONS.failed });
      navigate(location.pathname, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeEmailEvents((name) => { if (name !== "email:new") load(); }), [load]);

  // The mail client calls this when a provider says the sign-in is gone, or an account is no longer available.
  const handleProblem = useCallback(() => { load(); }, [load]);

  return (
    <div className="employee-email-page em-page">
      <div className="employee-email-header">
        <FaEnvelope aria-hidden="true" />
        <h1>Email</h1>
      </div>

      {loading && <p className="employee-email-hint" role="status">Loading your email accounts...</p>}
      {!loading && message && <p className="employee-email-hint" role="alert">{message}</p>}

      {!loading && !message && state.accounts.length === 0 && (
        <AddAccountPanel providers={state.providers} portal={portal} banner={banner} />
      )}

      {!loading && !message && state.accounts.length > 0 && (
        <>
          {banner && <p className={`em-banner ${banner.kind === "ok" ? "em-banner-ok" : "em-banner-error"}`} role="status">{banner.text}</p>}
          <EmailClient accounts={state.accounts} providers={state.providers} portal={portal} onAccountsChanged={load} onProblem={handleProblem} />
        </>
      )}
    </div>
  );
}

export default EmployeeEmail;
