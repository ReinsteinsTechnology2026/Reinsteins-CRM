import {
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  FaCalendarAlt,
  FaClock,
  FaCheckCircle,
  FaTimesCircle,
  FaUmbrellaBeach,
  FaIdBadge,
  FaChevronLeft,
  FaChevronRight,
  FaClipboardList,
  FaChartPie,
  FaLightbulb,
  FaRegCircle,
  FaExclamationTriangle,
  FaRedoAlt,
} from "react-icons/fa";

import {
  toast,
} from "react-toastify";

import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
} from "recharts";

import api from "../../services/api";

import "./EmployeeAttendance.css";


// ==========================================
// ATTENDANCE RECORD CLASSIFICATION
//
// Single source of truth for "is this row Present,
// Absent, or Leave" -- used identically for the
// monthly summary cards, the donut chart + legend,
// the per-row table status badge, and the workable-
// days total, so none of them can ever disagree.
//
// The real backend (server/controllers/
// attendanceController.js, getMonthlyAttendanceHistory)
// sends a resolved `status` string per day: "Present",
// "Absent", or one of six leave codes -- CL / SL / PL /
// UL / OL / LEAVE (getLeaveCode's own output). It never
// sends a separate `leave_type` field on history rows.
// The previous classification only recognized a literal
// "leave"/"on_leave" status or a `leave_type` field that
// never actually arrives, so every real leave day fell
// through to Absent. This checks the six real codes
// first (case-insensitively), then falls back to the
// older literal-status / leave_type shape for any other
// caller still using it.
// ==========================================

const BACKEND_LEAVE_CODES = new Set([
  "cl",
  "sl",
  "pl",
  "ul",
  "ol",
  "leave",
]);

const BACKEND_LEAVE_LABELS = {
  cl: "CL",
  sl: "SL",
  pl: "PL",
  ul: "UL",
  ol: "OL",
  leave: "LEAVE",
};

function getLegacyLeaveLabel(legacyLeaveType, record) {

  if (legacyLeaveType.includes("casual")) {
    return "CL";
  }

  if (legacyLeaveType.includes("sick")) {
    return "SL";
  }

  if (legacyLeaveType.includes("earned")) {
    return "EL";
  }

  if (legacyLeaveType.includes("paid")) {
    return "PL";
  }

  if (legacyLeaveType) {
    return legacyLeaveType.substring(0, 2).toUpperCase();
  }

  return (
    record?.leave_code ||
    record?.leaveCode ||
    "Leave"
  );
}

// Returns { bucket: "present" | "absent" | "leave", label: string } --
// bucket drives counting/coloring, label drives the badge text.
// Leave is checked first (matching the backend's own precedence: an
// approved leave day is classified as Leave even if some attendance
// also exists for it), so a record can never land in two buckets at
// once.
function classifyAttendanceRecord(record) {

  const rawStatus =
    String(
      record?.status ||
      record?.attendance_status ||
      ""
    )
      .trim()
      .toLowerCase();

  const legacyLeaveType =
    String(
      record?.leave_type ||
      record?.leaveType ||
      ""
    )
      .trim()
      .toLowerCase();

  const isLegacyLeaveStatus =
    rawStatus === "on_leave";

  if (
    BACKEND_LEAVE_CODES.has(rawStatus) ||
    legacyLeaveType ||
    isLegacyLeaveStatus
  ) {

    const label =
      BACKEND_LEAVE_LABELS[rawStatus] ||
      getLegacyLeaveLabel(
        legacyLeaveType,
        record
      );

    return {
      bucket: "leave",
      label,
    };
  }

  if (
    rawStatus === "present" ||
    rawStatus === "completed" ||
    rawStatus === "working" ||
    record?.first_login_time ||
    record?.login_time
  ) {

    return {
      bucket: "present",
      label: "Present",
    };
  }

  // Explicit "absent" and any other/unrecognized status with no
  // login signal both fall back to Absent -- same fallback
  // semantics the previous implementation already had.

  return {
    bucket: "absent",
    label: "Absent",
  };
}


