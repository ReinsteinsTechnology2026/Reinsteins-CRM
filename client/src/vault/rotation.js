// ==========================================
// ZIOVAULT -- when is a password due to be changed?
//
// Pure functions over what the list already knows (the interval, an optional explicit due date, when the password last changed, and the
// server's "rotation required" flag set when someone who could read it lost access). Nothing here reads a secret.
//   overdue   : the due date has passed
//   due       : due within the next day
//   upcoming  : due within the person's reminder window (default 14 days)
//   ok        : scheduled, further away
//   required  : flagged after someone who could see the password lost access (change it, whatever the schedule says)
//   none      : no schedule
// ==========================================

export const DAY_MS = 86400000;
export const REMINDER_WINDOWS = Object.freeze([7, 14, 30, 60]);
export const DEFAULT_WARN_DAYS = 14;

export function dueDateOf(item) {
  if (item.rotationDueAt) {
    const explicit = Date.parse(item.rotationDueAt);
    if (!Number.isNaN(explicit)) return explicit;
  }
  if (item.rotationIntervalDays && item.lastRotatedAt) {
    const last = Date.parse(item.lastRotatedAt);
    if (!Number.isNaN(last)) return last + item.rotationIntervalDays * DAY_MS;
  }
  return null;
}

export function rotationStatus(item, { now = Date.now(), warnDays = DEFAULT_WARN_DAYS } = {}) {
  const due = dueDateOf(item);
  const required = Boolean(item.rotationRequired);
  if (due === null) return { status: required ? "required" : "none", dueAt: null, daysLeft: null, required };
  const left = due - now;
  const daysLeft = Math.ceil(left / DAY_MS);
  let status = "ok";
  if (left < 0) status = "overdue";
  else if (left < DAY_MS) status = "due";
  else if (left <= warnDays * DAY_MS) status = "upcoming";
  if (required && status === "ok") status = "required";
  return { status, dueAt: new Date(due).toISOString(), daysLeft, required };
}

export const STATUS_LABELS = Object.freeze({
  overdue: "Overdue", due: "Due today", upcoming: "Due soon", ok: "Scheduled", required: "Change required", none: "No schedule",
});

export const SEVERITY = Object.freeze({ required: 0, overdue: 1, due: 2, upcoming: 3, ok: 4, none: 5 });

export function describeRotation(result) {
  if (result.status === "none") return "No rotation schedule";
  if (result.status === "required") return "Change required: someone who could see this password lost access";
  if (result.status === "overdue") return `Overdue by ${Math.max(1, -result.daysLeft)} day${-result.daysLeft === 1 ? "" : "s"}`;
  if (result.status === "due") return "Due today";
  return `Due in ${result.daysLeft} day${result.daysLeft === 1 ? "" : "s"}`;
}
