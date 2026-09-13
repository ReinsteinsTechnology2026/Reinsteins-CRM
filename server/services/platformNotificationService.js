const platformPool = require("../config/platformDb");
const platformUserService = require("./platformUserService");
const emailService = require("./emailService");

// ==========================================
// PLATFORM NOTIFICATION SERVICE (Phase 12N)
//
// A DELIBERATELY SEPARATE store from services/notificationService.js
// -- that one writes to the tenant `notifications` table (via the
// legacy single-tenant `config/db` pool) and is scoped to one
// company's own employees. Platform Owner alerts are inherently
// cross-company/platform-level facts with no tenant database to live
// in, so this writes to groworgs_platform_db.platform_notifications
// instead. Same conceptual shape (title/message/type/is_read/
// reference_type/reference_id/email_sent_at), same emailService
// reuse -- just the correct store for what these actually are.
//
// Fan-out model: since there is realistically one (sometimes a
// handful of) Platform Owner account, an event notifies ALL active
// platform_owner accounts by inserting one row per owner -- mirroring
// exactly how the tenant system creates one row per specific
// recipient, just with multiple recipients instead of one.
// ==========================================

const notifyAllOwners = async ({ title, message, type = "general", referenceType = null, referenceId = null, companyId = null, email = null }) => {
    const owners = await platformUserService.listActiveOwners();
    const notificationIds = [];

    for (const owner of owners) {
        // eslint-disable-next-line no-await-in-loop
        const [result] = await platformPool.query(
            `INSERT INTO platform_notifications (platform_user_id, title, message, type, reference_type, reference_id, company_id, is_read)
             VALUES (?, ?, ?, ?, ?, ?, ?, FALSE)
             RETURNING id`,
            [owner.id, title, message, type, referenceType, referenceId, companyId]
        );
        notificationIds.push(result.insertId);

        if (email) {
            // eslint-disable-next-line no-await-in-loop
            await dispatchEmail(result.insertId, owner.email, email);
        }
    }

    return notificationIds;
};

async function dispatchEmail(notificationId, toEmail, email) {
    try {
        const result = await emailService.sendMail({ to: toEmail, subject: email.subject, html: email.html, text: email.text });
        if (result.sent) {
            await platformPool.query(`UPDATE platform_notifications SET email_sent_at = NOW() WHERE id = ?`, [notificationId]);
        }
    } catch (error) {
        // Never let an email failure propagate -- the notification row
        // is already committed, and lifecycle automation must never be
        // interrupted by an SMTP problem (see subscriptionLifecycleService).
        console.error(`[platformNotificationService] Email dispatch failed for notification ${notificationId}:`, error.message);
    }
}

const listForOwner = async (platformUserId, { unreadOnly = false, limit = 50 } = {}) => {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const [rows] = await platformPool.query(
        `SELECT n.*, c.company_name, c.company_slug
         FROM platform_notifications n
         LEFT JOIN companies c ON c.id = n.company_id
         WHERE n.platform_user_id = ? ${unreadOnly ? "AND n.is_read = FALSE" : ""}
         ORDER BY n.created_at DESC
         LIMIT ${safeLimit}`,
        [platformUserId]
    );
    return rows;
};

const getUnreadCount = async (platformUserId) => {
    const [[row]] = await platformPool.query(
        `SELECT COUNT(*) AS c FROM platform_notifications WHERE platform_user_id = ? AND is_read = FALSE`,
        [platformUserId]
    );
    return Number(row.c);
};

const markRead = async (platformUserId, notificationId) => {
    const [result] = await platformPool.query(
        `UPDATE platform_notifications SET is_read = TRUE WHERE id = ? AND platform_user_id = ?`,
        [notificationId, platformUserId]
    );
    return result.affectedRows > 0;
};

const markAllRead = async (platformUserId) => {
    const [result] = await platformPool.query(
        `UPDATE platform_notifications SET is_read = TRUE WHERE platform_user_id = ? AND is_read = FALSE`,
        [platformUserId]
    );
    return result.affectedRows;
};

module.exports = {
    notifyAllOwners,
    listForOwner,
    getUnreadCount,
    markRead,
    markAllRead,
};
