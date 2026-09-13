import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FaEye, FaEyeSlash, FaEnvelope, FaLock, FaShieldAlt } from "react-icons/fa";
import { toast } from "react-toastify";

import platformApi from "../../services/platformApi";
import "../../styles/platformTheme.css";
import "./PlatformLogin.css";

// ==========================================
// PLATFORM OWNER LOGIN (Phase 4, extended Phase 14D)
//
// Uses the existing POST /api/platform/auth/login endpoint --
// entirely separate from the tenant login (Auth/Login.jsx) and the
// existing Reinsteins portal. Stores its own token under
// "platformToken"/"platformUser", never touching "token"/"user".
//
// Phase 14: when the account has 2FA enabled, /login returns
// {requiresTwoFactor: true, twoFactorToken} instead of a real session
// token -- this component then shows a second step (TOTP or backup
// code) and calls POST /auth/verify-2fa to complete the login. An
// account without 2FA enabled sees no change at all to this flow.
// ==========================================

function PlatformLogin() {
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const [stage, setStage] = useState("credentials"); // "credentials" | "twoFactor"
  const [twoFactorToken, setTwoFactorToken] = useState(null);
  const [code, setCode] = useState("");

  const completeLogin = (token, platformUser) => {
    sessionStorage.setItem("platformToken", token);
    sessionStorage.setItem("platformUser", JSON.stringify(platformUser));
    toast.success("Welcome back");
    navigate("/owner/dashboard", { replace: true });
  };

  const handleLogin = async (event) => {
    event.preventDefault();

    if (!email.trim() || !password) {
      toast.error("Please enter your email and password");
      return;
    }

    try {
      setLoading(true);

      const response = await platformApi.post("/auth/login", {
        email: email.trim(),
        password,
      });

      if (response.data.requiresTwoFactor) {
        setTwoFactorToken(response.data.twoFactorToken);
        setStage("twoFactor");
        return;
      }

      const { token, platformUser } = response.data;
      if (!token || !platformUser) {
        throw new Error("Invalid login response");
      }
      completeLogin(token, platformUser);

    } catch (error) {
      const message =
        error.response?.data?.message ||
        error.message ||
        "Unable to log in. Please try again.";

      toast.error(message);

    } finally {
      setLoading(false);
    }
  };

  const handleVerifyTwoFactor = async (event) => {
    event.preventDefault();

    if (!code.trim()) {
      toast.error("Enter your authenticator code or a backup code");
      return;
    }

    try {
      setLoading(true);

      const response = await platformApi.post("/auth/verify-2fa", {
        twoFactorToken,
        code: code.trim(),
      });

      const { token, platformUser } = response.data;
      if (!token || !platformUser) {
        throw new Error("Invalid verification response");
      }
      completeLogin(token, platformUser);

    } catch (error) {
      const message = error.response?.data?.message || "Invalid or expired code.";
      toast.error(message);
      if (error.response?.status === 401 && /expired/i.test(message)) {
        setStage("credentials");
        setTwoFactorToken(null);
        setCode("");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="platform-shell platform-login-page">

      <div className="platform-login-panel">

        <div className="platform-login-brand">
          <span className="platform-wordmark">
            <span className="brand-zio">Zio</span><span className="brand-venture">Venture</span>
          </span>
          <p>Platform Administration</p>
        </div>

        <div className="platform-login-card">

          {stage === "credentials" && (
            <>
              <div className="platform-login-header">
                <h1>Platform Owner Sign In</h1>
                <p>Manage companies, provisioning, and access across ZioVenture.</p>
              </div>

              <form onSubmit={handleLogin}>

                <div className="platform-form-group">
                  <label htmlFor="platform-email">Email</label>
                  <div className="platform-input-container">
                    <FaEnvelope className="platform-input-icon" />
                    <input
                      id="platform-email"
                      type="email"
                      placeholder="you@zioventure.com"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      autoComplete="username"
                    />
                  </div>
                </div>

                <div className="platform-form-group">
                  <label htmlFor="platform-password">Password</label>
                  <div className="platform-input-container">
                    <FaLock className="platform-input-icon" />
                    <input
                      id="platform-password"
                      type={showPassword ? "text" : "password"}
                      placeholder="Enter your password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="current-password"
                    />
                    <button
                      type="button"
                      className="platform-password-toggle"
                      onClick={() => setShowPassword((current) => !current)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? <FaEyeSlash /> : <FaEye />}
                    </button>
                  </div>
                </div>

                <button type="submit" className="platform-login-button" disabled={loading}>
                  {loading ? "Signing In..." : "Sign In"}
                </button>

              </form>
            </>
          )}

          {stage === "twoFactor" && (
            <>
              <div className="platform-login-header">
                <h1><FaShieldAlt style={{ marginRight: 8, verticalAlign: -2 }} />Two-Factor Verification</h1>
                <p>Enter the 6-digit code from your authenticator app, or one of your backup codes.</p>
              </div>

              <form onSubmit={handleVerifyTwoFactor}>
                <div className="platform-form-group">
                  <label htmlFor="platform-2fa-code">Verification Code</label>
                  <div className="platform-input-container">
                    <FaShieldAlt className="platform-input-icon" />
                    <input
                      id="platform-2fa-code"
                      type="text"
                      placeholder="123456 or XXXXX-XXXXX"
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      autoComplete="one-time-code"
                      autoFocus
                    />
                  </div>
                </div>

                <button type="submit" className="platform-login-button" disabled={loading}>
                  {loading ? "Verifying..." : "Verify & Sign In"}
                </button>

                <button
                  type="button"
                  className="platform-login-button"
                  style={{ marginTop: 10, background: "transparent", color: "var(--p-text-secondary, #64748B)", border: "1px solid var(--p-border, #E2E8F0)" }}
                  onClick={() => { setStage("credentials"); setTwoFactorToken(null); setCode(""); }}
                >
                  Back
                </button>
              </form>
            </>
          )}

          <div className="platform-login-footer">
            <p>This portal is for the ZioVenture Platform Owner only.</p>
            <span>Company accounts should use their own tenant login.</span>
          </div>

        </div>

      </div>

    </div>
  );
}

export default PlatformLogin;
