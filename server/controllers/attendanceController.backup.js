const pool = require("../config/db");

// ==========================================
// AUTO CLOSE OLD ATTENDANCE SESSIONS
//
// If an employee forgot to click Go Offline,
// any active session from a previous calendar
// day is closed at 23:59:59 of its login date.
//
// This prevents attendance from continuing
// into the next day.
// ==========================================

const closeOldSessions = async (userId = null) => {
  let query = `
    SELECT
      id,
      user_id,
      login_time,
      status,
      break_start_time,
      total_break_seconds
    FROM attendance
    WHERE status IN ('working', 'break')
    AND DATE(login_time) < CURDATE()
  `;

  const values = [];

  if (userId) {
    query += `
      AND user_id = ?
    `;

    values.push(userId);
  }

  const [sessions] =
    await pool.query(
      query,
      values
    );

  for (const session of sessions) {
    // End of the calendar day on which
    // the employee originally logged in.
    const [cutoffRows] =
      await pool.query(
        `
        SELECT
          TIMESTAMP(
            DATE(?),
            '23:59:59'
          ) AS cutoff_time
        `,
        [
          session.login_time,
        ]
      );

    const cutoffTime =
      cutoffRows[0]
        .cutoff_time;

    let totalBreakSeconds =
      Number(
        session
          .total_break_seconds
      ) || 0;

    // ========================================
    // EMPLOYEE WAS ON BREAK AT MIDNIGHT
    // ========================================

    if (
      session.status === "break" &&
      session.break_start_time
    ) {
      const [breakRows] =
        await pool.query(
          `
          SELECT
            GREATEST(
              0,
              TIMESTAMPDIFF(
                SECOND,
                ?,
                ?
              )
            ) AS unfinished_break_seconds
          `,
          [
            session
              .break_start_time,
            cutoffTime,
          ]
        );

      const unfinishedBreakSeconds =
        Number(
          breakRows[0]
            .unfinished_break_seconds
        ) || 0;

      totalBreakSeconds +=
        unfinishedBreakSeconds;
    }

    // ========================================
    // CALCULATE TOTAL SESSION DURATION
    // ========================================

    const [durationRows] =
      await pool.query(
        `
        SELECT
          GREATEST(
            0,
            TIMESTAMPDIFF(
              SECOND,
              ?,
              ?
            )
          ) AS session_seconds
        `,
        [
          session.login_time,
          cutoffTime,
        ]
      );

    const sessionSeconds =
      Number(
        durationRows[0]
          .session_seconds
      ) || 0;

    const workDurationSeconds =
      Math.max(
        0,
        sessionSeconds -
          totalBreakSeconds
      );

    // ========================================
    // CLOSE SESSION
    // ========================================

    await pool.query(
      `
      UPDATE attendance
      SET
        logout_time = ?,
        work_duration_seconds = ?,
        total_break_seconds = ?,
        break_start_time = NULL,
        status = 'completed'
      WHERE id = ?
      `,
      [
        cutoffTime,
        workDurationSeconds,
        totalBreakSeconds,
        session.id,
      ]
    );
  }
};

// ==========================================
// GO ONLINE
// ==========================================

const goOnline = async (req, res) => {
  try {
    const userId =
      req.user.id;

    // Close forgotten sessions
    // from previous dates first.
    await closeOldSessions(
      userId
    );

    // ========================================
    // CHECK CURRENT ACTIVE SESSION
    // ========================================

    const [activeSessions] =
      await pool.query(
        `
        SELECT
          id,
          login_time,
          status,
          break_start_time,
          total_break_seconds
        FROM attendance
        WHERE user_id = ?
        AND status IN (
          'working',
          'break'
        )
        AND DATE(login_time) = CURDATE()
        ORDER BY login_time DESC
        LIMIT 1
        `,
        [
          userId,
        ]
      );

    if (
      activeSessions.length >
      0
    ) {
      return res
        .status(409)
        .json({
          success: false,

          message:
            "You already have an active attendance session",

          attendance:
            activeSessions[0],
        });
    }

    // ========================================
    // CREATE NEW SESSION
    // ========================================

    const [result] =
      await pool.query(
        `
        INSERT INTO attendance
        (
          user_id,
          login_time,
          status,
          total_break_seconds
        )
        VALUES
        (
          ?,
          NOW(6),
          'working',
          0
        )
        `,
        [
          userId,
        ]
      );

    const [attendance] =
      await pool.query(
        `
        SELECT
          id,
          user_id,
          login_time,
          logout_time,
          work_duration_seconds,
          status,
          break_start_time,
          total_break_seconds
        FROM attendance
        WHERE id = ?
        `,
        [
          result.insertId,
        ]
      );

    return res
      .status(201)
      .json({
        success: true,

        message:
          "You are now online",

        attendance:
          attendance[0],
      });
  } catch (error) {
    console.error(
      "Go Online Error:",
      error
    );

    return res
      .status(500)
      .json({
        success: false,

        message:
          "Unable to go online",
      });
  }
};

