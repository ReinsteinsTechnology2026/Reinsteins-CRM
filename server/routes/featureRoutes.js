const express = require("express");

const router = express.Router();

const pool = require("../config/db");

const {
    getFeatures,
    getFeature,
    createFeature,
    updateFeature,
    deleteFeature
} = require("../controllers/featureController");

const {
    protect,
} = require("../middleware/authMiddleware");

const {
    requireProjectAccess,
    requireProjectPermission,
} = require("../middleware/accessMiddleware");

// ==========================================
// PROJECT ID RESOLVERS
// Same pattern as epicRoutes.js/sprintRoutes.js.
// ==========================================

const projectIdFromQuery = (req) => req.params.projectId;

const projectIdFromFeature = async (req) => {

    const [rows] = await pool.query(
        `SELECT project_id FROM features WHERE id = ? LIMIT 1`,
        [req.params.id]
    );

    return rows[0]?.project_id || null;

};

// ==========================================
// GET FEATURES FOR A PROJECT
// GET /api/features/project/:projectId
// ==========================================

router.get(
    "/project/:projectId",
    protect,
    requireProjectAccess,
    requireProjectPermission("FEATURE_VIEW", projectIdFromQuery),
    getFeatures
);

// ==========================================
// GET ONE FEATURE
// GET /api/features/:id
// ==========================================

router.get(
    "/:id",
    protect,
    requireProjectAccess,
    requireProjectPermission("FEATURE_VIEW", projectIdFromFeature),
    getFeature
);

// ==========================================
// CREATE FEATURE UNDER A PROJECT
// (optionally under an Epic -- epic_id in body,
// validated server-side against this SAME project)
// POST /api/features/project/:projectId
// ==========================================

router.post(
    "/project/:projectId",
    protect,
    requireProjectAccess,
    requireProjectPermission("FEATURE_CREATE", projectIdFromQuery),
    createFeature
);

// ==========================================
// UPDATE FEATURE
// PUT /api/features/:id
// ==========================================

router.put(
    "/:id",
    protect,
    requireProjectAccess,
    requireProjectPermission("FEATURE_EDIT", projectIdFromFeature),
    updateFeature
);

// ==========================================
// DELETE FEATURE
// DELETE /api/features/:id
// ==========================================

router.delete(
    "/:id",
    protect,
    requireProjectAccess,
    requireProjectPermission("FEATURE_DELETE", projectIdFromFeature),
    deleteFeature
);

module.exports = router;
