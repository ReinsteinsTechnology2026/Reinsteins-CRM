// ==========================================
// TENANT FEATURE CATALOG (single source of truth)
//
// Which CRM modules exist, what each one protects, and what it depends on. Everything else is derived from this file:
//   * the Owner Portal checklist           (GET /api/platform/features)
//   * the API gate                         (middleware/featureGate.js, one gate for every /api route)
//   * the Socket.IO gate                   (app.js onTenantEvent -> featureForSocketEvent)
//   * the client's route/sidebar mapping   (client/src/config/tenantFeatures.js, kept in step by _test_tenant_features.js)
//
// Feature ids are STABLE identifiers stored in the platform database (company_features.feature_id). Never rename or reuse
// one; display names and descriptions may change freely.
//
// A request is allowed when EVERY feature that guards it is enabled for the caller's company. Most routes are guarded by
// one feature; a few (the report endpoints) are guarded by the module AND the data domain they read.
//
// Always available to a signed-in user, whatever is enabled: sign-in and password change, "my profile", settings,
// notifications, signed file access, the public site, and the Owner Portal (/api/platform). See CORE_API_PREFIXES.
// ==========================================

const FEATURES = Object.freeze([
    {
        id: "dashboard",
        name: "Dashboard",
        description: "Home page with today's attendance, leave and task summaries.",
        requires: [],
    },
    {
        id: "employee_management",
        name: "Employee Management",
        description: "Employee records, departments, designations, the organization chart, hierarchy and \"My Team\".",
        requires: [],
    },
    {
        id: "attendance",
        name: "Attendance Management",
        description: "Clock in/out, breaks, live attendance and monthly attendance records.",
        requires: [],
    },
    {
        id: "leave_management",
        name: "Leave Management",
        description: "Leave requests and the manager / administrator approval chain.",
        requires: [],
    },
    {
        id: "shift_management",
        name: "Shift Management",
        description: "Shift schedules, weekly offs and shift reports.",
        requires: ["employee_management"], // the schedule is built from the employee directory
    },
    {
        id: "task_management",
        name: "Task Management",
        description: "Tasks, assignment, work logs, tags and task activity.",
        requires: [],
    },
    {
        id: "techops",
        name: "TechOps (Projects)",
        description: "Projects, epics, features, user stories, sprints and linked work items.",
        requires: ["task_management"], // every work item is a task
    },
    {
        id: "reports",
        name: "Reports",
        description: "Employee, attendance, task and leave reports with exports (each report also needs its own module).",
        requires: [],
    },
    {
        id: "chat",
        name: "Chat",
        description: "Direct and group messaging, attachments and voice/video calls.",
        requires: [],
    },
    {
        id: "meetings",
        name: "Meetings",
        description: "Scheduled and instant video meetings with in-meeting chat.",
        requires: ["employee_management"], // participants are picked by department
    },
    {
        id: "sops",
        name: "SOP Library",
        description: "Standard operating procedure documents.",
        requires: [],
    },
    {
        id: "smart_sheets",
        name: "Smart Sheets",
        description: "Collaborative spreadsheets with Excel import and export.",
        requires: [],
    },
    {
        id: "email",
        name: "Company Email",
        description: "Employee mailboxes on the company's own domain.",
        requires: [],
    },
    {
        id: "ziovault",
        name: "ZioVault (Password Manager)",
        description: "Client-side-encrypted personal and company password vault with granular sharing. The server never sees a secret.",
        requires: [],
    },
]);

const FEATURE_IDS = Object.freeze(FEATURES.map((feature) => feature.id));
const FEATURE_BY_ID = Object.freeze(Object.fromEntries(FEATURES.map((feature) => [feature.id, feature])));

// ------------------------------------------------------------------------------------------------ API routes

// Mount prefixes that are never feature-gated (and the reason).
const CORE_API_PREFIXES = Object.freeze([
    "/api/auth", // legacy sign-in
    "/api/tenant-auth", // company sign-in, /me
    "/api/files", // signed file access (the feature that owns a file already gated the request that produced the link)
    "/api/notifications", // in-app notifications
    "/api/public", // marketing site
    "/api/platform", // Owner Portal (its own authentication)
]);

