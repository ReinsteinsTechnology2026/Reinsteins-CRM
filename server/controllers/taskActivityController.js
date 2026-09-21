const {
    getTaskById,
    getActivityForTask,
    createActivity: createActivityService,
    editActivity: editActivityService,
    deleteActivity: deleteActivityService
} = require("../services/taskActivityService");

const { hasProjectPermission } = require("../services/projectPermissionService");

const pool = require("../config/db");

// ==========================================
// ACCESS CHECK
//
// Project-linked task (task.project_id set): access is decided
// ENTIRELY by project membership + TASK_VIEW — admin role grants
// nothing here, same "no project membership = no project access"
// rule enforced throughout the Project module.
//
// Non-project task: unchanged legacy rule — admin can access any
// task's activity; employees only if assigned to or the assigner
// of the task.
// ==========================================

const canAccessTask = async (req, task) => {

    if (task.project_id) {

        const [[row]] = await pool.query(
            `SELECT project_access_level, is_system_administrator FROM users WHERE id = ? LIMIT 1`,
            [req.user.id]
        );

        return hasProjectPermission(
            { id: req.user.id, accessLevel: row?.project_access_level, isSystemAdministrator: row?.is_system_administrator === true },
            task.project_id,
            "TASK_VIEW"
        );

    }

    if (req.user.role === "admin") {
        return true;
    }

    return (
        Number(task.assigned_to) === Number(req.user.id) ||
        Number(task.assigned_by) === Number(req.user.id)
    );

};

// ==========================================
// ACTIVITY -> TASK -> PROJECT RESOLVER
// Used by the edit/delete-single-activity routes,
// which only ever receive an activityId (not a
// taskId) — resolves back to the parent task's
// project_id so the same membership + TASK_VIEW
// gate applies there too. Non-project tasks pass
// through unaffected.
// ==========================================

const passesActivityProjectGate = async (req, activityId) => {

    const [[row]] = await pool.query(
        `
        SELECT t.project_id
        FROM task_activity ta
        INNER JOIN tasks t ON t.id = ta.task_id
        WHERE ta.id = ?
        LIMIT 1
        `,
        [activityId]
    );

    if (!row) {
        return true; // let the service's own not_found handling report this
    }

    if (!row.project_id) {
        return true;
    }

    const [[userRow]] = await pool.query(
        `SELECT project_access_level, is_system_administrator FROM users WHERE id = ? LIMIT 1`,
        [req.user.id]
    );

    return hasProjectPermission(
        { id: req.user.id, accessLevel: userRow?.project_access_level, isSystemAdministrator: userRow?.is_system_administrator === true },
        row.project_id,
        "TASK_VIEW"
    );

};

// ==========================================
// PARSE mentionedUserIds
// Arrives as a JSON string over multipart
// form data, or a plain array over JSON.
// ==========================================

const parseMentionedUserIds = (raw) => {

    if (Array.isArray(raw)) {
        return raw;
    }

    if (typeof raw === "string" && raw.trim()) {

        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return raw.split(",").map((id) => id.trim());
        }

    }

    return [];

};

// ==========================================
// GET ACTIVITY FOR A TASK
// ==========================================

const getActivity = async (req, res) => {

    try {

        const task = await getTaskById(req.params.taskId);

        if (!task) {
            return res.status(404).json({
                success: false,
                message: "Task not found"
            });
        }

        if (!await canAccessTask(req, task)) {
            return res.status(403).json({
                success: false,
                message: "You do not have access to this task"
            });
        }

        const activity = await getActivityForTask(req.params.taskId);

        return res.json({
            success: true,
            activity
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch task activity"
        });

    }

};

// ==========================================
// CREATE ACTIVITY ENTRY
// ==========================================

const createActivity = async (req, res) => {

    try {

        const task = await getTaskById(req.params.taskId);

        if (!task) {
            return res.status(404).json({
                success: false,
                message: "Task not found"
            });
        }

        if (!await canAccessTask(req, task)) {
            return res.status(403).json({
                success: false,
                message: "You do not have access to this task"
            });
        }

        const {
            activityType,
            body,
            progress
        } = req.body;

        if (!body?.trim() && (!req.files || req.files.length === 0)) {
            return res.status(400).json({
                success: false,
                message: "Enter a comment or attach a file"
            });
        }

        const io = req.app.get("io");

        const activity = await createActivityService(
            req.params.taskId,
            req.user.id,
            {
                activityType: activityType || "comment",
                body: body?.trim() || null,
                progress: progress !== undefined ? Number(progress) : undefined,
                mentionedUserIds: parseMentionedUserIds(req.body.mentionedUserIds)
            },
            req.files,
            io
        );

        return res.status(201).json({
            success: true,
            message: "Update posted successfully",
            activity
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to post update"
        });

    }

};

// ==========================================
// EDIT ACTIVITY (author only)
// ==========================================

const updateActivity = async (req, res) => {

    try {

        const { body } = req.body;

        if (!body?.trim()) {
            return res.status(400).json({
                success: false,
                message: "Comment cannot be empty"
            });
        }

        if (!await passesActivityProjectGate(req, req.params.activityId)) {
            return res.status(403).json({
                success: false,
                message: "You do not have access to this task"
            });
        }

        const result = await editActivityService(
            req.params.activityId,
            req.user,
            body.trim()
        );

        if (!result.success) {

            if (result.reason === "not_found") {
                return res.status(404).json({
                    success: false,
                    message: "Update not found"
                });
            }

            if (result.reason === "immutable") {
                return res.status(403).json({
                    success: false,
                    message: "System-generated activity entries cannot be edited"
                });
            }

            return res.status(403).json({
                success: false,
                message: "You can only edit your own comments"
            });

        }

        return res.json({
            success: true,
            message: "Update edited successfully"
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to edit update"
        });

    }

};

// ==========================================
// DELETE ACTIVITY (author or admin)
// ==========================================

const deleteActivity = async (req, res) => {

    try {

        if (!await passesActivityProjectGate(req, req.params.activityId)) {
            return res.status(403).json({
                success: false,
                message: "You do not have access to this task"
            });
        }

        const result = await deleteActivityService(
            req.params.activityId,
            req.user
        );

        if (!result.success) {

            if (result.reason === "not_found") {
                return res.status(404).json({
                    success: false,
                    message: "Update not found"
                });
            }

            if (result.reason === "immutable") {
                return res.status(403).json({
                    success: false,
                    message: "System-generated activity entries cannot be deleted"
                });
            }

            return res.status(403).json({
                success: false,
                message: "You do not have permission to delete this update"
            });

        }

        return res.json({
            success: true,
            message: "Update deleted successfully"
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to delete update"
        });

    }

};

module.exports = {

    getActivity,
    createActivity,
    updateActivity,
    deleteActivity

};
