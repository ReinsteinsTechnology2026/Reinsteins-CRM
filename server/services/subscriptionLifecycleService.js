const platformCompanyService = require("./platformCompanyService");
const subscriptionHistoryService = require("./subscriptionHistoryService");
const platformNotificationService = require("./platformNotificationService");
const subscriptionPlanService = require("./subscriptionPlanService");
const emailDeliveryService = require("./emailDeliveryService");
const {
    TRIAL_WARNING_DAYS,
    SUBSCRIPTION_EXPIRY_WARNING_DAYS,
    SUBSCRIPTION_GRACE_PERIOD_DAYS,
    GRACE_PERIOD_WARNING_DAYS,
} = require("../config/lifecycleConfig");

// ==========================================
// SUBSCRIPTION LIFECYCLE SERVICE (Phase 12B)
//
// The SINGLE place automated subscription-state decisions get made.
// Nothing outside this file decides "has this trial expired" or
// "should this company enter a grace period" -- the sweep job
// (jobs/subscriptionLifecycleSweep.js) just calls evaluateCompanySubscription()
// per company; platformPaymentController.js's finalizePaymentSuccess
// calls processRenewalSuccess() after a payment is verified paid;
// platformPaymentController.js's updatePaymentStatus calls
// processPaymentFailure() when a payment becomes 'failed'. Every write
// to companies.subscription_status/grace_period_ends_at driven by
// automation (not a direct Platform Owner edit) goes through here.
//
// Every notification/email in this file is a best-effort side effect
// -- a failure sending email must never prevent the underlying
// subscription_history row or companies update from being committed
// (see the try/catch around every notify*/email call).
// ==========================================

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function daysUntil(date, from = new Date()) {
    return Math.ceil((new Date(date).getTime() - from.getTime()) / ONE_DAY_MS);
}

function calculateGracePeriodEnd(expiresAt) {
    return new Date(new Date(expiresAt).getTime() + SUBSCRIPTION_GRACE_PERIOD_DAYS * ONE_DAY_MS);
}

async function logLifecycleEvent(fields) {
    return subscriptionHistoryService.logEvent(fields);
}

async function getPlanName(planId) {
    if (!planId) return null;
    const plan = await subscriptionPlanService.getPlanById(planId);
    return plan?.name || null;
}

// Sends the Platform Owner alert (always) and, best-effort, a tracked
// lifecycle email (only when an emailType + templateData are given --
// e.g. processPaymentFailure has no admin-facing email variant beyond
// what's already covered elsewhere for some events). Both halves are
// wrapped so a notification/email failure never breaks the caller --
// the subscription_history row this is called from has already
// committed by the time notify() runs.
//
// Phase 13: email sending/recipient-resolution/logging is now
// entirely owned by emailDeliveryService.sendLifecycleEmail -- this
// function only decides WHEN an email should be attempted (which
// event, with which data), never HOW it's sent or WHO it goes to.
async function notify({ company, ownerTitle, ownerMessage, type, referenceId = null, emailType = null, templateData = null }) {
    try {
        await platformNotificationService.notifyAllOwners({
            title: ownerTitle,
            message: ownerMessage,
            type,
            referenceType: "company",
            referenceId: referenceId ?? company.id,
            companyId: company.id,
        });
    } catch (error) {
        console.error(`[subscriptionLifecycle] Failed to notify Platform Owner(s) for company ${company.id}:`, error.message);
    }

    if (!emailType) return;

    try {
        await emailDeliveryService.sendLifecycleEmail({ companyId: company.id, emailType, templateData: templateData || {} });
    } catch (error) {
        console.error(`[subscriptionLifecycle] Failed to send/log lifecycle email for company ${company.id}:`, error.message);
    }
}

// ==========================================
// TRIAL
// ==========================================

