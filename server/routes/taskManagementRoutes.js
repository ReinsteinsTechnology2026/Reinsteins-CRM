console.log("✅ taskManagementRoutes loaded");

const express = require("express");

const router = express.Router();

const {

    getEmployees,

    getTasks,

    getTaskById,

    createTask,

    updateTask,

    changeTaskStatus,

    assignTaskToSprint,

    deleteTask,

    transferTask,

    assignTask,

    getTransferTargets,

    approveTask,

    sendBackTask

} = require("../controllers/taskManagementController");

const {

    protect

} = require("../middleware/authMiddleware");

const {

    requireActiveUser

} = require("../middleware/accessMiddleware");

// ==========================================
// GET EMPLOYEES
// ==========================================

router.get(
    "/employees",
    protect,
    requireActiveUser,
    getEmployees
);

// ==========================================
// GET TASKS
// ==========================================

router.get(
    "/tasks",
    protect,
    getTasks
);

// ==========================================
// GET ONE TASK (Task Workspace)
// ==========================================

router.get(
    "/task/:id",
    protect,
    getTaskById
);

// ==========================================
// CREATE TASK
// ==========================================

router.post(
    "/create",
    protect,
    requireActiveUser,
    createTask
);

// ==========================================
// UPDATE TASK
// ==========================================

router.put(
    "/update/:id",
    protect,
    updateTask
);

// ==========================================
// UPDATE TASK STATUS ONLY (Kanban move)
// ==========================================

router.patch(
    "/:id/status",
    protect,
    requireActiveUser,
    changeTaskStatus
);

// ==========================================
// ASSIGN TASK TO SPRINT (or back to Backlog)
// ==========================================

router.patch(
    "/:id/sprint",
    protect,
    requireActiveUser,
    assignTaskToSprint
);

// ==========================================
// DELETE TASK
// ==========================================

router.delete(
    "/delete/:id",
    protect,
    deleteTask
);

// ==========================================
// TRANSFER TASK
// ==========================================

router.put(
    "/transfer/:id",
    protect,
    requireActiveUser,
    transferTask
);

// ==========================================
// TRANSFER TARGETS
// Every active Employee/Intern in the company,
// unscoped by assignable-scope — the transfer
// dropdown deliberately shows everyone, since any
// current assignee may hand their task to anyone
// active. This is separate from GET /employees,
// which stays scope-limited for task CREATION
// assignment (unchanged).
// ==========================================

router.get(
    "/transfer-targets",
    protect,
    requireActiveUser,
    getTransferTargets
);

// ==========================================
// ASSIGN / REASSIGN TASK (project-linked tasks only —
// separate from Transfer above; see taskManagementController.js)
// ==========================================

router.put(
    "/assign/:id",
    protect,
    requireActiveUser,
    assignTask
);

// ==========================================
// ADMIN - APPROVE & CLOSE TASK
// ==========================================

// Authorization (project-linked: TASK_CHANGE_STATUS via project
// permissions; non-project: the original admin-only rule) now lives
// inside approveTask/sendBackTask themselves -- see
// taskManagementController.js -- so it can branch on task.project_id,
// same pattern as every other project-aware action in this file.

router.put(
    "/approve/:id",
    protect,
    approveTask
);

// ==========================================
// SEND TASK BACK TO EMPLOYEE
// ==========================================

router.put(
    "/send-back/:id",
    protect,
    sendBackTask
);

module.exports = router;