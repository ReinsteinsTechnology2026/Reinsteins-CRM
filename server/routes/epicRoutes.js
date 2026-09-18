const express = require("express");

const router = express.Router();

const pool = require("../config/db");

const {
    getEpics,
    getEpic,
    createEpic,
    updateEpic,
    deleteEpic,
    restoreEpic,
    permanentDeleteEpic
} = require("../controllers/epicController");

const {
    protect,
} = require("../middleware/authMiddleware");

const {
    requireProjectAccess,
    requireProjectPermission,
} = require("../middleware/accessMiddleware");

// ==========================================
// PROJECT ID RESOLVERS
// Same pattern as sprintRoutes.js/userStoryRoutes.js
// -- routes shaped around an EPIC id ("/:id")
// resolve the epic's project_id with a small lookup
// first, so a forged/unrelated epic id always
// authorizes against ITS OWN project, never the
// caller's.
// ==========================================

const projectIdFromQuery = (req) => req.params.projectId;

const projectIdFromEpic = async (req) => {

    const [rows] = await pool.query(
        `SELECT project_id FROM epics WHERE id = ? LIMIT 1`,
        [req.params.id]
    );

    return rows[0]?.project_id || null;

};

// ==========================================
// GET EPICS FOR A PROJECT
// GET /api/epics/project/:projectId
// ==========================================

router.get(
    "/project/:projectId",
    protect,
    requireProjectAccess,
    requireProjectPermission("EPIC_VIEW", projectIdFromQuery),
    getEpics
);

// ==========================================
// GET ONE EPIC
// GET /api/epics/:id
// ==========================================

router.get(
    "/:id",
    protect,
    requireProjectAccess,
    requireProjectPermission("EPIC_VIEW", projectIdFromEpic),
    getEpic
);

// ==========================================
// CREATE EPIC UNDER A PROJECT
// POST /api/epics/project/:projectId
// ==========================================

router.post(
    "/project/:projectId",
    protect,
    requireProjectAccess,
    requireProjectPermission("EPIC_CREATE", projectIdFromQuery),
    createEpic
);

// ==========================================
// UPDATE EPIC
// PUT /api/epics/:id
// ==========================================

router.put(
    "/:id",
    protect,
    requireProjectAccess,
    requireProjectPermission("EPIC_EDIT", projectIdFromEpic),
    updateEpic
);

// ==========================================
// DELETE EPIC
// DELETE /api/epics/:id
// ==========================================

router.delete(
    "/:id",
    protect,
    requireProjectAccess,
    requireProjectPermission("EPIC_DELETE", projectIdFromEpic),
    deleteEpic
);

// ==========================================
// RESTORE EPIC (from Recycle Bin)
// PATCH /api/epics/:id/restore
// PERMANENTLY DELETE EPIC (from Recycle Bin)
// DELETE /api/epics/:id/permanent
// Both reuse EPIC_DELETE -- whoever can delete an Epic can also
// restore/permanently delete it (see workItemDeletionService.js).
// ==========================================

router.patch(
    "/:id/restore",
    protect,
    requireProjectAccess,
    requireProjectPermission("EPIC_DELETE", projectIdFromEpic),
    restoreEpic
);

router.delete(
    "/:id/permanent",
    protect,
    requireProjectAccess,
    requireProjectPermission("EPIC_DELETE", projectIdFromEpic),
    permanentDeleteEpic
);

module.exports = router;
