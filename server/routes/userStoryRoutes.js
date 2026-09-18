const express = require("express");

const router = express.Router();

const pool = require("../config/db");

const {
    getUserStories,
    getUserStory,
    createUserStory,
    updateUserStory,
    assignUserStoryToSprint,
    createTask,
    deleteUserStory,
    restoreUserStory,
    permanentDeleteUserStory
} = require("../controllers/userStoryController");

const {
    protect,
} = require("../middleware/authMiddleware");

const {
    requireProjectAccess,
    requireProjectPermission,
} = require("../middleware/accessMiddleware");

// ==========================================
// PROJECT ID RESOLVERS
// requireProjectMembership/requireProjectPermission
// default to reading req.params.id as the project
// id, which is correct for "/project/:projectId"
// routes below (resolved explicitly) but NOT for
// routes shaped around a USER STORY id ("/:id",
// "/:id/tasks") — those resolve the story's
// project_id with a small lookup first.
// ==========================================

const projectIdFromQuery = (req) => req.params.projectId;

const projectIdFromStory = async (req) => {

    const [rows] = await pool.query(
        `SELECT project_id FROM user_stories WHERE id = ? LIMIT 1`,
        [req.params.id]
    );

    return rows[0]?.project_id || null;

};

// ==========================================
// GET USER STORIES FOR A PROJECT
// GET /api/user-stories/project/:projectId
// ==========================================

router.get(
    "/project/:projectId",
    protect,
    requireProjectAccess,
    requireProjectPermission("BACKLOG_VIEW", projectIdFromQuery),
    getUserStories
);

// ==========================================
// GET ONE USER STORY (with its tasks)
// GET /api/user-stories/:id
// ==========================================

router.get(
    "/:id",
    protect,
    requireProjectAccess,
    requireProjectPermission("USER_STORY_VIEW", projectIdFromStory),
    getUserStory
);

// ==========================================
// CREATE USER STORY UNDER A PROJECT
// POST /api/user-stories/project/:projectId
// ==========================================

router.post(
    "/project/:projectId",
    protect,
    requireProjectAccess,
    requireProjectPermission("USER_STORY_CREATE", projectIdFromQuery),
    createUserStory
);

// ==========================================
// UPDATE USER STORY
// PUT /api/user-stories/:id
// ==========================================

router.put(
    "/:id",
    protect,
    requireProjectAccess,
    requireProjectPermission("USER_STORY_EDIT", projectIdFromStory),
    updateUserStory
);

// ==========================================
// DELETE USER STORY
// DELETE /api/user-stories/:id
// ==========================================

router.delete(
    "/:id",
    protect,
    requireProjectAccess,
    requireProjectPermission("USER_STORY_DELETE", projectIdFromStory),
    deleteUserStory
);

// ==========================================
// RESTORE / PERMANENT DELETE (Recycle Bin)
// Both reuse USER_STORY_DELETE -- see epicRoutes.js for the pattern.
// ==========================================

router.patch(
    "/:id/restore",
    protect,
    requireProjectAccess,
    requireProjectPermission("USER_STORY_DELETE", projectIdFromStory),
    restoreUserStory
);

router.delete(
    "/:id/permanent",
    protect,
    requireProjectAccess,
    requireProjectPermission("USER_STORY_DELETE", projectIdFromStory),
    permanentDeleteUserStory
);

// ==========================================
// ASSIGN USER STORY TO SPRINT (or back to Backlog)
// PATCH /api/user-stories/:id/sprint
// Gated by USER_STORY_EDIT, no ownership requirement -- same
// reasoning as taskManagementController.assignTaskToSprint (Sprint
// planning is normally done by whoever runs planning, not by each
// story's individual owner).
// ==========================================

router.patch(
    "/:id/sprint",
    protect,
    requireProjectAccess,
    requireProjectPermission("USER_STORY_EDIT", projectIdFromStory),
    assignUserStoryToSprint
);

// ==========================================
// CREATE TASK UNDER A USER STORY
// POST /api/user-stories/:id/tasks
// Assignee is additionally validated against the
// caller's existing task-assignment scope inside
// the controller (see userStoryController.js) —
// TASK_CREATE alone does not grant unrestricted
// assignment authority.
// ==========================================

router.post(
    "/:id/tasks",
    protect,
    requireProjectAccess,
    requireProjectPermission("TASK_CREATE", projectIdFromStory),
    createTask
);

module.exports = router;