// Ordered, first match wins. `features`: every one must be enabled. `prefix` matches the path itself or anything below it.
// `paths` (optional) restricts a rule to those sub-paths of the prefix.
const API_RULES = Object.freeze([
    // self-service profile endpoints stay available to everyone; the rest of /api/employees is employee management
    { prefix: "/api/employees/profile", features: [] },
    { prefix: "/api/employees", features: ["employee_management"] },
    { prefix: "/api/departments", features: ["employee_management"] },
    { prefix: "/api/designations", features: ["employee_management"] },
    { prefix: "/api/organization", features: ["employee_management"] },

    // live task details read task data, so they need the task module as well
    { prefix: "/api/dashboard/live-work", features: ["dashboard", "task_management"] },
    { prefix: "/api/dashboard", features: ["dashboard"] },
    { prefix: "/api/attendance", features: ["attendance"] },
    { prefix: "/api/leaves", features: ["leave_management"] },
    { prefix: "/api/shifts", features: ["shift_management"] },

    { prefix: "/api/tasks", features: ["task_management"] },
    { prefix: "/api/task-management", features: ["task_management"] },
    { prefix: "/api/task-work", features: ["task_management"] },
    { prefix: "/api/task-activity", features: ["task_management"] },
    { prefix: "/api/tags", features: ["task_management"] },

    { prefix: "/api/projects", features: ["techops"] },
    { prefix: "/api/organizations", features: ["techops"] },
    { prefix: "/api/epics", features: ["techops"] },
    { prefix: "/api/features", features: ["techops"] },
    { prefix: "/api/user-stories", features: ["techops"] },
    { prefix: "/api/sprints", features: ["techops"] },
    { prefix: "/api/work-item-links", features: ["techops"] },

    // a report needs the reports module AND the module whose data it reads
    { prefix: "/api/reports/employees", features: ["reports", "employee_management"] },
    { prefix: "/api/reports/attendance", features: ["reports", "attendance"] },
    { prefix: "/api/reports/tasks", features: ["reports", "task_management"] },
    { prefix: "/api/reports/leave", features: ["reports", "leave_management"] },
    { prefix: "/api/reports/export/employees", features: ["reports", "employee_management"] },
    { prefix: "/api/reports/export/attendance", features: ["reports", "attendance"] },
    { prefix: "/api/reports/export/tasks", features: ["reports", "task_management"] },
    { prefix: "/api/reports/export/leave", features: ["reports", "leave_management"] },
    { prefix: "/api/reports", features: ["reports"] },

    { prefix: "/api/chat", features: ["chat"] },
    { prefix: "/api/meetings", features: ["meetings"] },
    { prefix: "/api/sops", features: ["sops"] },
    { prefix: "/api/smart-sheets", features: ["smart_sheets"] },
    { prefix: "/api/email", features: ["email"] },
    { prefix: "/api/ziovault", features: ["ziovault"] },
]);

const matchesPrefix = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

// -> { gated: false } for core/unknown paths, or { gated: true, features: [...] } (an empty list = explicitly always allowed)
function featuresForApiPath(rawPath) {
    const path = String(rawPath || "").split("?")[0].replace(/\/+$/, "") || "/";
    for (const rule of API_RULES) {
        if (matchesPrefix(path, rule.prefix)) return { gated: true, features: rule.features };
    }
    return { gated: false, features: [] };
}

// Uploaded files live under uploads/tenant_<slug>/<folder>/...; a folder belongs to the feature that wrote it. Other folders
// (profiles, branding, files) are core. Used by the signed-file route in app.js.
const UPLOAD_FOLDER_RULES = Object.freeze([
    { folder: "chat", feature: "chat" },
    { folder: "meetings", feature: "meetings" },
    { folder: "tasks", feature: "task_management" },
    { folder: "sops", feature: "sops" },
    { folder: "smart-sheets", feature: "smart_sheets" },
]);

