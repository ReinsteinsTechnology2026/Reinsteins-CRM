const pool = require("../config/db");
const { isOutboxAvailable, reportOutboxMissing } = require("./notificationEmailOutbox");
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
// Email is opt-in. An email request is persisted in the same tenant
// transaction as its in-app notification, then sent by the worker.
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

    // Without the outbox table the in-app notification must still be created;
    // the email is dropped and the problem is reported, never reported as sent.
    let queueEmail = Boolean(email);
    if (queueEmail && !await isOutboxAvailable()) {
        reportOutboxMissing();
        queueEmail = false;
    }
    const connection = queueEmail ? await pool.getConnection() : null;
    let result;
    try {
        if (connection) await connection.beginTransaction();
        [result] = await (connection || pool).query(
            `INSERT INTO notifications
             (user_id, title, message, type, is_read, reference_type, reference_id)
             VALUES (?, ?, ?, ?, FALSE, ?, ?) RETURNING id`,
            [userId, title, message, type || "general", referenceType || null, referenceId || null]
        );
        if (queueEmail) {
            await connection.query(
                `INSERT INTO notification_email_outbox
                 (notification_id, user_id, subject, html, plain_text)
                 VALUES (?, ?, ?, ?, ?)`,
                [result[0].id, userId, email.subject, email.html, email.text]
            );
            await connection.commit();
        }
    } catch (error) {
        if (connection) await connection.rollback();
        throw error;
    } finally {
        if (connection) connection.release();
    }

    const notificationId = result[0].id;

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

    return notificationId;

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

// Role of a recipient from the tenant database (never from the client),
// used to pick the /admin or /employee link. Falls back to employee.
async function getUserRole(userId) {
    try {
        const [[row]] = await pool.query(`SELECT role FROM users WHERE id = ? LIMIT 1`, [userId]);
        return row?.role || 'employee';
    } catch (_error) {
        return 'employee';
    }
}

// Runs a notification step AFTER the business operation has committed.
// A failure is logged (code only) and swallowed so the caller can still
// report the saved operation as successful instead of a misleading 500.
async function notifyBestEffort(step) {
    try {
        return await step();
    } catch (error) {
        console.error('[notificationService] Post-commit notification failed:', error.code || error.name);
        return null;
    }
}

async function notifyTaskAssignmentUnsafe(req, taskId, assigneeId, actorId, reassigned = false) {
    if (!assigneeId || Number(assigneeId) === Number(actorId)) return null;
    const { getTaskDetailById } = require('./taskService');
    const { taskAssignedEmail, taskReassignedEmail } = require('./emailTemplates');
    const task = await getTaskDetailById(taskId);
    if (!task || Number(task.assigned_to) !== Number(assigneeId)) return null;
    const actorName = await getUserFullName(actorId);
    const recipientName = await getUserFullName(assigneeId, '');
    const [[recipient]] = await pool.query(
        `SELECT role, status, employment_status FROM users WHERE id = ? LIMIT 1`, [assigneeId]
    );
    if (!recipient || recipient.status !== 'active' || recipient.employment_status !== 'active') return null;
    const data = {
        taskTitle: task.task_title, taskNumber: task.task_number || task.id,
        projectName: task.project_name, userStoryTitle: task.user_story_title,
        featureTitle: task.feature_title, epicTitle: task.epic_title,
        status: task.status, priority: task.priority, dueDate: task.due_date,
        actorName, recipientName, recipientRole: recipient.role, taskId: task.id,
    };
    return createNotification({
        req, userId: assigneeId,
        title: reassigned ? 'Task reassigned to you' : 'Task assigned to you',
        message: `"${task.task_title}" has been ${reassigned ? 'reassigned' : 'assigned'} to you.`,
        type: reassigned ? 'task_reassigned' : 'task_assigned',
        referenceType: 'task', referenceId: task.id,
        email: reassigned ? taskReassignedEmail(data) : taskAssignedEmail(data),
    });
}

// The assignment itself is already committed when this runs, so a
// notification/outbox failure must never turn the request into a 500
// (which would invite a client retry and a duplicate task).
async function notifyTaskAssignment(...args) {
    try {
        return await notifyTaskAssignmentUnsafe(...args);
    } catch (error) {
        console.error('[notificationService] Assignment notification failed:', error.code || error.name);
        return null;
    }
}

module.exports = {
    createNotification,
    getUserFullName,
    notifyTaskAssignment,
    notifyBestEffort,
    getUserRole,
};
