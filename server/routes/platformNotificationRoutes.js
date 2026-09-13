const express = require("express");

const router = express.Router();

const { listNotifications, getUnreadCount, markRead, markAllRead } = require("../controllers/platformNotificationController");
const { platformProtect } = require("../middleware/platformAuthMiddleware");

// ==========================================
// PLATFORM NOTIFICATION ROUTES (Phase 12N)
// Mounted at /api/platform/notifications in app.js.
//
// Route order: /unread-count and /read-all must be registered before
// /:id/read, same convention used throughout this codebase's platform
// routes (avoids "unread-count" being matched as an :id).
// ==========================================

router.get("/", platformProtect, listNotifications);
router.get("/unread-count", platformProtect, getUnreadCount);
router.patch("/read-all", platformProtect, markAllRead);
router.patch("/:id/read", platformProtect, markRead);

module.exports = router;