async function processTrialExpiry(company) {
    const updated = await platformCompanyService.updateCompanySubscription(company.id, {
        planId: company.plan_id,
        subscriptionStatus: "expired",
        trialEndsAt: company.trial_ends_at,
        subscriptionExpiresAt: company.subscription_expires_at,
    });
    if (!updated) return { changed: false };

    await logLifecycleEvent({
        companyId: company.id, planId: company.plan_id, eventType: "trial_expired",
        previousStatus: "trial", newStatus: "expired", effectiveAt: company.trial_ends_at, source: "system",
    });

    await notify({
        company,
        ownerTitle: `${company.company_name} trial expired`,
        ownerMessage: `${company.company_name}'s trial ended and access is now blocked until a plan is activated.`,
        type: "trial_expired",
        emailType: "trial_expired",
        templateData: { companyName: company.company_name, trialEndsAt: company.trial_ends_at },
    });

    return { changed: true, event: "trial_expired" };
}

async function processTrialReminders(company) {
    const daysRemaining = daysUntil(company.trial_ends_at);
    if (daysRemaining <= 0) return { sent: [] };

    const sent = [];
    for (const windowDays of TRIAL_WARNING_DAYS) {
        if (daysRemaining > windowDays) continue;
        const eventType = `trial_ending_soon_${windowDays}d`;
        // eslint-disable-next-line no-await-in-loop
        const alreadySent = await subscriptionHistoryService.hasEvent({ companyId: company.id, eventType, effectiveAt: company.trial_ends_at });
        if (alreadySent) continue;

        // eslint-disable-next-line no-await-in-loop
        await logLifecycleEvent({
            companyId: company.id, planId: company.plan_id, eventType,
            previousStatus: "trial", newStatus: "trial", effectiveAt: company.trial_ends_at, source: "system",
            notes: `${windowDays}-day trial-ending-soon reminder`,
        });

        // eslint-disable-next-line no-await-in-loop
        const planName = await getPlanName(company.plan_id);
        // eslint-disable-next-line no-await-in-loop
        await notify({
            company,
            ownerTitle: `${company.company_name} trial ends in ${windowDays} day${windowDays === 1 ? "" : "s"}`,
            ownerMessage: `${company.company_name}'s trial ends on ${new Date(company.trial_ends_at).toLocaleDateString()}.`,
            type: "trial_ending_soon",
            emailType: "trial_ending_soon",
            templateData: { companyName: company.company_name, trialEndsAt: company.trial_ends_at, planName, daysRemaining: windowDays },
        });

        sent.push(eventType);
    }
    return { sent };
}

// ==========================================
// PAID SUBSCRIPTION -- EXPIRY / GRACE PERIOD
// ==========================================

async function processGracePeriodStart(company) {
    const gracePeriodEndsAt = calculateGracePeriodEnd(company.subscription_expires_at);
    const updated = await platformCompanyService.setGracePeriodEndsAt(company.id, gracePeriodEndsAt);
    if (!updated) return { changed: false };

    await logLifecycleEvent({
        companyId: company.id, planId: company.plan_id, eventType: "grace_period_started",
        previousStatus: "active", newStatus: "active", effectiveAt: company.subscription_expires_at, source: "system",
        notes: `Grace period until ${gracePeriodEndsAt.toISOString()}`,
    });

    const planName = await getPlanName(company.plan_id);
    await notify({
        company,
        ownerTitle: `${company.company_name} subscription expired -- grace period started`,
        ownerMessage: `${company.company_name}'s subscription expired. Access remains available until ${gracePeriodEndsAt.toLocaleDateString()} unless renewed.`,
        type: "grace_period_started",
        emailType: "grace_period_started",
        templateData: { companyName: company.company_name, gracePeriodEndsAt, planName },
    });

    return { changed: true, event: "grace_period_started", gracePeriodEndsAt };
}

