const pool = require("../config/db");
const { createNotification } = require("./notificationService");
const { currentUserRoom } = require("../utils/socketRooms");
const { tenantUploadUrlPath } = require("../utils/tenantUploadPath");
const { hasProjectPermission } = require('./projectPermissionService');
const { taskMentionEmail } = require('./emailTemplates');

function hasSelectedMention(body, fullName) {
    const escaped = fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}_@.])@${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(body);
}

// ==========================================
// GET TASK (for access checks + notification text)
// ==========================================

const getTaskById = async (taskId) => {

    const [tasks] = await pool.query(`
        SELECT
            id,
            task_number,
            task_title,
            assigned_to,
            assigned_by,
            progress,
            project_id,
            (SELECT name FROM projects WHERE id = tasks.project_id) AS project_name
        FROM tasks
        WHERE id = ?
        LIMIT 1
    `, [taskId]);

    return tasks[0] || null;

};

// ==========================================
// GET ACTIVITY FEED FOR A TASK
// (comments + work updates + status changes,
// chronological, with attachments + mentions)
// ==========================================

const getActivityForTask = async (taskId) => {

    const [activity] = await pool.query(`
        SELECT
            ta.*,
            author.full_name AS author_name,
            author.role AS author_role
        FROM task_activity ta
        INNER JOIN users author
            ON author.id = ta.author_id
        WHERE
            ta.task_id = ?
            AND ta.is_deleted = FALSE
        ORDER BY ta.created_at ASC, ta.id ASC
    `, [taskId]);

    if (activity.length === 0) {
        return [];
    }

    const activityIds = activity.map((entry) => entry.id);

    const placeholders = activityIds.map(() => "?").join(",");

    const [attachments] = await pool.query(`
        SELECT
            id,
            activity_id,
            original_name,
            file_type,
            file_size,
            file_path
        FROM task_attachments
        WHERE activity_id IN (${placeholders})
        ORDER BY id ASC
    `, activityIds);

    const [mentions] = await pool.query(`
        SELECT
            tm.activity_id,
            tm.mentioned_user_id,
            u.full_name AS mentioned_user_name
        FROM task_mentions tm
        INNER JOIN users u
            ON u.id = tm.mentioned_user_id
        WHERE tm.activity_id IN (${placeholders})
    `, activityIds);

    return activity.map((entry) => ({

        ...entry,

        attachments: attachments.filter(
            (file) => file.activity_id === entry.id
        ),

        mentions: mentions.filter(
            (mention) => mention.activity_id === entry.id
        )

    }));

};

// ==========================================
// MENTIONS -> NOTIFICATIONS + REAL-TIME
// Split in three so the edit path can claim recipients atomically:
//   resolveMentionRecipients  read-only validation (stable user id, exact
//                             @Full Name token, active, can view the task,
//                             never the author, skipUserIds excluded)
//   notifyMentionRecipients   best-effort in-app + email, after the comment
//                             is saved
//   deliverMentions           create path: record, then notify
// ==========================================

const resolveMentionRecipients = async ({
    task, authorId, body, mentionedUserIds, skipUserIds = [],
}) => {

    const uniqueMentionedIds = [
        ...new Set(
            (mentionedUserIds || [])
                .map(Number)
                .filter(
                    (id) =>
                        Number.isInteger(id) &&
                        id > 0 &&
                        id !== Number(authorId) &&
                        !skipUserIds.includes(id)
                )
        )
    ];

    const recipients = [];

    if (uniqueMentionedIds.length === 0 || !body) {
        return { recipients, authorName: null };
    }

    const [authorRows] = await pool.query(`
        SELECT full_name FROM users WHERE id = ? LIMIT 1
    `, [authorId]);

    const authorName = authorRows[0]?.full_name || "Someone";

    for (const mentionedUserId of uniqueMentionedIds) {
        const [[recipient]] = await pool.query(
            `SELECT id, full_name, role, project_access_level, is_system_administrator
             FROM users WHERE id = ? AND status = 'active'
             AND employment_status = 'active' LIMIT 1`, [mentionedUserId]
        );
        if (!recipient || !hasSelectedMention(body, recipient.full_name)) continue;
        if (task.project_id) {
            const canView = await hasProjectPermission({
                id: mentionedUserId,
                accessLevel: recipient.project_access_level,
                isSystemAdministrator: recipient.is_system_administrator === true,
            }, task.project_id, 'TASK_VIEW');
            if (!canView) continue;
        } else if (recipient.role !== 'admin' &&
            Number(mentionedUserId) !== Number(task.assigned_to) &&
            Number(mentionedUserId) !== Number(task.assigned_by)) {
            continue;
        }
        recipients.push({ id: mentionedUserId, role: recipient.role });
    }

    return { recipients, authorName };

};

