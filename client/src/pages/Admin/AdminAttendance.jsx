import {
  useEffect,
  useState,
} from "react";

import {
  useNavigate,
} from "react-router-dom";

import {
  FaSignOutAlt,
  FaBell,
  FaSyncAlt,
} from "react-icons/fa";

import {
  toast,
} from "react-toastify";

import api from "../../services/api";



import "./AdminAttendance.css";

function AdminAttendance() {
  const navigate =
    useNavigate();

  const storedUser =
    localStorage.getItem(
      "user"
    );

  const user =
    storedUser
      ? JSON.parse(
          storedUser
        )
      : null;

  // ==========================================
  // STATE
  // ==========================================

  const [
    employees,
    setEmployees,
  ] = useState([]);

  const [
    summary,
    setSummary,
  ] = useState({
    totalEmployees: 0,
    working: 0,
    onBreak: 0,
    offline: 0,
  });

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    lastUpdated,
    setLastUpdated,
  ] = useState(null);

  // ==========================================
  // FORMAT DURATION
  // ==========================================

  const formatDuration = (
    seconds
  ) => {
    const safeSeconds =
      Math.max(
        0,
        Math.floor(
          Number(
            seconds
          ) || 0
        )
      );

    const hours =
      Math.floor(
        safeSeconds /
          3600
      );

    const minutes =
      Math.floor(
        (
          safeSeconds %
          3600
        ) / 60
      );

    const secs =
      safeSeconds %
      60;

    return [
      hours,
      minutes,
      secs,
    ]
      .map(
        (value) =>
          String(
            value
          ).padStart(
            2,
            "0"
          )
      )
      .join(":");
  };

  // ==========================================
  // FORMAT TIME
  // ==========================================

  const formatTime = (
    date
  ) => {
    if (!date) {
      return "--";
    }

    return new Date(
      date
    ).toLocaleTimeString(
      [],
      {
        hour:
          "2-digit",
        minute:
          "2-digit",
        second:
          "2-digit",
      }
    );
  };

  // ==========================================
  // LOAD LIVE ATTENDANCE
  // ==========================================

  const loadLiveAttendance =
    async (
      showError = true
    ) => {
      try {
        const response =
          await api.get(
            "/attendance/admin/live"
          );

        setEmployees(
          response.data
            .employees ||
            []
        );

        setSummary(
          response.data
            .summary || {
            totalEmployees: 0,
            working: 0,
            onBreak: 0,
            offline: 0,
          }
        );

        setLastUpdated(
          new Date()
        );

      } catch (error) {
        console.error(
          "Admin live attendance error:",
          error
        );

        if (showError) {
          toast.error(
            error.response
              ?.data
              ?.message ||
              "Unable to load live attendance"
          );
        }

      } finally {
        setLoading(
          false
        );
      }
    };

  // ==========================================
  // INITIAL LOAD + AUTO REFRESH
  // ==========================================

  useEffect(() => {
    loadLiveAttendance();

    const refreshInterval =
      setInterval(
        () => {
          loadLiveAttendance(
            false
          );
        },
        30000
      );

    return () =>
      clearInterval(
        refreshInterval
      );
  }, []);

  // ==========================================
  // LOGOUT
  // ==========================================

  const handleLogout =
    () => {
      localStorage.removeItem(
        "token"
      );

      localStorage.removeItem(
        "user"
      );

      navigate(
        "/",
        {
          replace:
            true,
        }
      );
    };

  // ==========================================
  // STATUS LABEL
  // ==========================================

  const getStatusLabel = (
    status
  ) => {
    if (
      status ===
      "working"
    ) {
      return "Working";
    }

    if (
      status ===
      "break"
    ) {
      return "On Break";
    }

    return "Offline";
  };

  return (
    <>

        {/* ====================================
            HEADER
        ==================================== */}

       

        {/* ====================================
            CONTENT
        ==================================== */}

        <div className="admin-page-content">

          {/* ==================================
              SUMMARY CARDS
          ================================== */}

          <div className="admin-attendance-summary-grid">

            {/* TOTAL EMPLOYEES */}

            <div className="admin-attendance-summary-card">

              <span>
                Total Employees
              </span>

              <strong>
                {
                  summary
                    .totalEmployees
                }
              </strong>

            </div>

            {/* WORKING */}

            <div className="admin-attendance-summary-card working">

              <span>
                Working Now
              </span>

              <strong>
                {
                  summary
                    .working
                }
              </strong>

            </div>

            {/* ON BREAK */}

            <div className="admin-attendance-summary-card break">

              <span>
                On Break
              </span>

              <strong>
                {
                  summary
                    .onBreak
                }
              </strong>

            </div>

            {/* OFFLINE */}

            <div className="admin-attendance-summary-card offline">

              <span>
                Offline
              </span>

              <strong>
                {
                  summary
                    .offline
                }
              </strong>

            </div>

          </div>

          {/* ==================================
              LIVE ATTENDANCE TABLE
          ================================== */}

          <section className="admin-attendance-live-card">

            <div className="admin-attendance-section-header">

              <div>

                <h2>
                  Employee Live Status
                </h2>

                <p>
                  Automatically
                  refreshes every
                  30 seconds
                </p>

              </div>

              <div className="admin-attendance-updated">

                Last updated:{" "}

                <strong>
                  {lastUpdated
                    ? formatTime(
                        lastUpdated
                      )
                    : "--"}
                </strong>

              </div>

            </div>

            {/* LOADING */}

            {loading ? (

              <div className="admin-attendance-message">

                Loading employee
                attendance...

              </div>

            ) : employees.length ===
              0 ? (

              /* NO EMPLOYEES */

              <div className="admin-attendance-message">

                No active employees
                found.

              </div>

            ) : (

              /* TABLE */

              <div className="admin-attendance-table-wrapper">

                <table className="admin-attendance-table">

                  <thead>

                    <tr>

                      <th>
                        Employee
                      </th>

                      <th>
                        Employee ID
                      </th>

                      <th>
                        Status
                      </th>

                      <th>
                        Current Login
                      </th>

                      <th>
                        Current Session
                      </th>

                      <th>
                        Today's Work
                      </th>

                    </tr>

                  </thead>

                  <tbody>

                    {employees.map(
                      (
                        employee
                      ) => (

                        <tr
                          key={
                            employee
                              .id
                          }
                        >

                          {/* EMPLOYEE */}

                          <td>

                            <div className="admin-attendance-employee">

                              <div className="admin-attendance-employee-avatar">

                                {employee
                                  .fullName
                                  ?.charAt(
                                    0
                                  )
                                  .toUpperCase() ||
                                  "E"}

                              </div>

                              <strong>

                                {
                                  employee
                                    .fullName
                                }

                              </strong>

                            </div>

                          </td>

                          {/* EMPLOYEE ID */}

                          <td>

                            {
                              employee
                                .employeeId
                            }

                          </td>

                          {/* STATUS */}

                          <td>

                            <span
                              className={`admin-live-status ${employee.status}`}
                            >

                              <span className="admin-live-dot">
                              </span>

                              {getStatusLabel(
                                employee
                                  .status
                              )}

                            </span>

                          </td>

                          {/* LOGIN TIME */}

                          <td>

                            {employee
                              .loginTime
                              ? formatTime(
                                  employee
                                    .loginTime
                                )
                              : "--"}

                          </td>

                          {/* CURRENT SESSION */}

                          <td>

                            <span className="admin-session-time">

                              {employee
                                .status ===
                              "offline"
                                ? "--"
                                : formatDuration(
                                    employee
                                      .currentSessionSeconds
                                  )}

                            </span>

                          </td>

                          {/* TODAY WORK */}

                          <td>

                            <span className="admin-today-work">

                              {formatDuration(
                                employee
                                  .todayWorkSeconds
                              )}

                            </span>

                          </td>

                        </tr>

                      )
                    )}

                  </tbody>

                </table>

              </div>

            )}

          </section>

        </div>

            </>
  );
}

export default AdminAttendance;