const pool = require("../config/db");

const getDashboardStats = async (req, res) => {
  try {
    // ==========================================
    // TOTAL ACTIVE EMPLOYEES
    // ==========================================

    const [employeeResult] = await pool.query(
      `
      SELECT COUNT(*) AS "totalEmployees"
      FROM users
      WHERE role = 'employee'
      AND status = 'active'
      `
    );

    // ==========================================
    // PRESENT TODAY
    // Employees who logged attendance today
    // ==========================================

    const [presentResult] = await pool.query(
      `
      SELECT COUNT(DISTINCT user_id) AS "presentToday"
      FROM attendance
      WHERE DATE(login_time) = CURRENT_DATE
      `
    );

    // ==========================================
    // EMPLOYEES ON APPROVED LEAVE TODAY
    // ==========================================

    const [onLeaveResult] = await pool.query(
      `
      SELECT COUNT(DISTINCT user_id) AS "onLeave"
      FROM leave_requests
      WHERE status = 'approved'
      AND CURRENT_DATE BETWEEN from_date AND to_date
      `
    );

    // ==========================================
    // ACTIVE TASKS
    // ==========================================

    const [activeTaskResult] = await pool.query(
      `
      SELECT COUNT(*) AS "activeTasks"
      FROM tasks
      WHERE status = 'in_progress'
      AND deleted_at IS NULL
      `
    );

    // ==========================================
    // RECENT EMPLOYEES
    // ==========================================

    const [recentEmployees] = await pool.query(
      `
      SELECT
        id,
        employee_id,
        full_name,
        email,
        status,
        created_at
      FROM users
      WHERE role = 'employee'
      ORDER BY created_at DESC
      LIMIT 5
      `
    );

    // ==========================================
    // SEND DASHBOARD DATA
    // ==========================================

    return res.status(200).json({
      success: true,

      stats: {
        totalEmployees:
          Number(employeeResult[0].totalEmployees),

        presentToday:
          Number(presentResult[0].presentToday),

        onLeave:
          Number(onLeaveResult[0].onLeave),

        activeTasks:
          Number(activeTaskResult[0].activeTasks),
      },

      recentEmployees,
    });

  } catch (error) {
    console.error(
      "Dashboard Stats Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to load dashboard statistics",
    });
  }
};
// ==========================================
// LIVE TASK DETAILS
// ==========================================

const getLiveTaskDetails = async (req, res) => {

  try {

    const [employees] = await pool.query(`

      SELECT

        u.id,

        u.employee_id,

        u.full_name,

        u.status,

        t.id AS task_id,

        t.task_title,

        t.task_description,

        t.priority,

        t.progress,

        t.status AS task_status,

        t.work_started_at,

        t.estimated_hours,

        t.due_date

      FROM users u

      LEFT JOIN tasks t

        ON t.assigned_to = u.id

        AND t.status = 'in_progress'

      WHERE

        u.role = 'employee'

        AND u.status = 'active'

      ORDER BY u.full_name ASC

    `);

    return res.status(200).json(employees);

  }

  catch (error) {

    console.error(

      "Live Task Details Error:",

      error

    );

    return res.status(500).json({

      success: false,

      message: "Unable to load task details."

    });

  }

};
module.exports = {

  getDashboardStats,

  getLiveTaskDetails,

};