const notifyMentionRecipients = async ({
    io, taskId, task, authorName, body, recipients,
}) => {

    const notificationMessage =
        `In Task #${task.task_number || task.id} "${task.task_title}": `
        + (body ? body.slice(0, 200) : "");

    for (const recipient of recipients) {
        try {
            await createNotification({
                io,
                userId: recipient.id,
                title: `${authorName} mentioned you`,
                message: notificationMessage,
                type: "task_mention",
                referenceType: "task",
                referenceId: taskId,
                email: taskMentionEmail({
                    authorName, body, taskTitle: task.task_title,
                    taskNumber: task.task_number || task.id,
                    projectName: task.project_name, taskId, recipientRole: recipient.role,
                }),
            });
        } catch (error) {
            // The comment is already saved; never fail it over a notification.
            console.error('[taskActivityService] Mention notification failed:', error.code || error.name);
        }
    }

};

// Post-save and entirely best-effort: the comment is already committed, so
// resolving recipients or recording mentions must never fail the request
// (which would show a 500 and invite a duplicate comment). Logs ids and the
// error code only -- never the comment text.
const deliverMentions = async ({
    io, activityId, taskId, task, authorId, body, mentionedUserIds,
}) => {

    try {

        const { recipients, authorName } = await resolveMentionRecipients({
            task, authorId, body, mentionedUserIds,
        });

        const recorded = [];

        for (const recipient of recipients) {
            try {
                await pool.query(`
                    INSERT INTO task_mentions(
                        activity_id,
                        mentioned_user_id
                    )
                    VALUES(?,?)
                `, [activityId, recipient.id]);
                recorded.push(recipient);
            } catch (error) {
                console.error(
                    `[taskActivityService] Mention not recorded (activity ${activityId}, task ${taskId}):`,
                    error.code || error.name
                );
            }
        }

        await notifyMentionRecipients({ io, taskId, task, authorName, body, recipients: recorded });

    } catch (error) {
        console.error(
            `[taskActivityService] Mention processing failed (activity ${activityId}, task ${taskId}):`,
            error.code || error.name
        );
    }

};

// ==========================================
// CREATE ACTIVITY ENTRY
// (comment / work update), with optional
// attachments + @mentions -> notifications
// ==========================================

