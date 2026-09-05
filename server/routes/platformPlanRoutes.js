const express = require("express");

const router = express.Router();

const {
    listPlans,
    getPlanDetails,
    createPlan,
    updatePlan,
    updatePlanStatus,
} = require("../controllers/platformPlanController");
const { platformProtect } = require("../middleware/platformAuthMiddleware");

// ==========================================
// PLATFORM PLAN ROUTES (Phase 8)
// Mounted at /api/platform/plans in app.js. Every route here requires
// an authenticated, active Platform Owner -- a tenant JWT (or no
// token at all) is rejected by platformProtect before any handler
// runs. No DELETE route exists by design -- see
// subscriptionPlanService.js's header comment.
// ==========================================

router.get("/", platformProtect, listPlans);
router.get("/:id", platformProtect, getPlanDetails);

router.post("/", platformProtect, createPlan);

router.patch("/:id", platformProtect, updatePlan);
router.patch("/:id/status", platformProtect, updatePlanStatus);

module.exports = router;
