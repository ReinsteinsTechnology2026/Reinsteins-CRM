const express = require("express");

const router = express.Router();

const {
    getOrganizations,
    getOrganization,
    createOrganization,
} = require("../controllers/organizationsController");

const {
    getMembers,
    getEligible,
    addMember,
    removeMember,
} = require("../controllers/organizationMembersController");

const {
    getProjects,
    createProject,
} = require("../controllers/organizationProjectsController");

const { protect, adminOnly } = require("../middleware/authMiddleware");

// ==========================================
// ORGANIZATIONS (Phase 2A) + ORGANIZATION
// MEMBERS (Phase 2B) + ORGANIZATION PROJECTS
// (Phase 2C). Everything below stays gated to
// role='admin' -- the same organization-administrator
// tier already established in Phase 1's project-
// visibility bypass, reused here rather than
// inventing a new permission.
// ==========================================

router.get(
    "/",
    protect,
    adminOnly,
    getOrganizations
);

router.get(
    "/:id",
    protect,
    adminOnly,
    getOrganization
);

router.post(
    "/",
    protect,
    adminOnly,
    createOrganization
);

// ==========================================
// ORGANIZATION MEMBERS (Phase 2B)
// organization_id is always resolved from :id (the
// route), never trusted from the request body.
// ==========================================

router.get(
    "/:id/members",
    protect,
    adminOnly,
    getMembers
);

router.get(
    "/:id/eligible-employees",
    protect,
    adminOnly,
    getEligible
);

router.post(
    "/:id/members",
    protect,
    adminOnly,
    addMember
);

router.delete(
    "/:id/members/:userId",
    protect,
    adminOnly,
    removeMember
);

// ==========================================
// ORGANIZATION PROJECTS (Phase 2C)
// organization_id is always resolved from :id (the
// route) -- POST never reads organization_id from the
// request body.
// ==========================================

router.get(
    "/:id/projects",
    protect,
    adminOnly,
    getProjects
);

router.post(
    "/:id/projects",
    protect,
    adminOnly,
    createProject
);

module.exports = router;