async function processGracePeriodEnd(company) {
    const updated = await platformCompanyService.updateCompanySubscription(company.id, {
        planId: company.plan_id,
        subscriptionStatus: "expired",
        trialEndsAt: company.trial_ends_at,
        subscriptionExpiresAt: company.subscription_expires_at,
    });
    if (!updated) return { changed: false };

    // Clear grace_period_ends_at now that it's genuinely over -- once
    // truly expired it no longer represents anything actionable, and
    // leaving it set would make a LATER renewal's processRenewalSuccess
    // find a stale (already-passed) grace date and log a second,
    // redundant grace_period_ended event for the same grace window.
    await platformCompanyService.setGracePeriodEndsAt(company.id, null);

    await logLifecycleEvent({
        companyId: company.id, planId: company.plan_id, eventType: "grace_period_ended",
        previousStatus: "active", newStatus: "expired", effectiveAt: company.grace_period_ends_at, source: "system",
    });
    await logLifecycleEvent({
        companyId: company.id, planId: company.plan_id, eventType: "subscription_expired",
        previousStatus: "active", newStatus: "expired", effectiveAt: company.subscription_expires_at, source: "system",
    });

    const planName = await getPlanName(company.plan_id);
    await notify({
        company,
        ownerTitle: `${company.company_name} subscription expired`,
        ownerMessage: `${company.company_name}'s grace period ended without renewal. Access is now blocked.`,
        type: "subscription_expired",
        emailType: "subscription_expired",
        templateData: { companyName: company.company_name, planName },
    });

    return { changed: true, event: "grace_period_ended" };
}

async function processGracePeriodReminders(company) {
    const daysRemaining = daysUntil(company.grace_period_ends_at);
    if (daysRemaining <= 0) return { sent: [] };

    const sent = [];
    for (const windowDays of GRACE_PERIOD_WARNING_DAYS) {
        if (daysRemaining > windowDays) continue;
        const eventType = `grace_period_ending_${windowDays}d`;
        // eslint-disable-next-line no-await-in-loop
        const alreadySent = await subscriptionHistoryService.hasEvent({ companyId: company.id, eventType, effectiveAt: company.grace_period_ends_at });
        if (alreadySent) continue;

        // eslint-disable-next-line no-await-in-loop
        await logLifecycleEvent({
            companyId: company.id, planId: company.plan_id, eventType,
            previousStatus: "active", newStatus: "active", effectiveAt: company.grace_period_ends_at, source: "system",
            notes: `${windowDays}-day grace-period-ending reminder`,
        });

        // eslint-disable-next-line no-await-in-loop
        await notify({
            company,
            ownerTitle: `${company.company_name} grace period ends in ${windowDays} day${windowDays === 1 ? "" : "s"}`,
            ownerMessage: `${company.company_name}'s grace period ends on ${new Date(company.grace_period_ends_at).toLocaleDateString()}.`,
            type: "grace_period_ending",
            emailType: "grace_period_ending",
            templateData: { companyName: company.company_name, gracePeriodEndsAt: company.grace_period_ends_at, daysRemaining: windowDays },
        });

        sent.push(eventType);
    }
    return { sent };
}

async function processExpiringSoonReminders(company) {
    const daysRemaining = daysUntil(company.subscription_expires_at);
    if (daysRemaining <= 0) return { sent: [] };

    const sent = [];
    for (const windowDays of SUBSCRIPTION_EXPIRY_WARNING_DAYS) {
        if (daysRemaining > windowDays) continue;
        const eventType = `subscription_expiring_soon_${windowDays}d`;
        // eslint-disable-next-line no-await-in-loop
        const alreadySent = await subscriptionHistoryService.hasEvent({ companyId: company.id, eventType, effectiveAt: company.subscription_expires_at });
        if (alreadySent) continue;

        // eslint-disable-next-line no-await-in-loop
        await logLifecycleEvent({
            companyId: company.id, planId: company.plan_id, eventType,
            previousStatus: "active", newStatus: "active", effectiveAt: company.subscription_expires_at, source: "system",
            notes: `${windowDays}-day subscription-expiring-soon reminder`,
        });

        // eslint-disable-next-line no-await-in-loop
        const planName = await getPlanName(company.plan_id);
        // eslint-disable-next-line no-await-in-loop
        await notify({
            company,
            ownerTitle: `${company.company_name} subscription expires in ${windowDays} day${windowDays === 1 ? "" : "s"}`,
            ownerMessage: `${company.company_name}'s subscription expires on ${new Date(company.subscription_expires_at).toLocaleDateString()}.`,
            type: "subscription_expiring_soon",
            emailType: "subscription_expiring_soon",
            templateData: { companyName: company.company_name, subscriptionExpiresAt: company.subscription_expires_at, planName, daysRemaining: windowDays },
        });

        sent.push(eventType);
    }
    return { sent };
}

