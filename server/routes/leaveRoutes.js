const express = require("express");

const {
    applyLeave,
    getMyLeaves,
    cancelLeave,
    getPendingManagerApprovals,
    managerDecideLeave,
    getAllLeaves,
    getPendingFinalApprovals,
    approveLeave,
    rejectLeave,
} = require("../controllers/leaveController");

const { protect } = require("../middleware/authMiddleware");
const { requireAccess } = require("../middleware/accessMiddleware");

const router = express.Router();

// Final approval is Super Admin/Admin/HR/Executive — role='admin'
// still always passes (requireAccess), so this is purely additive
// versus the previous adminOnly-only gate. Executive was added so
// Founder/Chairman can act on the same final-approval queue HR uses.

const finalApprover = requireAccess("super_admin", "admin", "hr", "executive");

// ==========================================
// ADMIN/HR - FINAL APPROVAL STAGE
// ==========================================

router.get("/admin/all", protect, finalApprover, getAllLeaves);
router.get("/admin/pending-final", protect, finalApprover, getPendingFinalApprovals);
router.patch("/admin/:id/approve", protect, finalApprover, approveLeave);
router.patch("/admin/:id/reject", protect, finalApprover, rejectLeave);

// ==========================================
// MANAGER - STAGE 1 APPROVAL
// Any authenticated user can call these — the
// controller itself only ever returns/acts on
// requests where manager_id === req.user.id, so
// this is inherently self-scoped regardless of
// system_access.
// ==========================================

router.get("/manager/pending", protect, getPendingManagerApprovals);
router.patch("/manager/:id/decide", protect, managerDecideLeave);

// ==========================================
// EMPLOYEE/INTERN - MY OWN LEAVE
// ==========================================

router.get("/my", protect, getMyLeaves);
router.post("/", protect, applyLeave);
router.patch("/:id/cancel", protect, cancelLeave);

module.exports = router;
