const pool = require("../config/db");

// ==========================================
// GET MY NOTIFICATIONS
// ==========================================

const getMyNotifications = async (req, res) => {
  try {
    const userId = req.user.id;

    const [notifications] = await pool.query(
      `
      SELECT
        id,
        user_id,
        title,
        message,
        type,
        reference_type,
        reference_id,
        is_read,
        created_at
      FROM notifications
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 100
      `,
      [userId]
    );

    return res.status(200).json({
      success: true,
      count: notifications.length,
      notifications,
    });
  } catch (error) {
    console.error(
      "Get Notifications Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to load notifications",
    });
  }
};

// ==========================================
// GET UNREAD NOTIFICATION COUNT
// ==========================================

const getUnreadCount = async (req, res) => {
  try {
    const userId = req.user.id;

    const [rows] = await pool.query(
      `
      SELECT
        COUNT(*) AS unread_count
      FROM notifications
      WHERE user_id = ?
      AND is_read = FALSE
      `,
      [userId]
    );

    const unreadCount =
      Number(
        rows[0]?.unread_count
      ) || 0;

    return res.status(200).json({
      success: true,
      unreadCount,
    });
  } catch (error) {
    console.error(
      "Get Unread Count Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to load unread notification count",
    });
  }
};

// ==========================================
// MARK ONE NOTIFICATION AS READ
// ==========================================

const markNotificationAsRead = async (
  req,
  res
) => {
  try {
    const userId = req.user.id;
    const notificationId =
      req.params.id;

    const [notifications] =
      await pool.query(
        `
        SELECT
          id
        FROM notifications
        WHERE id = ?
        AND user_id = ?
        LIMIT 1
        `,
        [
          notificationId,
          userId,
        ]
      );

    if (
      notifications.length === 0
    ) {
      return res.status(404).json({
        success: false,
        message:
          "Notification not found",
      });
    }

    await pool.query(
      `
      UPDATE notifications
      SET is_read = TRUE
      WHERE id = ?
      AND user_id = ?
      `,
      [
        notificationId,
        userId,
      ]
    );

    return res.status(200).json({
      success: true,
      message:
        "Notification marked as read",
    });
  } catch (error) {
    console.error(
      "Mark Notification Read Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to update notification",
    });
  }
};

// ==========================================
// MARK ALL NOTIFICATIONS AS READ
// ==========================================

const markAllNotificationsAsRead =
  async (req, res) => {
    try {
      const userId =
        req.user.id;

      const [result] =
        await pool.query(
          `
          UPDATE notifications
          SET is_read = TRUE
          WHERE user_id = ?
          AND is_read = FALSE
          `,
          [userId]
        );

      return res.status(200).json({
        success: true,

        message:
          "All notifications marked as read",

        updatedCount:
          result.affectedRows,
      });
    } catch (error) {
      console.error(
        "Mark All Notifications Read Error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Unable to update notifications",
      });
    }
  };

// ==========================================
// DELETE ONE NOTIFICATION
// ==========================================

const deleteNotification = async (
  req,
  res
) => {
  try {
    const userId = req.user.id;
    const notificationId =
      req.params.id;

    const [result] =
      await pool.query(
        `
        DELETE FROM notifications
        WHERE id = ?
        AND user_id = ?
        `,
        [
          notificationId,
          userId,
        ]
      );

    if (
      result.affectedRows === 0
    ) {
      return res.status(404).json({
        success: false,
        message:
          "Notification not found",
      });
    }

    return res.status(200).json({
      success: true,
      message:
        "Notification deleted successfully",
    });
  } catch (error) {
    console.error(
      "Delete Notification Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to delete notification",
    });
  }
};

// ==========================================
// EXPORT CONTROLLERS
// ==========================================

module.exports = {
  getMyNotifications,
  getUnreadCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
};