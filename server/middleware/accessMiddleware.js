const pool = require("../config/db");
const { hasProjectAccess } = require("../services/projectAccessService");
const {
    canUserAccessProject,
    hasProjectPermission,
} = require("../services/projectPermissionService");

// ==========================================
// SYSTEM ACCESS MIDDLEWARE
//
// This is an ADDITIVE permission layer on top of
// the existing role=admin/employee system — it
// never replaces authMiddleware.js's protect/
// adminOnly, which continue to work exactly as
// before everywhere they're already used.
//
// system_access can change at any time (an admin
// can promote/demote someone), so this middleware
// deliberately re-reads it fresh from the database
// on every request rather than trusting whatever
// was baked into the JWT at login time — a
// demoted user loses elevated access immediately,
// not after their token happens to expire.
//
// role='admin' always passes every requireAccess()
// check regardless of the allowed list — existing
// admin accounts keep full access to every new
// organization feature, matching "existing Admin
// functionality must remain" and the fact that
// every existing admin was already backfilled to
// system_access='super_admin' by the migration.
// ==========================================

const SYSTEM_ACCESS_LEVELS = [
    "super_admin",
    "admin",
    "executive",
    "hr",
    "department_head",
    "manager",
    "team_lead",
    "employee",
];

function requireAccess(...allowedLevels) {

    return async (req, res, next) => {

        try {

            if (!req.user?.id) {
                return res.status(401).json({
                    success: false,
                    message: "Authentication required",
                });
            }

            const [rows] = await pool.query(
                `
                SELECT role, system_access, employment_status
                FROM users
                WHERE id = ?
                LIMIT 1
                `,
                [req.user.id]
            );

            if (rows.length === 0) {
                return res.status(401).json({
                    success: false,
                    message: "Account not found",
                });
            }

            const account = rows[0];

            // A resigned/terminated/etc. account's elevated access
            // is void even if a still-valid JWT exists and the row
            // hasn't been touched — this only affects the NEW
            // organization endpoints; it does not change existing
            // login gating (already enforced separately at login).

            if (account.employment_status !== "active") {
                return res.status(403).json({
                    success: false,
                    message: "This account is not currently active",
                });
            }

            req.userAccess = {
                role: account.role,
                systemAccess: account.system_access,
            };

            if (account.role === "admin") {
                return next();
            }

            if (allowedLevels.includes(account.system_access)) {
                return next();
            }

            return res.status(403).json({
                success: false,
                message: "You do not have permission to perform this action",
            });

        } catch (error) {

            console.error("Access Middleware Error:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to verify permissions",
            });

        }

    };

}

// Convenience: passes for any active account (every real access
// level is allowed) while still populating req.userAccess — used
// where a route is open to all authenticated users but a handler
// needs to know the caller's role/system_access to compute their
// authorization scope itself (e.g. task assignment).

const requireActiveUser = requireAccess(...SYSTEM_ACCESS_LEVELS);

// ==========================================
// PROJECT ACCESS
// Re-reads role/system_access/designation/
// project_access_override fresh from the
// database on every request (same reasoning as
// requireAccess above — a revoked grant takes
// effect immediately, not after the JWT
// expires) and delegates the actual decision to
// the single centralized helper in
// projectAccessService.js.
// ==========================================

async function requireProjectAccess(req, res, next) {

    try {

        if (!req.user?.id) {
            return res.status(401).json({
                success: false,
                message: "Authentication required",
            });
        }

        const [rows] = await pool.query(
            `
            SELECT role, system_access, designation, project_access_override, employment_status
            FROM users
            WHERE id = ?
            LIMIT 1
            `,
            [req.user.id]
        );

        if (rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: "Account not found",
            });
        }

        const account = rows[0];

        if (account.employment_status !== "active") {
            return res.status(403).json({
                success: false,
                message: "This account is not currently active",
            });
        }

        const userForCheck = {
            role: account.role,
            systemAccess: account.system_access,
            designation: account.designation,
            projectAccessOverride: account.project_access_override,
        };

        if (!hasProjectAccess(userForCheck)) {
            return res.status(403).json({
                success: false,
                message: "You do not have access to the Projects area",
            });
        }

        req.userAccess = {
            role: account.role,
            systemAccess: account.system_access,
        };

        return next();

    } catch (error) {

        console.error("Project Access Middleware Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to verify project access",
        });

    }

}

