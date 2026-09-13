const platformPool = require("../config/platformDb");
const emailService = require("./emailService");
const platformCompanyService = require("./platformCompanyService");
const tenantUserService = require("./tenantUserService");
const { getTenantPoolForCompany } = require("../config/tenantConnectionManager");
const platformEmailTemplates = require("./platformEmailTemplates");
const { EMAIL_MAX_RETRIES, EMAIL_RETRY_DELAY_MINUTES } = require("../config/emailConfig");

// ==========================================
// EMAIL DELIVERY SERVICE (Phase 13D)
//
// The ONE place a lifecycle email is ever built, sent, and recorded.
// Wraps (never replaces) the existing emailService.sendMail -- this
// file owns recipient selection, template regeneration, and the
// email_delivery_logs row; emailService still owns the actual SMTP
// transport, exactly as before.
//
// STATUS DEFINITIONS (Phase 13's explicit rule -- a successful
// function call is NOT proof of delivery):
//   pending = log row created, send not yet attempted/resolved
//   sent    = emailService.sendMail returned {sent:true} -- the SMTP
//             server ACCEPTED the message. Never "delivered": this
//             codebase has no delivery-confirmation mechanism (no
//             webhook from an ESP), so the UI must never claim more
//             than "accepted by the mail server".
//   failed  = a real send attempt was made and genuinely failed
//             (network/auth/protocol error) -- retryable.
//   skipped = intentionally never attempted (no recipient available,
//             or SMTP not configured) -- NOT retryable automatically
//             (see Phase 13F: "do not retry skipped emails").
//
// RECIPIENT PRIORITY (Phase 13's explicit rule):
//   1. company.billing_contact_email (Phase 13A)
//   2. the tenant's first Admin (tenantUserService.getFirstAdmin --
//      same lookup platformCompanyController.js already uses for
//      GET /companies/:id's adminEmail field)
//   3. none -> status 'skipped', logged, no error thrown
// ==========================================

// email_type -> template builder. Only the small `template_data`
// object is ever persisted (never the rendered HTML) -- this map is
// what lets a retry regenerate the exact same email from that stored
// data (see Phase 13C: "prefer storing metadata... entire email
// bodies" is unnecessary and unsafe to keep around).
const TEMPLATE_BUILDERS = {
    trial_ending_soon: platformEmailTemplates.trialEndingSoonEmail,
    trial_expired: platformEmailTemplates.trialExpiredEmail,
    subscription_expiring_soon: platformEmailTemplates.subscriptionExpiringSoonEmail,
    payment_failed: platformEmailTemplates.paymentFailedEmail,
    grace_period_started: platformEmailTemplates.gracePeriodStartedEmail,
    grace_period_ending: platformEmailTemplates.gracePeriodEndingEmail,
    subscription_expired: platformEmailTemplates.subscriptionExpiredEmail,
    subscription_renewed: platformEmailTemplates.subscriptionRenewedEmail,
};

function buildEmail(emailType, templateData) {
    const builder = TEMPLATE_BUILDERS[emailType];
    if (!builder) {
        const error = new Error(`Unknown lifecycle email type: "${emailType}".`);
        error.code = "UNKNOWN_EMAIL_TYPE";
        throw error;
    }
    return builder(templateData || {});
}

// Resolution logic moved here from subscriptionLifecycleService.js
// (Phase 12's getCompanyAdminEmail) -- this is now the ONLY place a
// lifecycle-email recipient is ever resolved, so the priority order
// can never drift between call sites.
async function resolveRecipient(company) {
    if (company.billing_contact_email) {
        return { email: company.billing_contact_email, name: company.billing_contact_name || null, source: "billing_contact" };
    }
    try {
        const tenantPool = getTenantPoolForCompany(company);
        const admin = await tenantUserService.getFirstAdmin(tenantPool);
        if (admin?.email) {
            return { email: admin.email, name: admin.full_name || admin.fullName || null, source: "admin" };
        }
    } catch (_error) {
        // No usable tenant connection (e.g. still pending provisioning)
        // -- falls through to "no recipient" below, not an error.
    }
    return null;
}

const ERROR_MESSAGE_MAX_LENGTH = 500;
function truncateError(message) {
    if (!message) return null;
    return String(message).slice(0, ERROR_MESSAGE_MAX_LENGTH);
}