// "/uploads/tenant_acme/chat/files/x.pdf" -> "chat"; core or unknown folders -> null
function featureForUploadPath(rawPath) {
    const match = /^\/uploads\/tenant_[a-z0-9_]+\/([^/]+)\//.exec(String(rawPath || ""));
    if (!match) return null;
    const rule = UPLOAD_FOLDER_RULES.find((entry) => entry.folder === match[1]);
    return rule ? rule.feature : null;
}

// ------------------------------------------------------------------------------------------------ Socket.IO events

// Event-name prefix -> feature. Every event a feature owns must be listed here (see app.js and smartSheetRealtime.js).
const SOCKET_EVENT_RULES = Object.freeze([
    { prefix: "conversation:", feature: "chat" },
    { prefix: "call:", feature: "chat" }, // calls are started from a chat conversation
    { prefix: "webrtc:", feature: "chat" },
    { prefix: "meeting:", feature: "meetings" },
    { prefix: "smartsheet:", feature: "smart_sheets" },
]);

// -> the feature id that guards this socket event, or null when it is not feature-gated (presence, disconnect, ...)
function featureForSocketEvent(eventName) {
    const name = String(eventName || "");
    const rule = SOCKET_EVENT_RULES.find((entry) => name.startsWith(entry.prefix));
    return rule ? rule.feature : null;
}

// Socket.IO room name infix per feature, used to remove a user from live rooms when a feature is switched off.
const SOCKET_ROOM_MARKERS = Object.freeze({
    chat: [":conversation:"], // calls ride on personal user rooms, which are not feature rooms
    meetings: [":meeting:"],
    smart_sheets: [":smartsheet:"],
});

// ------------------------------------------------------------------------------------------------ selection rules

// Everything a selection needs in order to be valid, transitively: { missing: { featureId: [requiredId, ...] } }
function missingDependencies(selection) {
    const selected = new Set(selection);
    const missing = {};
    for (const id of selected) {
        const absent = (FEATURE_BY_ID[id] ? FEATURE_BY_ID[id].requires : []).filter((required) => !selected.has(required));
        if (absent.length > 0) missing[id] = absent;
    }
    return missing;
}

// Which currently selected features would break if `id` were switched off: ["shift_management", ...]
function dependentsOf(id, selection) {
    return selection.filter((other) => other !== id && FEATURE_BY_ID[other] && FEATURE_BY_ID[other].requires.includes(id));
}

// Validates a client-supplied list. Returns { ok: true, features: [...unique ids, catalog order] } or { ok: false, code, message, ... }.
function validateSelection(input) {
    if (!Array.isArray(input)) {
        return { ok: false, code: "INVALID_FEATURES", message: "features must be a list of feature ids." };
    }
    const unknown = input.filter((id) => typeof id !== "string" || !FEATURE_BY_ID[id]);
    if (unknown.length > 0) {
        return { ok: false, code: "UNKNOWN_FEATURE", message: "Unknown feature id(s).", unknown: unknown.map((id) => String(id).slice(0, 64)) };
    }
    const unique = FEATURE_IDS.filter((id) => input.includes(id));
    if (unique.length === 0) {
        return { ok: false, code: "EMPTY_SELECTION", message: "Select at least one feature." };
    }
    const missing = missingDependencies(unique);
    if (Object.keys(missing).length > 0) {
        return {
            ok: false,
            code: "MISSING_DEPENDENCIES",
            message: Object.entries(missing)
                .map(([id, needs]) => `${FEATURE_BY_ID[id].name} requires ${needs.map((need) => FEATURE_BY_ID[need].name).join(", ")}.`)
                .join(" "),
            missing,
        };
    }
    return { ok: true, features: unique };
}

const publicCatalog = () => FEATURES.map(({ id, name, description, requires }) => ({ id, name, description, requires: [...requires] }));

module.exports = {
    FEATURES,
    FEATURE_IDS,
    FEATURE_BY_ID,
    CORE_API_PREFIXES,
    API_RULES,
    SOCKET_EVENT_RULES,
    SOCKET_ROOM_MARKERS,
    featuresForApiPath,
    featureForSocketEvent,
    featureForUploadPath,
    UPLOAD_FOLDER_RULES,
    missingDependencies,
    dependentsOf,
    validateSelection,
    publicCatalog,
};
