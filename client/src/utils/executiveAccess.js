// ==========================================
// EXECUTIVE DASHBOARD ACCESS
//
// Determines which users get the Executive
// Dashboard experience (no attendance clock-in,
// company-overview home, executive-focused
// sidebar) instead of the normal employee
// portal experience.
//
// Deliberately keyed off DESIGNATION, not
// system_access — system_access='executive' is
// a broader backend permission tier that other
// roles (e.g. a CTO) can also hold, but that
// does not mean every "executive" access-level
// user should see this specific layout. This is
// a presentation-layer routing decision only:
// actual data access is still enforced by the
// backend's system_access checks regardless of
// what layout is shown here.
//
// Centralized here on purpose — every place that
// needs this decision (sidebar, dashboard router)
// imports this single helper instead of repeating
// the check.
// ==========================================

export const EXECUTIVE_DASHBOARD_DESIGNATIONS = [
  "Founder",
  "Chairman",
];

export function isExecutiveDashboardUser(user) {
  if (!user?.designation) {
    return false;
  }

  return EXECUTIVE_DASHBOARD_DESIGNATIONS.includes(user.designation);
}
