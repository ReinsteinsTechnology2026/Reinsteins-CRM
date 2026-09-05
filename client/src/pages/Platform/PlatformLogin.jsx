import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FaEye, FaEyeSlash, FaEnvelope, FaLock } from "react-icons/fa";
import { toast } from "react-toastify";

import platformApi from "../../services/platformApi";
import "../../styles/platformTheme.css";
import "./PlatformLogin.css";

// ==========================================
// PLATFORM OWNER LOGIN (Phase 4)
//
// Uses the existing POST /api/platform/auth/login endpoint --
// entirely separate from the tenant login (Auth/Login.jsx) and the
// existing Reinsteins portal. Stores its own token under
// "platformToken"/"platformUser", never touching "token"/"user".
// ==========================================

function PlatformLogin() {
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

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

      const { token, platformUser } = response.data;

      if (!token || !platformUser) {
        throw new Error("Invalid login response");
      }

      sessionStorage.setItem("platformToken", token);
      sessionStorage.setItem("platformUser", JSON.stringify(platformUser));

      toast.success("Welcome back");
      navigate("/platform/dashboard", { replace: true });

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
