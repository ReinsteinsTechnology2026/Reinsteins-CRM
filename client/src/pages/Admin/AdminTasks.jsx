import {
  useEffect,
  useState,
} from "react";

import {
  useNavigate,
} from "react-router-dom";

import {
  FaBell,
  FaSignOutAlt,
  FaSyncAlt,
} from "react-icons/fa";

import {
  toast,
} from "react-toastify";

import api from "../../services/api";

import AdminSidebar from "../../components/Layout/AdminSidebar";

import "./AdminTasks.css";

function AdminTasks() {
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
    tasks,
    setTasks,
  ] = useState([]);

  const [
    summary,
    setSummary,
  ] = useState({
    totalTasks: 0,
    inProgress: 0,
    completed: 0,
  });

  const [
    loading,
    setLoading,
  ] = useState(true);

  // ==========================================
  // LOAD ALL EMPLOYEE TASKS
  // ==========================================

  const loadTasks =
    async () => {
      try {
        setLoading(
          true
        );

        const response =
          await api.get(
            "/tasks/admin/all"
          );

        setTasks(
          response.data
            .tasks || []
        );

        setSummary(
          response.data
            .summary || {
            totalTasks: 0,
            inProgress: 0,
            completed: 0,
          }
        );

      } catch (error) {
        console.error(
          "Admin tasks error:",
          error
        );

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to load employee tasks"
        );

      } finally {
        setLoading(
          false
        );
      }
    };

  // ==========================================
  // INITIAL LOAD
  // ==========================================

  useEffect(() => {
    loadTasks();
  }, []);

  // ==========================================
  // FORMAT DATE
  // ==========================================

  const formatDateTime =
    (value) => {
      if (!value) {
        return "--";
      }

      return new Date(
        value
      ).toLocaleString(
        "en-IN",
        {
          day:
            "2-digit",
          month:
            "short",
          year:
            "numeric",
          hour:
            "2-digit",
          minute:
            "2-digit",
        }
      );
    };

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
  // PAGE
  // ==========================================

  return (
    <div className="admin-tasks-layout">

      {/* ======================================
          COMMON ADMIN SIDEBAR
      ====================================== */}

      <AdminSidebar />

      {/* ======================================
          MAIN CONTENT
      ====================================== */}

      <main className="admin-tasks-main">

        {/* ====================================
            HEADER
        ==================================== */}

        <header className="admin-tasks-header">

          <div>

            <h1>
              Employee Tasks
            </h1>

            <p>
              Monitor what employees
              are currently working on
            </p>

          </div>

          <div className="admin-tasks-header-actions">

            {/* REFRESH */}

            <button
              type="button"
              className="admin-tasks-refresh"
              onClick={
                loadTasks
              }
              title="Refresh Tasks"
            >
              <FaSyncAlt />
            </button>

            {/* NOTIFICATIONS */}

            <button
              type="button"
              className="admin-tasks-notification"
            >
              <FaBell />
            </button>

            {/* ADMIN PROFILE */}

            <div className="admin-tasks-profile">

              <div className="admin-tasks-avatar">

                {user
                  ?.fullName
                  ?.charAt(0)
                  .toUpperCase() ||
                  "A"}

              </div>

              <div>

                <p>
                  {user
                    ?.fullName ||
                    "Administrator"}
                </p>

                <span>
                  Admin
                </span>

              </div>

            </div>

            {/* LOGOUT */}

            <button
              type="button"
              className="admin-tasks-logout"
              onClick={
                handleLogout
              }
              title="Logout"
            >
              <FaSignOutAlt />
            </button>

          </div>

        </header>

        {/* ====================================
            CONTENT
        ==================================== */}

        <div className="admin-tasks-content">

          {/* ==================================
              SUMMARY CARDS
          ================================== */}

          <div className="admin-tasks-summary-grid">

            <div className="admin-task-summary-card">

              <span>
                Total Tasks
              </span>

              <strong>
                {
                  summary
                    .totalTasks
                }
              </strong>

            </div>

            <div className="admin-task-summary-card progress">

              <span>
                In Progress
              </span>

              <strong>
                {
                  summary
                    .inProgress
                }
              </strong>

            </div>

            <div className="admin-task-summary-card completed">

              <span>
                Completed
              </span>

              <strong>
                {
                  summary
                    .completed
                }
              </strong>

            </div>

          </div>

          {/* ==================================
              TASK LIST
          ================================== */}

          <section className="admin-task-list-card">

            <div className="admin-task-section-header">

              <div>

                <h2>
                  All Employee Tasks
                </h2>

                <p>
                  View current and
                  completed employee
                  work
                </p>

              </div>

              <button
                type="button"
                className="admin-task-refresh-button"
                onClick={
                  loadTasks
                }
              >
                <FaSyncAlt />

                Refresh
              </button>

            </div>

            {/* LOADING */}

            {loading ? (

              <div className="admin-task-message">

                Loading employee
                tasks...

              </div>

            ) : tasks.length ===
              0 ? (

              /* NO TASKS */

              <div className="admin-task-message">

                No employee tasks
                found.

              </div>

            ) : (

              /* TASK TABLE */

              <div className="admin-task-table-wrapper">

                <table className="admin-task-table">

                  <thead>

                    <tr>

                      <th>
                        Employee
                      </th>

                      <th>
                        Employee ID
                      </th>

                      <th>
                        Task
                      </th>

                      <th>
                        Work Description
                      </th>

                      <th>
                        Started
                      </th>

                      <th>
                        Completed
                      </th>

                      <th>
                        Status
                      </th>

                    </tr>

                  </thead>

                  <tbody>

                    {tasks.map(
                      (
                        task
                      ) => (

                        <tr
                          key={
                            task.id
                          }
                        >

                          {/* EMPLOYEE */}

                          <td>

                            <div className="admin-task-employee">

                              <div className="admin-task-employee-avatar">

                                {task
                                  .full_name
                                  ?.charAt(
                                    0
                                  )
                                  .toUpperCase() ||
                                  "E"}

                              </div>

                              <strong>

                                {
                                  task
                                    .full_name
                                }

                              </strong>

                            </div>

                          </td>

                          {/* EMPLOYEE ID */}

                          <td>

                            {
                              task
                                .employee_id
                            }

                          </td>

                          {/* TASK TITLE */}

                          <td className="admin-task-title">

                            {
                              task
                                .task_title
                            }

                          </td>

                          {/* DESCRIPTION */}

                          <td className="admin-task-description">

                            {
                              task
                                .task_description
                            }

                          </td>

                          {/* STARTED */}

                          <td>

                            {formatDateTime(
                              task
                                .start_time
                            )}

                          </td>

                          {/* COMPLETED */}

                          <td>

                            {formatDateTime(
                              task
                                .completed_time
                            )}

                          </td>

                          {/* STATUS */}

                          <td>

                            <span
                              className={
                                task
                                  .status ===
                                "closed"
                                  ? "admin-task-status completed"
                                  : "admin-task-status progress"
                              }
                            >

                              {task
                                .status ===
                              "closed"
                                ? "Completed"
                                : "In Progress"}

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

      </main>

    </div>
  );
}

export default AdminTasks;