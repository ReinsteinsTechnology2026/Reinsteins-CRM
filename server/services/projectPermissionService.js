const pool = require("../config/db");

// ==========================================
// PROJECT PERMISSION ENGINE
//
// Single centralized place that answers every
// project-specific authorization question for the
// whole backend:
//
//   canUserAccessProject(user, projectId)
//   hasProjectPermission(user, projectId, key)
//   getEffectivePermissions(user, projectId)
//
// Final access flow (STRICT — exactly one exception):
//
//   System Administrator (users.is_system_administrator
//   = TRUE — the tenant's single highest authority,
//   enforced unique per tenant by a DB partial unique
//   index) — bypasses everything below unconditionally.
//         |
//   Module Access (projectAccessService.js /
//   requireProjectAccess — unchanged, separate
//   concern: "can this user use Projects at all")
//         |
//   Project Membership (project_members — the ONLY
//   gate for "can this user see/act on THIS project",
//   for every non-System-Administrator user)
//         |
//   Access Level ceiling (users.project_access_level
//   — an org-level entitlement that CAPS what a
//   member can ever do in ANY project, regardless of
//   their security group)
//         |
//   Security Group permission (project_permissions,
//   resolved per the member's group)
//         |
//   Final decision
//
// THERE IS NO ROLE/SYSTEM_ACCESS BYPASS ANYWHERE IN
// THIS FILE. role='admin', system_access='super_admin'
// /'admin'/'executive' grant ORGANIZATION-level
// capabilities elsewhere (user management, org
// settings, module access) — they do NOT grant
// automatic membership or permission on any specific
// project. A user must have an explicit project_members
// row to see or act on a project, full stop, UNLESS they
// are the tenant's flagged System Administrator. This was
// the exact defect reported and is intentionally never
// reintroduced as a role/system_access check — the one
// exception here is identity-based (a single, uniquely-
// constrained boolean, set only at provisioning time, with
// no API to grant it), never satisfiable by any
// role/system_access value including system_access=
// 'super_admin'.
// ==========================================

const PERMISSION_KEYS = [
    "PROJECT_VIEW",
    "PROJECT_EDIT",
    "PROJECT_DELETE",
    "PROJECT_MANAGE_MEMBERS",
    "PROJECT_MANAGE_SECURITY",
    "EPIC_VIEW",
    "EPIC_CREATE",
    "EPIC_EDIT",
    "EPIC_DELETE",
    "FEATURE_VIEW",
    "FEATURE_CREATE",
    "FEATURE_EDIT",
    "FEATURE_DELETE",
    "USER_STORY_VIEW",
    "USER_STORY_CREATE",
    "USER_STORY_EDIT",
    "USER_STORY_DELETE",
    "TASK_VIEW",
    "TASK_CREATE",
    "TASK_EDIT",
    "TASK_DELETE",
    "TASK_ASSIGN",
    "TASK_TRANSFER",
    "TASK_CHANGE_STATUS",
    "BOARD_VIEW",
    "BACKLOG_VIEW",
    "WORK_ITEM_LINK_MANAGE",
];

// ==========================================
// ACCESS LEVEL CEILING
//
// A centralized, data-driven cap — NOT scattered
// if/else logic. Each access level maps to either:
//   - null  -> no ceiling, the security group's own
//              permissions apply unrestricted (this
//              is "basic", today's normal behavior).
//   - an array of permission keys -> the member can
//              NEVER exceed this set, no matter how
//              permissive their security group is.
//              The group can only ever narrow this
//              further, never widen it.
//
// "stakeholder" is modeled closer to real Azure
// DevOps Stakeholder behavior (can view and actively
// participate in backlog/board work-item tracking)
// rather than pure read-only — but is still always
// denied project administration, security
// management, and deletion, matching ADO's actual
// restriction. Adding a new access level later is a
// one-line addition here; nothing else in the engine
// needs to change.
// ==========================================

const ACCESS_LEVEL_CEILINGS = {

    basic: null,

    stakeholder: [
        "PROJECT_VIEW",
        "BACKLOG_VIEW",
        "BOARD_VIEW",
        // Epic/Feature: view-only parity with the rest of the backlog
        // they can already see (BACKLOG_VIEW/USER_STORY_VIEW below) --
        // a Stakeholder can see where a story sits in the hierarchy,
        // but restructuring that hierarchy (create/edit/delete) is
        // deliberately NOT granted at this level, unlike User
        // Story/Task below. Without this entry a Stakeholder would be
        // unable to view Epics/Features at all regardless of what
        // their security group grants, since this ceiling only ever
        // narrows -- it never widens -- what the group allows.
        "EPIC_VIEW",
        "FEATURE_VIEW",
        "USER_STORY_VIEW",
        "USER_STORY_CREATE",
        "USER_STORY_EDIT",
        "TASK_VIEW",
        "TASK_CREATE",
        "TASK_EDIT",
        "TASK_CHANGE_STATUS",
        "TASK_ASSIGN",
        "TASK_TRANSFER",
        // Deliberately NOT included at any access level below "basic":
        // PROJECT_EDIT, PROJECT_DELETE, PROJECT_MANAGE_MEMBERS,
        // PROJECT_MANAGE_SECURITY, EPIC_CREATE/EDIT/DELETE,
        // FEATURE_CREATE/EDIT/DELETE, USER_STORY_DELETE, TASK_DELETE —
        // project administration, hierarchy restructuring, and
        // deletion are never available to a Stakeholder regardless of
        // their security group.
    ],

};

