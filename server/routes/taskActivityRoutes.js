const express = require("express");

const router = express.Router();

const taskUpload = require("../middleware/taskUploadMiddleware");

const {
    getActivity,
    createActivity,
    updateActivity,
    deleteActivity
} = require("../controllers/taskActivityController");

const {
    protect
} = require("../middleware/authMiddleware");

// ==========================================
// GET ACTIVITY FEED FOR A TASK
// GET /api/task-activity/:taskId
// ==========================================

router.get(
    "/:taskId",
    protect,
    getActivity
);

// ==========================================
// POST NEW ACTIVITY ENTRY (comment / work update)
// Supports optional file attachments.
// POST /api/task-activity/:taskId
// ==========================================

router.post(
    "/:taskId",
    protect,
    taskUpload.array("attachments", 5),
    createActivity
);

// ==========================================
// EDIT ACTIVITY ENTRY (author only)
// PUT /api/task-activity/activity/:activityId
// ==========================================

router.put(
    "/activity/:activityId",
    protect,
    updateActivity
);

// ==========================================
// DELETE ACTIVITY ENTRY (author or admin)
// DELETE /api/task-activity/activity/:activityId
// ==========================================

router.delete(
    "/activity/:activityId",
    protect,
    deleteActivity
);

module.exports = router;
