const express = require("express");

const {
    getShifts,
    searchShiftEmployees,
    createShift,
    updateShift,
    deleteShift,
    bulkSaveShifts,
} = require("../controllers/shiftScheduleController");

const { protect } = require("../middleware/authMiddleware");
const { requireActiveUser } = require("../middleware/accessMiddleware");

const router = express.Router();

// ==========================================
// SHIFT SCHEDULE ROUTES (Phase 17b, corrected ownership model;
// role/team visibility scoping added on top -- see
// shiftScheduleController.js's getShiftVisibilityScope)
//
// VIEW (list + search): every active tenant user (requireActiveUser,
// so req.userAccess is always populated -- previously this route ran
// behind `protect` only, which is why the visibility scoping now
// living in the controller could not be enforced here before). WHAT
// each tier sees is decided entirely inside the controller, never
// here: Admin/Super Admin see everyone; Manager sees self + their
// direct reports only; everyone else sees only their own shift by
// default, but MAY still look up one specific other employee (list
// with ?userId=, or via /search) -- never a client-supplied
// role/team/company id, always derived from the authenticated
// req.user/req.userAccess.
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
// checks), not here at the route layer. Unchanged by this update --
// a Manager's new visibility into their team's shifts does NOT grant
// any new write/edit capability over those rows.
// ==========================================

router.get("/", protect, requireActiveUser, getShifts);

router.get("/search", protect, requireActiveUser, searchShiftEmployees);

router.post("/", protect, requireActiveUser, createShift);

router.post("/bulk", protect, requireActiveUser, bulkSaveShifts);

router.patch("/:id", protect, requireActiveUser, updateShift);

router.delete("/:id", protect, requireActiveUser, deleteShift);

module.exports = router;
