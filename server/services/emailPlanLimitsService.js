const subscriptionPlanService = require("./subscriptionPlanService");

// ==========================================
// EMAIL PLAN LIMITS (Phase 16A Step 13)
//
// Reads limits from the EXISTING subscription_plans.features JSONB
// column -- no new plan table, no hardcoded Starter/Business/
// Enterprise definitions in code, exactly as instructed ("Do NOT
// hardcode these plans... design the system so existing subscription
// plan features can eventually control mailbox count/storage/
// domains"). A plan the Platform Owner has not configured for email
// yet (features.email absent/null) falls back to a small, safe
// default rather than either "unlimited" (an abuse risk on a brand
// new feature) or "zero" (which would silently break email for every
// existing plan the instant this phase ships).
//
// To grant a real, larger limit to a specific plan, the Platform
// Owner sets its `features` column (already editable via the
// existing Plans UI) to include, e.g.:
//   { "email": { "maxDomains": 3, "maxMailboxes": 50 } }
// ==========================================

const DEFAULT_MAX_DOMAINS = 1;
const DEFAULT_MAX_MAILBOXES = 5;

async function getEmailLimitsForPlan(planId) {

    if (!planId) {
        return { maxDomains: DEFAULT_MAX_DOMAINS, maxMailboxes: DEFAULT_MAX_MAILBOXES };
    }

    const plan = await subscriptionPlanService.getPlanById(planId);
    const emailFeatures = (plan && plan.features && typeof plan.features === "object" && plan.features.email) || {};

    return {
        maxDomains: Number.isInteger(emailFeatures.maxDomains) && emailFeatures.maxDomains >= 0
            ? emailFeatures.maxDomains
            : DEFAULT_MAX_DOMAINS,
        maxMailboxes: Number.isInteger(emailFeatures.maxMailboxes) && emailFeatures.maxMailboxes >= 0
            ? emailFeatures.maxMailboxes
            : DEFAULT_MAX_MAILBOXES,
    };

}

module.exports = {
    getEmailLimitsForPlan,
    DEFAULT_MAX_DOMAINS,
    DEFAULT_MAX_MAILBOXES,
};
