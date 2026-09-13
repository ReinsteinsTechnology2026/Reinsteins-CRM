const platformPool = require("../config/platformDb");

// ==========================================
// SUBSCRIPTION HISTORY SERVICE (Phase 12A)
//
// Pure DB logic against groworgs_platform_db.subscription_history
// ONLY. Two jobs:
//   1. An honest, append-only record of real lifecycle events --
//      never backfilled with invented history (see logEvent, which
//      always uses the CURRENT moment/state, never a guessed past
//      one).
//   2. The durable dedupe store for reminder emails/notifications --
//      hasEvent() is what lets the sweep run every hour without ever
//      sending the same "trial ends in 3 days" reminder twice, without
//      relying on any in-memory state that would reset on a restart.
// ==========================================

const logEvent = async ({
    companyId, planId = null, eventType, previousStatus = null, newStatus = null,
    previousPlanId = null, newPlanId = null, effectiveAt = null, source = "system",
    referencePaymentId = null, notes = null,
}) => {
    const [result] = await platformPool.query(
        `INSERT INTO subscription_history
            (company_id, plan_id, event_type, previous_status, new_status,
             previous_plan_id, new_plan_id, effective_at, source, reference_payment_id, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        [companyId, planId, eventType, previousStatus, newStatus, previousPlanId, newPlanId, effectiveAt, source, referencePaymentId, notes]
    );
    return result.insertId;
};

// The dedupe check -- effectiveAt is the SPECIFIC date being warned
// about (e.g. the exact trial_ends_at value at the moment the
// reminder was sent). If that date later changes (e.g. the Platform
// Owner extends a trial), a new, different effectiveAt means a fresh
// reminder correctly fires again; if the sweep just runs again with
// nothing changed, effectiveAt matches exactly and this returns true.
const hasEvent = async ({ companyId, eventType, effectiveAt }) => {
    const [rows] = await platformPool.query(
        `SELECT id FROM subscription_history
         WHERE company_id = ? AND event_type = ? AND effective_at = ?
         LIMIT 1`,
        [companyId, eventType, effectiveAt]
    );
    return rows.length > 0;
};

const listByCompany = async (companyId, { limit = 50 } = {}) => {
    // LIMIT interpolated directly (not as a `?` placeholder) --
    // mysql2 prepared statements don't reliably accept LIMIT as a bound
    // parameter; safe here because it's clamped to a plain integer in
    // a fixed range, never a raw string.
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const [rows] = await platformPool.query(
        `SELECT h.*, sp.name AS plan_name
         FROM subscription_history h
         LEFT JOIN subscription_plans sp ON sp.id = h.plan_id
         WHERE h.company_id = ?
         ORDER BY h.created_at DESC
         LIMIT ${safeLimit}`,
        [companyId]
    );
    return rows;
};

module.exports = {
    logEvent,
    hasEvent,
    listByCompany,
};
