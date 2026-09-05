import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import CompanyLogo from "../../components/Common/CompanyLogo";
import {
  FaEye,
  FaEyeSlash,
  FaUser,
  FaLock,
} from "react-icons/fa";

import { toast } from "react-toastify";

import api from "../../services/api";
import "./Login.css";

// ==========================================
// COMPANY-AWARE LOGIN (Phase 5)
//
// This single component now serves BOTH the legacy login ("/") and
// the new company-aware login ("/:companySlug/login") -- useParams()
// picks up companySlug automatically when rendered under the
// company-scoped route. companySlug is always undefined at "/",
// so every branch below falls through to the EXACT original
// behavior (POST /api/auth/login, redirect to /admin or /employee)
// when there isn't one -- the legacy path is byte-identical to
// before this phase.
//
// When companySlug IS present: posts to
// POST /api/tenant-auth/:companySlug/login instead (the slug comes
// only from the URL param -- never from a form field or anything
// user-editable), and redirects to /:companySlug/admin or
// /:companySlug/employee. The returned token is stored under the
// SAME "token"/"user" keys the legacy path already uses -- safe
// because the backend's `protect` middleware already accepts both
// token shapes (it tries the legacy secret first, falls back to
// tenant verification), so every existing page/service that calls
// services/api.js keeps working completely unmodified for a
// company-aware session too.
// ==========================================