const createActivity = async (

    taskId,
    authorId,
    { activityType, body, progress, mentionedUserIds },
    files,
    io

) => {

    const task = await getTaskById(taskId);

    if (!task) {
        return null;
    }

    const [result] = await pool.query(`
        INSERT INTO task_activity(
            task_id,
            author_id,
            activity_type,
            body,
            progress_snapshot
        )
        VALUES(?,?,?,?,?)
        RETURNING id
    `, [

        taskId,
        authorId,
        activityType || "comment",
        body || null,
        (activityType === "work_update" && progress !== undefined && progress !== null)
            ? progress
            : null

    ]);

    const activityId = result[0].id;

    // ======================================
    // KEEP TASK PROGRESS IN SYNC
    // Only work_update entries move the
    // task's actual progress value.
    // ======================================

    if (
        activityType === "work_update" &&
        progress !== undefined &&
        progress !== null
    ) {

        const clampedProgress = Math.max(
            0,
            Math.min(100, Number(progress))
        );

        await pool.query(`
            UPDATE tasks
            SET progress = ?
            WHERE id = ?
        `, [clampedProgress, taskId]);

    }

    // ======================================
    // ATTACHMENTS
    // ======================================

    if (files && files.length > 0) {

        for (const file of files) {

            await pool.query(`
                INSERT INTO task_attachments(
                    activity_id,
                    original_name,
                    stored_name,
                    file_type,
                    file_size,
                    file_path,
                    uploaded_by
                )
                VALUES(?,?,?,?,?,?,?)
            `, [

                activityId,
                file.originalname,
                file.filename,
                file.mimetype,
                file.size,
                tenantUploadUrlPath("tasks", file.filename),
                authorId

            ]);

        }

    }

    // ======================================
    // MENTIONS -> NOTIFICATIONS + REAL-TIME
    // ======================================

    await deliverMentions({
        io, activityId, taskId, task, authorId, body, mentionedUserIds,
    });

    // ======================================
    // LIVE ACTIVITY REFRESH FOR PARTICIPANTS
    // ======================================

    if (io) {

        const participantIds = new Set(
            [task.assigned_to, task.assigned_by]
                .filter((id) => id && Number(id) !== Number(authorId))
        );

        participantIds.forEach((userId) => {
            io.to(currentUserRoom(userId)).emit(
                "task-activity:new",
                { taskId }
            );
        });

    }

    const [savedActivity] = await pool.query(`
        SELECT
            ta.*,
            author.full_name AS author_name,
            author.role AS author_role
        FROM task_activity ta
        INNER JOIN users author
            ON author.id = ta.author_id
        WHERE ta.id = ?
        LIMIT 1
    `, [activityId]);

    return savedActivity[0];

};

// ==========================================
// EDIT ACTIVITY (author only)
// ==========================================

