import { useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { FaCheckCircle, FaEye, FaEyeSlash, FaLock, FaRegCircle } from "react-icons/fa";

import CompanyLogo from "../../components/Common/CompanyLogo";
import ZioVentureLogo from "../../components/Common/ZioVentureLogo";
import api from "../../services/api";
import { fetchDeployedBuildId, reloadForNewBuild } from "../../utils/buildVersion";
import {
  clearPendingPasswordChange,
  evaluatePasswordRules,
  readPendingPasswordChange,
} from "../../utils/passwordChangeFlow";
import "./Login.css";
import "./ChangePassword.css";

// ==========================================
// MANDATORY FIRST-LOGIN PASSWORD CHANGE
//
// Reached only from the login page, when the server answered a correct temporary password with
// `passwordChangeRequired` and a short-lived challenge token (no session). The challenge is kept
// in sessionStorage under its OWN key, never under "token", so nothing in the app can mistake it
// for a session: every protected route still sees "not signed in" until this succeeds.
//
// All real enforcement is on the server (utils/passwordChangeChallenge.js,
// services/forcedPasswordChangeService.js); this page only collects the passwords and shows the
// server's rules and answers. The user being changed is whoever the challenge belongs to -- the
// form has no field that could name anyone else.
// ==========================================

function PasswordField({ label, value, onChange, autoComplete, visible, onToggle, placeholder, id }) {
  return (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <div className="input-container">
        <FaLock className="input-icon" />
        <input
          id={id}
          type={visible ? "text" : "password"}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
        />
        <button
          type="button"
          className="password-toggle"
          onClick={onToggle}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        >
          {visible ? <FaEyeSlash /> : <FaEye />}
        </button>
      </div>
    </div>
  );
}

function ChangePassword() {
  const navigate = useNavigate();
  const { companySlug } = useParams();

  const loginPath = companySlug ? `/${companySlug}/login` : "/legacy-login";

  // Read once. A refresh keeps working (sessionStorage), an expired challenge is detected by the
  // server on submit, and a missing/foreign one sends the user back to sign in.
  const pending = useMemo(() => readPendingPasswordChange(), []);

  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [visible, setVisible] = useState({ temporary: false, next: false, confirm: false });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const rules = useMemo(
    () => evaluatePasswordRules(newPassword, pending?.passwordPolicy),
    [newPassword, pending]
  );

  // No pending change, or one that belongs to a different company than this URL: not a place the
  // user can be, so send them to sign in (never to a dashboard).
  if (!pending || (pending.companySlug || null) !== (companySlug || null)) {
    return <Navigate to={loginPath} replace />;
  }

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const ready =
    temporaryPassword.length > 0 &&
    rules.every((rule) => rule.met) &&
    confirmPassword.length > 0 &&
    !mismatch &&
    !submitting;

  const backToSignIn = () => {
    clearPendingPasswordChange();
    navigate(loginPath, { replace: true });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!ready) return;

    setError("");
    setSubmitting(true);

    try {
      // The request interceptor adds the session token when there is one; there must not be one
      // here, otherwise it would replace the challenge in the Authorization header.
      sessionStorage.removeItem("token");
      sessionStorage.removeItem("user");
      sessionStorage.removeItem("company");

      const response = await api.post(
        companySlug ? `/tenant-auth/${companySlug}/force-change-password` : "/auth/force-change-password",
        { temporaryPassword, newPassword, confirmPassword },
        { headers: { Authorization: `Bearer ${pending.challengeToken}` } }
      );

      const { token, user, company } = response.data;

      if (!token || !user) {
        throw new Error("Invalid response");
      }

      sessionStorage.setItem("token", token);
      sessionStorage.setItem("user", JSON.stringify(user));

      if (companySlug && (company || pending.company)) {
        sessionStorage.setItem("company", JSON.stringify(company || pending.company));
      } else {
        sessionStorage.removeItem("company");
      }

      clearPendingPasswordChange();
      toast.success("Password changed successfully");

      const adminPath = companySlug ? `/${companySlug}/admin` : "/admin";
      const employeePath = companySlug ? `/${companySlug}/employee` : "/employee";
      const deployedBuildId = await fetchDeployedBuildId();

      if (user.role === "admin") {
        navigate(adminPath, { replace: true });
      } else if (user.role === "employee") {
        navigate(employeePath, { replace: true });
      } else {
        sessionStorage.removeItem("token");
        sessionStorage.removeItem("user");
        sessionStorage.removeItem("company");
        navigate(loginPath, { replace: true });
        return;
      }

      reloadForNewBuild(deployedBuildId);
    } catch (err) {
      const code = err.response?.data?.code;

      // The challenge is expired, spent or invalid: nothing more can be done on this page.
      if (code === "CHALLENGE_EXPIRED" || code === "CHALLENGE_INVALID") {
        clearPendingPasswordChange();
        toast.error(err.response?.data?.message || "Your password-change session has ended. Please sign in again.");
        navigate(loginPath, { replace: true });
        return;
      }

      setError(err.response?.data?.message || "Unable to change the password. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const brandName = companySlug ? pending.company?.name || "ZioVenture" : "Reinsteins WorkHub";

  return (
    <div className="login-page">
      <div className="login-brand-section">
        <div className="brand-content">
          <div className="brand-logo">{companySlug ? <ZioVentureLogo size={90} /> : <CompanyLogo size={90} />}</div>
          <h1>{brandName}</h1>
          <p>Your account is almost ready. Choose a personal password to keep your workspace secure.</p>
        </div>
      </div>

      <div className="login-form-section">
        <div className="login-card">
          <div className="login-header">
            <h2>Set Your New Password</h2>
            <p>
              {pending.fullName ? `Welcome, ${pending.fullName}. ` : ""}
              The password your company gave you is temporary. You must replace it before you can use the
              workspace.
            </p>
          </div>

          {error && (
            <p className="change-password-error" role="alert">
              {error}
            </p>
          )}

          <form onSubmit={handleSubmit} noValidate>
            <PasswordField
              id="cp-temporary"
              label="Temporary Password"
              placeholder="The password you were given"
              value={temporaryPassword}
              onChange={setTemporaryPassword}
              autoComplete="current-password"
              visible={visible.temporary}
              onToggle={() => setVisible((v) => ({ ...v, temporary: !v.temporary }))}
            />

            <PasswordField
              id="cp-new"
              label="New Password"
              placeholder="Choose a new password"
              value={newPassword}
              onChange={setNewPassword}
              autoComplete="new-password"
              visible={visible.next}
              onToggle={() => setVisible((v) => ({ ...v, next: !v.next }))}
            />

            <ul className="change-password-rules" aria-label="Password requirements">
              {rules.map((rule) => (
                <li key={rule.key} className={rule.met ? "met" : ""}>
                  {rule.met ? <FaCheckCircle aria-hidden="true" /> : <FaRegCircle aria-hidden="true" />}
                  <span>{rule.label}</span>
                </li>
              ))}
            </ul>

            <PasswordField
              id="cp-confirm"
              label="Confirm New Password"
              placeholder="Re-enter the new password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              autoComplete="new-password"
              visible={visible.confirm}
              onToggle={() => setVisible((v) => ({ ...v, confirm: !v.confirm }))}
            />

            {mismatch && (
              <p className="change-password-hint change-password-hint-error" role="alert">
                The new password and confirmation do not match.
              </p>
            )}

            <button type="submit" className="login-button change-password-submit" disabled={!ready}>
              {submitting ? "Saving..." : "Change Password"}
            </button>

            <button type="button" className="change-password-back" onClick={backToSignIn} disabled={submitting}>
              Back to sign in
            </button>
          </form>

          <div className="login-footer">
            <p>{companySlug ? pending.company?.name || "ZioVenture" : "Reinsteins Technology"}</p>
            <span>Secure Employee Portal</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ChangePassword;
