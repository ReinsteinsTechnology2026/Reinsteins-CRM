import {
  useState,
} from "react";

import {
  FaBell,
  FaShieldAlt,
  FaSave,
  FaLock,
  FaKey,
} from "react-icons/fa";

import api from "../../services/api";
import AdminEmailSettings from "./AdminEmailSettings";

import "./AdminSettings.css";

function AdminSettings() {
  // ==========================================
  // SETTINGS STATE
  // ==========================================

  const [
    employeeNotifications,
    setEmployeeNotifications,
  ] = useState(true);

  const [
    leaveNotifications,
    setLeaveNotifications,
  ] = useState(true);

  const [
    taskNotifications,
    setTaskNotifications,
  ] = useState(true);

  const [
    message,
    setMessage,
  ] = useState("");

  // ==========================================
  // CHANGE PASSWORD STATE
  // Same endpoint/rules as EmployeeSettings.jsx's
  // password form (PUT /auth/change-password,
  // protect-only, scoped to req.user.id) — the
  // only thing missing on the admin side was this
  // UI, so this mirrors that logic exactly.
  // ==========================================

  const [
    currentPassword,
    setCurrentPassword,
  ] = useState("");

  const [
    newPassword,
    setNewPassword,
  ] = useState("");

  const [
    confirmPassword,
    setConfirmPassword,
  ] = useState("");

  const [
    passwordLoading,
    setPasswordLoading,
  ] = useState(false);

  const [
    passwordError,
    setPasswordError,
  ] = useState("");

  // ==========================================
  // SAVE SETTINGS
  // ==========================================

  const handleSaveSettings =
    () => {
      const settings = {
        employeeNotifications,
        leaveNotifications,
        taskNotifications,
      };

      // This stores only preferences.
      // Authentication still uses sessionStorage.

      localStorage.setItem(
        "adminNotificationSettings",
        JSON.stringify(
          settings
        )
      );

      setMessage(
        "Settings saved successfully."
      );

      setTimeout(
        () => {
          setMessage("");
        },
        3000
      );
    };

  // ==========================================
  // CHANGE PASSWORD
  // ==========================================

  const handleChangePassword =
    async (event) => {
      event.preventDefault();

      setPasswordError("");

      if (
        !currentPassword ||
        !newPassword ||
        !confirmPassword
      ) {
        setPasswordError(
          "Please complete all password fields."
        );

        return;
      }

      if (
        newPassword.length <
        8
      ) {
        setPasswordError(
          "New password must contain at least 8 characters."
        );

        return;
      }

      if (
        newPassword !==
        confirmPassword
      ) {
        setPasswordError(
          "New password and confirm password do not match."
        );

        return;
      }

      if (
        currentPassword ===
        newPassword
      ) {
        setPasswordError(
          "New password cannot be the same as your current password."
        );

        return;
      }

      try {
        setPasswordLoading(
          true
        );

        const response =
          await api.put(
            "/auth/change-password",
            {
              currentPassword,
              newPassword,
              confirmPassword,
            }
          );

        setCurrentPassword(
          ""
        );

        setNewPassword(
          ""
        );

        setConfirmPassword(
          ""
        );

        setMessage(
          response.data
            ?.message ||
            "Password changed successfully."
        );

        setTimeout(
          () => {
            setMessage("");
          },
          3000
        );
      } catch (error) {
        console.error(
          "Change Password Error:",
          error
        );

        setPasswordError(
          error.response
            ?.data
            ?.message ||
            "Unable to change password."
        );
      } finally {
        setPasswordLoading(
          false
        );
      }
    };

return (
<>

        <div className="admin-page-content">

          {/* ==================================
              PAGE TITLE
          ================================== */}

          <div className="admin-settings-page-title">

            <h1>
              Settings
            </h1>

            <p>
              Manage your administrator preferences
              and WorkHub settings.
            </p>

          </div>

          {/* ==================================
              SUCCESS MESSAGE
          ================================== */}

          {message && (

            <div className="admin-settings-success">

              {message}

            </div>

          )}

          <div className="admin-settings-grid">

            {/* ==================================
                NOTIFICATION SETTINGS
            ================================== */}

            <section className="admin-settings-card">

              <div className="admin-settings-card-header">

                <div className="admin-settings-icon">

                  <FaBell />

                </div>

                <div>

                  <h2>
                    Notification Settings
                  </h2>

                  <p>
                    Choose which administrator
                    notifications you want to receive.
                  </p>

                </div>

              </div>

              <div className="admin-settings-options">

                {/* EMPLOYEE NOTIFICATIONS */}

                <div className="admin-setting-option">

                  <div>

                    <h3>
                      Employee Notifications
                    </h3>

                    <p>
                      Receive notifications for new
                      employee registrations and
                      employee account activity.
                    </p>

                  </div>

                  <label className="admin-settings-switch">

                    <input
                      type="checkbox"
                      checked={
                        employeeNotifications
                      }
                      onChange={() =>
                        setEmployeeNotifications(
                          (
                            current
                          ) =>
                            !current
                        )
                      }
                    />

                    <span className="admin-settings-slider" />

                  </label>

                </div>

                {/* LEAVE NOTIFICATIONS */}

                <div className="admin-setting-option">

                  <div>

                    <h3>
                      Leave Notifications
                    </h3>

                    <p>
                      Receive notifications when
                      employees submit new leave
                      requests.
                    </p>

                  </div>

                  <label className="admin-settings-switch">

                    <input
                      type="checkbox"
                      checked={
                        leaveNotifications
                      }
                      onChange={() =>
                        setLeaveNotifications(
                          (
                            current
                          ) =>
                            !current
                        )
                      }
                    />

                    <span className="admin-settings-slider" />

                  </label>

                </div>

                {/* TASK NOTIFICATIONS */}

                <div className="admin-setting-option">

                  <div>

                    <h3>
                      Task Notifications
                    </h3>

                    <p>
                      Receive notifications about
                      employee task updates and
                      completion activity.
                    </p>

                  </div>

                  <label className="admin-settings-switch">

                    <input
                      type="checkbox"
                      checked={
                        taskNotifications
                      }
                      onChange={() =>
                        setTaskNotifications(
                          (
                            current
                          ) =>
                            !current
                        )
                      }
                    />

                    <span className="admin-settings-slider" />

                  </label>

                </div>

              </div>

              <button
                type="button"
                className="admin-settings-save-button"
                onClick={
                  handleSaveSettings
                }
              >

                <FaSave />

                Save Settings

              </button>

            </section>

            {/* ==================================
                PASSWORD & SECURITY
            ================================== */}

            <section className="admin-settings-card">

              <div className="admin-settings-card-header">

                <div className="admin-settings-icon">

                  <FaLock />

                </div>

                <div>

                  <h2>
                    Password & Security
                  </h2>

                  <p>
                    Change your administrator
                    account password securely.
                  </p>

                </div>

              </div>

              {passwordError && (

                <div className="admin-settings-password-error">
                  {passwordError}
                </div>

              )}

              <form
                className="admin-password-form"
                onSubmit={
                  handleChangePassword
                }
              >

                <div className="admin-password-field">

                  <label htmlFor="currentPassword">
                    Current Password
                  </label>

                  <input
                    id="currentPassword"
                    type="password"
                    value={currentPassword}
                    onChange={(event) =>
                      setCurrentPassword(event.target.value)
                    }
                    placeholder="Enter current password"
                    autoComplete="current-password"
                    disabled={passwordLoading}
                  />

                </div>

                <div className="admin-password-field">

                  <label htmlFor="newPassword">
                    New Password
                  </label>

                  <input
                    id="newPassword"
                    type="password"
                    value={newPassword}
                    onChange={(event) =>
                      setNewPassword(event.target.value)
                    }
                    placeholder="Enter new password"
                    autoComplete="new-password"
                    disabled={passwordLoading}
                  />

                  <span className="admin-password-hint">
                    Password must contain at least 8 characters.
                  </span>

                </div>

                <div className="admin-password-field">

                  <label htmlFor="confirmPassword">
                    Confirm New Password
                  </label>

                  <input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(event) =>
                      setConfirmPassword(event.target.value)
                    }
                    placeholder="Confirm new password"
                    autoComplete="new-password"
                    disabled={passwordLoading}
                  />

                </div>

                <button
                  type="submit"
                  className="admin-settings-save-button"
                  disabled={passwordLoading}
                >
                  <FaKey />
                  {passwordLoading
                    ? "Changing Password..."
                    : "Change Password"}
                </button>

              </form>

              <div className="admin-security-info">

                <FaShieldAlt />

                <div>

                  <h3>
                    Secure Administrator Session
                  </h3>

                  <p>
                    Your administrator account is
                    protected using authenticated
                    session access and role-based
                    authorization.
                  </p>

                </div>

              </div>

            </section>

            {/* ==================================
                BUSINESS EMAIL (Phase 16A)
            ================================== */}

            <AdminEmailSettings />

          </div>

        </div>

      </>

    
  );
}

export default AdminSettings;