// ==========================================
// PAYMENT SUCCESS / FAILURE
// ==========================================

// Called from platformPaymentController.js's finalizePaymentSuccess,
// AFTER platformCompanyService.updateCompanySubscription has already
// activated the subscription for a verified Razorpay/webhook payment.
// Distinguishes a first-time activation from a renewal purely from
// the state the company was in BEFORE this payment (passed in as
// previousStatus/previousPlanId, captured by the caller before its own
// update) -- this function does not re-derive it, avoiding a second
// (possibly stale) read.
async function processRenewalSuccess({ company, payment, previousStatus, previousPlanId }) {
    // A renewal is specifically "was already an active paid subscriber,
    // paid again" -- coming from trial/expired/cancelled is always a
    // first-time activation, regardless of which plan_id it happens to
    // match, so this intentionally does not consider previousPlanId.
    const isRenewal = previousStatus === "active";
    const eventType = isRenewal ? "subscription_renewed" : "subscription_activated";

    await logLifecycleEvent({
        companyId: company.id, planId: payment.plan_id, eventType,
        previousStatus, newStatus: "active",
        previousPlanId, newPlanId: payment.plan_id,
        effectiveAt: new Date(), source: payment.payment_provider || "system",
        referencePaymentId: payment.id,
    });

    // Clear any grace period -- a successful renewal always supersedes
    // it, regardless of which state it was in.
    if (company.grace_period_ends_at) {
        await platformCompanyService.setGracePeriodEndsAt(company.id, null);
        await logLifecycleEvent({
            companyId: company.id, planId: payment.plan_id, eventType: "grace_period_ended",
            previousStatus: "active", newStatus: "active", effectiveAt: new Date(), source: payment.payment_provider || "system",
            referencePaymentId: payment.id, notes: "Cleared by successful renewal payment.",
        });
    }

    const planName = await getPlanName(payment.plan_id);
    const updatedCompany = await platformCompanyService.getCompanyById(company.id);
    await notify({
        company,
        ownerTitle: `${company.company_name} subscription ${isRenewal ? "renewed" : "activated"}`,
        ownerMessage: `${company.company_name}'s ${planName || "subscription"} was ${isRenewal ? "renewed" : "activated"} successfully.`,
        type: eventType,
        referenceId: payment.id,
        emailType: "subscription_renewed",
        templateData: { companyName: company.company_name, planName, subscriptionExpiresAt: updatedCompany?.subscription_expires_at },
    });

    return { eventType };
}