async function createEmailLog({ companyId, recipientEmail, recipientName, emailType, subject, templateData, status }) {
    const [result] = await platformPool.query(
        `INSERT INTO email_delivery_logs
            (company_id, recipient_email, recipient_name, email_type, subject, template_data, status, last_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        [
            companyId || null, recipientEmail || null, recipientName || null, emailType, subject,
            templateData ? JSON.stringify(templateData) : null, status,
            status === "pending" ? null : new Date(),
        ]
    );
    return result.insertId;
}

async function getEmailLogById(id) {
    const [rows] = await platformPool.query(`SELECT * FROM email_delivery_logs WHERE id = ? LIMIT 1`, [id]);
    return rows[0] || null;
}

async function markEmailSent(logId, { providerMessageId }) {
    await platformPool.query(
        `UPDATE email_delivery_logs SET status = 'sent', provider_message_id = ?, error_message = NULL, sent_at = NOW(), last_attempt_at = NOW() WHERE id = ?`,
        [providerMessageId || null, logId]
    );
}

async function markEmailFailed(logId, { errorMessage }) {
    await platformPool.query(
        `UPDATE email_delivery_logs SET status = 'failed', error_message = ?, last_attempt_at = NOW() WHERE id = ?`,
        [truncateError(errorMessage), logId]
    );
}

async function markEmailSkipped(logId, { errorMessage }) {
    await platformPool.query(
        `UPDATE email_delivery_logs SET status = 'skipped', error_message = ?, last_attempt_at = NOW() WHERE id = ?`,
        [truncateError(errorMessage), logId]
    );
}

// ==========================================
// SEND A LIFECYCLE EMAIL (Phase 13E)
//
// Called by subscriptionLifecycleService.notify() for every real
// lifecycle event. Always creates exactly one email_delivery_logs
// row per call -- this function is only ever invoked from a code path
// ALREADY deduplicated by subscriptionHistoryService (a reminder event
// only fires once per company+eventType+effectiveAt), so no separate
// dedup logic is needed here (Phase 13M).
//
// Never throws for an ordinary "no recipient"/"SMTP not configured"
// outcome -- those are legitimate, correctly-logged 'skipped' results,
// not failures. Only truly unexpected errors (a DB write failure,
// an unknown email_type) propagate to the caller.
// ==========================================
async function sendLifecycleEmail({ companyId, emailType, templateData }) {
    const company = await platformCompanyService.getCompanyById(companyId);
    const email = buildEmail(emailType, templateData);

    if (!company) {
        const logId = await createEmailLog({ companyId, recipientEmail: null, recipientName: null, emailType, subject: email.subject, templateData, status: "skipped" });
        await markEmailSkipped(logId, { errorMessage: "Company not found." });
        return logId;
    }

    const recipient = await resolveRecipient(company);

    if (!recipient) {
        const logId = await createEmailLog({ companyId, recipientEmail: null, recipientName: null, emailType, subject: email.subject, templateData, status: "skipped" });
        await markEmailSkipped(logId, { errorMessage: "No billing contact or company admin email available." });
        return logId;
    }

    const logId = await createEmailLog({
        companyId, recipientEmail: recipient.email, recipientName: recipient.name, emailType, subject: email.subject, templateData, status: "pending",
    });

    const result = await emailService.sendMail({ to: recipient.email, subject: email.subject, html: email.html, text: email.text });

    if (result.sent) {
        await markEmailSent(logId, { providerMessageId: result.messageId });
    } else if (result.reason === "send_failed") {
        await markEmailFailed(logId, { errorMessage: result.error || "Send failed." });
    } else {
        // smtp_not_configured (no_recipient can't happen here -- we
        // always pass a real `to` once recipient resolution succeeded).
        await markEmailSkipped(logId, { errorMessage: "SMTP is not configured." });
    }

    return logId;
}

// ==========================================
// RETRY (Phase 13F/13J) -- shared by both the automatic sweep-driven
// path and the Platform Owner's manual "Retry" button. Only ever acts
// on a log currently in 'failed' status, under the max-retry cap.
// retry_count is incremented BEFORE the attempt (so it always
// reflects "how many retries have been attempted", win or lose).
// ==========================================
async function retryFailedEmail(logId) {
    const log = await getEmailLogById(logId);
    if (!log) {
        return { error: "NOT_FOUND", log: null };
    }
    if (log.status !== "failed") {
        return { error: "NOT_RETRYABLE", log };
    }
    if (log.retry_count >= EMAIL_MAX_RETRIES) {
        return { error: "MAX_RETRIES_EXCEEDED", log };
    }

    let email;
    try {
        email = buildEmail(log.email_type, log.template_data);
    } catch (_buildError) {
        // Template data too old/malformed to regenerate -- surface as
        // a real failure rather than silently doing nothing.
        await platformPool.query(`UPDATE email_delivery_logs SET retry_count = retry_count + 1, last_attempt_at = NOW() WHERE id = ?`, [logId]);
        await markEmailFailed(logId, { errorMessage: "Unable to regenerate this email for retry (unknown or malformed template data)." });
        return { error: null, log: await getEmailLogById(logId) };
    }

    await platformPool.query(`UPDATE email_delivery_logs SET retry_count = retry_count + 1, last_attempt_at = NOW() WHERE id = ?`, [logId]);

    const result = await emailService.sendMail({ to: log.recipient_email, subject: email.subject, html: email.html, text: email.text });

    if (result.sent) {
        await markEmailSent(logId, { providerMessageId: result.messageId });
    } else if (result.reason === "send_failed") {
        await markEmailFailed(logId, { errorMessage: result.error || "Send failed." });
    } else {
        await markEmailFailed(logId, { errorMessage: "SMTP is not configured." });
    }

    return { error: null, log: await getEmailLogById(logId) };
}

// Automatic, sweep-driven retries only -- gated by BOTH the max-retry
// cap (checked inside retryFailedEmail) AND an exponential backoff
// window computed here (delay = EMAIL_RETRY_DELAY_MINUTES * 2^retryCount).
// A manual Platform Owner retry (platformEmailController.js) calls
// retryFailedEmail() directly and is NOT subject to this backoff --
// an explicit human action is allowed to try sooner.
async function processEmailRetries() {
    const [candidates] = await platformPool.query(
        `SELECT id, retry_count, last_attempt_at FROM email_delivery_logs WHERE status = 'failed' AND retry_count < ?`,
        [EMAIL_MAX_RETRIES]
    );

    let retried = 0;
    const now = Date.now();
    for (const candidate of candidates) {
        const requiredDelayMs = EMAIL_RETRY_DELAY_MINUTES * 60 * 1000 * Math.pow(2, candidate.retry_count);
        const lastAttemptMs = candidate.last_attempt_at ? new Date(candidate.last_attempt_at).getTime() : 0;
        if (now - lastAttemptMs < requiredDelayMs) continue;

        // eslint-disable-next-line no-await-in-loop
        await retryFailedEmail(candidate.id);
        retried += 1;
    }

    if (retried > 0) {
        console.log(`[emailDeliveryService] Automatic retry pass: ${retried} email(s) retried.`);
    }
    return { retried, candidates: candidates.length };
}

async function listEmailLogs({ companyId, emailType, status, search, dateFrom, dateTo, limit = 100 } = {}) {
    const conditions = [];
    const params = [];

    if (companyId) { conditions.push(`e.company_id = ?`); params.push(companyId); }
    if (emailType) { conditions.push(`e.email_type = ?`); params.push(emailType); }
    if (status) { conditions.push(`e.status = ?`); params.push(status); }
    if (dateFrom) { conditions.push(`e.created_at >= ?`); params.push(dateFrom); }
    if (dateTo) { conditions.push(`e.created_at <= ?`); params.push(dateTo); }
    if (search) {
        conditions.push(`(e.recipient_email LIKE ? OR c.company_name LIKE ? OR e.subject LIKE ?)`);
        const term = `%${search}%`;
        params.push(term, term, term);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);

    const [rows] = await platformPool.query(
        `SELECT e.*, c.company_name, c.company_slug
         FROM email_delivery_logs e
         LEFT JOIN companies c ON c.id = e.company_id
         ${whereClause}
         ORDER BY e.created_at DESC
         LIMIT ${safeLimit}`,
        params
    );
    return rows;
}

async function getFailedEmailSummary() {
    const [rows] = await platformPool.query(
        `SELECT e.id, e.company_id, c.company_name, c.company_slug, e.email_type, e.retry_count
         FROM email_delivery_logs e
         LEFT JOIN companies c ON c.id = e.company_id
         WHERE e.status = 'failed'
         ORDER BY e.created_at DESC
         LIMIT 10`
    );
    return rows;
}

module.exports = {
    sendLifecycleEmail,
    retryFailedEmail,
    processEmailRetries,
    listEmailLogs,
    getEmailLogById,
    getFailedEmailSummary,
    resolveRecipient,
};
