import {
  useEffect,
  useState,
} from "react";

import {
  FaBell,
  FaLock,
  FaSave,
  FaKey,
} from "react-icons/fa";

import api from "../../services/api";



import "./EmployeeSettings.css";

function EmployeeSettings() {
  // ==========================================
  // NOTIFICATION STATE
  // ==========================================

  const [
    emailNotifications,
    setEmailNotifications,
  ] = useState(true);

  const [
    leaveNotifications,
    setLeaveNotifications,
  ] = useState(true);

  const [
    taskNotifications,
    setTaskNotifications,
  ] = useState(true);

  // ==========================================
  // PASSWORD STATE
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

  // ==========================================
  // MESSAGE STATE
  // ==========================================

  const [
    successMessage,
    setSuccessMessage,
  ] = useState("");

  const [
    errorMessage,
    setErrorMessage,
  ] = useState("");

  // ==========================================
  // LOAD SAVED NOTIFICATION SETTINGS
  // ==========================================

  useEffect(() => {
    const savedSettings =
      localStorage.getItem(
        "employeeNotificationSettings"
      );

    if (!savedSettings) {
      return;
    }

    try {
      const settings =
        JSON.parse(
          savedSettings
        );

      if (
        typeof settings
          .emailNotifications ===
        "boolean"
      ) {
        setEmailNotifications(
          settings
            .emailNotifications
        );
      }

      if (
        typeof settings
          .leaveNotifications ===
        "boolean"
      ) {
        setLeaveNotifications(
          settings
            .leaveNotifications
        );
      }

      if (
        typeof settings
          .taskNotifications ===
        "boolean"
      ) {
        setTaskNotifications(
          settings
            .taskNotifications
        );
      }
    } catch (error) {
      console.error(
        "Unable to load notification settings:",
        error
      );
    }
  }, []);

  // ==========================================
  // CLEAR MESSAGES
  // ==========================================

  const clearMessages =
    () => {
      setSuccessMessage(
        ""
      );

      setErrorMessage(
        ""
      );
    };

  // ==========================================
  // SHOW SUCCESS MESSAGE
  // ==========================================

  const showSuccess =
    (message) => {
      setErrorMessage(
        ""
      );

      setSuccessMessage(
        message
      );

      setTimeout(
        () => {
          setSuccessMessage(
            ""
          );
        },
        3000
      );
    };

  // ==========================================
  // SAVE NOTIFICATION SETTINGS
  // ==========================================

  const handleSaveNotifications =
    () => {
      clearMessages();

      const settings = {
        emailNotifications,
        leaveNotifications,
        taskNotifications,
      };

      localStorage.setItem(
        "employeeNotificationSettings",
        JSON.stringify(
          settings
        )
      );

      showSuccess(
        "Notification settings saved successfully."
      );
    };

  // ==========================================
  // CHANGE PASSWORD
  // ==========================================

  const handleChangePassword =
    async (event) => {
      event.preventDefault();

      clearMessages();

      // ======================================
      // REQUIRED FIELDS
      // ======================================

      if (
        !currentPassword ||
        !newPassword ||
        !confirmPassword
      ) {
        setErrorMessage(
          "Please complete all password fields."
        );

        return;
      }

      // ======================================
      // PASSWORD LENGTH
      // ======================================

      if (
        newPassword.length <
        8
      ) {
        setErrorMessage(
          "New password must contain at least 8 characters."
        );

        return;
      }

      // ======================================
      // PASSWORD MATCH
      // ======================================

      if (
        newPassword !==
        confirmPassword
      ) {
        setErrorMessage(
          "New password and confirm password do not match."
        );

        return;
      }

      // ======================================
      // CURRENT VS NEW PASSWORD
      // ======================================

      if (
        currentPassword ===
        newPassword
      ) {
        setErrorMessage(
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

        // ====================================
        // CLEAR PASSWORD FORM
        // ====================================

        setCurrentPassword(
          ""
        );

        setNewPassword(
          ""
        );

        setConfirmPassword(
          ""
        );

        showSuccess(
          response.data
            ?.message ||
            "Password changed successfully."
        );
      } catch (error) {
        console.error(
          "Change Password Error:",
          error
        );

        setErrorMessage(
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

  // ==========================================
  // RENDER
  // ==========================================

return (
<>

        <div className="employee-page-content">

          {/* ==================================
              PAGE TITLE
          ================================== */}

          <div className="employee-settings-page-title">

            <h1>
              Settings
            </h1>

            <p>
              Manage your account,
              password and notification
              preferences.
            </p>

          </div>

          {/* ==================================
              SUCCESS MESSAGE
          ================================== */}

          {successMessage && (

            <div className="employee-settings-success">

              {
                successMessage
              }

            </div>

          )}

          {/* ==================================
              ERROR MESSAGE
          ================================== */}

          {errorMessage && (

            <div className="employee-settings-error">

              {
                errorMessage
              }

            </div>

          )}

          <div className="employee-settings-grid">

            {/* ==================================
                NOTIFICATION SETTINGS
            ================================== */}

            <section className="employee-settings-card">

              <div className="employee-settings-card-header">

                <div className="employee-settings-icon">

                  <FaBell />

                </div>

                <div>

                  <h2>
                    Notification Settings
                  </h2>

                  <p>
                    Choose which
                    notifications you
                    want to receive.
                  </p>

                </div>

              </div>

              <div className="employee-settings-options">

                {/* LEAVE NOTIFICATIONS */}

                <div className="employee-setting-option">

                  <div>

                    <h3>
                      Leave Notifications
                    </h3>

                    <p>
                      Receive notifications
                      when your leave
                      request is approved
                      or rejected.
                    </p>

                  </div>

                  <label className="employee-settings-switch">

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

                    <span className="employee-settings-slider" />

                  </label>

                </div>

                {/* TASK NOTIFICATIONS */}

                <div className="employee-setting-option">

                  <div>

                    <h3>
                      Task Notifications
                    </h3>

                    <p>
                      Receive notifications
                      about task updates
                      and assignments.
                    </p>

                  </div>

                  <label className="employee-settings-switch">

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

                    <span className="employee-settings-slider" />

                  </label>

                </div>

                {/* EMAIL NOTIFICATIONS */}

                <div className="employee-setting-option">

                  <div>

                    <h3>
                      Email Notifications
                    </h3>

                    <p>
                      Allow WorkHub to
                      send important
                      notifications by
                      email.
                    </p>

                  </div>

                  <label className="employee-settings-switch">

                    <input
                      type="checkbox"
                      checked={
                        emailNotifications
                      }
                      onChange={() =>
                        setEmailNotifications(
                          (
                            current
                          ) =>
                            !current
                        )
                      }
                    />

                    <span className="employee-settings-slider" />

                  </label>

                </div>

              </div>

              <button
                type="button"
                className="employee-settings-save-button"
                onClick={
                  handleSaveNotifications
                }
              >

                <FaSave />

                Save Settings

              </button>

            </section>

            {/* ==================================
                PASSWORD & SECURITY
            ================================== */}

            <section className="employee-settings-card">

              <div className="employee-settings-card-header">

                <div className="employee-settings-icon">

                  <FaLock />

                </div>

                <div>

                  <h2>
                    Password & Security
                  </h2>

                  <p>
                    Change your WorkHub
                    account password
                    securely.
                  </p>

                </div>

              </div>

              {/* ==================================
                  PASSWORD FORM
              ================================== */}

              <form
                className="employee-password-form"
                onSubmit={
                  handleChangePassword
                }
              >

                {/* CURRENT PASSWORD */}

                <div className="employee-password-field">

                  <label
                    htmlFor="currentPassword"
                  >
                    Current Password
                  </label>

                  <input
                    id="currentPassword"
                    type="password"
                    value={
                      currentPassword
                    }
                    onChange={(
                      event
                    ) =>
                      setCurrentPassword(
                        event.target
                          .value
                      )
                    }
                    placeholder="Enter current password"
                    autoComplete="current-password"
                    disabled={
                      passwordLoading
                    }
                  />

                </div>

                {/* NEW PASSWORD */}

                <div className="employee-password-field">

                  <label
                    htmlFor="newPassword"
                  >
                    New Password
                  </label>

                  <input
                    id="newPassword"
                    type="password"
                    value={
                      newPassword
                    }
                    onChange={(
                      event
                    ) =>
                      setNewPassword(
                        event.target
                          .value
                      )
                    }
                    placeholder="Enter new password"
                    autoComplete="new-password"
                    disabled={
                      passwordLoading
                    }
                  />

                  <span className="employee-password-hint">

                    Password must contain
                    at least 8 characters.

                  </span>

                </div>

                {/* CONFIRM PASSWORD */}

                <div className="employee-password-field">

                  <label
                    htmlFor="confirmPassword"
                  >
                    Confirm New Password
                  </label>

                  <input
                    id="confirmPassword"
                    type="password"
                    value={
                      confirmPassword
                    }
                    onChange={(
                      event
                    ) =>
                      setConfirmPassword(
                        event.target
                          .value
                      )
                    }
                    placeholder="Confirm new password"
                    autoComplete="new-password"
                    disabled={
                      passwordLoading
                    }
                  />

                </div>

                {/* CHANGE PASSWORD BUTTON */}

                <button
                  type="submit"
                  className="employee-password-change-button"
                  disabled={
                    passwordLoading
                  }
                >

                  <FaKey />

                  {passwordLoading
                    ? "Changing Password..."
                    : "Change Password"}

                </button>

              </form>

            </section>

          </div>

        </div>

      </>

    
  );
}

export default EmployeeSettings;