// Called from platformPaymentController.js's updatePaymentStatus when
// a payment (manual or Razorpay) transitions to 'failed'. Deliberately
// does NOT itself start a grace period or change subscription_status
// -- see module header: grace-period timing is decided ONLY by the
// sweep, from real subscription_expires_at dates, so there is exactly
// one place that ever makes that call. This just logs the event and
// notifies -- a real, honest record of what happened, not an
// automated state change.
async function processPaymentFailure({ company, payment }) {
    await logLifecycleEvent({
        companyId: company.id, planId: payment.plan_id, eventType: "payment_failed",
        previousStatus: company.subscription_status, newStatus: company.subscription_status,
        effectiveAt: new Date(), source: payment.payment_provider || "system", referencePaymentId: payment.id,
    });

    const planName = await getPlanName(payment.plan_id);
    await notify({
        company,
        ownerTitle: `${company.company_name} payment failed`,
        ownerMessage: `A payment for ${company.company_name}'s ${planName || "subscription"} failed.`,
        type: "payment_failed",
        referenceId: payment.id,
        emailType: "payment_failed",
        templateData: { companyName: company.company_name, planName, amount: payment.amount, currency: payment.currency },
    });

    return { event: "payment_failed" };
}

// ==========================================
// PER-COMPANY EVALUATION -- called by the sweep for every active
// company. Subscription_status decides which (if any) branch applies;
// a 'cancelled' or already-'expired' company has nothing further
// automated to do (a human action -- reactivation or a new payment --
// is what moves it forward again).
// ==========================================

async function evaluateCompanySubscription(company) {
    if (!company || company.status !== "active") {
        return { skipped: true, reason: "company not active" };
    }

    if (company.subscription_status === "trial") {
        if (!company.trial_ends_at) return { skipped: true, reason: "no trial_ends_at" };
        if (new Date(company.trial_ends_at) <= new Date()) {
            return processTrialExpiry(company);
        }
        return processTrialReminders(company);
    }

    if (company.subscription_status === "active") {
        if (!company.subscription_expires_at) return { skipped: true, reason: "no subscription_expires_at (complimentary/unmetered)" };

        if (new Date(company.subscription_expires_at) <= new Date()) {
            if (company.grace_period_ends_at) {
                if (new Date(company.grace_period_ends_at) <= new Date()) {
                    return processGracePeriodEnd(company);
                }
                return processGracePeriodReminders(company);
            }
            return processGracePeriodStart(company);
        }

        return processExpiringSoonReminders(company);
    }

    return { skipped: true, reason: `subscription_status '${company.subscription_status}' has nothing to automate` };
}

async function runSweepOnce() {
    const companies = await platformCompanyService.listCompanies();
    const results = { evaluated: 0, changed: 0, remindersSent: 0, errors: 0 };

    for (const company of companies) {
        if (company.status !== "active") continue;
        results.evaluated += 1;
        try {
            // eslint-disable-next-line no-await-in-loop
            const outcome = await evaluateCompanySubscription(company);
            if (outcome?.changed) results.changed += 1;
            if (outcome?.sent?.length) results.remindersSent += outcome.sent.length;
        } catch (error) {
            results.errors += 1;
            console.error(`[subscriptionLifecycle] Sweep failed for company ${company.id} (${company.company_slug}):`, error.message);
        }
    }

    if (results.changed > 0 || results.remindersSent > 0 || results.errors > 0) {
        console.log(`[subscriptionLifecycle] Sweep: evaluated ${results.evaluated}, changed ${results.changed}, reminders sent ${results.remindersSent}, errors ${results.errors}.`);
    }

    // Phase 13F -- reuses this SAME hourly sweep for eligible email
    // retries rather than starting a second timer (see
    // jobs/subscriptionLifecycleSweep.js). A failure here must never
    // affect the subscription-lifecycle results already computed above.
    try {
        results.emailRetries = await emailDeliveryService.processEmailRetries();
    } catch (error) {
        console.error("[subscriptionLifecycle] Email retry pass failed:", error.message);
    }

    return results;
}

module.exports = {
    evaluateCompanySubscription,
    processTrialExpiry,
    processTrialReminders,
    processGracePeriodStart,
    processGracePeriodEnd,
    processGracePeriodReminders,
    processExpiringSoonReminders,
    processRenewalSuccess,
    processPaymentFailure,
    logLifecycleEvent,
    calculateGracePeriodEnd,
    runSweepOnce,
};
