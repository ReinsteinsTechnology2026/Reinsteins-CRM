const express =
  require("express");

const {
  createTask,
  getMyTasks,
  updateTask,
  completeTask,
  getAdminTasks,
} = require(
  "../controllers/taskController"
);

const {
  protect,
  adminOnly,
} = require(
  "../middleware/authMiddleware"
);

const router =
  express.Router();

// ==========================================
// ADMIN - GET ALL EMPLOYEE TASKS
// ==========================================

router.get(
  "/admin/all",
  protect,
  adminOnly,
  getAdminTasks
);

// ==========================================
// EMPLOYEE - GET MY TASKS
// ==========================================

router.get(
  "/my",
  protect,
  getMyTasks
);

// ==========================================
// EMPLOYEE - CREATE / START TASK
// ==========================================

router.post(
  "/",
  protect,
  createTask
);

// ==========================================
// EMPLOYEE - UPDATE TASK
// ==========================================

router.put(
  "/:id",
  protect,
  updateTask
);

// ==========================================
// EMPLOYEE - COMPLETE TASK
// ==========================================

router.patch(
  "/:id/complete",
  protect,
  completeTask
);

module.exports = router;