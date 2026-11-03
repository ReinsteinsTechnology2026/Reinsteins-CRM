// ==========================================
// SMART SHEETS -- ACCESS POLICY (pure, no I/O)
//
// The ONE place that decides what a user may do with a spreadsheet. REST handlers, the socket
// join and every incoming socket update all call resolveAccess() with a FRESH database read, so a
// demoted, deactivated or unassigned user loses access on the very next request/update -- never
// when a token happens to expire.
//
// Reuses the CRM's existing role model; no new roles:
//   * admin tier  = role 'admin', or system_access 'admin' | 'super_admin'
//                   (the same boundary as shiftScheduleController.isAdminTier). Admin tier can
//                   create, import, assign, archive and delete, and can open every
//                   non-deleted sheet.
//   * everyone else may only open a sheet they were explicitly assigned, and only while it is
//     active. 'edit' assignments may change it; 'view' assignments may not.
//
// Archived sheets are read-only for everyone (writes are also refused by the store).
// ==========================================

const ADMIN_SYSTEM_ACCESS = ["admin", "super_admin"];

const isAdminTier = (account) =>
    Boolean(account) && (account.role === "admin" || ADMIN_SYSTEM_ACCESS.includes(account.system_access));

const isActiveAccount = (account) => Boolean(account) && account.employment_status === "active";

// context: the row returned by store.getAccessContext() -- the user's role/system_access/
// employment_status plus the sheet's status/deleted_at and the user's assignment (if any).
//
// Returns { allowed, reason, canManage, permission } where permission is 'edit' | 'view' | null.
// `reason` is only for logs/tests; callers always surface the same NOT_FOUND for "no access".
function resolveAccess(context) {
    const denied = (reason) => ({ allowed: false, reason, canManage: false, permission: null });

    if (!context || !context.account) {
        return denied("no_account");
    }
    const { account, sheet, assignment } = context;

    if (!isActiveAccount(account)) {
        return denied("inactive_account");
    }
    if (!sheet || sheet.deleted_at) {
        return denied("no_sheet");
    }

    if (isAdminTier(account)) {
        return {
            allowed: true,
            reason: "admin",
            canManage: true,
            permission: sheet.status === "active" ? "edit" : "view",
        };
    }

    if (sheet.status !== "active") {
        return denied("sheet_not_active");
    }
    if (!assignment) {
        return denied("not_assigned");
    }

    return {
        allowed: true,
        reason: "assigned",
        canManage: false,
        permission: assignment.permission === "edit" ? "edit" : "view",
    };
}

module.exports = { resolveAccess, isAdminTier, isActiveAccount };
