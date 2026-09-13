const emailDeliveryService = require("../services/emailDeliveryService");
const emailService = require("../services/emailService");
const platformAuditService = require("../services/platformAuditService");
const platformPool = require("../config/platformDb");
const { EMAIL_MAX_RETRIES } = require("../config/emailConfig");

// ==========================================
// PLATFORM EMAIL CONTROLLER (Phase 13I/13J/13H)
//
// Every route using this controller is mounted behind platformProtect.
// Nothing here ever returns SMTP credentials -- getConfigStatus()
// only ever reports presence (boolean), never values (see
// emailService.getConfigStatus).
// ==========================================

const VALID_STATUSES = ["pending", "sent", "failed", "skipped"];

const toSafeLog = (row) => ({
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    companySlug: row.company_slug,
    recipientEmail: row.recipient_email,
    recipientName: row.recipient_name,
    emailType: row.email_type,
    subject: row.subject,
    status: row.status,
    providerMessageId: row.provider_message_id,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    maxRetries: EMAIL_MAX_RETRIES,
    lastAttemptAt: row.last_attempt_at,
    sentAt: row.sent_at,
    createdAt: row.created_at,
});

const listEmailLogs = async (req, res) => {
    try {
        const { companyId, emailType, status, search, dateFrom, dateTo } = req.query;

        if (status && !VALID_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid status filter." });
        }

        let companyIdNum;
        if (companyId !== undefined) {
            companyIdNum = Number(companyId);
            if (!Number.isInteger(companyIdNum) || companyIdNum <= 0) {
                return res.status(400).json({ success: false, message: "Invalid companyId filter." });
            }
        }

        const rows = await emailDeliveryService.listEmailLogs({
            companyId: companyIdNum, emailType: emailType || undefined, status: status || undefined,
            search: typeof search === "string" ? search.trim() : undefined,
            dateFrom: dateFrom || undefined, dateTo: dateTo || undefined,
        });

        return res.status(200).json({ success: true, logs: rows.map(toSafeLog) });
    } catch (error) {
        console.error("[platform] listEmailLogs failed:", error);
        return res.status(500).json({ success: false, message: "Failed to load email logs." });
    }
};

// Manual retry -- Phase 13J. Never fakes a resend success: the real
// result of emailDeliveryService.retryFailedEmail (which itself only
// ever reports 'sent' when emailService.sendMail genuinely returned
// {sent:true}) is what this endpoint returns.
const retryEmailLog = async (req, res) => {
    try {
        const logId = Number(req.params.id);
        if (!Number.isInteger(logId) || logId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid email log id." });
        }

        const { error, log } = await emailDeliveryService.retryFailedEmail(logId);

        if (error === "NOT_FOUND") {
            return res.status(404).json({ success: false, message: "Email log not found." });
        }
        if (error === "NOT_RETRYABLE") {
            return res.status(409).json({ success: false, message: `This email is '${log.status}' and cannot be retried. Only failed emails can be retried.` });
        }
        if (error === "MAX_RETRIES_EXCEEDED") {
            return res.status(409).json({ success: false, message: `Maximum retry count (${EMAIL_MAX_RETRIES}) has already been reached for this email.` });
        }

        await platformAuditService.logAction({
            platformUserId: req.platformUser.id, actionType: "email_retried", targetType: "email_log", targetId: logId, companyId: log.company_id,
            metadata: { emailType: log.email_type, resultStatus: log.status },
        }).catch((auditError) => console.error("[platform] audit log failed (email_retried):", auditError.message));

        return res.status(200).json({ success: true, log: toSafeLog(log) });
    } catch (error) {
        console.error("[platform] retryEmailLog failed:", error);
        return res.status(500).json({ success: false, message: "Failed to retry email." });
    }
};

// Passive status -- Phase 13H/13K. Never sends anything, never
// exposes a credential value, only presence booleans.
const getEmailStatus = async (_req, res) => {
    try {
        const configStatus = emailService.getConfigStatus();
        const [recentSent] = await platformPool.query(
            `SELECT MAX(sent_at) AS lastSentAt FROM email_delivery_logs WHERE status = 'sent'`
        );
        return res.status(200).json({
            success: true,
            status: {
                ...configStatus,
                sendingEnabled: configStatus.configured,
                lastSuccessfulSendAt: recentSent[0]?.lastSentAt || null,
                maxRetries: EMAIL_MAX_RETRIES,
            },
        });
    } catch (error) {
        console.error("[platform] getEmailStatus failed:", error);
        return res.status(500).json({ success: false, message: "Failed to load email status." });
    }
};

// Explicit-action-only connection check -- Phase 13H. Never sends an
// email (see emailService.verifyConnection -- a pure SMTP handshake
// check, nodemailer's transporter.verify()).
const testEmailConnection = async (req, res) => {
    try {
        const result = await emailService.verifyConnection();

        await platformAuditService.logAction({
            platformUserId: req.platformUser.id, actionType: "smtp_test_triggered", targetType: "platform_settings",
            metadata: { result: result.ok ? "ok" : (result.reason || "failed") },
        }).catch((auditError) => console.error("[platform] audit log failed (smtp_test_triggered):", auditError.message));

        if (result.ok) {
            return res.status(200).json({ success: true, connected: true });
        }
        return res.status(200).json({
            success: true,
            connected: false,
            reason: result.reason === "smtp_not_configured" ? "SMTP is not configured." : "Connection failed. Check the server logs for details.",
        });
    } catch (error) {
        console.error("[platform] testEmailConnection failed:", error);
        return res.status(500).json({ success: false, message: "Failed to test SMTP connection." });
    }
};

module.exports = { listEmailLogs, retryEmailLog, getEmailStatus, testEmailConnection };
