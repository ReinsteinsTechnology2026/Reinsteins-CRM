// ==========================================
// SHIFT ACCESS (frontend mirror)
//
// Decides WHICH Shift entry the sidebar shows and whether the
// company-wide Shift Management page may be opened from the employee
// portal. It depends ONLY on role and system_access -- never on
// designation (a Founder, Chairman, CTO or plain employee with the same
// access all get the same result).
//
// Mirrors server/utils/shiftDefaults.js's isAdminTierUser /
// isManagerTierUser, which in turn mirror
// server/controllers/shiftScheduleController.js's isAdminTier: the
// backend independently re-derives this on every request from a fresh
// database read, so this file is presentation-layer convenience, never
// the security boundary. Changing what is shown here grants nothing.
//
//   admin    role = 'admin', or system_access = 'admin' | 'super_admin'
//            -> company-wide "Shift Management"
//   manager  system_access = 'manager' (and not admin tier)
//            -> "Shift Schedule" (self + direct reports, enforced server-side)
//   employee everyone else
//            -> "Shift Schedule" (own shift + search, enforced server-side)
// ==========================================

export function getShiftTier(user) {
  if (user?.role === "admin" || ["admin", "super_admin"].includes(user?.systemAccess)) {
    return "admin";
  }

  if (user?.systemAccess === "manager") {
    return "manager";
  }

  return "employee";
}

// { name, path } for the sidebar entry; the caller adds the icon.
export function getShiftNavItem(user, basePath) {
  if (getShiftTier(user) === "admin") {
    return { name: "Shift Management", path: `${basePath}/shift-management` };
  }

  return { name: "Shift Schedule", path: `${basePath}/shift-schedule` };
}

// Guard for the employee-portal "shift-management" route. Non-admin-tier
// users are sent to the "shift-schedule" sibling of the SAME base path
// (so a company-prefixed URL stays company-prefixed). Convenience only:
// the shift and employee-list APIs enforce access themselves.
export function resolveShiftManagementAccess(user, pathname) {
  if (getShiftTier(user) === "admin") {
    return { allow: true };
  }

  // Case-insensitive (the router matches routes case-insensitively, so "/employee/Shift-Management"
  // reaches this guard) and tolerant of trailing slashes, so the redirect target always differs
  // from the current URL. Everything before the matched segment - including a company prefix - is kept.
  return {
    allow: false,
    redirectTo: String(pathname || "").replace(/\/shift-management\/*$/i, "/shift-schedule"),
  };
}