const editActivity = async (activityId, requestingUser, newBody, mentionedUserIds = [], io = null) => {

    // PHASE 1 -- before any transaction: read-only lookups on the pool.
    // Nothing below holds a transaction connection while it needs another
    // one from the same pool (tenant pools are small), so these run first.
    // Candidate recipients are validated here without the "already
    // mentioned" filter; that filter must be applied under the row lock.
    const [preRows] = await pool.query(`
        SELECT id, task_id FROM task_activity
        WHERE id = ?
        AND is_deleted = FALSE
        LIMIT 1
    `, [activityId]);

    if (preRows.length === 0) {
        return { success: false, reason: "not_found" };
    }

    let task = null;
    let candidates = { recipients: [], authorName: null };

    try {
        task = await getTaskById(preRows[0].task_id);
        if (task) {
            candidates = await resolveMentionRecipients({
                task, authorId: requestingUser.id, body: newBody, mentionedUserIds,
            });
        }
    } catch (error) {
        // Optional work: the edit proceeds without mention notifications.
        console.error('[taskActivityService] Edit mention validation failed:', error.code || error.name);
        candidates = { recipients: [], authorName: null };
    }

    // PHASE 2 -- one short transaction on a single connection, using only
    // that connection. The activity row is locked for the whole edit, so a
    // competing edit of the same comment waits, then reads the task_mentions
    // rows this edit recorded and skips them. task_mentions has no unique
    // constraint; this lock -- not a constraint -- provides the guarantee.
    const connection = await pool.getConnection();
    let claimed = null;

    try {

        await connection.beginTransaction();

        const [rows] = await connection.query(`
            SELECT id, task_id, author_id, activity_type
            FROM task_activity
            WHERE id = ?
            AND is_deleted = FALSE
            LIMIT 1
            FOR UPDATE
        `, [activityId]);

        if (rows.length === 0) {
            await connection.rollback();
            return { success: false, reason: "not_found" };
        }

        // Same immutability rule as deleteActivity below -- system/
        // status_change audit entries can never be edited either, by
        // anyone, including their own author (the acting user).
        if (rows[0].activity_type === "system" || rows[0].activity_type === "status_change") {
            await connection.rollback();
            return { success: false, reason: "immutable" };
        }

        if (Number(rows[0].author_id) !== Number(requestingUser.id)) {
            await connection.rollback();
            return { success: false, reason: "forbidden" };
        }

        await connection.query(`
            UPDATE task_activity
            SET
                body = ?,
                is_edited = TRUE
            WHERE id = ?
        `, [newBody, activityId]);

        // Mention recording is optional. A failed statement aborts a
        // PostgreSQL transaction, and COMMIT of an aborted transaction
        // silently rolls everything back -- losing the edit. So the optional
        // work runs inside a SAVEPOINT and is rolled back to it on failure,
        // which makes the transaction usable again.
        if (task && candidates.recipients.length > 0 &&
            String(task.id) === String(rows[0].task_id)) {

            await connection.query('SAVEPOINT edit_mentions');

            try {
                const [existing] = await connection.query(
                    `SELECT mentioned_user_id FROM task_mentions WHERE activity_id = ?`, [activityId]
                );
                const already = new Set(existing.map((row) => Number(row.mentioned_user_id)));
                const fresh = candidates.recipients.filter((r) => !already.has(Number(r.id)));

                for (const recipient of fresh) {
                    await connection.query(
                        `INSERT INTO task_mentions(activity_id, mentioned_user_id) VALUES(?,?)`,
                        [activityId, recipient.id]
                    );
                }

                await connection.query('RELEASE SAVEPOINT edit_mentions');

                if (fresh.length > 0) {
                    claimed = { recipients: fresh, authorName: candidates.authorName };
                }
            } catch (error) {
                console.error('[taskActivityService] Edit mention recording failed; edit kept:',
                    error.code || error.name);
                claimed = null;
                // If this itself fails the transaction is unusable; the error
                // propagates to the outer catch, which rolls back and surfaces
                // a failure instead of reporting a lost edit as success.
                await connection.query('ROLLBACK TO SAVEPOINT edit_mentions');
            }
        }

        await connection.commit();

    } catch (error) {
        try { await connection.rollback(); } catch (_rollbackError) { /* connection already unusable */ }
        throw error;
    } finally {
        connection.release();
    }

    // After commit, with the connection already released: notify exactly the
    // users this edit claimed. Best-effort inside notifyMentionRecipients.
    if (claimed) {
        await notifyMentionRecipients({
            io, taskId: preRows[0].task_id, task,
            authorName: claimed.authorName, body: newBody, recipients: claimed.recipients,
        });
    }

    return { success: true };

};

// ==========================================
// SOFT DELETE ACTIVITY (author or admin)
// ==========================================

const deleteActivity = async (activityId, requestingUser) => {

    const [rows] = await pool.query(`
        SELECT id, author_id, activity_type
        FROM task_activity
        WHERE id = ?
        AND is_deleted = FALSE
        LIMIT 1
    `, [activityId]);

    if (rows.length === 0) {
        return { success: false, reason: "not_found" };
    }

    // System-generated audit entries (task created, status transitions,
    // start/stop work, tag changes, transfer, reassignment, Kanban status
    // moves, etc.) are permanent history and can never be deleted, by
    // anyone -- unlike a comment or a genuine composer-posted work_update,
    // which remain deletable by their author or an admin below.
    if (rows[0].activity_type === "system" || rows[0].activity_type === "status_change") {
        return { success: false, reason: "immutable" };
    }

    const isAuthor = Number(rows[0].author_id) === Number(requestingUser.id);
    const isAdmin = requestingUser.role === "admin";

    if (!isAuthor && !isAdmin) {
        return { success: false, reason: "forbidden" };
    }

    await pool.query(`
        UPDATE task_activity
        SET is_deleted = TRUE
        WHERE id = ?
    `, [activityId]);

    return { success: true };

};

module.exports = {

    deliverMentions,
    hasSelectedMention,
    getTaskById,
    getActivityForTask,
    createActivity,
    editActivity,
    deleteActivity

};