// ==========================================
// PROJECT MEMBERSHIP / PERMISSION
//
// Distinct from requireProjectAccess above:
// requireProjectAccess gates the Projects MODULE
// (can this user use Projects at all); the two
// middlewares below gate a SPECIFIC project, using
// project_members / project_permissions
// (projectPermissionService.js) — the real
// membership-based visibility/authorization layer.
//
// Both are factories that accept an optional
// resolver — a function (req) => projectId, which
// may itself be async (e.g. looking up a story's
// project_id). Default resolver reads req.params.id,
// which covers every "/projects/:id..." route;
// routes shaped differently (e.g.
// "/user-stories/:id/tasks", where :id is a STORY
// id) pass their own resolver.
//
// Both independently re-read role/system_access
// fresh from the database on every request, same
// defensive pattern as requireAccess/
// requireProjectAccess above, rather than trusting
// a previous middleware already ran.
// ==========================================

async function loadUserForCheck(req) {

    const [rows] = await pool.query(
        `SELECT role, system_access, project_access_level, employment_status, is_system_administrator FROM users WHERE id = ? LIMIT 1`,
        [req.user.id]
    );

    if (rows.length === 0) return null;

    if (rows[0].employment_status !== "active") return null;

    return {
        id: req.user.id,
        role: rows[0].role,
        systemAccess: rows[0].system_access,
        accessLevel: rows[0].project_access_level,
        isSystemAdministrator: rows[0].is_system_administrator === true,
    };

}

const defaultProjectIdResolver = (req) => req.params.id;

function requireProjectMembership(resolveProjectId = defaultProjectIdResolver) {

    return (req, res, next) => {

        (async () => {

            try {

                if (!req.user?.id) {
                    return res.status(401).json({
                        success: false,
                        message: "Authentication required",
                    });
                }

                const user = await loadUserForCheck(req);

                if (!user) {
                    return res.status(401).json({
                        success: false,
                        message: "Account not found or not active",
                    });
                }

                const projectId = await resolveProjectId(req);

                if (!projectId) {
                    return res.status(404).json({
                        success: false,
                        message: "Project not found",
                    });
                }

                const allowed = await canUserAccessProject(user, projectId);

                if (!allowed) {
                    return res.status(403).json({
                        success: false,
                        message: "You are not a member of this project",
                    });
                }

                req.userAccess = { role: user.role, systemAccess: user.systemAccess, accessLevel: user.accessLevel, isSystemAdministrator: user.isSystemAdministrator };
                req.resolvedProjectId = projectId;

                return next();

            } catch (error) {

                console.error("Project Membership Middleware Error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to verify project membership",
                });

            }

        })();

    };

}

function requireProjectPermission(permissionKey, resolveProjectId = defaultProjectIdResolver) {

    return (req, res, next) => {

        (async () => {

            try {

                if (!req.user?.id) {
                    return res.status(401).json({
                        success: false,
                        message: "Authentication required",
                    });
                }

                const user = await loadUserForCheck(req);

                if (!user) {
                    return res.status(401).json({
                        success: false,
                        message: "Account not found or not active",
                    });
                }

                const projectId = await resolveProjectId(req);

                if (!projectId) {
                    return res.status(404).json({
                        success: false,
                        message: "Project not found",
                    });
                }

                const allowed = await hasProjectPermission(user, projectId, permissionKey);

                if (!allowed) {
                    return res.status(403).json({
                        success: false,
                        message: "You do not have permission to perform this action",
                    });
                }

                req.userAccess = { role: user.role, systemAccess: user.systemAccess, accessLevel: user.accessLevel, isSystemAdministrator: user.isSystemAdministrator };
                req.resolvedProjectId = projectId;

                return next();

            } catch (error) {

                console.error("Project Permission Middleware Error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to verify project permission",
                });

            }

        })();

    };

}

