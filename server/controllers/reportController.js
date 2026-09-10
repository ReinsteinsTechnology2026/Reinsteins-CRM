const pool = require("../config/db");
const ExcelJS = require("exceljs");

// ==========================================
// EMPLOYEE REPORT
// ==========================================

const getEmployeeReport = async (req, res) => {
  try {
    const [employees] = await pool.query(
      `SELECT
        id,
        employee_id,
        full_name,
        email,
        phone,
        designation,
        date_of_birth,
        emergency_contact,
        address,
        profile_photo,
        status,
        last_login,
        created_at
       FROM users
       WHERE role = 'employee'
       ORDER BY full_name ASC`
    );

    return res.status(200).json({
      success: true,
      reportType: "employees",
      count: employees.length,
      data: employees,
    });
  } catch (error) {
    console.error(
      "Employee Report Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Unable to load employee report",
    });
  }
};

// ==========================================
// ATTENDANCE REPORT
// ==========================================

const getAttendanceReport = async (req, res) => {
  try {
    const {
      employeeId,
      fromDate,
      toDate,
    } = req.query;

    let query = `
      SELECT
        a.id,
        u.employee_id,
        u.full_name,
        u.profile_photo,
        u.email,
        u.designation,
        a.login_time,
        a.logout_time,
        a.work_duration_seconds,
        a.total_break_seconds,
        a.status,
        a.created_at
      FROM attendance a
      INNER JOIN users u
        ON a.user_id = u.id
      WHERE u.role = 'employee'
    `;

    const values = [];

    if (employeeId) {
      query += `
        AND u.employee_id = ?
      `;

      values.push(employeeId);
    }

    if (fromDate) {
      query += `
        AND DATE(a.login_time) >= ?
      `;

      values.push(fromDate);
    }

    if (toDate) {
      query += `
        AND DATE(a.login_time) <= ?
      `;

      values.push(toDate);
    }

    query += `
      ORDER BY a.login_time ASC
    `;

    const [attendance] =
      await pool.query(
        query,
        values
      );

    let totalWorkSeconds = 0;
    let totalBreakSeconds = 0;

    attendance.forEach((record) => {
      totalWorkSeconds +=
        Number(
          record.work_duration_seconds || 0
        );

      totalBreakSeconds +=
        Number(
          record.total_break_seconds || 0
        );
    });

    const attendanceRecords =
      attendance.length;

    const averageWorkSeconds =
      attendanceRecords > 0
        ? Math.round(
            totalWorkSeconds /
              attendanceRecords
          )
        : 0;

    return res.status(200).json({
      success: true,

      reportType:
        "attendance",

      employeeId:
        employeeId || null,

      count:
        attendanceRecords,

      summary: {
        attendanceRecords,
        totalWorkSeconds,
        totalBreakSeconds,
        averageWorkSeconds,
      },

      data:
        attendance,
    });
  } catch (error) {
    console.error(
      "Attendance Report Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to load attendance report",
    });
  }
};

// ==========================================
// TASK REPORT
//
// Answers "what did this employee actually WORK ON
// during the selected date range" -- not "what tasks
// were created in that range" (the old, wrong
// behavior). A task qualifies if either:
//
//   A. it has a task_work_logs session (a completed
//      Stop Work) whose created_at falls inside the
//      range, or
//   B. it is currently being worked (current_working=TRUE,
//      work_started_at NOT NULL) and work_started_at
//      itself falls inside the range -- so a task
//      Started today but not yet Stopped still shows up
//      in a Today->Today report.
//
// Employee matching is via tasks.assigned_to (the real
// assignee) -- tasks.user_id is the task CREATOR
// (almost always an admin) and was the root cause of
// the original bug: joining on it, combined with
// `WHERE u.role = 'employee'`, silently excluded every
// admin-assigned task from every employee's report.
//
// One row per task (never per work-log row): all
// task_work_logs rows for a task within the range are
// pre-aggregated in the wl subquery before the join, so
// a task with several work sessions still contributes
// exactly one row, with its hours summed and its dates/
// descriptions concatenated.
//
// Shared by getTaskReport (JSON) and the "tasks" branch
// of exportReportExcel below, so the on-screen report
// and the Excel export can never drift apart.
// ==========================================

