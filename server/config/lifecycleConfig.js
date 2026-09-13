// ==========================================
// SUBSCRIPTION LIFECYCLE CONFIGURATION (Phase 12S)
//
// Single centralized source for every lifecycle timing constant --
// no reminder window, grace-period length, or sweep interval is ever
// hardcoded anywhere else in the lifecycle service, job, or
// controllers. Overridable via environment variables (matching the
// existing NOTIFICATION_* convention in jobs/notificationSweep.js)
// but ships with sensible defaults so nothing needs to be configured
// to work.
// ==========================================

function parseIntList(envValue, fallback) {
    if (!envValue) return fallback;
    const parsed = envValue.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    return parsed.length ? parsed : fallback;
}

// Days-before-expiry windows that trigger a reminder. Sorted
// descending so "furthest out first" reads naturally in logs.
const TRIAL_WARNING_DAYS = parseIntList(process.env.TRIAL_WARNING_DAYS, [3, 1]).sort((a, b) => b - a);
const SUBSCRIPTION_EXPIRY_WARNING_DAYS = parseIntList(process.env.SUBSCRIPTION_EXPIRY_WARNING_DAYS, [7, 3, 1]).sort((a, b) => b - a);

// How many days after subscription_expires_at a company keeps access
// while marked as needing renewal (see platformCompanyService.
// isCompanyAccessAllowed for the enforcement side of this).
const SUBSCRIPTION_GRACE_PERIOD_DAYS = Number(process.env.SUBSCRIPTION_GRACE_PERIOD_DAYS) || 5;

// Days-before-grace-ends windows that trigger a "grace period ending
// soon" reminder.
const GRACE_PERIOD_WARNING_DAYS = parseIntList(process.env.GRACE_PERIOD_WARNING_DAYS, [1]).sort((a, b) => b - a);

// How often the sweep runs, and whether it's enabled at all --
// mirrors NOTIFICATION_SWEEP_ENABLED/NOTIFICATION_SWEEP_INTERVAL_MS.
const LIFECYCLE_SWEEP_INTERVAL_MS = Number(process.env.LIFECYCLE_SWEEP_INTERVAL_MS) || 60 * 60 * 1000; // hourly
const LIFECYCLE_SWEEP_ENABLED = process.env.LIFECYCLE_SWEEP_ENABLED !== "false"; // enabled unless explicitly disabled

module.exports = {
    TRIAL_WARNING_DAYS,
    SUBSCRIPTION_EXPIRY_WARNING_DAYS,
    SUBSCRIPTION_GRACE_PERIOD_DAYS,
    GRACE_PERIOD_WARNING_DAYS,
    LIFECYCLE_SWEEP_INTERVAL_MS,
    LIFECYCLE_SWEEP_ENABLED,
};
