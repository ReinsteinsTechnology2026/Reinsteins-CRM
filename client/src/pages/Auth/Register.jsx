import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  FaUser,
  FaLock,
  FaEye,
  FaEyeSlash,
  FaCheckCircle,
} from "react-icons/fa";
import { toast } from "react-toastify";

import api from "../../services/api";
import "./Register.css";

function Register() {
  const navigate = useNavigate();

  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    password: "",
    confirmPassword: "",
  });

  const [showPassword, setShowPassword] =
    useState(false);

  const [showConfirmPassword, setShowConfirmPassword] =
    useState(false);

  const [loading, setLoading] =
    useState(false);

  const [registeredEmployee, setRegisteredEmployee] =
    useState(null);

  const handleChange = (event) => {
    const { name, value } = event.target;

    setFormData((previous) => ({
      ...previous,
      [name]: value,
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (
      !formData.firstName.trim() ||
      !formData.lastName.trim() ||
      !formData.password ||
      !formData.confirmPassword
    ) {
      toast.error("Please fill all fields");
      return;
    }

    if (
      formData.password !==
      formData.confirmPassword
    ) {
      toast.error("Passwords do not match");
      return;
    }

    if (formData.password.length < 8) {
      toast.error(
        "Password must contain at least 8 characters"
      );
      return;
    }

    try {
      setLoading(true);

      const response = await api.post(
        "/auth/register-employee",
        {
          firstName: formData.firstName.trim(),
          lastName: formData.lastName.trim(),
          password: formData.password,
          confirmPassword:
            formData.confirmPassword,
        }
      );

      setRegisteredEmployee({
        employeeId: response.data.employeeId,
      });

      toast.success(
        "Account created successfully"
      );
    } catch (error) {
      toast.error(
        error.response?.data?.message ||
          "Unable to create account"
      );
    } finally {
      setLoading(false);
    }
  };

  if (registeredEmployee) {
    return (
      <div className="register-page">

        <div className="registration-success-card">

          <div className="registration-success-icon">
            <FaCheckCircle />
          </div>

          <h1>Account Created</h1>

          <p className="success-description">
            Your employee account has been created
            successfully.
          </p>

          <div className="generated-id-box">

            <span>Your Employee ID</span>

            <strong>
              {registeredEmployee.employeeId}
            </strong>

          </div>

          <div className="approval-message">

            <h3>Waiting for Admin Approval</h3>

            <p>
              Your account is currently pending.
              Please save your Employee ID.
              You can log in after your administrator
              approves your account.
            </p>

          </div>

          <button
            className="back-login-button"
            onClick={() => navigate("/")}
          >
            Go to Login
          </button>

        </div>

      </div>
    );
  }

  return (
    <div className="register-page">

      <div className="register-brand-section">

        <div className="register-brand-content">

          <div className="register-logo">
            R
          </div>

          <h1>Join Reinsteins WorkHub</h1>

          <p>
            Create your employee account to access
            your company workspace, attendance,
            tasks and work activities.
          </p>

        </div>

      </div>

      <div className="register-form-section">

        <div className="register-card">

          <div className="register-header">

            <h2>Create Employee Account</h2>

            <p>
              Enter your details to register
            </p>

          </div>

          <form onSubmit={handleSubmit}>

            <div className="register-name-grid">

              <div className="register-form-group">

                <label>First Name</label>

                <div className="register-input-container">

                  <FaUser />

                  <input
                    type="text"
                    name="firstName"
                    placeholder="First name"
                    value={formData.firstName}
                    onChange={handleChange}
                    required
                  />

                </div>

              </div>

              <div className="register-form-group">

                <label>Last Name</label>

                <div className="register-input-container">

                  <FaUser />

                  <input
                    type="text"
                    name="lastName"
                    placeholder="Last name"
                    value={formData.lastName}
                    onChange={handleChange}
                    required
                  />

                </div>

              </div>

            </div>

            <div className="register-form-group">

              <label>Password</label>

              <div className="register-input-container">

                <FaLock />

                <input
                  type={
                    showPassword
                      ? "text"
                      : "password"
                  }
                  name="password"
                  placeholder="Create password"
                  value={formData.password}
                  onChange={handleChange}
                  required
                />

                <button
                  type="button"
                  className="register-password-toggle"
                  onClick={() =>
                    setShowPassword(
                      !showPassword
                    )
                  }
                >
                  {showPassword
                    ? <FaEyeSlash />
                    : <FaEye />}
                </button>

              </div>

            </div>

            <div className="register-form-group">

              <label>Confirm Password</label>

              <div className="register-input-container">

                <FaLock />

                <input
                  type={
                    showConfirmPassword
                      ? "text"
                      : "password"
                  }
                  name="confirmPassword"
                  placeholder="Confirm password"
                  value={formData.confirmPassword}
                  onChange={handleChange}
                  required
                />

                <button
                  type="button"
                  className="register-password-toggle"
                  onClick={() =>
                    setShowConfirmPassword(
                      !showConfirmPassword
                    )
                  }
                >
                  {showConfirmPassword
                    ? <FaEyeSlash />
                    : <FaEye />}
                </button>

              </div>

            </div>

            <button
              type="submit"
              className="register-submit-button"
              disabled={loading}
            >
              {loading
                ? "Creating Account..."
                : "Create Account"}
            </button>

          </form>

          <div className="register-login-link">

            <span>
              Already have an Employee ID?
            </span>

            <button
              onClick={() => navigate("/")}
            >
              Sign In
            </button>

          </div>

        </div>

      </div>

    </div>
  );
}

export default Register;