// ==========================================
// ORGANIZATION-ADMIN VISIBILITY BYPASS
//
// role='admin' (the literal System Administrator
// account type -- not system_access tiers like
// super_admin/executive) can reach the specific
// routes wired to these two factories for ANY
// project, with no project_members row required, so
// the organization admin can see every project and
// delete one if needed.
//
// This is deliberately NOT folded into
// requireProjectMembership/requireProjectPermission
// above -- every other project route (Backlog,
// Board, Sprints, Settings sub-tabs, task mutations,
// etc.) keeps calling those two, completely
// unmodified, with zero bypass. Only routes
// explicitly wired to these two Or-Admin variants
// grant the extra visibility.
// ==========================================

function requireProjectMembershipOrOrgAdmin(resolveProjectId = defaultProjectIdResolver) {

    return (req, res, next) => {

        (async () => {

            try {

                if (!req.user?.id) {
                    return res.status(401).json({
                        success: false,
                        message: "Authentication required",
                    });
                }

                const user = await loadUserForCheck(req);

                if (!user) {
                    return res.status(401).json({
                        success: false,
                        message: "Account not found or not active",
                    });
                }

                const projectId = await resolveProjectId(req);

                if (!projectId) {
                    return res.status(404).json({
                        success: false,
                        message: "Project not found",
                    });
                }

                const allowed = user.role === "admin" || await canUserAccessProject(user, projectId);

                if (!allowed) {
                    return res.status(403).json({
                        success: false,
                        message: "You are not a member of this project",
                    });
                }

                req.userAccess = { role: user.role, systemAccess: user.systemAccess, accessLevel: user.accessLevel, isSystemAdministrator: user.isSystemAdministrator };
                req.resolvedProjectId = projectId;

                return next();

            } catch (error) {

                console.error("Project Membership Or Org Admin Middleware Error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to verify project membership",
                });

            }

        })();

    };

}

function requireProjectPermissionOrOrgAdmin(permissionKey, resolveProjectId = defaultProjectIdResolver) {

    return (req, res, next) => {

        (async () => {

            try {

                if (!req.user?.id) {
                    return res.status(401).json({
                        success: false,
                        message: "Authentication required",
                    });
                }

                const user = await loadUserForCheck(req);

                if (!user) {
                    return res.status(401).json({
                        success: false,
                        message: "Account not found or not active",
                    });
                }

                const projectId = await resolveProjectId(req);

                if (!projectId) {
                    return res.status(404).json({
                        success: false,
                        message: "Project not found",
                    });
                }

                const allowed = user.role === "admin" || await hasProjectPermission(user, projectId, permissionKey);

                if (!allowed) {
                    return res.status(403).json({
                        success: false,
                        message: "You do not have permission to perform this action",
                    });
                }

                req.userAccess = { role: user.role, systemAccess: user.systemAccess, accessLevel: user.accessLevel, isSystemAdministrator: user.isSystemAdministrator };
                req.resolvedProjectId = projectId;

                return next();

            } catch (error) {

                console.error("Project Permission Or Org Admin Middleware Error:", error);

                return res.status(500).json({
                    success: false,
                    message: "Unable to verify project permission",
                });

            }

        })();

    };

}

module.exports = {
    SYSTEM_ACCESS_LEVELS,
    requireAccess,
    requireActiveUser,
    requireProjectAccess,
    requireProjectMembership,
    requireProjectPermission,
    requireProjectMembershipOrOrgAdmin,
    requireProjectPermissionOrOrgAdmin,
};