function Login() {
  const navigate = useNavigate();
  const { companySlug } = useParams();

  const [employeeId, setEmployeeId] =
    useState("");

  const [password, setPassword] =
    useState("");

  const [
    showPassword,
    setShowPassword,
  ] = useState(false);

  const [loading, setLoading] =
    useState(false);

  const [companyInfo, setCompanyInfo] = useState(null);
  const [companyInfoError, setCompanyInfoError] = useState(false);

  // ==========================================
  // COMPANY BRANDING (Phase 5 foundation)
  // Public, unauthenticated lookup -- company name only for now.
  // logoUrl is always null until a future phase adds real logo
  // storage; this component already renders it when present.
  // ==========================================

  useEffect(() => {
    if (!companySlug) return;

    let cancelled = false;

    api.get(`/tenant-auth/${companySlug}/info`)
      .then((response) => {
        if (!cancelled) setCompanyInfo(response.data.company);
      })
      .catch(() => {
        if (!cancelled) setCompanyInfoError(true);
      });

    return () => { cancelled = true; };
  }, [companySlug]);

  // ==========================================
  // LOGIN
  // ==========================================

  const handleLogin = async (event) => {
    event.preventDefault();

    if (
      !employeeId.trim() ||
      !password
    ) {
      toast.error(
        "Please enter Employee ID and password"
      );

      return;
    }

    try {
      setLoading(true);

      const response = companySlug
        ? await api.post(
          `/tenant-auth/${companySlug}/login`,
          {
            employeeId: employeeId.trim(),
            password,
          }
        )
        : await api.post(
          "/auth/login",
          {
            employeeId:
              employeeId.trim(),

            password,
          }
        );

      const {
        token,
        user,
      } = response.data;

      // ======================================
      // VALIDATE LOGIN RESPONSE
      // ======================================

      if (
        !token ||
        !user
      ) {
        throw new Error(
          "Invalid login response"
        );
      }

      // ======================================
      // SAVE LOGIN SESSION
      // ======================================

      sessionStorage.setItem(
        "token",
        token
      );

      sessionStorage.setItem(
        "user",
        JSON.stringify(
          user
        )
      );

      toast.success(
        "Login successful"
      );

      // ======================================
      // REDIRECT BASED ON ROLE
      // ======================================

      const adminPath = companySlug ? `/${companySlug}/admin` : "/admin";
      const employeePath = companySlug ? `/${companySlug}/employee` : "/employee";

      if (
        user.role ===
        "admin"
      ) {
        navigate(
          adminPath,
          {
            replace: true,
          }
        );

        return;
      }

      if (
        user.role ===
        "employee"
      ) {
        navigate(
          employeePath,
          {
            replace: true,
          }
        );

        return;
      }

      // ======================================
      // INVALID ROLE
      // ======================================

      sessionStorage.removeItem(
        "token"
      );

      sessionStorage.removeItem(
        "user"
      );

      toast.error(
        "Invalid user role"
      );

    } catch (error) {
      console.error(
        "Login Error:",
        error
      );

      const message =
        error.response?.data?.message ||
        error.message ||
        "Unable to login. Please try again.";

      toast.error(
        message
      );

    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">

      <div className="login-brand-section">

        <div className="brand-content">

          <div className="brand-logo">

  {companySlug ? (
    companyInfo?.logoUrl ? (
      <img src={companyInfo.logoUrl} alt={companyInfo.name} width={90} height={90} style={{ borderRadius: 16, objectFit: "cover" }} />
    ) : (
      // Default ZioVenture branding -- used until a future phase adds
      // real per-company logo storage (Phase 5 explicitly does not
      // build that yet; companyInfo.logoUrl is always null today).
      <div className="groworgs-fallback-mark" aria-hidden="true">Zi</div>
    )
  ) : (
    <CompanyLogo size={90} />
  )}

</div>

          <h1>
            {companySlug
              ? (companyInfo?.name || "ZioVenture")
              : "Reinsteins WorkHub"}
          </h1>

          <p>
            {companySlug
              ? `A centralized workspace for ${companyInfo?.name || "your company"} — powered by ZioVenture.`
              : "A centralized workspace for employees, attendance, productivity, and company operations."}
          </p>

        </div>

      </div>

      <div className="login-form-section">

        <div className="login-card">

          <div className="login-header">

            <h2>
              Welcome Back
            </h2>

            <p>
              {companySlug
                ? `Sign in to ${companyInfo?.name || "your company"}'s workspace`
                : "Sign in to continue to your workspace"}
            </p>

          </div>

          {companySlug && companyInfoError && (
            <p style={{ color: "#D64545", fontSize: 13.5, marginBottom: 18 }}>
              This company could not be found. Please check the link you used, or contact your administrator.
            </p>
          )}

          <form
            onSubmit={
              handleLogin
            }
          >

            <div className="form-group">

              <label>
                Employee ID
              </label>

              <div className="input-container">

                <FaUser
                  className="input-icon"
                />

                <input
                  type="text"
                  placeholder="Enter your Employee ID"
                  value={
                    employeeId
                  }
                  onChange={(
                    event
                  ) =>
                    setEmployeeId(
                      event.target.value
                    )
                  }
                  autoComplete="username"
                />

              </div>

            </div>

            <div className="form-group">

              <label>
                Password
              </label>

              <div className="input-container">

                <FaLock
                  className="input-icon"
                />

                <input
                  type={
                    showPassword
                      ? "text"
                      : "password"
                  }
                  placeholder="Enter your password"
                  value={
                    password
                  }
                  onChange={(
                    event
                  ) =>
                    setPassword(
                      event.target.value
                    )
                  }
                  autoComplete="current-password"
                />

                <button
                  type="button"
                  className="password-toggle"
                  onClick={() =>
                    setShowPassword(
                      (
                        current
                      ) =>
                        !current
                    )
                  }
                  aria-label={
                    showPassword
                      ? "Hide password"
                      : "Show password"
                  }
                >

                  {showPassword
                    ? (
                      <FaEyeSlash />
                    )
                    : (
                      <FaEye />
                    )
                  }

                </button>

              </div>

            </div>

            <button
              type="submit"
              className="login-button"
              disabled={
                loading || (companySlug && companyInfoError)
              }
            >

              {loading
                ? "Signing In..."
                : "Sign In"
              }

            </button>

          </form>

          <div className="login-footer">

            <p>
              {companySlug ? (companyInfo?.name || "ZioVenture") : "Reinsteins Technology"}
            </p>

            <span>
              Secure Employee Portal
            </span>

          </div>

        </div>

      </div>

    </div>
  );
}

export default Login;