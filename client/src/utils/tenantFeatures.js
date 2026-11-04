// ==========================================
// TENANT FEATURES -- what the BROWSER shows (pure; no React)
//
// The server decides (middleware/featureGate.js refuses a disabled module's APIs and socket events). The browser only uses
// the company's enabled list to decide what to SHOW: sidebar entries, routes, dashboard sections. Hiding is a courtesy;
// it is never the protection.
//
// `features` is the array of enabled feature ids the server sent for this company, or null when there is no such list (a
// legacy Reinsteins session, or a session that has not loaded one yet): null means "every module", exactly as before.
//
// The path -> feature table must agree with server/config/tenantFeatures.js (server/_test_tenant_features.js checks).
// ==========================================

// First path segment after /admin or /employee (or /:companySlug/admin ...) -> the feature that owns that page.
// A segment that is not listed (settings, profile, ...) is always available.
const SEGMENT_FEATURES = {
  employees: "employee_management",
  hierarchy: "employee_management",
  organization: "employee_management",
  "reporting-manager": "employee_management",
  team: "employee_management",
  attendance: "attendance",
  leave: "leave_management",
  "shift-management": "shift_management",
  "shift-schedule": "shift_management",
  tasks: "task_management",
  "task-workspace": "task_management",
  projects: "techops",
  "user-stories": "techops",
  epics: "techops",
  features: "techops",
  organizations: "techops",
  reports: "reports",
  chat: "chat",
  meetings: "meetings",
  sops: "sops",
  "smart-sheets": "smart_sheets",
  email: "email",
};

// "chat" or "meetings/12/room" or "team/leave-approvals" -> feature id, or null when the page is always available.
// The empty path (the portal's home page) is the dashboard.
export function featureForSubPath(subPath) {
  const clean = String(subPath || "").replace(/^\/+|\/+$/g, "");
  if (clean === "") return "dashboard";
  if (clean === "team/leave-approvals") return "leave_management"; // approving leave belongs to leave, although it lives under "team"
  const segment = clean.split("/")[0];
  return Object.prototype.hasOwnProperty.call(SEGMENT_FEATURES, segment) ? SEGMENT_FEATURES[segment] : null;
}

export function isFeatureEnabled(features, featureId) {
  if (!featureId) return true;
  if (!Array.isArray(features)) return true;
  return features.includes(featureId);
}

// A full menu path ("/acme/employee/chat") -> its feature, given the portal's base path ("/acme/employee").
export function featureForMenuPath(path, basePath) {
  const full = String(path || "");
  if (full === basePath) return "dashboard";
  return featureForSubPath(full.startsWith(`${basePath}/`) ? full.slice(basePath.length + 1) : full);
}

// Where to send someone whose home page (the dashboard) is not enabled: the first enabled module, in this order. The two
// portals do not have identical pages (shift management and email differ), so each entry names its page per portal; a module
// with no page in a portal is skipped there.
const LANDING_ORDER = [
  ["attendance", { admin: "attendance", employee: "attendance" }],
  ["task_management", { admin: "tasks", employee: "tasks" }],
  ["leave_management", { admin: "leave", employee: "leave" }],
  ["chat", { admin: "chat", employee: "chat" }],
  ["meetings", { admin: "meetings", employee: "meetings" }],
  ["smart_sheets", { admin: "smart-sheets", employee: "smart-sheets" }],
  ["shift_management", { admin: "shift-management", employee: "shift-schedule" }],
  ["employee_management", { admin: "employees", employee: "hierarchy" }],
  ["techops", { admin: "projects", employee: "projects" }],
  ["sops", { admin: "sops", employee: "sops" }],
  ["email", { employee: "email" }],
  ["reports", { admin: "reports", employee: "reports" }],
];

export function firstEnabledLanding(features, portal = "employee") {
  const hit = LANDING_ORDER.find(([featureId, pages]) => pages[portal] && isFeatureEnabled(features, featureId));
  return hit ? hit[1][portal] : null;
}

export const FEATURE_DISABLED_MESSAGE = "This feature is not enabled for your organization.";

// The API answers 403 { code: "FEATURE_NOT_ENABLED" } for a disabled module.
export const isFeatureDisabledError = (error) =>
  error?.response?.status === 403 && error?.response?.data?.code === "FEATURE_NOT_ENABLED";

const SESSION_KEY = "company";

// The enabled list stored with the signed-in company (login response / /tenant-auth/me), or null.
export function readStoredFeatures(storage = typeof sessionStorage !== "undefined" ? sessionStorage : null) {
  try {
    const company = JSON.parse(storage?.getItem(SESSION_KEY) || "null");
    return company && Array.isArray(company.features) ? company.features : null;
  } catch {
    return null;
  }
}

export function storeFeatures(features, storage = typeof sessionStorage !== "undefined" ? sessionStorage : null) {
  try {
    const company = JSON.parse(storage?.getItem(SESSION_KEY) || "null");
    if (!company) return;
    storage.setItem(SESSION_KEY, JSON.stringify({ ...company, features }));
  } catch {
    // storage unavailable: the in-memory value still drives the page
  }
}