// ==========================================
// START BREAK
// ==========================================

const startBreak = async (
  req,
  res
) => {
  try {
    const userId =
      req.user.id;

    await closeOldSessions(
      userId
    );

    const [sessions] =
      await pool.query(
        `
        SELECT
          id,
          status
        FROM attendance
        WHERE user_id = ?
        AND status = 'working'
        AND DATE(login_time) = CURDATE()
        ORDER BY login_time DESC
        LIMIT 1
        `,
        [
          userId,
        ]
      );

    if (
      sessions.length === 0
    ) {
      return res
        .status(400)
        .json({
          success: false,

          message:
            "You must be online and working before starting a break",
        });
    }

    const attendanceId =
      sessions[0].id;

    await pool.query(
      `
      UPDATE attendance
      SET
        status = 'break',
        break_start_time = NOW(6)
      WHERE id = ?
      `,
      [
        attendanceId,
      ]
    );

    const [attendance] =
      await pool.query(
        `
        SELECT
          id,
          user_id,
          login_time,
          logout_time,
          work_duration_seconds,
          status,
          break_start_time,
          total_break_seconds
        FROM attendance
        WHERE id = ?
        `,
        [
          attendanceId,
        ]
      );

    return res
      .status(200)
      .json({
        success: true,

        message:
          "Break started",

        attendance:
          attendance[0],
      });
  } catch (error) {
    console.error(
      "Start Break Error:",
      error
    );

    return res
      .status(500)
      .json({
        success: false,

        message:
          "Unable to start break",
      });
  }
};

// ==========================================
// END BREAK
// ==========================================

const endBreak = async (
  req,
  res
) => {
  try {
    const userId =
      req.user.id;

    await closeOldSessions(
      userId
    );

    const [sessions] =
      await pool.query(
        `
        SELECT
          id,
          break_start_time
        FROM attendance
        WHERE user_id = ?
        AND status = 'break'
        AND DATE(login_time) = CURDATE()
        ORDER BY login_time DESC
        LIMIT 1
        `,
        [
          userId,
        ]
      );

    if (
      sessions.length === 0
    ) {
      return res
        .status(400)
        .json({
          success: false,

          message:
            "You are not currently on break",
        });
    }

    const attendanceId =
      sessions[0].id;

    await pool.query(
      `
      UPDATE attendance
      SET
        total_break_seconds =
          total_break_seconds +
          TIMESTAMPDIFF(
            SECOND,
            break_start_time,
            NOW(6)
          ),

        break_start_time =
          NULL,

        status =
          'working'

      WHERE id = ?
      `,
      [
        attendanceId,
      ]
    );

    const [attendance] =
      await pool.query(
        `
        SELECT
          id,
          user_id,
          login_time,
          logout_time,
          work_duration_seconds,
          status,
          break_start_time,
          total_break_seconds
        FROM attendance
        WHERE id = ?
        `,
        [
          attendanceId,
        ]
      );

    return res
      .status(200)
      .json({
        success: true,

        message:
          "Break ended. You are back to work.",

        attendance:
          attendance[0],
      });
  } catch (error) {
    console.error(
      "End Break Error:",
      error
    );

    return res
      .status(500)
      .json({
        success: false,

        message:
          "Unable to end break",
      });
  }
};

// ==========================================
// GO OFFLINE
// ==========================================

const goOffline = async (
  req,
  res
) => {
  try {
    const userId =
      req.user.id;

    await closeOldSessions(
      userId
    );

    const [sessions] =
      await pool.query(
        `
        SELECT
          id,
          login_time,
          status,
          break_start_time,
          total_break_seconds
        FROM attendance
        WHERE user_id = ?
        AND status IN (
          'working',
          'break'
        )
        AND DATE(login_time) = CURDATE()
        ORDER BY login_time DESC
        LIMIT 1
        `,
        [
          userId,
        ]
      );

    if (
      sessions.length === 0
    ) {
      return res
        .status(400)
        .json({
          success: false,

          message:
            "You are not currently online",
        });
    }

    const session =
      sessions[0];

    const attendanceId =
      session.id;

    // ========================================
    // FINISH CURRENT BREAK
    // ========================================

    if (
      session.status ===
        "break" &&
      session.break_start_time
    ) {
      await pool.query(
        `
        UPDATE attendance
        SET
          total_break_seconds =
            total_break_seconds +
            TIMESTAMPDIFF(
              SECOND,
              break_start_time,
              NOW(6)
            ),

          break_start_time =
            NULL

        WHERE id = ?
        `,
        [
          attendanceId,
        ]
      );
    }

    // ========================================
    // COMPLETE SESSION
    // ========================================

    await pool.query(
      `
      UPDATE attendance
      SET
        logout_time =
          NOW(6),

        work_duration_seconds =
          GREATEST(
            0,

            TIMESTAMPDIFF(
              SECOND,
              login_time,
              NOW(6)
            ) -

            COALESCE(
              total_break_seconds,
              0
            )
          ),

        status =
          'completed',

        break_start_time =
          NULL

      WHERE id = ?
      `,
      [
        attendanceId,
      ]
    );

    const [attendance] =
      await pool.query(
        `
        SELECT
          id,
          user_id,
          login_time,
          logout_time,
          work_duration_seconds,
          status,
          break_start_time,
          total_break_seconds
        FROM attendance
        WHERE id = ?
        `,
        [
          attendanceId,
        ]
      );

    return res
      .status(200)
      .json({
        success: true,

        message:
          "You are now offline",

        attendance:
          attendance[0],
      });
  } catch (error) {
    console.error(
      "Go Offline Error:",
      error
    );

    return res
      .status(500)
      .json({
        success: false,

        message:
          "Unable to go offline",
      });
  }
};