const fetchTaskReportRows = async ({
  employeeId,
  fromDate,
  toDate,
}) => {

  let query = `
    SELECT
      t.id,
      t.task_number,
      u.employee_id,
      u.full_name,
      u.profile_photo,
      u.email,
      u.designation,
      t.task_title,
      t.task_description,
      p.name AS project_name,
      t.status,
      t.progress,
      t.start_time,
      t.completed_time,
      t.created_at,
      t.updated_at,
      t.current_working,
      t.work_started_at,

      COALESCE(wl.logged_hours, 0) AS logged_hours,
      wl.work_dates,
      wl.work_descriptions,
      COALESCE(wl.session_count, 0) AS session_count,
      wl.last_activity,

      -- Live elapsed time for a task currently being
      -- worked on, using the exact same
      -- FLOOR(EXTRACT(EPOCH FROM (NOW() - work_started_at)) / 60) / 60
      -- formula taskWorkService.js's stopWork already
      -- uses to compute hours_worked -- read-only here,
      -- never written back, never a fabricated
      -- hours_worked row.
      CASE
        WHEN t.current_working = TRUE AND t.work_started_at IS NOT NULL
        THEN ROUND(FLOOR(EXTRACT(EPOCH FROM (NOW() - t.work_started_at)) / 60) / 60, 2)
        ELSE NULL
      END AS active_elapsed_hours

    FROM tasks t

    INNER JOIN users u
      ON t.assigned_to = u.id

    LEFT JOIN projects p
      ON t.project_id = p.id

    LEFT JOIN (
      SELECT
        task_id,
        SUM(hours_worked) AS logged_hours,
        COUNT(*) AS session_count,
        MAX(created_at) AS last_activity,
        STRING_AGG(
          DISTINCT TO_CHAR(created_at, 'YYYY-MM-DD'),
          ','
          ORDER BY TO_CHAR(created_at, 'YYYY-MM-DD')
        ) AS work_dates,
        STRING_AGG(
          work_description,
          E'\n'
          ORDER BY created_at
        ) AS work_descriptions
      FROM task_work_logs
      WHERE 1 = 1
  `;

  const wlValues = [];

  if (fromDate) {
    query += ` AND DATE(created_at) >= ?`;
    wlValues.push(fromDate);
  }

  if (toDate) {
    query += ` AND DATE(created_at) <= ?`;
    wlValues.push(toDate);
  }

  query += `
      GROUP BY task_id
    ) wl
      ON wl.task_id = t.id

    WHERE u.role = 'employee'
  `;

  const values = [...wlValues];

  if (employeeId) {
    query += ` AND u.employee_id = ?`;
    values.push(employeeId);
  }

  // ======================================
  // QUALIFICATION: a real work session in range
  // (via the wl join above) OR an active session that
  // started in range. A task is never included merely
  // because it was created in the range.
  // ======================================

  query += `
    AND (
      wl.task_id IS NOT NULL
      OR (
        t.current_working = TRUE
        AND t.work_started_at IS NOT NULL
  `;

  if (fromDate) {
    query += ` AND DATE(t.work_started_at) >= ?`;
    values.push(fromDate);
  }

  if (toDate) {
    query += ` AND DATE(t.work_started_at) <= ?`;
    values.push(toDate);
  }

  query += `
      )
    )
    ORDER BY COALESCE(wl.last_activity, t.work_started_at, t.updated_at) DESC
  `;

  const [rows] = await pool.query(query, values);

  // ======================================
  // Total work time per task = completed sessions
  // (logged_hours, straight from task_work_logs) +
  // live elapsed time if still active. Never invents a
  // completed hours_worked value for the active leg --
  // it is kept as its own field too.
  // ======================================

  return rows.map((row) => {

    const loggedHours = Number(row.logged_hours) || 0;

    const activeHours =
      row.active_elapsed_hours === null
        ? null
        : Number(row.active_elapsed_hours);

    const totalWorkHours =
      Math.round((loggedHours + (activeHours || 0)) * 100) / 100;

    const workDates = row.work_dates
      ? row.work_dates.split(",")
      : [];

    if (
      row.current_working &&
      row.work_started_at &&
      !workDates.includes(
        new Date(row.work_started_at).toISOString().slice(0, 10)
      )
    ) {
      workDates.push(
        new Date(row.work_started_at).toISOString().slice(0, 10)
      );
      workDates.sort();
    }

    return {
      ...row,
      logged_hours: loggedHours,
      active_elapsed_hours: activeHours,
      total_work_hours: totalWorkHours,
      work_dates: workDates,
      work_descriptions: row.work_descriptions
        ? row.work_descriptions.split("\n").filter(Boolean)
        : [],
      is_currently_working: !!row.current_working,
    };

  });

};

