// ==========================================
// CENTRALIZED PROJECT ACCESS
//
// Single source of truth for "does this user
// get the Projects area" — used by the
// requireProjectAccess middleware and nowhere
// else, so this is the only place the rule is
// defined (per the requirement to not scatter
// designation checks across files).
//
// Resolution order:
//   1. role === 'admin'            -> always true (matches every
//                                      other requireAccess-style gate
//                                      in this codebase)
//   2. system_access is super_admin/admin/executive
//                                   -> always true. This is what keeps
//                                      Founder/Chairman (system_access
//                                      = 'executive') on their existing
//                                      Executive Projects experience
//                                      without needing their
//                                      designations added to the
//                                      default list below.
//   3. project_access_override === 'granted'  -> true
//   4. project_access_override === 'revoked'  -> false
//   5. otherwise, fall back to the designation-based default list.
// ==========================================

const DEFAULT_PROJECT_ACCESS_DESIGNATIONS = [
    "CEO",
    "CTO",
    "Tech Lead",
    "Manager",
    "Software Engineer",
];

// Normalized (trimmed + lowercased) for safe, casing/whitespace-
// insensitive comparison — "CTO", "cto", " Cto " all match the same.

const NORMALIZED_DEFAULT_DESIGNATIONS = DEFAULT_PROJECT_ACCESS_DESIGNATIONS.map(
    (title) => normalizeDesignation(title)
);

function normalizeDesignation(value) {
    return (value || "").trim().toLowerCase();
}

function hasProjectAccess(user) {

    // user = { role, systemAccess, designation, projectAccessOverride }

    if (user.role === "admin") {
        return true;
    }

    if (["super_admin", "admin", "executive"].includes(user.systemAccess)) {
        return true;
    }

    if (user.projectAccessOverride === "granted") {
        return true;
    }

    if (user.projectAccessOverride === "revoked") {
        return false;
    }

    return NORMALIZED_DEFAULT_DESIGNATIONS.includes(
        normalizeDesignation(user.designation)
    );

}

module.exports = {
    DEFAULT_PROJECT_ACCESS_DESIGNATIONS,
    normalizeDesignation,
    hasProjectAccess,
};
