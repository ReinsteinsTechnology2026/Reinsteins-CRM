const express = require("express");

const {
  getMyNotifications,
  getUnreadCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
} = require(
  "../controllers/notificationController"
);

const {
  protect,
} = require(
  "../middleware/authMiddleware"
);

const router =
  express.Router();

// ==========================================
// GET MY NOTIFICATIONS
// GET /api/notifications
// ==========================================

router.get(
  "/",
  protect,
  getMyNotifications
);

// ==========================================
// GET UNREAD COUNT
// GET /api/notifications/unread-count
// IMPORTANT:
// Must be before /:id routes
// ==========================================

router.get(
  "/unread-count",
  protect,
  getUnreadCount
);

// ==========================================
// MARK ALL AS READ
// PUT /api/notifications/read-all
// IMPORTANT:
// Must be before /:id routes
// ==========================================

router.put(
  "/read-all",
  protect,
  markAllNotificationsAsRead
);

// ==========================================
// MARK ONE NOTIFICATION AS READ
// PUT /api/notifications/:id/read
// ==========================================

router.put(
  "/:id/read",
  protect,
  markNotificationAsRead
);

// ==========================================
// DELETE ONE NOTIFICATION
// DELETE /api/notifications/:id
// ==========================================

router.delete(
  "/:id",
  protect,
  deleteNotification
);

// ==========================================
// EXPORT ROUTER
// ==========================================

module.exports =
  router;