const getTaskReport = async (req, res) => {
  try {
    const {
      employeeId,
      fromDate,
      toDate,
    } = req.query;

    const tasks = await fetchTaskReportRows({
      employeeId,
      fromDate,
      toDate,
    });

    const totalTasks =
      tasks.length;

    const completedTasks =
      tasks.filter(
        (task) =>
          String(
            task.status
          ).toLowerCase() ===
          "closed"
      ).length;

    const pendingReviewTasks =
      tasks.filter(
        (task) =>
          String(task.status || "")
            .toLowerCase()
            .replace(/[-\s]/g, "_") ===
          "pending_review"
      ).length;

    const inProgressTasks =
      tasks.filter((task) => {
        const status =
          String(
            task.status || ""
          )
            .toLowerCase()
            .replace(
              /[-\s]/g,
              "_"
            );

        return (
          status === "in_progress" ||
          status === "progress"
        );
      }).length;

    const totalWorkHours =
      Math.round(
        tasks.reduce(
          (sum, task) => sum + (Number(task.total_work_hours) || 0),
          0
        ) * 100
      ) / 100;

    return res.status(200).json({
      success: true,

      reportType:
        "tasks",

      employeeId:
        employeeId || null,

      count:
        totalTasks,

      summary: {
        totalTasks,
        completedTasks,
        inProgressTasks,
        pendingReviewTasks,
        totalWorkHours,
      },

      data:
        tasks,
    });
  } catch (error) {
    console.error(
      "Task Report Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to load task report",
    });
  }
};

// ==========================================
// LEAVE REPORT
// ==========================================

const getLeaveReport = async (req, res) => {
  try {
    const {
      employeeId,
      fromDate,
      toDate,
    } = req.query;

    let query = `
      SELECT
        l.id,
        u.employee_id,
        u.full_name,
        u.profile_photo,
        u.email,
        u.designation,
        l.leave_type,
        l.from_date,
        l.to_date,
        l.reason,
        l.status,
        l.admin_comment,
        l.created_at,
        l.updated_at
      FROM leave_requests l
      INNER JOIN users u
        ON l.user_id = u.id
      WHERE u.role = 'employee'
    `;

    const values = [];

    if (employeeId) {
      query += `
        AND u.employee_id = ?
      `;

      values.push(employeeId);
    }

    if (fromDate) {
      query += `
        AND DATE(l.to_date) >= ?
      `;

      values.push(fromDate);
    }

    if (toDate) {
      query += `
        AND DATE(l.from_date) <= ?
      `;

      values.push(toDate);
    }

    query += `
      ORDER BY
        l.from_date DESC,
        l.created_at DESC
    `;

    const [leaves] =
      await pool.query(
        query,
        values
      );

    const totalRequests =
      leaves.length;

    const pendingRequests =
      leaves.filter(
        (leave) =>
          String(
            leave.status
          ).toLowerCase() ===
          "pending"
      ).length;

    const approvedRequests =
      leaves.filter(
        (leave) =>
          String(
            leave.status
          ).toLowerCase() ===
          "approved"
      ).length;

    const rejectedRequests =
      leaves.filter(
        (leave) =>
          String(
            leave.status
          ).toLowerCase() ===
          "rejected"
      ).length;

    return res.status(200).json({
      success: true,

      reportType:
        "leave",

      employeeId:
        employeeId || null,

      count:
        totalRequests,

      summary: {
        totalRequests,
        pendingRequests,
        approvedRequests,
        rejectedRequests,
      },

      data:
        leaves,
    });
  } catch (error) {
    console.error(
      "Leave Report Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to load leave report",
    });
  }
};

