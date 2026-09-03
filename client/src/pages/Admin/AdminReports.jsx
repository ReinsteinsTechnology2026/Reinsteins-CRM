import {
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  FaUsers,
  FaCalendarCheck,
  FaTasks,
  FaCalendarAlt,
  FaFileExcel,
  FaFilter,
  FaSyncAlt,
  FaClock,
  FaChartLine,
  FaCheckCircle,
  FaSpinner,
  FaListAlt,
  FaHourglassHalf,
  FaTimesCircle,
  FaSearch,
} from "react-icons/fa";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

import api from "../../services/api";



import "./AdminReports.css";

function AdminReports() {
  // ==========================================
  // STATE
  // ==========================================

  const [reportType, setReportType] =
    useState("attendance");

  const [fromDate, setFromDate] =
    useState("");

  const [toDate, setToDate] =
    useState("");

  const [
    selectedEmployee,
    setSelectedEmployee,
  ] = useState("");

  const [employees, setEmployees] =
    useState([]);

  const [reportData, setReportData] =
    useState([]);

  const [loading, setLoading] =
    useState(false);

  const [error, setError] =
    useState("");

  const [
    employeeSearch,
    setEmployeeSearch,
  ] = useState("");

  // ==========================================
  // REPORT TYPES
  // ==========================================

  const reports = [
    {
      id: "attendance",
      title: "Attendance Report",
      description:
        "View individual employee attendance",
      icon: <FaCalendarCheck />,
    },
    {
      id: "tasks",
      title: "Task Report",
      description:
        "View individual employee task progress",
      icon: <FaTasks />,
    },
    {
      id: "leave",
      title: "Leave Report",
      description:
        "View individual employee leave requests",
      icon: <FaCalendarAlt />,
    },
    {
      id: "employees",
      title: "Employee Report",
      description:
        "View and search employee information",
      icon: <FaUsers />,
    },
  ];

  // ==========================================
  // LOAD EMPLOYEES
  // ==========================================

  const loadEmployees =
    async () => {
      try {
        const response =
          await api.get(
            "/reports/employees"
          );

        setEmployees(
          response.data?.data ||
            []
        );
      } catch (error) {
        console.error(
          "Employee load error:",
          error
        );
      }
    };

  useEffect(() => {
    loadEmployees();
  }, []);

  // ==========================================
  // REPORT REQUIRES EMPLOYEE
  // ==========================================

  const requiresEmployee =
    reportType ===
      "attendance" ||
    reportType ===
      "tasks" ||
    reportType ===
      "leave";

  // ==========================================
  // LOAD REPORT
  // ==========================================

  const loadReport =
    async (
      employeeId =
        selectedEmployee,
      type =
        reportType
    ) => {
      try {
        const employeeRequired =
          type ===
            "attendance" ||
          type ===
            "tasks" ||
          type ===
            "leave";

        if (
          employeeRequired &&
          !employeeId
        ) {
          setReportData([]);
          return;
        }

        setLoading(true);
        setError("");
        setReportData([]);

        const endpoint =
          `/reports/${type}`;

        const params = {};

        if (
          type !==
          "employees"
        ) {
          if (fromDate) {
            params.fromDate =
              fromDate;
          }

          if (toDate) {
            params.toDate =
              toDate;
          }
        }

        if (
          employeeRequired &&
          employeeId
        ) {
          params.employeeId =
            employeeId;
        }

        const response =
          await api.get(
            endpoint,
            {
              params,
            }
          );

        let data =
          response.data?.data ||
          [];

        // ======================================
        // FRONTEND EMPLOYEE SAFETY FILTER
        // ======================================

        if (
          employeeRequired &&
          employeeId
        ) {
          data =
            data.filter(
              (record) =>
                String(
                  record.employee_id
                ) ===
                String(
                  employeeId
                )
            );
        }

        setReportData(
          data
        );
      } catch (error) {
        console.error(
          "Report load error:",
          error
        );

        setReportData([]);

        setError(
          error.response?.data
            ?.message ||
            "Unable to load report"
        );
      } finally {
        setLoading(false);
      }
    };

  // ==========================================
  // REPORT TYPE CHANGE
  // ==========================================

  const handleReportTypeChange =
    async (type) => {
      setReportType(type);

      setReportData([]);
      setError("");
      setSelectedEmployee("");
      setFromDate("");
      setToDate("");
      setEmployeeSearch("");

      if (
        type ===
        "employees"
      ) {
        try {
          setLoading(true);

          const response =
            await api.get(
              "/reports/employees"
            );

          setReportData(
            response.data?.data ||
              []
          );
        } catch (error) {
          console.error(
            "Employee report error:",
            error
          );

          setError(
            "Unable to load employee report"
          );
        } finally {
          setLoading(false);
        }
      }
    };

  // ==========================================
  // EMPLOYEE CHANGE
  // ==========================================

  const handleEmployeeChange =
    async (event) => {
      const employeeId =
        event.target.value;

      setSelectedEmployee(
        employeeId
      );

      setReportData([]);
      setError("");

      if (!employeeId) {
        return;
      }

      if (
        fromDate &&
        toDate &&
        fromDate >
          toDate
      ) {
        setError(
          "From Date cannot be after To Date."
        );

        return;
      }

      await loadReport(
        employeeId,
        reportType
      );
    };

  // ==========================================
  // SELECTED EMPLOYEE DETAILS
  // ==========================================

  const employeeDetails =
    useMemo(() => {
      return employees.find(
        (employee) =>
          String(
            employee.employee_id
          ) ===
          String(
            selectedEmployee
          )
      );
    }, [
      employees,
      selectedEmployee,
    ]);

  // ==========================================
  // FILTER EMPLOYEE REPORT
  // ==========================================

  const filteredEmployees =
    useMemo(() => {
      if (
        reportType !==
        "employees"
      ) {
        return [];
      }

      const search =
        employeeSearch
          .trim()
          .toLowerCase();

      if (!search) {
        return reportData;
      }

      return reportData.filter(
        (employee) =>
          String(
            employee.employee_id ||
              ""
          )
            .toLowerCase()
            .includes(
              search
            ) ||
          String(
            employee.full_name ||
              ""
          )
            .toLowerCase()
            .includes(
              search
            ) ||
          String(
            employee.email ||
              ""
          )
            .toLowerCase()
            .includes(
              search
            ) ||
          String(
            employee.phone ||
              ""
          )
            .toLowerCase()
            .includes(
              search
            ) ||
          String(
            employee.designation ||
              ""
          )
            .toLowerCase()
            .includes(
              search
            ) ||
          String(
            employee.status ||
              ""
          )
            .toLowerCase()
            .includes(
              search
            )
      );
    }, [
      reportData,
      employeeSearch,
      reportType,
    ]);

  // ==========================================
  // FORMAT DURATION
  // ==========================================

  const formatDuration = (
    seconds
  ) => {
    const value =
      Number(seconds) || 0;

    const hours =
      Math.floor(
        value / 3600
      );

    const minutes =
      Math.floor(
        (value % 3600) /
          60
      );

    const secs =
      Math.floor(
        value % 60
      );

    return `${hours}h ${minutes}m ${secs}s`;
  };

  // ==========================================
  // FORMAT DATE
  // ==========================================

  const formatDate = (
    value
  ) => {
    if (!value) {
      return "--";
    }

    const date =
      new Date(value);

    if (
      Number.isNaN(
        date.getTime()
      )
    ) {
      return "--";
    }

    return date.toLocaleDateString(
      "en-IN"
    );
  };

  // ==========================================
  // FORMAT TIME
  // ==========================================

  const formatTime = (
    value
  ) => {
    if (!value) {
      return "--";
    }

    const date =
      new Date(value);

    if (
      Number.isNaN(
        date.getTime()
      )
    ) {
      return "--";
    }

    return date.toLocaleTimeString(
      "en-IN",
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
  // FORMAT DATE + TIME
  // ==========================================

  const formatDateTime = (
    value
  ) => {
    if (!value) {
      return "--";
    }

    const date =
      new Date(value);

    if (
      Number.isNaN(
        date.getTime()
      )
    ) {
      return "--";
    }

    return date.toLocaleString(
      "en-IN",
      {
        day:
          "2-digit",
        month:
          "2-digit",
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
  // FORMAT HOURS (decimal) AS "Xh Ym"
  // Mirrors formatHoursDuration in
  // reportController.js -- same "Xh Ym" convention,
  // used for task_work_logs-derived total work time.
  // ==========================================

  const formatHours = (
    decimalHours
  ) => {
    const value =
      Number(decimalHours) || 0;

    const totalMinutes =
      Math.round(value * 60);

    const hours =
      Math.floor(totalMinutes / 60);

    const minutes =
      totalMinutes % 60;

    return `${hours}h ${minutes}m`;
  };

  // ==========================================
  // ATTENDANCE BY DATE
  // ==========================================

  const dailyAttendance =
    useMemo(() => {
      if (
        reportType !==
          "attendance" ||
        !selectedEmployee
      ) {
        return [];
      }

      const grouped = {};

      reportData.forEach(
        (record) => {
          const rawDate =
            record.login_time ||
            record.created_at;

          if (!rawDate) {
            return;
          }

          const date =
            new Date(
              rawDate
            );

          if (
            Number.isNaN(
              date.getTime()
            )
          ) {
            return;
          }

          const year =
            date.getFullYear();

          const month =
            String(
              date.getMonth() +
                1
            ).padStart(
              2,
              "0"
            );

          const day =
            String(
              date.getDate()
            ).padStart(
              2,
              "0"
            );

          const dateKey =
            `${year}-${month}-${day}`;

          if (
            !grouped[
              dateKey
            ]
          ) {
            grouped[
              dateKey
            ] = {
              dateKey,

              displayDate:
                formatDate(
                  rawDate
                ),

              firstLogin:
                null,

              lastLogout:
                null,

              totalWorkSeconds:
                0,
            };
          }

          const daily =
            grouped[
              dateKey
            ];

          if (
            record.login_time
          ) {
            if (
              !daily.firstLogin ||
              new Date(
                record.login_time
              ) <
                new Date(
                  daily.firstLogin
                )
            ) {
              daily.firstLogin =
                record.login_time;
            }
          }

          if (
            record.logout_time
          ) {
            if (
              !daily.lastLogout ||
              new Date(
                record.logout_time
              ) >
                new Date(
                  daily.lastLogout
                )
            ) {
              daily.lastLogout =
                record.logout_time;
            }
          }

          daily
            .totalWorkSeconds +=
            Number(
              record
                .work_duration_seconds ||
                0
            );
        }
      );

      return Object.values(
        grouped
      ).sort(
        (a, b) =>
          new Date(
            b.dateKey
          ) -
          new Date(
            a.dateKey
          )
      );
    }, [
      reportData,
      reportType,
      selectedEmployee,
    ]);

  // ==========================================
  // ATTENDANCE SUMMARY
  // ==========================================

  const totalWorkSeconds =
    useMemo(() => {
      return dailyAttendance.reduce(
        (
          total,
          day
        ) =>
          total +
          day.totalWorkSeconds,
        0
      );
    }, [
      dailyAttendance,
    ]);

  const averageWorkSeconds =
    useMemo(() => {
      if (
        dailyAttendance.length ===
        0
      ) {
        return 0;
      }

      return Math.round(
        totalWorkSeconds /
          dailyAttendance.length
      );
    }, [
      totalWorkSeconds,
      dailyAttendance,
    ]);

  const chartData =
    useMemo(() => {
      return dailyAttendance
        .map(
          (day) => ({
            date:
              day.displayDate,

            workingHours:
              Number(
                (
                  day.totalWorkSeconds /
                  3600
                ).toFixed(
                  2
                )
              ),
          })
        )
        .reverse();
    }, [
      dailyAttendance,
    ]);

  // ==========================================
  // TASK SUMMARY
  // ==========================================

  const taskSummary =
    useMemo(() => {
      const total =
        reportData.length;

      const completed =
        reportData.filter(
          (task) =>
            String(
              task.status ||
                ""
            ).toLowerCase() ===
            "closed"
        ).length;

      const inProgress =
        reportData.filter(
          (task) => {
            const status =
              String(
                task.status ||
                  ""
              )
                .toLowerCase()
                .replace(
                  /[-\s]/g,
                  "_"
                );

            return (
              status ===
                "in_progress" ||
              status ===
                "progress"
            );
          }
        ).length;

      const pendingReview =
        reportData.filter(
          (task) =>
            String(
              task.status || ""
            )
              .toLowerCase()
              .replace(/[-\s]/g, "_") ===
            "pending_review"
        ).length;

      const totalWorkHours =
        Math.round(
          reportData.reduce(
            (sum, task) =>
              sum + (Number(task.total_work_hours) || 0),
            0
          ) * 100
        ) / 100;

      return {
        total,
        completed,
        inProgress,
        pendingReview,
        totalWorkHours,
      };
    }, [
      reportData,
    ]);

  // ==========================================
  // LEAVE SUMMARY
  // ==========================================

  const leaveSummary =
    useMemo(() => {
      const total =
        reportData.length;

      const pending =
        reportData.filter(
          (leave) =>
            String(
              leave.status ||
                ""
            ).toLowerCase() ===
            "pending"
        ).length;

      const approved =
        reportData.filter(
          (leave) =>
            String(
              leave.status ||
                ""
            ).toLowerCase() ===
            "approved"
        ).length;

      const rejected =
        reportData.filter(
          (leave) =>
            String(
              leave.status ||
                ""
            ).toLowerCase() ===
            "rejected"
        ).length;

      return {
        total,
        pending,
        approved,
        rejected,
      };
    }, [
      reportData,
    ]);

  // ==========================================
  // EMPLOYEE SUMMARY
  // ==========================================

  const employeeSummary =
    useMemo(() => {
      const total =
        reportData.length;

      const active =
        reportData.filter(
          (employee) =>
            String(
              employee.status ||
                ""
            ).toLowerCase() ===
            "active"
        ).length;

      const inactive =
        total -
        active;

      return {
        total,
        active,
        inactive,
      };
    }, [
      reportData,
    ]);

  // ==========================================
  // TASK STATUS
  // ==========================================

  const getTaskStatusLabel = (
    status
  ) => {
    const value =
      String(
        status || ""
      )
        .toLowerCase()
        .replace(
          /[-\s]/g,
          "_"
        );

    if (
      value ===
      "closed"
    ) {
      return "Completed";
    }

    if (
      value ===
        "in_progress" ||
      value ===
        "progress"
    ) {
      return "In Progress";
    }

    if (
      value ===
      "pending_review"
    ) {
      return "Pending Review";
    }

    return (
      status ||
      "Unknown"
    );
  };

  const getTaskStatusClass = (
    status
  ) => {
    const value =
      String(
        status || ""
      )
        .toLowerCase()
        .replace(
          /[-\s]/g,
          "_"
        );

    if (
      value ===
      "closed"
    ) {
      return "completed";
    }

    if (
      value ===
      "pending_review"
    ) {
      return "pending-review";
    }

    return "progress";
  };

  // ==========================================
  // LEAVE STATUS
  // ==========================================

  const getLeaveStatusLabel = (
    status
  ) => {
    const value =
      String(
        status || ""
      ).toLowerCase();

    if (
      value ===
      "approved"
    ) {
      return "Approved";
    }

    if (
      value ===
      "rejected"
    ) {
      return "Rejected";
    }

    if (
      value ===
      "pending"
    ) {
      return "Pending";
    }

    return (
      status ||
      "Unknown"
    );
  };

  const getLeaveStatusClass = (
    status
  ) => {
    const value =
      String(
        status || ""
      ).toLowerCase();

    if (
      value ===
      "approved"
    ) {
      return "completed";
    }

    if (
      value ===
      "rejected"
    ) {
      return "rejected";
    }

    return "progress";
  };

  // ==========================================
  // APPLY FILTER
  // ==========================================

  const handleApplyFilter =
    () => {
      if (
        requiresEmployee &&
        !selectedEmployee
      ) {
        setError(
          "Please select an employee first."
        );

        return;
      }

      if (
        fromDate &&
        toDate &&
        fromDate >
          toDate
      ) {
        setError(
          "From Date cannot be after To Date."
        );

        return;
      }

      loadReport(
        selectedEmployee,
        reportType
      );
    };

  // ==========================================
  // EXPORT
  // ==========================================

 // ==========================================
// EXPORT EXCEL REPORT
// ==========================================

const handleExport = async () => {
  try {
    // ========================================
    // VALIDATE EMPLOYEE
    // ATTENDANCE + TASK REPORTS
    // ========================================

    if (
      requiresEmployee &&
      !selectedEmployee
    ) {
      setError(
        "Please select an employee before exporting."
      );

      return;
    }

    // ========================================
    // VALIDATE DATE RANGE
    // ========================================

    if (
      fromDate &&
      toDate &&
      fromDate > toDate
    ) {
      setError(
        "From Date cannot be after To Date."
      );

      return;
    }

    setError("");

    // ========================================
    // CREATE QUERY PARAMETERS
    // ========================================

    const params = {};

    if (
      selectedEmployee
    ) {
      params.employeeId =
        selectedEmployee;
    }

    if (fromDate) {
      params.fromDate =
        fromDate;
    }

    if (toDate) {
      params.toDate =
        toDate;
    }

    // ========================================
    // REQUEST EXCEL FILE
    // ========================================

    const response =
      await api.get(
        `/reports/export/${reportType}`,
        {
          params,

          responseType:
            "blob",
        }
      );

    // ========================================
    // CREATE DOWNLOAD BLOB
    // ========================================

    const blob =
      new Blob(
        [
          response.data,
        ],
        {
          type:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }
      );

    // ========================================
    // CREATE TEMPORARY DOWNLOAD URL
    // ========================================

    const url =
      window.URL.createObjectURL(
        blob
      );

    // ========================================
    // CREATE DOWNLOAD LINK
    // ========================================

    const link =
      document.createElement(
        "a"
      );

    link.href =
      url;

    // ========================================
    // CREATE FILE NAME
    // ========================================

    const dateStamp =
      new Date()
        .toISOString()
        .slice(
          0,
          10
        );

    let fileName =
      `${reportType}-report-${dateStamp}.xlsx`;

    if (
      selectedEmployee &&
      (
        reportType ===
          "attendance" ||
        reportType ===
          "tasks"
      )
    ) {
      fileName =
        `${selectedEmployee}-${reportType}-report-${dateStamp}.xlsx`;
    }

    link.setAttribute(
      "download",
      fileName
    );

    // ========================================
    // START DOWNLOAD
    // ========================================

    document.body.appendChild(
      link
    );

    link.click();

    // ========================================
    // CLEANUP
    // ========================================

    link.remove();

    window.URL.revokeObjectURL(
      url
    );

  } catch (error) {
    console.error(
      "Excel export error:",
      error
    );

    setError(
      "Unable to export Excel report. Please try again."
    );
  }
};
  // ==========================================
  // EMPLOYEE HEADER
  // ==========================================

  const renderEmployeeHeader = (
    title
  ) => (
    <section className="attendance-employee-card">

      <div className="attendance-employee-avatar">

        {employeeDetails
          ?.profile_photo ? (

          <img
            src={
              employeeDetails
                .profile_photo
                .startsWith(
                  "http"
                )
                ? employeeDetails
                    .profile_photo
                : `http://localhost:5000${employeeDetails.profile_photo}`
            }
            alt={
              employeeDetails
                .full_name
            }
          />

        ) : (

          employeeDetails
            ?.full_name
            ?.charAt(0)
            .toUpperCase() ||
          "E"

        )}

      </div>

      <div>

        <span>
          {title}
        </span>

        <h2>
          {
            employeeDetails
              ?.full_name
          }
        </h2>

        <p>

          {
            employeeDetails
              ?.employee_id
          }

          {employeeDetails
            ?.designation
            ? ` • ${employeeDetails.designation}`
            : ""}

        </p>

      </div>

    </section>
  );

  // ==========================================
  // RENDER
  // ==========================================

return (
<>

       <div className="admin-page-content">

          {/* ==================================
              PAGE HEADER
          ================================== */}

          <div className="admin-reports-page-header">

            <div>

              <h1>
                Reports
              </h1>

              <p>
                View employee attendance,
                tasks, leave and employee
                information.
              </p>

            </div>

            <button
              type="button"
              className="admin-reports-export-button"
              onClick={
                handleExport
              }
            >

              <FaFileExcel />

              Export Excel

            </button>

          </div>

          {/* ==================================
              REPORT CARDS
          ================================== */}

          <div className="admin-reports-type-grid">

            {reports.map(
              (report) => (

                <button
                  type="button"
                  key={
                    report.id
                  }
                  className={
                    reportType ===
                    report.id
                      ? "admin-report-type-card active"
                      : "admin-report-type-card"
                  }
                  onClick={() =>
                    handleReportTypeChange(
                      report.id
                    )
                  }
                >

                  <div className="admin-report-type-icon">

                    {
                      report.icon
                    }

                  </div>

                  <div>

                    <h3>
                      {
                        report.title
                      }
                    </h3>

                    <p>
                      {
                        report.description
                      }
                    </p>

                  </div>

                </button>

              )
            )}

          </div>

          {/* ==================================
              FILTER SECTION
          ================================== */}

          <section className="admin-reports-filter-card">

            <div className="admin-reports-filter-title">

              {reportType ===
              "employees" ? (

                <FaSearch />

              ) : (

                <FaFilter />

              )}

              <div>

                <h2>

                  {reportType ===
                  "employees"
                    ? "Employee Search"
                    : "Report Filters"}

                </h2>

                <p>

                  {reportType ===
                  "employees"
                    ? "Search registered employees."
                    : "Select employee and date range."}

                </p>

              </div>

            </div>

            {reportType ===
            "employees" ? (

              /* ==============================
                  EMPLOYEE SEARCH
              ============================== */

              <div className="admin-reports-filter-row">

                <div className="admin-reports-field employee-select-field">

                  <label>
                    Search Employee
                  </label>

                  <input
                    type="text"
                    value={
                      employeeSearch
                    }
                    onChange={(
                      event
                    ) =>
                      setEmployeeSearch(
                        event.target
                          .value
                      )
                    }
                    placeholder="Search by ID, name, email, phone or designation"
                  />

                </div>

                <button
                  type="button"
                  className="admin-reports-filter-button"
                  onClick={() =>
                    setEmployeeSearch(
                      ""
                    )
                  }
                >

                  <FaSyncAlt />

                  Clear Search

                </button>

              </div>

            ) : (

              /* ==============================
                  ATTENDANCE/TASK/LEAVE FILTER
              ============================== */

              <div className="admin-reports-filter-row">

                <div className="admin-reports-field employee-select-field">

                  <label>
                    Employee
                  </label>

                  <select
                    value={
                      selectedEmployee
                    }
                    onChange={
                      handleEmployeeChange
                    }
                  >

                    <option value="">
                      Select Employee
                    </option>

                    {employees.map(
                      (
                        employee
                      ) => (

                        <option
                          key={
                            employee.id
                          }
                          value={
                            employee
                              .employee_id
                          }
                        >

                          {
                            employee
                              .employee_id
                          }

                          {" - "}

                          {
                            employee
                              .full_name
                          }

                        </option>

                      )
                    )}

                  </select>

                </div>

                <div className="admin-reports-field">

                  <label>
                    From Date
                  </label>

                  <input
                    type="date"
                    value={
                      fromDate
                    }
                    onChange={(
                      event
                    ) =>
                      setFromDate(
                        event.target
                          .value
                      )
                    }
                  />

                </div>

                <div className="admin-reports-field">

                  <label>
                    To Date
                  </label>

                  <input
                    type="date"
                    value={
                      toDate
                    }
                    onChange={(
                      event
                    ) =>
                      setToDate(
                        event.target
                          .value
                      )
                    }
                  />

                </div>

                <button
                  type="button"
                  className="admin-reports-filter-button"
                  onClick={
                    handleApplyFilter
                  }
                >

                  <FaFilter />

                  Apply Filter

                </button>

              </div>

            )}

          </section>

          {/* ==================================
              ERROR
          ================================== */}

          {error && (

            <div className="admin-reports-error">

              {error}

            </div>

          )}

          {/* ==================================
              LOADING
          ================================== */}

          {loading && (

            <div className="admin-reports-loading">

              Loading report...

            </div>

          )}

          {/* ==================================
              ATTENDANCE REPORT
          ================================== */}

          {!loading &&
            reportType ===
              "attendance" && (

            <>

              {!selectedEmployee ? (

                <section className="admin-reports-empty-card">

                  <FaUsers />

                  <h2>
                    Select an Employee
                  </h2>

                  <p>
                    Select an employee
                    above to view their
                    individual attendance
                    report.
                  </p>

                </section>

              ) : reportData.length ===
                0 ? (

                <section className="admin-reports-empty-card">

                  <FaCalendarCheck />

                  <h2>
                    No Attendance Data
                  </h2>

                  <p>
                    No attendance records
                    were found for this
                    employee and selected
                    date range.
                  </p>

                </section>

              ) : (

                <>

                  {renderEmployeeHeader(
                    "Attendance Report"
                  )}

                  <div className="attendance-summary-grid">

                    <div className="attendance-summary-card">

                      <FaCalendarCheck />

                      <div>

                        <span>
                          Working Days
                        </span>

                        <strong>
                          {
                            dailyAttendance
                              .length
                          }
                        </strong>

                      </div>

                    </div>

                    <div className="attendance-summary-card">

                      <FaClock />

                      <div>

                        <span>
                          Total Working Hours
                        </span>

                        <strong>
                          {formatDuration(
                            totalWorkSeconds
                          )}
                        </strong>

                      </div>

                    </div>

                    <div className="attendance-summary-card">

                      <FaChartLine />

                      <div>

                        <span>
                          Average Daily Hours
                        </span>

                        <strong>
                          {formatDuration(
                            averageWorkSeconds
                          )}
                        </strong>

                      </div>

                    </div>

                  </div>

                  <section className="attendance-chart-card">

                    <div className="attendance-section-title">

                      <div>

                        <h2>
                          Daily Working Hours
                        </h2>

                        <p>
                          Total working
                          hours for each
                          date.
                        </p>

                      </div>

                    </div>

                    <div className="attendance-chart-container">

                      <ResponsiveContainer
                        width="100%"
                        height={350}
                      >

                        <BarChart
                          data={
                            chartData
                          }
                          margin={{
                            top: 20,
                            right: 30,
                            left: 10,
                            bottom: 20,
                          }}
                        >

                          <CartesianGrid
                            strokeDasharray="3 3"
                          />

                          <XAxis
                            dataKey="date"
                          />

                          <YAxis
                            label={{
                              value:
                                "Working Hours",
                              angle:
                                -90,
                              position:
                                "insideLeft",
                            }}
                          />

                          <Tooltip />

                          <Bar
                            dataKey="workingHours"
                            name="Working Hours"
                            fill="#16A66A"
                          />

                        </BarChart>

                      </ResponsiveContainer>

                    </div>

                  </section>

                  <section className="attendance-report-table-card">

                    <div className="attendance-section-title">

                      <div>

                        <h2>
                          Attendance Details
                        </h2>

                        <p>
                          Daily login,
                          logout and total
                          working hours.
                        </p>

                      </div>

                      <button
                        type="button"
                        className="attendance-refresh-button"
                        onClick={() =>
                          loadReport(
                            selectedEmployee,
                            "attendance"
                          )
                        }
                      >

                        <FaSyncAlt />

                        Refresh

                      </button>

                    </div>

                    <div className="attendance-table-wrapper">

                      <table className="attendance-report-table">

                        <thead>

                          <tr>

                            <th>
                              Date
                            </th>

                            <th>
                              Login Time
                            </th>

                            <th>
                              Logout Time
                            </th>

                            <th>
                              Total Working Hours
                            </th>

                          </tr>

                        </thead>

                        <tbody>

                          {dailyAttendance.map(
                            (
                              day
                            ) => (

                              <tr
                                key={
                                  day.dateKey
                                }
                              >

                                <td>
                                  {
                                    day.displayDate
                                  }
                                </td>

                                <td>
                                  {formatTime(
                                    day.firstLogin
                                  )}
                                </td>

                                <td>
                                  {formatTime(
                                    day.lastLogout
                                  )}
                                </td>

                                <td className="work-time-cell">

                                  {formatDuration(
                                    day.totalWorkSeconds
                                  )}

                                </td>

                              </tr>

                            )
                          )}

                        </tbody>

                      </table>

                    </div>

                  </section>

                </>

              )}

            </>

          )}

          {/* ==================================
              TASK REPORT
          ================================== */}

          {!loading &&
            reportType ===
              "tasks" && (

            <>

              {!selectedEmployee ? (

                <section className="admin-reports-empty-card">

                  <FaTasks />

                  <h2>
                    Select an Employee
                  </h2>

                  <p>
                    Select an employee
                    above to view their
                    individual task
                    report.
                  </p>

                </section>

              ) : reportData.length ===
                0 ? (

                <section className="admin-reports-empty-card">

                  <FaTasks />

                  <h2>
                    No Task Data
                  </h2>

                  <p>
                    No tasks were found
                    for this employee and
                    selected date range.
                  </p>

                </section>

              ) : (

                <>

                  {renderEmployeeHeader(
                    "Task Report"
                  )}

                  <div className="attendance-summary-grid">

                    <div className="attendance-summary-card">

                      <FaListAlt />

                      <div>

                        <span>
                          Total Tasks
                        </span>

                        <strong>
                          {
                            taskSummary
                              .total
                          }
                        </strong>

                      </div>

                    </div>

                    <div className="attendance-summary-card">

                      <FaSpinner />

                      <div>

                        <span>
                          In Progress
                        </span>

                        <strong>
                          {
                            taskSummary
                              .inProgress
                          }
                        </strong>

                      </div>

                    </div>

                    <div className="attendance-summary-card">

                      <FaHourglassHalf />

                      <div>

                        <span>
                          Pending Review
                        </span>

                        <strong>
                          {
                            taskSummary
                              .pendingReview
                          }
                        </strong>

                      </div>

                    </div>

                    <div className="attendance-summary-card">

                      <FaCheckCircle />

                      <div>

                        <span>
                          Completed
                        </span>

                        <strong>
                          {
                            taskSummary
                              .completed
                          }
                        </strong>

                      </div>

                    </div>

                    <div className="attendance-summary-card">

                      <FaClock />

                      <div>

                        <span>
                          Total Work Time
                        </span>

                        <strong>
                          {formatHours(
                            taskSummary
                              .totalWorkHours
                          )}
                        </strong>

                      </div>

                    </div>

                  </div>

                  <section className="attendance-report-table-card">

                    <div className="attendance-section-title">

                      <div>

                        <h2>
                          Task Details
                        </h2>

                        <p>
                          Tasks the selected
                          employee actually
                          worked on during the
                          selected date range.
                        </p>

                      </div>

                      <button
                        type="button"
                        className="attendance-refresh-button"
                        onClick={() =>
                          loadReport(
                            selectedEmployee,
                            "tasks"
                          )
                        }
                      >

                        <FaSyncAlt />

                        Refresh

                      </button>

                    </div>

                    <div className="attendance-table-wrapper">

                      <table className="attendance-report-table">

                        <thead>

                          <tr>

                            <th>
                              Task Title
                            </th>

                            <th>
                              Description
                            </th>

                            <th>
                              Project
                            </th>

                            <th>
                              Status
                            </th>

                            <th>
                              Progress
                            </th>

                            <th>
                              Work Date(s)
                            </th>

                            <th>
                              Total Work Time
                            </th>

                            <th>
                              Start Time
                            </th>

                            <th>
                              Completed Time
                            </th>

                          </tr>

                        </thead>

                        <tbody>

                          {reportData.map(
                            (
                              task
                            ) => (

                              <tr
                                key={
                                  task.id
                                }
                              >

                                <td className="task-report-title">

                                  {
                                    task.task_title ||
                                    "--"
                                  }

                                </td>

                                <td className="task-report-description">

                                  <div>
                                    {
                                      task.task_description ||
                                      "--"
                                    }
                                  </div>

                                  {task.work_descriptions &&
                                    task.work_descriptions
                                      .length >
                                      0 && (

                                    <ul className="task-report-worklog-list">

                                      {task.work_descriptions.map(
                                        (
                                          desc,
                                          index
                                        ) => (
                                          <li
                                            key={
                                              index
                                            }
                                          >
                                            {desc}
                                          </li>
                                        )
                                      )}

                                    </ul>

                                  )}

                                </td>

                                <td>

                                  {task.project_name ||
                                    "--"}

                                </td>

                                <td>

                                  <span
                                    className={`task-report-status ${getTaskStatusClass(
                                      task.status
                                    )}`}
                                  >

                                    {getTaskStatusLabel(
                                      task.status
                                    )}

                                  </span>

                                </td>

                                <td>

                                  {task.progress !=
                                  null
                                    ? `${task.progress}%`
                                    : "--"}

                                </td>

                                <td>

                                  {task.work_dates &&
                                  task.work_dates
                                    .length >
                                    0
                                    ? task.work_dates
                                        .map(
                                          (
                                            date
                                          ) =>
                                            formatDate(
                                              date
                                            )
                                        )
                                        .join(
                                          ", "
                                        )
                                    : "--"}

                                </td>

                                <td className="work-time-cell">

                                  {task.total_work_hours >
                                  0
                                    ? formatHours(
                                        task.total_work_hours
                                      )
                                    : "--"}

                                  {task.is_currently_working && (

                                    <div className="task-report-active-note">
                                      Active
                                      since{" "}
                                      {formatTime(
                                        task.work_started_at
                                      )}
                                    </div>

                                  )}

                                </td>

                                <td>

                                  {formatDateTime(
                                    task.start_time
                                  )}

                                </td>

                                <td>

                                  {formatDateTime(
                                    task.completed_time
                                  )}

                                </td>

                              </tr>

                            )
                          )}

                        </tbody>

                      </table>

                    </div>

                  </section>

                </>

              )}

            </>

          )}

          {/* ==================================
              LEAVE REPORT
          ================================== */}

          {!loading &&
            reportType ===
              "leave" && (

            <>

              {!selectedEmployee ? (

                <section className="admin-reports-empty-card">

                  <FaCalendarAlt />

                  <h2>
                    Select an Employee
                  </h2>

                  <p>
                    Select an employee
                    above to view their
                    individual leave
                    report.
                  </p>

                </section>

              ) : reportData.length ===
                0 ? (

                <section className="admin-reports-empty-card">

                  <FaCalendarAlt />

                  <h2>
                    No Leave Data
                  </h2>

                  <p>
                    No leave requests
                    were found for this
                    employee and selected
                    date range.
                  </p>

                </section>

              ) : (

                <>

                  {renderEmployeeHeader(
                    "Leave Report"
                  )}

                  <div className="attendance-summary-grid">

                    <div className="attendance-summary-card">

                      <FaCalendarAlt />

                      <div>

                        <span>
                          Total Requests
                        </span>

                        <strong>
                          {
                            leaveSummary
                              .total
                          }
                        </strong>

                      </div>

                    </div>

                    <div className="attendance-summary-card">

                      <FaHourglassHalf />

                      <div>

                        <span>
                          Pending
                        </span>

                        <strong>
                          {
                            leaveSummary
                              .pending
                          }
                        </strong>

                      </div>

                    </div>

                    <div className="attendance-summary-card">

                      <FaCheckCircle />

                      <div>

                        <span>
                          Approved
                        </span>

                        <strong>
                          {
                            leaveSummary
                              .approved
                          }
                        </strong>

                      </div>

                    </div>

                    <div className="attendance-summary-card">

                      <FaTimesCircle />

                      <div>

                        <span>
                          Rejected
                        </span>

                        <strong>
                          {
                            leaveSummary
                              .rejected
                          }
                        </strong>

                      </div>

                    </div>

                  </div>

                  <section className="attendance-report-table-card">

                    <div className="attendance-section-title">

                      <div>

                        <h2>
                          Leave Details
                        </h2>

                        <p>
                          Leave requests
                          submitted by the
                          selected employee.
                        </p>

                      </div>

                      <button
                        type="button"
                        className="attendance-refresh-button"
                        onClick={() =>
                          loadReport(
                            selectedEmployee,
                            "leave"
                          )
                        }
                      >

                        <FaSyncAlt />

                        Refresh

                      </button>

                    </div>

                    <div className="attendance-table-wrapper">

                      <table className="attendance-report-table">

                        <thead>

                          <tr>

                            <th>
                              Leave Type
                            </th>

                            <th>
                              From Date
                            </th>

                            <th>
                              To Date
                            </th>

                            <th>
                              Reason
                            </th>

                            <th>
                              Status
                            </th>

                            <th>
                              Admin Comment
                            </th>

                            <th>
                              Requested On
                            </th>

                          </tr>

                        </thead>

                        <tbody>

                          {reportData.map(
                            (
                              leave
                            ) => (

                              <tr
                                key={
                                  leave.id
                                }
                              >

                                <td className="task-report-title">

                                  {
                                    leave.leave_type ||
                                    "--"
                                  }

                                </td>

                                <td>

                                  {formatDate(
                                    leave.from_date
                                  )}

                                </td>

                                <td>

                                  {formatDate(
                                    leave.to_date
                                  )}

                                </td>

                                <td className="task-report-description">

                                  {
                                    leave.reason ||
                                    "--"
                                  }

                                </td>

                                <td>

                                  <span
                                    className={`task-report-status ${getLeaveStatusClass(
                                      leave.status
                                    )}`}
                                  >

                                    {getLeaveStatusLabel(
                                      leave.status
                                    )}

                                  </span>

                                </td>

                                <td>

                                  {
                                    leave.admin_comment ||
                                    "--"
                                  }

                                </td>

                                <td>

                                  {formatDateTime(
                                    leave.created_at
                                  )}

                                </td>

                              </tr>

                            )
                          )}

                        </tbody>

                      </table>

                    </div>

                  </section>

                </>

              )}

            </>

          )}

          {/* ==================================
              EMPLOYEE REPORT
          ================================== */}

          {!loading &&
            reportType ===
              "employees" && (

            <>

              <div className="attendance-summary-grid">

                <div className="attendance-summary-card">

                  <FaUsers />

                  <div>

                    <span>
                      Total Employees
                    </span>

                    <strong>
                      {
                        employeeSummary
                          .total
                      }
                    </strong>

                  </div>

                </div>

                <div className="attendance-summary-card">

                  <FaCheckCircle />

                  <div>

                    <span>
                      Active Employees
                    </span>

                    <strong>
                      {
                        employeeSummary
                          .active
                      }
                    </strong>

                  </div>

                </div>

                <div className="attendance-summary-card">

                  <FaTimesCircle />

                  <div>

                    <span>
                      Inactive Employees
                    </span>

                    <strong>
                      {
                        employeeSummary
                          .inactive
                      }
                    </strong>

                  </div>

                </div>

                <div className="attendance-summary-card">

                  <FaSearch />

                  <div>

                    <span>
                      Search Results
                    </span>

                    <strong>
                      {
                        filteredEmployees
                          .length
                      }
                    </strong>

                  </div>

                </div>

              </div>

              <section className="attendance-report-table-card">

                <div className="attendance-section-title">

                  <div>

                    <h2>
                      Employee Details
                    </h2>

                    <p>
                      View all registered
                      employee information.
                    </p>

                  </div>

                  <button
                    type="button"
                    className="attendance-refresh-button"
                    onClick={async () => {
                      setEmployeeSearch(
                        ""
                      );

                      try {
                        setLoading(
                          true
                        );

                        const response =
                          await api.get(
                            "/reports/employees"
                          );

                        setReportData(
                          response.data
                            ?.data ||
                            []
                        );

                        setEmployees(
                          response.data
                            ?.data ||
                            []
                        );
                      } catch (error) {
                        setError(
                          "Unable to refresh employee report"
                        );
                      } finally {
                        setLoading(
                          false
                        );
                      }
                    }}
                  >

                    <FaSyncAlt />

                    Refresh

                  </button>

                </div>

                {filteredEmployees.length ===
                0 ? (

                  <div className="admin-reports-empty-card">

                    <FaUsers />

                    <h2>
                      No Employees Found
                    </h2>

                    <p>
                      No employees match
                      your current search.
                    </p>

                  </div>

                ) : (

                  <div className="attendance-table-wrapper">

                    <table className="attendance-report-table">

                      <thead>

                        <tr>

                          <th>
                            Employee
                          </th>

                          <th>
                            Employee ID
                          </th>

                          <th>
                            Designation
                          </th>

                          <th>
                            Email
                          </th>

                          <th>
                            Phone
                          </th>

                          <th>
                            Status
                          </th>

                          <th>
                            Date of Birth
                          </th>

                          <th>
                            Emergency Contact
                          </th>

                          <th>
                            Address
                          </th>

                          <th>
                            Last Login
                          </th>

                          <th>
                            Joined Date
                          </th>

                        </tr>

                      </thead>

                      <tbody>

                        {filteredEmployees.map(
                          (
                            employee
                          ) => (

                            <tr
                              key={
                                employee.id
                              }
                            >

                              <td>

                                <div
                                  style={{
                                    display:
                                      "flex",

                                    alignItems:
                                      "center",

                                    gap:
                                      "10px",

                                    minWidth:
                                      "170px",
                                  }}
                                >

                                  <div
                                    className="attendance-employee-avatar"
                                    style={{
                                      width:
                                        "40px",

                                      height:
                                        "40px",

                                      minWidth:
                                        "40px",

                                      fontSize:
                                        "15px",
                                    }}
                                  >

                                    {employee
                                      .profile_photo ? (

                                      <img
                                        src={
                                          employee
                                            .profile_photo
                                            .startsWith(
                                              "http"
                                            )
                                            ? employee
                                                .profile_photo
                                            : `http://localhost:5000${employee.profile_photo}`
                                        }
                                        alt={
                                          employee
                                            .full_name
                                        }
                                      />

                                    ) : (

                                      employee
                                        .full_name
                                        ?.charAt(
                                          0
                                        )
                                        .toUpperCase() ||
                                      "E"

                                    )}

                                  </div>

                                  <strong>

                                    {
                                      employee
                                        .full_name ||
                                      "--"
                                    }

                                  </strong>

                                </div>

                              </td>

                              <td>

                                <strong>

                                  {
                                    employee
                                      .employee_id ||
                                    "--"
                                  }

                                </strong>

                              </td>

                              <td>

                                {
                                  employee
                                    .designation ||
                                  "--"
                                }

                              </td>

                              <td>

                                {
                                  employee
                                    .email ||
                                  "--"
                                }

                              </td>

                              <td>

                                {
                                  employee
                                    .phone ||
                                  "--"
                                }

                              </td>

                              <td>

                                <span
                                  className={`task-report-status ${
                                    String(
                                      employee.status ||
                                        ""
                                    ).toLowerCase() ===
                                    "active"
                                      ? "completed"
                                      : "progress"
                                  }`}
                                >

                                  {
                                    employee
                                      .status ||
                                    "Unknown"
                                  }

                                </span>

                              </td>

                              <td>

                                {formatDate(
                                  employee
                                    .date_of_birth
                                )}

                              </td>

                              <td>

                                {
                                  employee
                                    .emergency_contact ||
                                  "--"
                                }

                              </td>

                              <td>

                                <div
                                  style={{
                                    minWidth:
                                      "180px",

                                    maxWidth:
                                      "260px",

                                    whiteSpace:
                                      "normal",
                                  }}
                                >

                                  {
                                    employee
                                      .address ||
                                    "--"
                                  }

                                </div>

                              </td>

                              <td>

                                {formatDateTime(
                                  employee
                                    .last_login
                                )}

                              </td>

                              <td>

                                {formatDate(
                                  employee
                                    .created_at
                                )}

                              </td>

                            </tr>

                          )
                        )}

                      </tbody>

                    </table>

                  </div>

                )}

              </section>

            </>

          )}

        </div>

      </>

    
  );
}

export default AdminReports;