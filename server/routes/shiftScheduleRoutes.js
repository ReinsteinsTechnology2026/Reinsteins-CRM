const express = require("express");

const {
    getShifts,
    createShift,
    updateShift,
    deleteShift,
    bulkSaveShifts,
} = require("../controllers/shiftScheduleController");

const { protect } = require("../middleware/authMiddleware");
const { requireActiveUser } = require("../middleware/accessMiddleware");

const router = express.Router();

// ==========================================
// SHIFT SCHEDULE ROUTES (Phase 17b, corrected ownership model)
//
// VIEW: every authenticated tenant user (protect only) -- the
// company-wide availability board is visible to everyone.
//
// WRITE (create/update/delete/bulk): every active tenant user may
// call these routes (requireActiveUser = requireAccess(...every
// SYSTEM_ACCESS_LEVELS value), which populates req.userAccess =
// {role, systemAccess} and rejects only a deactivated account) --
// this is deliberately NOT tier-gated at the route level, because
// self-service ("I can manage MY OWN schedule") applies equally to
// every tier from plain Employee up through Executive. The actual
// authorization decision -- "is this row mine, or am I an
// Admin/Super Admin using the explicit override" -- can only be made
// once the target row's owner is known, so it lives inside the
// controller (see shiftScheduleController.js's isAdminTier/isOwner
// checks), not here at the route layer.
// ==========================================

router.get("/", protect, getShifts);

router.post("/", protect, requireActiveUser, createShift);

router.post("/bulk", protect, requireActiveUser, bulkSaveShifts);

router.patch("/:id", protect, requireActiveUser, updateShift);

router.delete("/:id", protect, requireActiveUser, deleteShift);

module.exports = router;