// ==========================================
// FORMAT EXCEL DATE
// ==========================================

const formatExcelDate = (value) => {
  if (!value) {
    return "";
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "";
  }

  return date.toLocaleDateString(
    "en-IN"
  );
};

// ==========================================
// FORMAT EXCEL TIME
// ==========================================

const formatExcelTime = (value) => {
  if (!value) {
    return "";
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "";
  }

  return date.toLocaleTimeString(
    "en-IN",
    {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }
  );
};

// ==========================================
// FORMAT EXCEL DATE TIME
// ==========================================

const formatExcelDateTime = (value) => {
  if (!value) {
    return "";
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "";
  }

  return date.toLocaleString(
    "en-IN"
  );
};

// ==========================================
// FORMAT WORKING DURATION
// ==========================================

const formatDuration = (seconds) => {
  const value =
    Number(seconds) || 0;

  const hours =
    Math.floor(
      value / 3600
    );

  const minutes =
    Math.floor(
      (value % 3600) / 60
    );

  const secs =
    Math.floor(
      value % 60
    );

  return `${hours}h ${minutes}m ${secs}s`;
};

// ==========================================
// FORMAT HOURS (decimal) AS "Xh Ym"
// Used for task_work_logs-derived work time, which is
// stored/summed as decimal hours (e.g. 3.5), not seconds
// -- a separate helper from formatDuration above rather
// than reusing it, since the input unit is different.
// ==========================================

const formatHoursDuration = (decimalHours) => {
  const value = Number(decimalHours) || 0;

  const totalMinutes = Math.round(value * 60);

  const hours = Math.floor(totalMinutes / 60);

  const minutes = totalMinutes % 60;

  return `${hours}h ${minutes}m`;
};

// ==========================================
// EXPORT REPORT TO EXCEL
// ==========================================