// ==========================================
// GET CURRENT ATTENDANCE STATUS
// ==========================================

const getAttendanceStatus = async (
  req,
  res
) => {
  try {
    const userId =
      req.user.id;

    // Automatically close yesterday's
    // forgotten session.
    await closeOldSessions(
      userId
    );

    // ========================================
    // CURRENT DAY ACTIVE SESSION
    // ========================================

    const [activeSessions] =
      await pool.query(
        `
        SELECT
          id,
          user_id,
          login_time,
          logout_time,
          work_duration_seconds,
          status,
          break_start_time,
          total_break_seconds
        FROM attendance
        WHERE user_id = ?
        AND status IN (
          'working',
          'break'
        )
        AND DATE(login_time) = CURDATE()
        ORDER BY login_time DESC
        LIMIT 1
        `,
        [
          userId,
        ]
      );

    // ========================================
    // TODAY COMPLETED WORK
    // ========================================

    const [todayStats] =
      await pool.query(
        `
        SELECT

          COALESCE(
            SUM(
              work_duration_seconds
            ),
            0
          ) AS total_work_seconds,

          COALESCE(
            SUM(
              total_break_seconds
            ),
            0
          ) AS total_break_seconds

        FROM attendance

        WHERE user_id = ?

        AND DATE(login_time) =
          CURDATE()

        AND status =
          'completed'
        `,
        [
          userId,
        ]
      );

    const completedWorkSeconds =
      Number(
        todayStats[0]
          .total_work_seconds
      ) || 0;

    const completedBreakSeconds =
      Number(
        todayStats[0]
          .total_break_seconds
      ) || 0;

    if (
      activeSessions.length >
      0
    ) {
      const activeAttendance =
        activeSessions[0];

      return res
        .status(200)
        .json({
          success: true,

          isOnline: true,

          isOnBreak:
            activeAttendance
              .status ===
            "break",

          attendance:
            activeAttendance,

          totalWorkSeconds:
            completedWorkSeconds,

          totalBreakSeconds:
            completedBreakSeconds,
        });
    }

    return res
      .status(200)
      .json({
        success: true,

        isOnline: false,

        isOnBreak: false,

        attendance: null,

        totalWorkSeconds:
          completedWorkSeconds,

        totalBreakSeconds:
          completedBreakSeconds,
      });
  } catch (error) {
    console.error(
      "Attendance Status Error:",
      error
    );

    return res
      .status(500)
      .json({
        success: false,

        message:
          "Unable to load attendance status",
      });
  }
};

// ==========================================
// GET EMPLOYEE ATTENDANCE HISTORY
// ==========================================

const getAttendanceHistory =
  async (req, res) => {
    try {
      const userId =
        req.user.id;

      // Close old forgotten session
      // before generating history.
      await closeOldSessions(
        userId
      );

      const [history] =
        await pool.query(
          `
          SELECT

            DATE(login_time)
              AS attendance_date,

            MIN(login_time)
              AS first_login_time,

            MAX(logout_time)
              AS last_logout_time,

            SUM(
              COALESCE(
                total_break_seconds,
                0
              )
            ) AS total_break_seconds,

            SUM(
              COALESCE(
                work_duration_seconds,
                0
              )
            ) AS total_work_seconds,

            COUNT(*)
              AS total_sessions

          FROM attendance

          WHERE user_id = ?

          AND status =
            'completed'

          GROUP BY
            DATE(login_time)

          ORDER BY
            attendance_date DESC
          `,
          [
            userId,
          ]
        );

      return res
        .status(200)
        .json({
          success: true,

          history:
            history.map(
              (record) => ({
                ...record,

                total_break_seconds:
                  Number(
                    record
                      .total_break_seconds
                  ) || 0,

                total_work_seconds:
                  Number(
                    record
                      .total_work_seconds
                  ) || 0,

                total_sessions:
                  Number(
                    record
                      .total_sessions
                  ) || 0,
              })
            ),
        });
    } catch (error) {
      console.error(
        "Attendance History Error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,

          message:
            "Unable to load attendance history",
        });
    }
  };

