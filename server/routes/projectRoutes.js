const express = require("express");

const router = express.Router();

const {
    getProjects,
    getProject,
    getProjectTaskList,
    createProject,
    updateProject,
    deleteProject
} = require("../controllers/projectController");

const {
    getMyPermissions,
    getMembers,
    addMembers,
    changeMemberGroup,
    removeMember,
    getSecurityGroups,
    getPermissionMatrix,
    updatePermission,
    getProjectActivity,
} = require("../controllers/projectMemberController");

const {
    protect,
} = require("../middleware/authMiddleware");

const {
    requireProjectAccess,
    requireProjectMembership,
    requireProjectPermission,
    requireProjectMembershipOrOrgAdmin,
    requireProjectPermissionOrOrgAdmin,
} = require("../middleware/accessMiddleware");

// requireProjectAccess = MODULE access (can the user use Projects at
// all — an organization-level concern). requireProjectMembership = is
// the user an EXPLICIT member of this specific project — no role or
// system_access exception exists anywhere in this chain; Super Admin/
// Admin/Executive get NOTHING here without a project_members row.
// requireProjectPermission(key) = does this member's security group
// AND access-level ceiling grant a specific capability inside this
// project. Three distinct layers — see projectPermissionService.js.

// ==========================================
// GET ALL PROJECTS
// Visibility is membership-based inside
// getAllProjects() (see projectService.js) — module
// access means the user can reach this endpoint,
// not that every project is returned to them.
// ==========================================

router.get(
    "/",
    protect,
    requireProjectAccess,
    getProjects
);

// ==========================================
// GET ONE PROJECT — must be an explicit member of
// THIS project with the PROJECT_VIEW permission their
// security group and access level resolve to, WITH
// one narrow exception: role='admin' (organization
// administrator) can open any project's Overview even
// without membership — see
// requireProjectPermissionOrOrgAdmin in
// accessMiddleware.js. Every other project route stays
// on the plain requireProjectPermission, unaffected.
// ==========================================

router.get(
    "/:id",
    protect,
    requireProjectAccess,
    requireProjectPermissionOrOrgAdmin("PROJECT_VIEW"),
    getProject
);

// ==========================================
// GET ALL TASKS FOR A PROJECT (Kanban/Board)
// ==========================================

router.get(
    "/:id/tasks",
    protect,
    requireProjectAccess,
    requireProjectPermission("BOARD_VIEW"),
    getProjectTaskList
);

// ==========================================
// CREATE PROJECT
// Module access only — there is no project id yet
// to check membership against. The creator (and
// selected owner) are auto-added as Project
// Administrators inside createProject().
// ==========================================

router.post(
    "/",
    protect,
    requireProjectAccess,
    createProject
);

// ==========================================
// UPDATE PROJECT
// ==========================================

router.put(
    "/:id",
    protect,
    requireProjectAccess,
    requireProjectPermission("PROJECT_EDIT"),
    updateProject
);

// ==========================================
// DELETE PROJECT
// tasks.project_id is ON DELETE SET NULL, so
// deleteProjectService explicitly removes the
// project's tasks before the project row itself —
// see projectService.js. role='admin' can delete any
// project even without membership (same organization-
// admin exception as GET /:id above); a real member
// still needs PROJECT_DELETE for their security group.
// ==========================================

router.delete(
    "/:id",
    protect,
    requireProjectAccess,
    requireProjectPermissionOrOrgAdmin("PROJECT_DELETE"),
    deleteProject
);

// ==========================================
// MY EFFECTIVE PERMISSIONS FOR THIS PROJECT
// Powers frontend UI-gating only — every mutating
// route below independently re-checks permission
// regardless of what this reports. role='admin' gets
// the same organization-admin exception as GET /:id —
// getEffectivePermissions() already returns an
// all-false, isMember:false shape for a non-member
// caller, which is exactly correct here: an admin
// viewing a project they don't belong to should see
// every mutating control hidden, not an error.
// ==========================================

router.get(
    "/:id/my-permissions",
    protect,
    requireProjectAccess,
    requireProjectMembershipOrOrgAdmin(),
    getMyPermissions
);

// ==========================================
// MEMBERS
// Viewing the member list is available to any
// project member; managing it requires
// PROJECT_MANAGE_MEMBERS.
// ==========================================

router.get(
    "/:id/members",
    protect,
    requireProjectAccess,
    requireProjectMembership(),
    getMembers
);

router.post(
    "/:id/members",
    protect,
    requireProjectAccess,
    requireProjectPermission("PROJECT_MANAGE_MEMBERS"),
    addMembers
);

router.patch(
    "/:id/members/:userId/group",
    protect,
    requireProjectAccess,
    requireProjectPermission("PROJECT_MANAGE_MEMBERS"),
    changeMemberGroup
);

router.delete(
    "/:id/members/:userId",
    protect,
    requireProjectAccess,
    requireProjectPermission("PROJECT_MANAGE_MEMBERS"),
    removeMember
);

// ==========================================
// SECURITY GROUPS — viewable by any member.
// ==========================================

router.get(
    "/:id/groups",
    protect,
    requireProjectAccess,
    requireProjectMembership(),
    getSecurityGroups
);

// ==========================================
// PERMISSION MATRIX — Project Administrators
// (PROJECT_MANAGE_SECURITY) only.
// ==========================================

router.get(
    "/:id/permissions",
    protect,
    requireProjectAccess,
    requireProjectPermission("PROJECT_MANAGE_SECURITY"),
    getPermissionMatrix
);

router.patch(
    "/:id/permissions",
    protect,
    requireProjectAccess,
    requireProjectPermission("PROJECT_MANAGE_SECURITY"),
    updatePermission
);

// ==========================================
// PROJECT ACTIVITY (membership/permission audit)
// ==========================================

router.get(
    "/:id/activity",
    protect,
    requireProjectAccess,
    requireProjectPermission("PROJECT_MANAGE_MEMBERS"),
    getProjectActivity
);

module.exports = router;
