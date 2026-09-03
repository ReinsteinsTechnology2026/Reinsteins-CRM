const express = require("express");

const {
  getEmployeeReport,
  getAttendanceReport,
  getTaskReport,
  getLeaveReport,
  exportReportExcel,
} = require(
  "../controllers/reportController"
);

const {
  protect,
  adminOnly,
} = require(
  "../middleware/authMiddleware"
);

const router = express.Router();

// ==========================================
// EMPLOYEE REPORT
// ==========================================

router.get(
  "/employees",
  protect,
  adminOnly,
  getEmployeeReport
);

// ==========================================
// ATTENDANCE REPORT
// ==========================================

router.get(
  "/attendance",
  protect,
  adminOnly,
  getAttendanceReport
);

// ==========================================
// TASK REPORT
// ==========================================

router.get(
  "/tasks",
  protect,
  adminOnly,
  getTaskReport
);

// ==========================================
// LEAVE REPORT
// ==========================================

router.get(
  "/leave",
  protect,
  adminOnly,
  getLeaveReport
);

// ==========================================
// EXPORT REPORT TO EXCEL
// ==========================================

router.get(
  "/export/:reportType",
  protect,
  adminOnly,
  exportReportExcel
);

module.exports = router;