// ==========================================
// ADMIN - GET LIVE EMPLOYEE ATTENDANCE
// ==========================================

const getAdminLiveAttendance =
  async (req, res) => {
    try {
      // ======================================
      // CLOSE ALL OLD ACTIVE SESSIONS
      // ======================================

      await closeOldSessions();

      const [employees] =
        await pool.query(
          `
          SELECT
            u.id,
            u.employee_id,
            u.full_name,

            CASE

              WHEN a.status =
                'working'
                THEN 'working'

              WHEN a.status =
                'break'
                THEN 'break'

              ELSE 'offline'

            END AS attendance_status,

            a.login_time,

            a.break_start_time,

            a.total_break_seconds,

            COALESCE(
              (
                SELECT
                  SUM(
                    COALESCE(
                      completed
                        .work_duration_seconds,
                      0
                    )
                  )

                FROM attendance
                  completed

                WHERE
                  completed.user_id =
                    u.id

                AND DATE(
                  completed.login_time
                ) =
                  CURDATE()

                AND completed.status =
                  'completed'
              ),
              0
            )
              AS completed_work_seconds

          FROM users u

          LEFT JOIN attendance a
            ON a.id = (

              SELECT
                active.id

              FROM attendance
                active

              WHERE
                active.user_id =
                  u.id

              AND active.status
                IN (
                  'working',
                  'break'
                )

              AND DATE(
                active.login_time
              ) =
                CURDATE()

              ORDER BY
                active.login_time
                DESC

              LIMIT 1
            )

          WHERE
            u.role =
              'employee'

          AND u.status =
              'active'

          ORDER BY
            u.full_name ASC
          `
        );

      const liveEmployees =
        employees.map(
          (employee) => {
            let currentSessionSeconds =
              0;

            if (
              employee.login_time &&
              employee
                .attendance_status !==
                "offline"
            ) {
              const now =
                new Date();

              const loginTime =
                new Date(
                  employee
                    .login_time
                );

              const sessionSeconds =
                Math.max(
                  0,

                  Math.floor(
                    (
                      now.getTime() -
                      loginTime.getTime()
                    ) / 1000
                  )
                );

              let breakSeconds =
                Number(
                  employee
                    .total_break_seconds
                ) || 0;

              if (
                employee
                  .attendance_status ===
                  "break" &&

                employee
                  .break_start_time
              ) {
                const breakStart =
                  new Date(
                    employee
                      .break_start_time
                  );

                breakSeconds +=
                  Math.max(
                    0,

                    Math.floor(
                      (
                        now.getTime() -
                        breakStart.getTime()
                      ) / 1000
                    )
                  );
              }

              currentSessionSeconds =
                Math.max(
                  0,

                  sessionSeconds -
                    breakSeconds
                );
            }

            const completedWorkSeconds =
              Number(
                employee
                  .completed_work_seconds
              ) || 0;

            return {
              id:
                employee.id,

              employeeId:
                employee
                  .employee_id,

              fullName:
                employee
                  .full_name,

              status:
                employee
                  .attendance_status,

              loginTime:
                employee
                  .login_time,

              breakStartTime:
                employee
                  .break_start_time,

              currentSessionSeconds,

              completedWorkSeconds,

              todayWorkSeconds:
                completedWorkSeconds +
                currentSessionSeconds,
            };
          }
        );

      return res
        .status(200)
        .json({
          success: true,

          summary: {
            totalEmployees:
              liveEmployees.length,

            working:
              liveEmployees.filter(
                (employee) =>
                  employee
                    .status ===
                  "working"
              ).length,

            onBreak:
              liveEmployees.filter(
                (employee) =>
                  employee
                    .status ===
                  "break"
              ).length,

            offline:
              liveEmployees.filter(
                (employee) =>
                  employee
                    .status ===
                  "offline"
              ).length,
          },

          employees:
            liveEmployees,
        });
    } catch (error) {
      console.error(
        "Admin Live Attendance Error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,

          message:
            "Unable to load live employee attendance",
        });
    }
  };

// ==========================================
// EXPORT CONTROLLERS
// ==========================================

module.exports = {
  goOnline,
  startBreak,
  endBreak,
  goOffline,
  getAttendanceStatus,
  getAttendanceHistory,
  getAdminLiveAttendance,
};