import { useState } from "react";
import { useNavigate } from "react-router-dom";
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

function Login() {
  const navigate = useNavigate();

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

      const response =
        await api.post(
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

      if (
        user.role ===
        "admin"
      ) {
        navigate(
          "/admin",
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
          "/employee",
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

  <CompanyLogo size={90} />

</div>

          <h1>
            Reinsteins WorkHub
          </h1>

          <p>
            A centralized workspace for employees,
            attendance, productivity, and company
            operations.
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
              Sign in to continue to your workspace
            </p>

          </div>

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
                loading
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
              Reinsteins Technology
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