const exportReportExcel = async (
  req,
  res
) => {
  try {
    const {
      reportType,
    } = req.params;

    const {
      employeeId,
      fromDate,
      toDate,
    } = req.query;

    const allowedReports = [
      "attendance",
      "tasks",
      "leave",
      "employees",
    ];

    if (
      !allowedReports.includes(
        reportType
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid report type",
      });
    }

    const workbook =
      new ExcelJS.Workbook();

    workbook.creator =
      "Reinsteins Technology";

    workbook.created =
      new Date();

    let worksheet;

    // ========================================
    // ATTENDANCE EXCEL REPORT
    // ONE ROW PER EMPLOYEE PER DAY
    // ========================================

    if (
      reportType ===
      "attendance"
    ) {
      let query = `
        SELECT
          u.employee_id,
          u.full_name,
          u.designation,

          DATE(a.login_time)
            AS attendance_date,

          MIN(a.login_time)
            AS first_login,

          MAX(a.logout_time)
            AS last_logout,

          SUM(
            COALESCE(
              a.work_duration_seconds,
              0
            )
          ) AS total_work_seconds

        FROM attendance a

        INNER JOIN users u
          ON a.user_id = u.id

        WHERE
          u.role = 'employee'
      `;

      const values = [];

      // ======================================
      // EMPLOYEE FILTER
      // ======================================

      if (employeeId) {
        query += `
          AND u.employee_id = ?
        `;

        values.push(
          employeeId
        );
      }

      // ======================================
      // FROM DATE FILTER
      // ======================================

      if (fromDate) {
        query += `
          AND DATE(a.login_time) >= ?
        `;

        values.push(
          fromDate
        );
      }

      // ======================================
      // TO DATE FILTER
      // ======================================

      if (toDate) {
        query += `
          AND DATE(a.login_time) <= ?
        `;

        values.push(
          toDate
        );
      }

      // ======================================
      // GROUP BY EMPLOYEE + DATE
      // ======================================

      query += `
        GROUP BY
          u.employee_id,
          u.full_name,
          u.designation,
          DATE(a.login_time)

        ORDER BY
          attendance_date DESC,
          u.full_name ASC
      `;

      const [rows] =
        await pool.query(
          query,
          values
        );

      worksheet =
        workbook.addWorksheet(
          "Attendance Report"
        );

      worksheet.columns = [
        {
          header:
            "Employee ID",
          key:
            "employee_id",
          width: 15,
        },
        {
          header:
            "Employee Name",
          key:
            "full_name",
          width: 25,
        },
        {
          header:
            "Designation",
          key:
            "designation",
          width: 20,
        },
        {
          header:
            "Date",
          key:
            "attendance_date",
          width: 15,
        },
        {
          header:
            "First Login",
          key:
            "first_login",
          width: 18,
        },
        {
          header:
            "Last Logout",
          key:
            "last_logout",
          width: 18,
        },
        {
          header:
            "Total Working Hours",
          key:
            "total_working_hours",
          width: 22,
        },
      ];

      rows.forEach(
        (row) => {
          worksheet.addRow({
            employee_id:
              row.employee_id,

            full_name:
              row.full_name,

            designation:
              row.designation ||
              "",

            attendance_date:
              formatExcelDate(
                row.attendance_date
              ),

            first_login:
              formatExcelTime(
                row.first_login
              ),

            last_logout:
              row.last_logout
                ? formatExcelTime(
                    row.last_logout
                  )
                : "Currently Working",

            total_working_hours:
              formatDuration(
                row.total_work_seconds
              ),
          });
        }
      );
    }

    // ========================================
    // TASK EXCEL REPORT
    // ========================================

    if (
      reportType ===
      "tasks"
    ) {
      // Same corrected data logic as the on-screen
      // report -- assigned_to join, work-session-based
      // date qualification, one row per task -- via the
      // shared helper, so this export can never drift
      // from what Reports -> Task Report shows.

      const rows = await fetchTaskReportRows({
        employeeId,
        fromDate,
        toDate,
      });

      worksheet =
        workbook.addWorksheet(
          "Task Report"
        );

      worksheet.columns = [
        {
          header:
            "Employee ID",
          key:
            "employee_id",
          width: 15,
        },
        {
          header:
            "Employee Name",
          key:
            "full_name",
          width: 25,
        },
        {
          header:
            "Designation",
          key:
            "designation",
          width: 20,
        },
        {
          header:
            "Task Title",
          key:
            "task_title",
          width: 30,
        },
        {
          header:
            "Project",
          key:
            "project_name",
          width: 22,
        },
        {
          header:
            "Status",
          key:
            "status",
          width: 18,
        },
        {
          header:
            "Progress",
          key:
            "progress",
          width: 12,
        },
        {
          header:
            "Work Date(s)",
          key:
            "work_dates",
          width: 25,
        },
        {
          header:
            "Total Work Time",
          key:
            "total_work_time",
          width: 18,
        },
        {
          header:
            "Work Description",
          key:
            "work_description",
          width: 45,
        },
        {
          header:
            "Start Time",
          key:
            "start_time",
          width: 25,
        },
        {
          header:
            "Completed Time",
          key:
            "completed_time",
          width: 25,
        },
      ];

      rows.forEach(
        (row) => {
          worksheet.addRow({
            employee_id:
              row.employee_id,

            full_name:
              row.full_name,

            designation:
              row.designation ||
              "",

            task_title:
              row.task_title ||
              "",

            project_name:
              row.project_name ||
              "--",

            status:
              row.status ||
              "",

            progress:
              row.progress != null
                ? `${row.progress}%`
                : "",

            work_dates:
              row.work_dates.length
                ? row.work_dates.join(", ")
                : "--",

            total_work_time:
              row.total_work_hours
                ? formatHoursDuration(row.total_work_hours)
                : "--",

            work_description:
              row.work_descriptions.length
                ? row.work_descriptions.join(" | ")
                : (row.task_description || ""),

            start_time:
              formatExcelDateTime(
                row.start_time
              ),

            completed_time:
              formatExcelDateTime(
                row.completed_time
              ),
          });
        }
      );
    }

    // ========================================
    // LEAVE EXCEL REPORT
    // ========================================

    if (
      reportType ===
      "leave"
    ) {
      let query = `
        SELECT
          u.employee_id,
          u.full_name,
          u.designation,
          l.leave_type,
          l.from_date,
          l.to_date,
          l.reason,
          l.status,
          l.admin_comment,
          l.created_at
        FROM leave_requests l
        INNER JOIN users u
          ON l.user_id = u.id
        WHERE u.role = 'employee'
      `;

      const values = [];

      if (employeeId) {
        query += `
          AND u.employee_id = ?
        `;

        values.push(
          employeeId
        );
      }

      if (fromDate) {
        query += `
          AND DATE(l.to_date) >= ?
        `;

        values.push(
          fromDate
        );
      }

      if (toDate) {
        query += `
          AND DATE(l.from_date) <= ?
        `;

        values.push(
          toDate
        );
      }

      query += `
        ORDER BY
          l.from_date DESC
      `;

      const [rows] =
        await pool.query(
          query,
          values
        );

      worksheet =
        workbook.addWorksheet(
          "Leave Report"
        );

      worksheet.columns = [
        {
          header:
            "Employee ID",
          key:
            "employee_id",
          width: 15,
        },
        {
          header:
            "Employee Name",
          key:
            "full_name",
          width: 25,
        },
        {
          header:
            "Designation",
          key:
            "designation",
          width: 20,
        },
        {
          header:
            "Leave Type",
          key:
            "leave_type",
          width: 20,
        },
        {
          header:
            "From Date",
          key:
            "from_date",
          width: 15,
        },
        {
          header:
            "To Date",
          key:
            "to_date",
          width: 15,
        },
        {
          header:
            "Reason",
          key:
            "reason",
          width: 40,
        },
        {
          header:
            "Status",
          key:
            "status",
          width: 15,
        },
        {
          header:
            "Admin Comment",
          key:
            "admin_comment",
          width: 35,
        },
      ];

      rows.forEach(
        (row) => {
          worksheet.addRow({
            employee_id:
              row.employee_id,

            full_name:
              row.full_name,

            designation:
              row.designation ||
              "",

            leave_type:
              row.leave_type ||
              "",

            from_date:
              formatExcelDate(
                row.from_date
              ),

            to_date:
              formatExcelDate(
                row.to_date
              ),

            reason:
              row.reason ||
              "",

            status:
              row.status ||
              "",

            admin_comment:
              row.admin_comment ||
              "",
          });
        }
      );
    }

    // ========================================
    // EMPLOYEE EXCEL REPORT
    // ========================================

    if (
      reportType ===
      "employees"
    ) {
      const [rows] =
        await pool.query(
          `SELECT
            employee_id,
            full_name,
            email,
            phone,
            designation,
            date_of_birth,
            emergency_contact,
            address,
            status,
            last_login,
            created_at
           FROM users
           WHERE role = 'employee'
           ORDER BY full_name ASC`
        );

      worksheet =
        workbook.addWorksheet(
          "Employee Report"
        );

      worksheet.columns = [
        {
          header:
            "Employee ID",
          key:
            "employee_id",
          width: 15,
        },
        {
          header:
            "Full Name",
          key:
            "full_name",
          width: 25,
        },
        {
          header:
            "Email",
          key:
            "email",
          width: 30,
        },
        {
          header:
            "Phone",
          key:
            "phone",
          width: 18,
        },
        {
          header:
            "Designation",
          key:
            "designation",
          width: 20,
        },
        {
          header:
            "Date of Birth",
          key:
            "date_of_birth",
          width: 18,
        },
        {
          header:
            "Emergency Contact",
          key:
            "emergency_contact",
          width: 20,
        },
        {
          header:
            "Address",
          key:
            "address",
          width: 40,
        },
        {
          header:
            "Status",
          key:
            "status",
          width: 15,
        },
        {
          header:
            "Last Login",
          key:
            "last_login",
          width: 25,
        },
        {
          header:
            "Created Date",
          key:
            "created_at",
          width: 25,
        },
      ];

      rows.forEach(
        (row) => {
          worksheet.addRow({
            employee_id:
              row.employee_id,

            full_name:
              row.full_name,

            email:
              row.email || "",

            phone:
              row.phone || "",

            designation:
              row.designation || "",

            date_of_birth:
              formatExcelDate(
                row.date_of_birth
              ),

            emergency_contact:
              row.emergency_contact ||
              "",

            address:
              row.address || "",

            status:
              row.status || "",

            last_login:
              formatExcelDateTime(
                row.last_login
              ),

            created_at:
              formatExcelDateTime(
                row.created_at
              ),
          });
        }
      );
    }

    // ========================================
    // EXCEL HEADER STYLE
    // ========================================

    const headerRow =
      worksheet.getRow(1);

    headerRow.font = {
      bold: true,
      color: {
        argb:
          "FFFFFFFF",
      },
    };

    headerRow.fill = {
      type:
        "pattern",

      pattern:
        "solid",

      fgColor: {
        argb:
          "FF2563EB",
      },
    };

    headerRow.alignment = {
      vertical:
        "middle",

      horizontal:
        "center",
    };

    headerRow.height =
      25;

    // ========================================
    // STYLE ALL CELLS
    // ========================================

    worksheet.eachRow(
      (
        row,
        rowNumber
      ) => {
        row.eachCell(
          (cell) => {
            cell.alignment = {
              vertical:
                "middle",

              wrapText:
                true,
            };

            cell.border = {
              top: {
                style:
                  "thin",
              },

              left: {
                style:
                  "thin",
              },

              bottom: {
                style:
                  "thin",
              },

              right: {
                style:
                  "thin",
              },
            };
          }
        );

        if (
          rowNumber > 1
        ) {
          row.height =
            22;
        }
      }
    );

    // ========================================
    // FREEZE HEADER
    // ========================================

    worksheet.views = [
      {
        state:
          "frozen",

        ySplit:
          1,
      },
    ];

    // ========================================
    // AUTO FILTER
    // ========================================

    worksheet.autoFilter = {
      from:
        "A1",

      to: {
        row:
          1,

        column:
          worksheet.columnCount,
      },
    };

    // ========================================
    // FILE NAME
    // ========================================

    const dateStamp =
      new Date()
        .toISOString()
        .slice(
          0,
          10
        );

    const fileName =
      `${reportType}-report-${dateStamp}.xlsx`;

    // ========================================
    // RESPONSE HEADERS
    // ========================================

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`
    );

    // ========================================
    // SEND EXCEL FILE
    // ========================================

    await workbook.xlsx.write(
      res
    );

    res.end();
  } catch (error) {
    console.error(
      "Excel Export Error:",
      error
    );

    if (
      !res.headersSent
    ) {
      return res.status(500).json({
        success: false,
        message:
          "Unable to export Excel report",
      });
    }
  }
};

// ==========================================
// EXPORT CONTROLLERS
// ==========================================

module.exports = {
  getEmployeeReport,
  getAttendanceReport,
  getTaskReport,
  getLeaveReport,
  exportReportExcel,
};