const pool = require("../config/db");
const { createNotification } = require("./notificationService");
const { currentUserRoom } = require("../utils/socketRooms");
const { tenantUploadUrlPath } = require("../utils/tenantUploadPath");

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
            project_id
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

    const uniqueMentionedIds = [
        ...new Set(
            (mentionedUserIds || [])
                .map(Number)
                .filter(
                    (id) =>
                        Number.isInteger(id) &&
                        id > 0 &&
                        id !== Number(authorId)
                )
        )
    ];

    if (uniqueMentionedIds.length > 0) {

        const [authorRows] = await pool.query(`
            SELECT full_name FROM users WHERE id = ? LIMIT 1
        `, [authorId]);

        const authorName = authorRows[0]?.full_name || "Someone";

        const notificationTitle = `${authorName} mentioned you`;

        const notificationMessage =
            `In Task #${task.task_number || task.id} "${task.task_title}": `
            + (body ? body.slice(0, 200) : "");

        for (const mentionedUserId of uniqueMentionedIds) {

            await pool.query(`
                INSERT INTO task_mentions(
                    activity_id,
                    mentioned_user_id
                )
                VALUES(?,?)
            `, [activityId, mentionedUserId]);

            await createNotification({
                io,
                userId: mentionedUserId,
                title: notificationTitle,
                message: notificationMessage,
                type: "task_mention",
                referenceType: "task",
                referenceId: taskId,
            });

        }

    }

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

const editActivity = async (activityId, requestingUser, newBody) => {

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

    // Same immutability rule as deleteActivity below -- system/
    // status_change audit entries can never be edited either, by
    // anyone, including their own author (the acting user).
    if (rows[0].activity_type === "system" || rows[0].activity_type === "status_change") {
        return { success: false, reason: "immutable" };
    }

    if (Number(rows[0].author_id) !== Number(requestingUser.id)) {
        return { success: false, reason: "forbidden" };
    }

    await pool.query(`
        UPDATE task_activity
        SET
            body = ?,
            is_edited = TRUE
        WHERE id = ?
    `, [newBody, activityId]);

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

    getTaskById,
    getActivityForTask,
    createActivity,
    editActivity,
    deleteActivity

};
