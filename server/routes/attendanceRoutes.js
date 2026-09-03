const express = require("express");

const {
  goOnline,
  startBreak,
  endBreak,
  goOffline,
  getAttendanceStatus,
  getAttendanceHistory,
  getAdminLiveAttendance,
  getMonthlyAttendanceHistory,
} = require("../controllers/attendanceController");

const {
  protect,
  adminOnly,
} = require("../middleware/authMiddleware");

const router = express.Router();

// ==========================================
// ADMIN - LIVE EMPLOYEE ATTENDANCE
// ==========================================

router.get(
  "/admin/live",
  protect,
  adminOnly,
  getAdminLiveAttendance
);

// ==========================================
// EMPLOYEE - ATTENDANCE HISTORY
// ==========================================

router.get(
  "/history",
  protect,
  getAttendanceHistory
);
// ==========================================
// EMPLOYEE - MONTHLY ATTENDANCE HISTORY
// ==========================================

router.get(
  "/monthly",
  protect,
  getMonthlyAttendanceHistory
);

// ==========================================
// EMPLOYEE - CURRENT ATTENDANCE STATUS
// ==========================================

router.get(
  "/status",
  protect,
  getAttendanceStatus
);

// ==========================================
// EMPLOYEE - GO ONLINE
// ==========================================

router.post(
  "/online",
  protect,
  goOnline
);

// ==========================================
// EMPLOYEE - START BREAK
// ==========================================

router.post(
  "/break/start",
  protect,
  startBreak
);

// ==========================================
// EMPLOYEE - END BREAK
// ==========================================

router.post(
  "/break/end",
  protect,
  endBreak
);

// ==========================================
// EMPLOYEE - GO OFFLINE
// ==========================================

router.post(
  "/offline",
  protect,
  goOffline
);

module.exports = router;