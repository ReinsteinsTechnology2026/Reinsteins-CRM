const platformNotificationService = require("../services/platformNotificationService");

// ==========================================
// PLATFORM NOTIFICATION CONTROLLER (Phase 12N)
//
// Every handler operates ONLY on req.platformUser.id (from
// platformProtect) -- a Platform Owner can only ever read/mark their
// OWN notifications, never another owner's, and never via any
// client-supplied user id.
// ==========================================

const toSafeNotification = (row) => ({
    id: row.id,
    title: row.title,
    message: row.message,
    type: row.type,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    companyId: row.company_id,
    companyName: row.company_name,
    companySlug: row.company_slug,
    isRead: Boolean(row.is_read),
    createdAt: row.created_at,
});

const listNotifications = async (req, res) => {
    try {
        const unreadOnly = req.query?.unreadOnly === "true" || req.query?.unreadOnly === "1";
        const rows = await platformNotificationService.listForOwner(req.platformUser.id, { unreadOnly });
        return res.status(200).json({ success: true, notifications: rows.map(toSafeNotification) });
    } catch (error) {
        console.error("[platform] listNotifications failed:", error);
        return res.status(500).json({ success: false, message: "Failed to load notifications." });
    }
};

const getUnreadCount = async (req, res) => {
    try {
        const count = await platformNotificationService.getUnreadCount(req.platformUser.id);
        return res.status(200).json({ success: true, count });
    } catch (error) {
        console.error("[platform] getUnreadCount failed:", error);
        return res.status(500).json({ success: false, message: "Failed to load unread count." });
    }
};

const markRead = async (req, res) => {
    try {
        const notificationId = Number(req.params.id);
        if (!Number.isInteger(notificationId) || notificationId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid notification id." });
        }
        const updated = await platformNotificationService.markRead(req.platformUser.id, notificationId);
        if (!updated) {
            return res.status(404).json({ success: false, message: "Notification not found." });
        }
        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("[platform] markRead failed:", error);
        return res.status(500).json({ success: false, message: "Failed to mark notification read." });
    }
};

const markAllRead = async (req, res) => {
    try {
        const count = await platformNotificationService.markAllRead(req.platformUser.id);
        return res.status(200).json({ success: true, markedCount: count });
    } catch (error) {
        console.error("[platform] markAllRead failed:", error);
        return res.status(500).json({ success: false, message: "Failed to mark all notifications read." });
    }
};

module.exports = { listNotifications, getUnreadCount, markRead, markAllRead };
