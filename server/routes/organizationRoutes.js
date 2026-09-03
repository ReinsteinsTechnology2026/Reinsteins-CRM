const express = require("express");

const {
    getMyTeam,
    getDirectReports,
    getMyReportingManager,
    getDepartmentManagers,
    getOrgChartRoots,
    getOrgChartNodeChildren,
    searchOrgUsers,
    transferUser,
    setReportingManager,
    setSystemAccess,
    getOrganizationHistory,
    getExecutiveSummary,
    setProjectAccess,
    setProjectAccessLevel,
} = require("../controllers/organizationController");

const { protect } = require("../middleware/authMiddleware");
const { requireAccess } = require("../middleware/accessMiddleware");

const router = express.Router();

// ==========================================
// SELF-SCOPED READS (any authenticated user —
// each of these can only ever return information
// tied to the requester's own id/relationships,
// or non-sensitive organization-wide structure
// already readable via the departments list)
// ==========================================

router.get("/my-team", protect, getMyTeam);
router.get("/direct-reports", protect, getDirectReports);
router.get("/my-reporting-manager", protect, getMyReportingManager);
router.get("/departments/:id/managers", protect, getDepartmentManagers);
router.get("/chart/roots", protect, getOrgChartRoots);
router.get("/chart/:id/children", protect, getOrgChartNodeChildren);
router.get("/search", protect, searchOrgUsers);

// Executive company-overview summary — Founder/Chairman (and
// Super Admin/Admin) only, via the same requireAccess pattern used
// throughout this file.

router.get(
    "/executive-summary",
    protect,
    requireAccess("super_admin", "admin", "executive"),
    getExecutiveSummary
);

// ==========================================
// ORGANIZATION-CHANGING ACTIONS
// Department Head is deliberately not included —
// Part 14 gives Department Head visibility only,
// not transfer/reassignment authority.
// ==========================================

router.put(
    "/users/:id/transfer",
    protect,
    requireAccess("super_admin", "admin", "hr"),
    transferUser
);

router.put(
    "/users/:id/reporting-manager",
    protect,
    requireAccess("super_admin", "admin", "hr"),
    setReportingManager
);

// System access changes are Super Admin/Admin only — HR explicitly
// has no system/super-admin controls (Part 14). Super-admin-specific
// protection (nobody but a Super Admin touches super_admin) is
// enforced inside the controller itself.

router.patch(
    "/users/:id/system-access",
    protect,
    requireAccess("super_admin", "admin"),
    setSystemAccess
);

// Project Access grant/revoke — Super Admin/Admin only, same gate as
// System Access above.

router.patch(
    "/users/:id/project-access",
    protect,
    requireAccess("super_admin", "admin"),
    setProjectAccess
);

// Project Access LEVEL (basic/stakeholder) — the org-level ceiling on
// what a user can ever do inside any project. Same gate.

router.patch(
    "/users/:id/project-access-level",
    protect,
    requireAccess("super_admin", "admin"),
    setProjectAccessLevel
);

router.get(
    "/users/:id/history",
    protect,
    requireAccess("super_admin", "admin", "hr"),
    getOrganizationHistory
);

module.exports = router;