function EmployeeAttendance() {

  // ==========================================
  // LOGGED-IN USER
  // ==========================================

  const storedUser =
    sessionStorage.getItem("user") ||
    localStorage.getItem("user");

  let user = null;

  try {
    user = storedUser
      ? JSON.parse(storedUser)
      : null;
  } catch (error) {
    console.error(
      "Unable to read user:",
      error
    );
  }


  // ==========================================
  // EMPLOYEE JOIN DATE
  // ==========================================

const employeeJoinDate =
  user?.createdAt ||
  user?.created_at ||
  user?.joiningDate ||
  user?.joining_date ||
  null;

  // ==========================================
  // CURRENT DATE
  // ==========================================

  const currentDate = new Date();

  const currentYear =
    currentDate.getFullYear();

  const currentMonth =
    currentDate.getMonth() + 1;


  const currentMonthValue =
    `${currentYear}-${String(
      currentMonth
    ).padStart(2, "0")}`;


  // ==========================================
  // STATE
  // ==========================================

  const [
    selectedMonth,
    setSelectedMonth,
  ] = useState(
    currentMonthValue
  );
  const [
  firstLoginMonth,
  setFirstLoginMonth,
] = useState(null);

  const [
    history,
    setHistory,
  ] = useState([]);


  const [
    loading,
    setLoading,
  ] = useState(true);

  // ==========================================
  // LOAD ERROR
  // Distinct from "loaded successfully with zero
  // records" -- a failed request must never render
  // the same empty-state card as a genuine empty
  // month.
  // ==========================================

  const [
    loadError,
    setLoadError,
  ] = useState(false);


  const [
    monthlySummary,
    setMonthlySummary,
  ] = useState({
    workableDays: 0,
    presentDays: 0,
    absentDays: 0,
    leaveDays: 0,
    totalWorkSeconds: 0,
  });

  // ==========================================
  // PAGINATION (client-side -- the monthly
  // history array is already fully loaded in one
  // request; no new API call needed)
  // ==========================================

  const [
    currentPage,
    setCurrentPage,
  ] = useState(1);

  const RECORDS_PER_PAGE = 10;


  // ==========================================
  // FORMAT DURATION
  // ==========================================

  const formatDuration = (
    seconds
  ) => {

    if (
      seconds === null ||
      seconds === undefined ||
      seconds === ""
    ) {
      return "--";
    }

    const safeSeconds =
      Math.max(
        0,
        Math.floor(
          Number(seconds) || 0
        )
      );


    const hours =
      Math.floor(
        safeSeconds / 3600
      );


    const minutes =
      Math.floor(
        (
          safeSeconds % 3600
        ) / 60
      );


    const secs =
      safeSeconds % 60;


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
  // FORMAT DURATION -- SHORT ("7h 55m")
  // Used only for the Total Work Hours card's
  // average-per-day subtext.
  // ==========================================

  const formatDurationShort = (
    seconds
  ) => {

    const safeSeconds =
      Math.max(
        0,
        Math.floor(
          Number(seconds) || 0
        )
      );

    const hours =
      Math.floor(
        safeSeconds / 3600
      );

    const minutes =
      Math.floor(
        (
          safeSeconds % 3600
        ) / 60
      );

    return `${hours}h ${minutes}m`;
  };


  // ==========================================
  // FORMAT DATE
  // ==========================================

  const formatDate = (
    date
  ) => {

    if (!date) {
      return "--";
    }


    return new Date(
      date
    ).toLocaleDateString(
      "en-IN",
      {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }
    );
  };

  // ==========================================
  // FORMAT DAY NAME ("Thu") -- derived purely
  // from the record's own date, not a new API
  // field.
  // ==========================================

  const formatDayName = (
    date
  ) => {

    if (!date) {
      return "--";
    }

    return new Date(date).toLocaleDateString(
      "en-IN",
      { weekday: "short" }
    );
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
      "en-IN",
      {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }
    );
  };


  // ==========================================
  // FORMAT MONTH NAME
  // ==========================================

  const formatMonthName = (
    monthValue
  ) => {

    if (!monthValue) {
      return "";
    }


    const [
      year,
      month,
    ] =
      monthValue.split("-");


    const date =
      new Date(
        Number(year),
        Number(month) - 1,
        1
      );


    return date.toLocaleDateString(
      "en-IN",
      {
        month: "long",
        year: "numeric",
      }
    );
  };

  // ==========================================
  // DAYS IN SELECTED MONTH
  // ==========================================

  const daysInSelectedMonth = useMemo(() => {
    if (!selectedMonth) {
      return 0;
    }

    const [year, month] = selectedMonth.split("-").map(Number);

    return new Date(year, month, 0).getDate();
  }, [selectedMonth]);


  // ==========================================
  // AVAILABLE MONTHS
  // EMPLOYEE JOIN MONTH → CURRENT MONTH
  // ==========================================

  const availableMonths =
    useMemo(() => {

      const months = [];

   let startDate;


if (firstLoginMonth) {

  const [
    firstYear,
    firstMonth,
  ] =
    firstLoginMonth.split("-");

  startDate =
    new Date(
      Number(firstYear),
      Number(firstMonth) - 1,
      1
    );

} else if (employeeJoinDate) {

  startDate =
    new Date(
      employeeJoinDate
    );

} else {

  startDate =
    new Date(
      currentYear,
      currentMonth - 1,
      1
    );
}

      const endDate =
        new Date(
          currentYear,
          currentMonth - 1,
          1
        );


      let cursor =
        new Date(
          startDate
        );


      while (
        cursor <= endDate
      ) {

        const year =
          cursor.getFullYear();


        const month =
          String(
            cursor.getMonth() + 1
          ).padStart(
            2,
            "0"
          );


        months.push({
          value:
            `${year}-${month}`,

          label:
            cursor.toLocaleDateString(
              "en-IN",
              {
                month: "long",
                year: "numeric",
              }
            ),
        });


        cursor =
          new Date(
            cursor.getFullYear(),
            cursor.getMonth() + 1,
            1
          );
      }


      return months.reverse();

 }, [
  employeeJoinDate,
  firstLoginMonth,
  currentYear,
  currentMonth,
]);


  // ==========================================
  // LOAD MONTHLY ATTENDANCE
  // ==========================================

  const loadMonthlyAttendance =
    async (
      monthValue =
        selectedMonth
    ) => {

      try {

        setLoading(
          true
        );

        setLoadError(
          false
        );


        const response =
          await api.get(
            "/attendance/monthly",
            {
              params: {
                month:
                  monthValue,
              },
            }
          );


        const data =
          response.data || {};
          if (
  data.firstLoginMonth
) {
  setFirstLoginMonth(
    data.firstLoginMonth
  );
}


        const records =
          data.history ||
          data.attendance ||
          data.data ||
          [];


        setHistory(
          Array.isArray(
            records
          )
            ? records
            : []
        );

        setCurrentPage(1);


// ==========================================
// CALCULATE MONTHLY SUMMARY FROM DAILY ROWS
// ==========================================

const safeRecords =
  Array.isArray(records)
    ? records
    : [];

let presentDays = 0;
let absentDays = 0;
let leaveDays = 0;
let totalWorkSeconds = 0;

safeRecords.forEach(
  (record) => {

    // ========================================
    // CLASSIFY (shared helper -- see module top)
    // ========================================

    const { bucket } =
      classifyAttendanceRecord(
        record
      );

    if (bucket === "leave") {

      leaveDays++;

    } else if (bucket === "present") {

      presentDays++;

    } else {

      absentDays++;

    }


    // ========================================
    // TOTAL WORK HOURS
    // ========================================

    totalWorkSeconds +=
      Number(
        record?.total_work_seconds ??
        record?.work_duration_seconds ??
        0
      ) || 0;

  }
);


// ==========================================
// WORKABLE DAYS
// PRESENT + LEAVE
// ABSENT IS NOT WORKABLE
// ==========================================

const workableDays =
  presentDays +
  leaveDays;


setMonthlySummary({

  workableDays,

  presentDays,

  absentDays,

  leaveDays,

  totalWorkSeconds,

});


      } catch (error) {

        console.error(
          "Monthly attendance error:",
          error
        );


        setHistory(
          []
        );


        setMonthlySummary({
          workableDays: 0,
          absentDays: 0,
          presentDays: 0,
          leaveDays: 0,
          totalWorkSeconds: 0,
        });

        setLoadError(
          true
        );


        toast.error(
          error.response
            ?.data
            ?.message ||
          "Unable to load monthly attendance"
        );


      } finally {

        setLoading(
          false
        );

      }
    };


  // ==========================================
  // LOAD WHEN PAGE OPENS
  // ==========================================

  useEffect(() => {

    loadMonthlyAttendance(
      selectedMonth
    );

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // ==========================================
  // CHANGE MONTH
  // ==========================================

  const handleMonthChange =
    (event) => {

      const month =
        event.target.value;


      setSelectedMonth(
        month
      );


      loadMonthlyAttendance(
        month
      );
    };


  // ==========================================
  // STATUS TEXT
  // ==========================================

  // Both now thin wrappers over the single shared
  // classifyAttendanceRecord() helper (module top) --
  // guarantees the table badges can never disagree
  // with the summary cards/donut, which use the same
  // helper on the same rows.

  const getStatusText =
    (record) =>
      classifyAttendanceRecord(record).label;


  // ==========================================
  // STATUS CLASS
  // ==========================================

  const getStatusClass =
    (record) =>
      classifyAttendanceRecord(record).bucket;

  // ==========================================
  // OVERVIEW DONUT DATA
  // Built only from values this component already
  // computes for the summary cards -- "Remaining"
  // is the one additional derived value: calendar
  // days in the selected month strictly AFTER today
  // that have no record yet, because they haven't
  // happened. This is only ever non-zero for the
  // CURRENT month -- a past month has already fully
  // elapsed (Remaining = 0), and a future month can
  // never be selected (the month dropdown and the
  // backend both reject it). This is a plain calendar-
  // day count, not a working-day count: there's no
  // verified holiday/weekend calendar to subtract
  // against, so it is never labelled "workable."
  // ==========================================

  const remainingDays =
    selectedMonth === currentMonthValue
      ? Math.max(0, daysInSelectedMonth - currentDate.getDate())
      : 0;

  const overviewTotal =
    monthlySummary.presentDays +
    monthlySummary.absentDays +
    monthlySummary.leaveDays +
    remainingDays;

  const pct = (value) =>
    overviewTotal > 0
      ? Math.round((value / overviewTotal) * 1000) / 10
      : 0;

  const overviewSegments = [
    { key: "present", label: "Present", value: monthlySummary.presentDays, color: "#16A66A" },
    { key: "absent", label: "Absent", value: monthlySummary.absentDays, color: "#D64545" },
    { key: "leave", label: "Leave", value: monthlySummary.leaveDays, color: "#E0A32E" },
    { key: "remaining", label: "Remaining", value: remainingDays, color: "#D7DEDA" },
  ];

  const chartData = overviewSegments.filter((segment) => segment.value > 0);

  // ==========================================
  // AVERAGE WORK HOURS PER PRESENT DAY
  // ==========================================

  const avgWorkSecondsPerPresentDay =
    monthlySummary.presentDays > 0
      ? monthlySummary.totalWorkSeconds / monthlySummary.presentDays
      : 0;

  // ==========================================
  // PAGINATION
  // ==========================================

  const totalPages = Math.max(
    1,
    Math.ceil(history.length / RECORDS_PER_PAGE)
  );

  const pagedHistory = history.slice(
    (currentPage - 1) * RECORDS_PER_PAGE,
    currentPage * RECORDS_PER_PAGE
  );

  const goToPage = (page) => {
    setCurrentPage(Math.min(Math.max(1, page), totalPages));
  };


  // ==========================================
  // PAGE
  // ==========================================

  return (
    <>

      <div className="employee-page-content attendance-v2">


        {/* ==================================
            PAGE HEADER
        ================================== */}

        <section className="attendance-page-header">

          <div className="attendance-header-title-row">

            <span className="attendance-header-icon">
              <FaCalendarAlt />
            </span>

            <div>
              <h2>
                Attendance History
              </h2>

              <p>
                Track your monthly attendance and working hours
              </p>
            </div>

          </div>


          <div className="attendance-employee-badge">

            <span className="attendance-employee-badge-icon">
              <FaIdBadge />
            </span>

            <div>
              <span>Employee ID</span>
              <strong>
                {user?.employeeId}
              </strong>
            </div>

          </div>

        </section>


        {/* ==================================
            MONTH SELECTOR
        ================================== */}

        <section className="attendance-month-selector">

          <div className="attendance-month-label">

            <FaCalendarAlt />

            <span>
              Select Month
            </span>

          </div>


          <select
            value={
              selectedMonth
            }
            onChange={
              handleMonthChange
            }
          >

            {availableMonths.map(
              (month) => (

                <option
                  key={
                    month.value
                  }
                  value={
                    month.value
                  }
                >
                  {month.label}
                </option>

              )
            )}

          </select>

        </section>


        {/* ==================================
            SUMMARY CARDS
        ================================== */}

        <section className="attendance-summary-cards">

          <div className="attendance-summary-card tone-blue">
            <div className="attendance-summary-card-icon">
              <FaCalendarAlt />
            </div>
            <div className="attendance-summary-card-body">
              <span>Total Workable Days</span>
              <strong>{monthlySummary.workableDays}</strong>
              <small>Present + approved leave</small>
            </div>
          </div>

          <div className="attendance-summary-card tone-green">
            <div className="attendance-summary-card-icon">
              <FaCheckCircle />
            </div>
            <div className="attendance-summary-card-body">
              <span>Present Days</span>
              <strong>{monthlySummary.presentDays}</strong>
              <small>{pct(monthlySummary.presentDays)}% of the month</small>
            </div>
          </div>

          <div className="attendance-summary-card tone-red">
            <div className="attendance-summary-card-icon">
              <FaTimesCircle />
            </div>
            <div className="attendance-summary-card-body">
              <span>Absent Days</span>
              <strong>{monthlySummary.absentDays}</strong>
              <small>{pct(monthlySummary.absentDays)}% of the month</small>
            </div>
          </div>

          <div className="attendance-summary-card tone-amber">
            <div className="attendance-summary-card-icon">
              <FaUmbrellaBeach />
            </div>
            <div className="attendance-summary-card-body">
              <span>Leave Days</span>
              <strong>{monthlySummary.leaveDays}</strong>
              <small>{pct(monthlySummary.leaveDays)}% of the month</small>
            </div>
          </div>

          <div className="attendance-summary-card tone-indigo">
            <div className="attendance-summary-card-icon">
              <FaClock />
            </div>
            <div className="attendance-summary-card-body">
              <span>Total Work Hours</span>
              <strong>{formatDuration(monthlySummary.totalWorkSeconds)}</strong>
              <small>
                {monthlySummary.presentDays > 0
                  ? `Avg. ${formatDurationShort(avgWorkSecondsPerPresentDay)}/day`
                  : "No working days yet"}
              </small>
            </div>
          </div>

        </section>


        {/* ==================================
            MAIN LAYOUT -- Records (left) /
            Overview + Quick Info + Legend (right)
        ================================== */}

        <div className="attendance-main-grid">

          {/* ==================================
              ATTENDANCE RECORDS
          ================================== */}

          <section className="attendance-history-card">

            <div className="attendance-card-header">
              <div className="attendance-card-title">
                <span className="attendance-card-icon"><FaClipboardList /></span>
                <h3>Attendance Records</h3>
              </div>
              {history.length > 0 && (
                <span className="attendance-record-count">
                  {history.length} record{history.length === 1 ? "" : "s"}
                </span>
              )}
            </div>

            {loading ? (

              <div className="attendance-loading">

                Loading attendance...

              </div>


            ) : loadError ? (

              <div className="attendance-empty attendance-error-state">

                <span className="attendance-empty-icon attendance-error-icon">
                  <FaExclamationTriangle />
                </span>

                <h3>
                  Unable to load attendance
                </h3>

                <p>
                  Something went wrong while loading{" "}
                  {formatMonthName(selectedMonth)}. Your connection or our
                  server may be having trouble.
                </p>

                <button
                  type="button"
                  className="attendance-retry-button"
                  onClick={() => loadMonthlyAttendance(selectedMonth)}
                >
                  <FaRedoAlt /> Retry
                </button>

              </div>


            ) : history.length === 0 ? (

              <div className="attendance-empty">

                <span className="attendance-empty-icon"><FaClock /></span>

                <h3>
                  No attendance records
                </h3>

                <p>
                  No attendance information
                  is available for{" "}
                  {formatMonthName(
                    selectedMonth
                  )}
                  .
                </p>

              </div>


            ) : (

              <>

                <div className="attendance-table-wrapper">

                  <table className="attendance-table">


                    <thead>

                      <tr>

                        <th>
                          Date
                        </th>

                        <th>
                          Day
                        </th>

                        <th>
                          Check In
                        </th>

                        <th>
                          Check Out
                        </th>

                        <th>
                          Break
                        </th>

                        <th>
                          Working Hours
                        </th>

                        <th>
                          Status
                        </th>

                        <th>
                          Sessions
                        </th>

                      </tr>

                    </thead>


                    <tbody>

                      {pagedHistory.map(
                        (
                          record,
                          index
                        ) => {

                          const status =
                            getStatusText(
                              record
                            );


                          const statusClass =
                            getStatusClass(
                              record
                            );

                          const recordDate =
                            record.attendance_date ||
                            record.date;


                          return (

                            <tr
                              key={
                                recordDate ||
                                index
                              }
                            >


                              {/* DATE */}

                              <td className="attendance-date">

                                {formatDate(
                                  recordDate
                                )}

                              </td>

                              {/* DAY */}

                              <td>
                                {formatDayName(recordDate)}
                              </td>


                              {/* CHECK IN */}

                              <td>

                                {formatTime(
                                  record.first_login_time ||
                                  record.login_time
                                )}

                              </td>


                              {/* CHECK OUT */}

                              <td>

                                {formatTime(
                                  record.last_logout_time ||
                                  record.logout_time
                                )}

                              </td>

                              {/* BREAK TIME */}

                              <td>

                                {formatDuration(
                                  record.total_break_seconds
                                )}

                              </td>


                              {/* WORK HOURS */}

                              <td>

                                <span className="work-hours-value">

                                  {formatDuration(
                                    record.total_work_seconds ??
                                    record.work_duration_seconds
                                  )}

                                </span>

                              </td>


                              {/* STATUS */}

                              <td>

                                <span
                                  className={
                                    `attendance-status-badge ${statusClass}`
                                  }
                                >

                                  {status}

                                </span>

                              </td>


                              {/* SESSIONS */}

                              <td>

                                {
                                  record.total_sessions ??
                                  record.sessions ??
                                  0
                                }

                              </td>


                            </tr>

                          );

                        }
                      )}

                    </tbody>

                  </table>

                </div>

                {totalPages > 1 && (

                  <div className="attendance-pagination">

                    <button
                      type="button"
                      className="attendance-page-nav"
                      onClick={() => goToPage(currentPage - 1)}
                      disabled={currentPage === 1}
                      aria-label="Previous page"
                    >
                      <FaChevronLeft />
                    </button>

                    {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                      <button
                        key={page}
                        type="button"
                        className={
                          page === currentPage
                            ? "attendance-page-number active"
                            : "attendance-page-number"
                        }
                        onClick={() => goToPage(page)}
                        aria-current={page === currentPage ? "page" : undefined}
                      >
                        {page}
                      </button>
                    ))}

                    <button
                      type="button"
                      className="attendance-page-nav"
                      onClick={() => goToPage(currentPage + 1)}
                      disabled={currentPage === totalPages}
                      aria-label="Next page"
                    >
                      <FaChevronRight />
                    </button>

                  </div>

                )}

              </>

            )}

          </section>

          {/* ==================================
              RIGHT COLUMN -- Overview / Quick
              Info / Legend
          ================================== */}

          <aside className="attendance-side-column">

            {/* OVERVIEW DONUT */}

            <section className="attendance-overview-card">

              <div className="attendance-card-title">
                <span className="attendance-card-icon"><FaChartPie /></span>
                <h3>Attendance Overview</h3>
              </div>

              {loading ? (

                <div className="attendance-overview-empty">
                  <FaRegCircle />
                  <span>Loading...</span>
                </div>

              ) : loadError ? (

                <div className="attendance-overview-empty">
                  <FaExclamationTriangle />
                  <span>Unable to load</span>
                </div>

              ) : overviewTotal === 0 ? (

                <div className="attendance-overview-empty">
                  <FaRegCircle />
                  <span>No data for this month</span>
                </div>

              ) : (

                <>

                  <div className="attendance-donut-wrap">

                    <ResponsiveContainer width="100%" height={180}>
                      <PieChart>
                        <Pie
                          data={chartData}
                          dataKey="value"
                          nameKey="label"
                          innerRadius={55}
                          outerRadius={78}
                          paddingAngle={chartData.length > 1 ? 2 : 0}
                          startAngle={90}
                          endAngle={-270}
                          stroke="none"
                        >
                          {chartData.map((segment) => (
                            <Cell key={segment.key} fill={segment.color} />
                          ))}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>

                    <div className="attendance-donut-center">
                      <strong>
                        {monthlySummary.presentDays}/{overviewTotal}
                      </strong>
                      <span>Present</span>
                    </div>

                  </div>

                  <ul className="attendance-overview-legend">
                    {overviewSegments.map((segment) => (
                      <li key={segment.key}>
                        <span
                          className="attendance-legend-dot"
                          style={{ background: segment.color }}
                        />
                        <span className="attendance-legend-label">{segment.label}</span>
                        <span className="attendance-legend-value">{segment.value}</span>
                        <span className="attendance-legend-pct">{pct(segment.value)}%</span>
                      </li>
                    ))}
                  </ul>

                </>

              )}

            </section>

            {/* QUICK INFO */}

            <section className="attendance-quick-info">
              <span className="attendance-quick-info-icon"><FaLightbulb /></span>
              <div>
                <strong>Quick Info</strong>
                <p>
                  Working hours exclude break time. Attendance data is updated
                  in real time after you check out.
                </p>
              </div>
            </section>

            {/* LEGEND */}

            <section className="attendance-legend-card">

              <div className="attendance-card-title">
                <h3>Legend</h3>
              </div>

              <ul>
                <li>
                  <span className="attendance-legend-dot" style={{ background: "#16A66A" }} />
                  <div>
                    <strong>Present</strong>
                    <span>Checked in and worked normally</span>
                  </div>
                </li>
                <li>
                  <span className="attendance-legend-dot" style={{ background: "#D64545" }} />
                  <div>
                    <strong>Absent</strong>
                    <span>No attendance record</span>
                  </div>
                </li>
                <li>
                  <span className="attendance-legend-dot" style={{ background: "#E0A32E" }} />
                  <div>
                    <strong>Leave</strong>
                    <span>Approved leave for the day</span>
                  </div>
                </li>
              </ul>

            </section>

          </aside>

        </div>


      </div>

    </>
  );
}

export default EmployeeAttendance;
