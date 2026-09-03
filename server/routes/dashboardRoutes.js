const express = require("express");

const {
  getDashboardStats,
  getLiveTaskDetails,
} = require("../controllers/dashboardController");

const {
  protect,
} = require("../middleware/authMiddleware");

const {
  requireAccess,
} = require("../middleware/accessMiddleware");

const router = express.Router();

// Widened to include Executive (Founder/Chairman need the company
// overview numbers) — role='admin' still always passes via
// requireAccess, so nothing changes for existing admin usage.

const viewDashboard = requireAccess("super_admin", "admin", "executive");

// ==========================================
// DASHBOARD STATS
// ==========================================

router.get(
  "/stats",
  protect,
  viewDashboard,
  getDashboardStats
);

// ==========================================
// LIVE TASK DETAILS
// ==========================================

router.get(
  "/live-work",
  protect,
  viewDashboard,
  getLiveTaskDetails
);

module.exports = router;