function accessLevelAllows(accessLevel, permissionKey) {

    const ceiling = ACCESS_LEVEL_CEILINGS[accessLevel];

    // No ceiling recorded for this level (including unknown/legacy
    // values) -> default to "basic" behavior (no restriction) rather
    // than silently denying everything.
    if (ceiling === undefined || ceiling === null) {
        return true;
    }

    return ceiling.includes(permissionKey);

}

// ==========================================
// MEMBERSHIP
// ==========================================

async function getProjectMembership(userId, projectId) {

    const [rows] = await pool.query(
        `
        SELECT pm.id, pm.security_group_id, psg.name AS group_name
        FROM project_members pm
        JOIN project_security_groups psg ON psg.id = pm.security_group_id
        WHERE pm.project_id = ? AND pm.user_id = ?
        LIMIT 1
        `,
        [projectId, userId]
    );

    return rows[0] || null;

}

// user = { id, accessLevel, isSystemAdministrator } — role/systemAccess
// are accepted if present but never consulted; only membership decides
// this, with exactly one identity-based exception below.
async function canUserAccessProject(user, projectId) {

    // The tenant's single System Administrator (users.is_system_administrator
    // = TRUE, enforced unique per tenant) bypasses project_members
    // entirely -- highest tenant authority, access to every project.
    // Keyed ONLY on this explicit flag, never role or system_access,
    // so no role/tier can ever satisfy it (see the file header above).
    if (user.isSystemAdministrator === true) {
        return true;
    }

    const membership = await getProjectMembership(user.id, projectId);

    return Boolean(membership);

}

// ==========================================
// ELIGIBLE PROJECT ASSIGNEE
// A user is a valid task-assignment target for a project only if
// they are BOTH an active employee AND an explicit member of that
// project — same two checks assignTask already makes inline; shared
// here so createTask/updateTask paths can reuse the same rule
// instead of re-deriving it.
// ==========================================

async function isEligibleProjectAssignee(userId, projectId) {

    const [[user]] = await pool.query(
        `SELECT employment_status FROM users WHERE id = ? LIMIT 1`,
        [userId]
    );

    if (!user || user.employment_status !== "active") {
        return false;
    }

    return canUserAccessProject({ id: userId }, projectId);

}

// ==========================================
// EFFECTIVE PERMISSION
// Resolution order per permission_key:
//   1. Not a member -> always deny. (No bypass.)
//   2. Access level ceiling denies it -> deny,
//      regardless of the security group.
//   3. A project-specific override row for this
//      group+key (project_id = this project) if one
//      exists.
//   4. Otherwise the group's global default row
//      (project_id IS NULL).
//   5. An explicit 'deny' always wins over 'allow' if
//      both existed (they cannot in this schema — only
//      one row is selected — but the ceiling check
//      above already enforces "deny at any layer wins"
//      for the access-level layer specifically).
//   6. 'not_set' (or no row at all) resolves to deny —
//      no further inheritance chain exists yet.
// ==========================================

async function hasProjectPermission(user, projectId, permissionKey) {

    // System Administrator bypass -- see canUserAccessProject above.
    if (user.isSystemAdministrator === true) {
        return true;
    }

    const membership = await getProjectMembership(user.id, projectId);

    if (!membership) {
        return false;
    }

    if (!accessLevelAllows(user.accessLevel, permissionKey)) {
        return false;
    }

    const [rows] = await pool.query(
        `
        SELECT value, project_id
        FROM project_permissions
        WHERE security_group_id = ?
        AND permission_key = ?
        AND (project_id = ? OR project_id IS NULL)
        ORDER BY project_id IS NULL ASC
        LIMIT 1
        `,
        [membership.security_group_id, permissionKey, projectId]
    );

    const value = rows[0]?.value || "not_set";

    return value === "allow";

}

// ==========================================
// EFFECTIVE PERMISSION MAP (all keys at once —
// used by the Permissions page and by the frontend
// to know what UI to show for the current member)
// ==========================================

async function getEffectivePermissions(user, projectId) {

    // System Administrator bypass -- see canUserAccessProject above.
    // Every permission key granted without consulting project_members,
    // project_permissions, or ACCESS_LEVEL_CEILINGS at all.
    if (user.isSystemAdministrator === true) {
        const all = {};
        for (const key of PERMISSION_KEYS) all[key] = true;
        return { isMember: true, groupName: "System Administrator", permissions: all };
    }

    const membership = await getProjectMembership(user.id, projectId);

    if (!membership) {
        const none = {};
        for (const key of PERMISSION_KEYS) none[key] = false;
        return { isMember: false, groupName: null, permissions: none };
    }

    const [rows] = await pool.query(
        `
        SELECT permission_key, value, project_id
        FROM project_permissions
        WHERE security_group_id = ?
        AND (project_id = ? OR project_id IS NULL)
        `,
        [membership.security_group_id, projectId]
    );

    // Project-specific override rows win over the group's global row
    // for the same key.
    const resolved = {};
    for (const row of rows) {
        const alreadySet = resolved[row.permission_key];
        if (alreadySet === undefined || row.project_id !== null) {
            resolved[row.permission_key] = row.value;
        }
    }

    const permissions = {};
    for (const key of PERMISSION_KEYS) {
        const groupAllows = (resolved[key] || "not_set") === "allow";
        permissions[key] = groupAllows && accessLevelAllows(user.accessLevel, key);
    }

    return { isMember: true, groupName: membership.group_name, permissions };

}

module.exports = {
    PERMISSION_KEYS,
    ACCESS_LEVEL_CEILINGS,
    accessLevelAllows,
    getProjectMembership,
    canUserAccessProject,
    isEligibleProjectAssignee,
    hasProjectPermission,
    getEffectivePermissions,
};
