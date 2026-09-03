const express = require("express");

const router = express.Router();

const pool = require("../config/db");

const {
    getMyActiveSprints,
    getSprints,
    getSprint,
    createSprint,
    updateSprint,
    startSprint,
    completeSprint,
    deleteSprint
} = require("../controllers/sprintController");

const {
    getSprintAnalytics
} = require("../controllers/sprintAnalyticsController");

const {
    protect,
} = require("../middleware/authMiddleware");

const {
    requireProjectAccess,
    requireProjectPermission,
} = require("../middleware/accessMiddleware");

// ==========================================
// PROJECT ID RESOLVERS
// Same pattern as userStoryRoutes.js — routes
// shaped around a SPRINT id ("/:id", "/:id/start",
// etc.) resolve the sprint's project_id with a
// small lookup first.
// ==========================================

const projectIdFromQuery = (req) => req.params.projectId;

const projectIdFromSprint = async (req) => {

    const [rows] = await pool.query(
        `SELECT project_id FROM sprints WHERE id = ? LIMIT 1`,
        [req.params.id]
    );

    return rows[0]?.project_id || null;

};

// ==========================================
// GET ACTIVE SPRINTS ACROSS ALL MY PROJECTS
// GET /api/sprints/active
// Must be registered BEFORE "/:id" below, or
// Express would match this as a sprint id lookup.
// ==========================================

router.get(
    "/active",
    protect,
    getMyActiveSprints
);

// ==========================================
// GET SPRINTS FOR A PROJECT
// GET /api/sprints/project/:projectId
// ==========================================

router.get(
    "/project/:projectId",
    protect,
    requireProjectAccess,
    requireProjectPermission("BACKLOG_VIEW", projectIdFromQuery),
    getSprints
);

// ==========================================
// GET ONE SPRINT (with its tasks)
// GET /api/sprints/:id
// ==========================================

router.get(
    "/:id",
    protect,
    requireProjectAccess,
    requireProjectPermission("BACKLOG_VIEW", projectIdFromSprint),
    getSprint
);

// ==========================================
// GET SPRINT ANALYTICS (read-only)
// GET /api/sprints/:id/analytics
// Project resolved from the sprint id via the same
// projectIdFromSprint resolver every other sprint-id
// route already uses -- a forged/unrelated sprint id
// resolves to ITS OWN project, and TASK_VIEW is
// checked against that, never the caller's own
// project. Reuses TASK_VIEW (not BACKLOG_VIEW) since
// analytics is a rollup of task data, matching what
// Board/Backlog already gate on.
// ==========================================

router.get(
    "/:id/analytics",
    protect,
    requireProjectAccess,
    requireProjectPermission("TASK_VIEW", projectIdFromSprint),
    getSprintAnalytics
);

// ==========================================
// CREATE SPRINT UNDER A PROJECT
// POST /api/sprints/project/:projectId
// ==========================================

router.post(
    "/project/:projectId",
    protect,
    requireProjectAccess,
    requireProjectPermission("PROJECT_EDIT", projectIdFromQuery),
    createSprint
);

// ==========================================
// UPDATE SPRINT
// PUT /api/sprints/:id
// ==========================================

router.put(
    "/:id",
    protect,
    requireProjectAccess,
    requireProjectPermission("PROJECT_EDIT", projectIdFromSprint),
    updateSprint
);

// ==========================================
// START SPRINT
// PATCH /api/sprints/:id/start
// ==========================================

router.patch(
    "/:id/start",
    protect,
    requireProjectAccess,
    requireProjectPermission("PROJECT_EDIT", projectIdFromSprint),
    startSprint
);

// ==========================================
// COMPLETE SPRINT
// PATCH /api/sprints/:id/complete
// ==========================================

router.patch(
    "/:id/complete",
    protect,
    requireProjectAccess,
    requireProjectPermission("PROJECT_EDIT", projectIdFromSprint),
    completeSprint
);

// ==========================================
// DELETE SPRINT
// DELETE /api/sprints/:id
// ==========================================

router.delete(
    "/:id",
    protect,
    requireProjectAccess,
    requireProjectPermission("PROJECT_EDIT", projectIdFromSprint),
    deleteSprint
);

module.exports = router;
