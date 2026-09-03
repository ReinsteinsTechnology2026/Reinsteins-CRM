import {
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  FaCalendarAlt,
  FaClock,
} from "react-icons/fa";

import {
  toast,
} from "react-toastify";

import api from "../../services/api";

import "./EmployeeAttendance.css";


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

    const status =
      String(
        record?.status ||
        record?.attendance_status ||
        ""
      ).toLowerCase();

    const leaveType =
      String(
        record?.leave_type ||
        record?.leaveType ||
        ""
      ).toLowerCase();


    // ========================================
    // LEAVE
    // ========================================

    const isLeave =
      Boolean(leaveType) ||
      status === "leave" ||
      status === "on_leave";


    if (isLeave) {

      leaveDays++;

    }

    // ========================================
    // PRESENT
    // ========================================

    else if (
      status === "present" ||
      status === "completed" ||
      status === "working" ||
      record?.first_login_time ||
      record?.login_time
    ) {

      presentDays++;

    }

    // ========================================
    // ABSENT
    // ========================================

    else {

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
          presentDays: 0,
          absentDays: 0,
          leaveDays: 0,
          totalWorkSeconds: 0,
        });


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

  const getStatusText =
    (record) => {

      const status =
        String(
          record?.status ||
          record?.attendance_status ||
          ""
        ).toLowerCase();


      const leaveType =
        String(
          record?.leave_type ||
          record?.leaveType ||
          ""
        ).toLowerCase();


      // ========================================
      // LEAVE
      // ========================================

      if (
        leaveType
      ) {

        if (
          leaveType.includes(
            "casual"
          )
        ) {
          return "CL";
        }


        if (
          leaveType.includes(
            "sick"
          )
        ) {
          return "SL";
        }


        if (
          leaveType.includes(
            "earned"
          )
        ) {
          return "EL";
        }


        if (
          leaveType.includes(
            "paid"
          )
        ) {
          return "PL";
        }


        return leaveType
          .substring(
            0,
            2
          )
          .toUpperCase();
      }


      // ========================================
      // LEAVE STATUS
      // ========================================

      if (
        status === "leave" ||
        status === "on_leave"
      ) {

        return (
          record?.leave_code ||
          record?.leaveCode ||
          "Leave"
        );
      }


      // ========================================
      // PRESENT
      // ========================================

      if (
        status === "present" ||
        status === "completed" ||
        status === "working"
      ) {

        return "Present";
      }


      // ========================================
      // ABSENT
      // ========================================

      if (
        status === "absent"
      ) {

        return "Absent";
      }


      // ========================================
      // FALLBACK
      // ========================================

      if (
        record?.first_login_time ||
        record?.login_time
      ) {

        return "Present";
      }


      return "Absent";
    };


  // ==========================================
  // STATUS CLASS
  // ==========================================

  const getStatusClass =
    (record) => {

      const status =
        getStatusText(
          record
        ).toLowerCase();


      if (
        status === "present"
      ) {

        return "present";
      }


      if (
        status === "absent"
      ) {

        return "absent";
      }


      return "leave";
    };


  // ==========================================
  // PAGE
  // ==========================================

  return (
    <>

      <div className="employee-page-content">


        {/* ==================================
            PAGE HEADER
        ================================== */}

        <section className="attendance-page-header">

          <div>

            <h2>
              Attendance History
            </h2>

            <p>
              Your monthly attendance
            </p>

          </div>


          <div className="attendance-employee-badge">

            <span>
              Employee ID
            </span>

            <strong>
              {user?.employeeId}
            </strong>

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
            ATTENDANCE TABLE
        ================================== */}

        <section className="attendance-history-card">


          {loading ? (

            <div className="attendance-loading">

              Loading attendance...

            </div>


          ) : history.length === 0 ? (

            <div className="attendance-empty">

              <FaClock />

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

            <div className="attendance-table-wrapper">

              <table className="attendance-table">


                <thead>

                  <tr>

                    <th>
                      Date
                    </th>

                    <th>
                      First Online
                    </th>

                    <th>
                      Last Offline
                    </th>

                    <th>
                      Work Hours
                    </th>

                    <th>
                      Break Time
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

                  {history.map(
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


                      return (

                        <tr
                          key={
                            record.attendance_date ||
                            record.date ||
                            index
                          }
                        >


                          {/* DATE */}

                          <td className="attendance-date">

                            {formatDate(
                              record.attendance_date ||
                              record.date
                            )}

                          </td>


                          {/* FIRST ONLINE */}

                          <td>

                            {formatTime(
                              record.first_login_time ||
                              record.login_time
                            )}

                          </td>


                          {/* LAST OFFLINE */}

                          <td>

                            {formatTime(
                              record.last_logout_time ||
                              record.logout_time
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


                          {/* BREAK TIME */}

                          <td>

                            {formatDuration(
                              record.total_break_seconds
                            )}

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

          )}

        </section>


        {/* ==================================
            MONTHLY SUMMARY
        ================================== */}

        <section className="attendance-monthly-summary">

          <h3>
            Monthly Summary
          </h3>


          <div className="attendance-summary-list">


            <div className="attendance-summary-row">

              <span>
                Total Workable Days:
              </span>

              <strong>
                {
                  monthlySummary.workableDays
                }
              </strong>

            </div>


            <div className="attendance-summary-row">

              <span>
                Present:
              </span>

              <strong>
                {
                  monthlySummary.presentDays
                }
              </strong>

            </div>


            <div className="attendance-summary-row">

              <span>
                Absent:
              </span>

              <strong>
                {
                  monthlySummary.absentDays
                }
              </strong>

            </div>


            <div className="attendance-summary-row">

              <span>
                Leave:
              </span>

              <strong>
                {
                  monthlySummary.leaveDays
                }
              </strong>

            </div>


            <div className="attendance-summary-row">

              <span>
                Total Work Hours:
              </span>

              <strong>
                {formatDuration(
                  monthlySummary.totalWorkSeconds
                )}
              </strong>

            </div>


          </div>

        </section>


      </div>

    </>
  );
}


export default EmployeeAttendance;