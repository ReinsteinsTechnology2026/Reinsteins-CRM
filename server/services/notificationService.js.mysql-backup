const pool = require("../config/db");
const emailService = require("./emailService");
const { currentUserRoom } = require("../utils/socketRooms");

// ==========================================
// NOTIFICATION SERVICE
//
// The single, shared "create a notification"
// flow, consolidating what used to be five
// duplicated notifyUser/notifySingleUser helpers
// (taskManagementController.js,
// organizationController.js,
// projectMemberController.js, leaveController.js,
// chatController.js) plus the inline version in
// taskActivityService.js's mention handling. Every
// existing call site now goes through this same
// function with IDENTICAL behavior to before --
// same notifications row shape, same Socket.IO
// "notification:new" event shape.
//
// Recipient (userId) is ALWAYS supplied by the
// caller from data it already resolved server-side
// (task.assigned_to, a project member row, the
// authenticated req.user.id, etc.) -- this
// function itself never reads anything from a
// request body, so there is no path by which a
// client can choose who receives a notification.
//
// Email is opt-in per call: pass `email` (an
// { subject, html, text } object, normally built
// via emailTemplates.js) only for the event types
// that are supposed to send one. Omitting it
// preserves a call site's exact pre-existing
// behavior (portal notification only).
// ==========================================

async function createNotification({
    req,
    io: ioOverride,
    userId,
    title,
    message,
    type,
    referenceType = null,
    referenceId = null,
    email = null,
    // Extra fields merged into the emitted Socket.IO payload only
    // (never persisted -- the notifications table has no columns for
    // these). Exists solely so call sites that previously emitted
    // extra data alongside the standard shape (e.g. chatController's
    // senderName/conversationName/preview, read by
    // ChatNotificationListener.jsx) keep doing so unchanged after
    // being consolidated into this shared function.
    extraSocketFields = null,
}) {

    if (!userId) {
        return null;
    }

    const [result] = await pool.query(
        `
        INSERT INTO notifications
        (user_id, title, message, type, is_read, reference_type, reference_id)
        VALUES (?, ?, ?, ?, FALSE, ?, ?)
        `,
        [userId, title, message, type || "general", referenceType || null, referenceId || null]
    );

    const notificationId = result.insertId;

    const io = ioOverride || req?.app?.get("io");

    if (io) {
        io.to(currentUserRoom(userId)).emit("notification:new", {
            id: notificationId,
            title,
            message,
            type: type || "general",
            reference_type: referenceType || null,
            reference_id: referenceId || null,
            is_read: false,
            created_at: new Date().toISOString(),
            ...(extraSocketFields || {}),
        });
    }

    // ======================================
    // EMAIL (best-effort, never throws)
    //
    // Awaited so tests/callers can rely on
    // email_sent_at being set by the time this
    // resolves, but any failure here is fully
    // swallowed -- it can never surface as a
    // rejected promise, and the notification row
    // above has already been committed regardless
    // of what happens next.
    // ======================================

    if (email) {
        await dispatchEmail(notificationId, userId, email);
    }

    return notificationId;

}

async function dispatchEmail(notificationId, userId, email) {

    try {

        const [[user]] = await pool.query(
            `SELECT email FROM users WHERE id = ? LIMIT 1`,
            [userId]
        );

        if (!user?.email) {
            console.log(`[notificationService] Skipped email for notification ${notificationId} — recipient has no email on file.`);
            return;
        }

        const result = await emailService.sendMail({
            to: user.email,
            subject: email.subject,
            html: email.html,
            text: email.text,
        });

        if (result.sent) {
            await pool.query(
                `UPDATE notifications SET email_sent_at = NOW() WHERE id = ?`,
                [notificationId]
            );
        }

    } catch (error) {

        // Never let an email-side failure propagate -- the
        // notification row (and, upstream, the task/leave/chat
        // action that triggered it) is already committed.
        console.error(`[notificationService] Email dispatch failed for notification ${notificationId}:`, error.message);

    }

}

// ==========================================
// GET ACTING USER'S DISPLAY NAME
//
// req.user (the JWT payload) only carries
// {id, employeeId, role} -- no name -- so every
// call site that wants to say "X assigned you a
// task" needs this same one-row lookup. Centralized
// here instead of repeated per controller.
// ==========================================

async function getUserFullName(userId, fallback = "A team member") {

    if (!userId) {
        return fallback;
    }

    const [[row]] = await pool.query(
        `SELECT full_name FROM users WHERE id = ? LIMIT 1`,
        [userId]
    );

    return row?.full_name || fallback;

}

module.exports = {
    createNotification,
    getUserFullName,
};
