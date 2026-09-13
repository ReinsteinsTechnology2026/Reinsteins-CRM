const nodemailer = require("nodemailer");

// ==========================================
// EMAIL SERVICE
//
// Configuration comes ONLY from environment
// variables (SMTP_HOST, SMTP_PORT, SMTP_USER,
// SMTP_PASS, SMTP_FROM) -- never hardcoded, and
// never logged. If SMTP_HOST is not set, the
// transporter is left null and sendMail()
// silently no-ops (logging only that it skipped,
// never any credential) -- this lets the app run
// in any environment without email configured,
// exactly as it did before this feature existed.
//
// Failures here must NEVER throw back into the
// caller's request path -- every call site that
// uses this (via notificationService) treats
// email purely as a best-effort side effect.
// ==========================================

let transporter = null;
let loggedMissingConfig = false;

function getTransporter() {

    if (transporter) {
        return transporter;
    }

    const {
        SMTP_HOST,
        SMTP_PORT,
        SMTP_USER,
        SMTP_PASS,
    } = process.env;

    if (!SMTP_HOST) {

        if (!loggedMissingConfig) {
            console.log("[emailService] SMTP_HOST not configured — email sending is disabled (portal notifications are unaffected).");
            loggedMissingConfig = true;
        }

        return null;

    }

    // SMTP_USER/SMTP_PASS are optional -- a local dev capture tool
    // (e.g. MailHog/MailDev) typically accepts unauthenticated
    // connections, matching how this app is tested without any real
    // provider credentials.
    transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: Number(SMTP_PORT) || 587,
        secure: Number(SMTP_PORT) === 465,
        auth: SMTP_USER
            ? { user: SMTP_USER, pass: SMTP_PASS }
            : undefined,
    });

    return transporter;

}

// ==========================================
// SEND MAIL
// Never throws -- returns { sent: boolean, reason?: string }
// so callers can record success/failure without ever needing
// to handle a rejected promise.
// ==========================================

async function sendMail({ to, subject, html, text }) {

    if (!to) {
        return { sent: false, reason: "no_recipient" };
    }

    const activeTransporter = getTransporter();

    if (!activeTransporter) {
        return { sent: false, reason: "smtp_not_configured" };
    }

    const fromAddress = process.env.SMTP_FROM || "WorkHub <notifications@workhub.local>";

    try {

        const info = await activeTransporter.sendMail({
            from: fromAddress,
            to,
            subject,
            text,
            html,
        });

        // Safe diagnostic only -- message id and accepted/rejected
        // recipient lists, never transport config or credentials.
        console.log(`[emailService] Sent "${subject}" to ${to} (messageId: ${info.messageId})`);

        // messageId returned to the caller (Phase 13C) so callers that
        // track delivery (emailDeliveryService) can store the real
        // provider message id -- proof the SMTP server actually
        // accepted it, not just that this function ran without error.
        return { sent: true, messageId: info.messageId };

    } catch (error) {

        // error.message from nodemailer/SMTP does not include the
        // configured credentials (those live only in the transporter
        // object created above, which is never logged) -- only
        // connection/protocol-level diagnostics. Still truncated by
        // every caller before persisting, as defense in depth.
        console.error(`[emailService] Failed to send "${subject}" to ${to}:`, error.message);

        return { sent: false, reason: "send_failed", error: error.message };

    }

}

// ==========================================
// VERIFY CONNECTION (Phase 13H)
//
// A CONNECTION check only -- never sends an email. Used by the
// Platform Owner's explicit "Test Connection" action and the passive
// SMTP status endpoint. Returns only a boolean + a short, safe reason
// string (nodemailer's verify() error messages are protocol-level,
// e.g. "Invalid login" -- never the configured password itself, which
// lives only in the transporter object and is never logged/returned).
// ==========================================

async function verifyConnection() {
    const activeTransporter = getTransporter();
    if (!activeTransporter) {
        return { ok: false, reason: "smtp_not_configured" };
    }
    try {
        await activeTransporter.verify();
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: "connection_failed", error: error.message };
    }
}

// Safe, secret-free snapshot of the current SMTP configuration state
// -- host/user PRESENCE only, never the actual values, and never the
// password under any circumstance.
function getConfigStatus() {
    return {
        configured: Boolean(process.env.SMTP_HOST),
        fromAddress: process.env.SMTP_FROM || "WorkHub <notifications@workhub.local>",
        hostConfigured: Boolean(process.env.SMTP_HOST),
        userConfigured: Boolean(process.env.SMTP_USER),
    };
}

module.exports = {
    sendMail,
    verifyConnection,
    getConfigStatus,
};
