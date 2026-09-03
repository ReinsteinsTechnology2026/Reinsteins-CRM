// ==========================================
// PROJECT ACCESS (frontend mirror)
//
// Mirrors server/services/projectAccessService.js
// exactly — used ONLY to decide whether to show
// the "Projects" sidebar item. The backend
// independently re-derives and enforces this same
// rule on every request via requireProjectAccess;
// this file is presentation-layer convenience,
// never the security boundary.
// ==========================================

const DEFAULT_PROJECT_ACCESS_DESIGNATIONS = [
  "CEO",
  "CTO",
  "Tech Lead",
  "Manager",
  "Software Engineer",
];

const NORMALIZED_DEFAULT_DESIGNATIONS = DEFAULT_PROJECT_ACCESS_DESIGNATIONS.map(
  (title) => normalizeDesignation(title)
);

function normalizeDesignation(value) {
  return (value || "").trim().toLowerCase();
}

export function hasProjectAccess(user) {

  if (!user) {
    return false;
  }

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
