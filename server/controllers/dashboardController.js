const pool = require("../config/db");
const companyFeatureService = require("../services/companyFeatureService");
const { FEATURE_IDS } = require("../config/tenantFeatures");

// The dashboard summarises several modules. A company only sees (and only has queried for it) the sections of the modules
// it has: a legacy request has every module; a tenant request is limited to its company's features.
const enabledFeaturesFor = async (req) =>
  req.tenantCompany ? companyFeatureService.getEnabledFeatureIds(req.tenantCompany.id) : [...FEATURE_IDS];

const getDashboardStats = async (req, res) => {
  try {
    const enabled = await enabledFeaturesFor(req);
    const has = (featureId) => enabled.includes(featureId);

    // ==========================================
    // TOTAL ACTIVE EMPLOYEES
    // ==========================================

    const [employeeResult] = !has("employee_management") ? [[{ totalEmployees: 0 }]] : await pool.query(
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

    const [presentResult] = !has("attendance") ? [[{ presentToday: 0 }]] : await pool.query(
      `
      SELECT COUNT(DISTINCT user_id) AS "presentToday"
      FROM attendance
      WHERE DATE(login_time) = CURRENT_DATE
      `
    );

    // ==========================================
    // EMPLOYEES ON APPROVED LEAVE TODAY
    // ==========================================

    const [onLeaveResult] = !has("leave_management") ? [[{ onLeave: 0 }]] : await pool.query(
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

    const [activeTaskResult] = !has("task_management") ? [[{ activeTasks: 0 }]] : await pool.query(
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

    const [recentEmployees] = !has("employee_management") ? [[]] : await pool.query(
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

      // Which sections the browser should show (a disabled module's section is hidden, not shown as zero).
      sections: {
        employees: has("employee_management"),
        attendance: has("attendance"),
        leave: has("leave_management"),
        tasks: has("task_management"),
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