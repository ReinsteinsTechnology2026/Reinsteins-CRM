const {

    startWork: startWorkService,

    stopWork: stopWorkService

} = require("../services/taskWorkService");

const {
    createActivity
} = require("../services/taskActivityService");

const { hasProjectPermission } = require("../services/projectPermissionService");

const { getAssignableScope, isWithinScope } = require("../services/organizationService");

const pool = require("../config/db");

// ==========================================
// ASSIGNABLE-SCOPE CHECK
// Identical helper to taskManagementController.js's
// assertAssignable — not shared across controllers
// because none of this codebase's per-controller gate
// helpers are (see passesProjectPermission/
// passesProjectGate below, each defined locally too).
// ==========================================

async function assertAssignable(req, targetUserId) {

    const scope = await getAssignableScope({
        id: req.user.id,
        role: req.userAccess?.role,
        systemAccess: req.userAccess?.systemAccess
    });

    return isWithinScope(scope, targetUserId);

}

// ==========================================
// PROJECT PERMISSION GATE (additive only)
// Same pattern as taskManagementController.js's
// passesProjectPermission — a non-project task
// (project_id NULL) always passes unchanged; a
// project-linked task additionally requires
// TASK_CHANGE_STATUS, matching the Kanban
// status-change gate this work timer feeds into.
//
// Ownership check added to match changeTaskStatus's
// own gate exactly: isOwnTask || assertAssignable(...)
// is required regardless of project_id, so a normal
// project member can only start/stop work on their own
// task (or one within their assignable scope), never a
// teammate's — the same boundary every other mutating
// action in the Task Management module already enforces.
// ==========================================

async function passesProjectGate(req, taskId, permissionKey) {

    const [[task]] = await pool.query(
        `SELECT project_id, assigned_to FROM tasks WHERE id = ? LIMIT 1`,
        [taskId]
    );

    if (!task) {
        return { found: false, allowed: false };
    }

    const isOwnTask = Number(task.assigned_to) === Number(req.user.id);

    const ownershipOk = isOwnTask || await assertAssignable(req, task.assigned_to);

    if (!task.project_id) {
        return { found: true, allowed: ownershipOk };
    }

    const [[userRow]] = await pool.query(
        `SELECT project_access_level FROM users WHERE id = ? LIMIT 1`,
        [req.user.id]
    );

    const permissionOk = await hasProjectPermission(
        { id: req.user.id, accessLevel: userRow?.project_access_level },
        task.project_id,
        permissionKey
    );

    return { found: true, allowed: ownershipOk && permissionOk };

}

// ==========================================
// START WORK
// ==========================================

const startWork = async (req, res) => {

    try {

        const gate = await passesProjectGate(req, req.params.id, "TASK_CHANGE_STATUS");

        if (!gate.found) {
            return res.status(404).json({
                success: false,
                message: "Task not found"
            });
        }

        if (!gate.allowed) {
            return res.status(403).json({
                success: false,
                message: "You do not have permission to work on this task"
            });
        }

        await startWorkService(

            req.params.id

        );

        await createActivity(
            req.params.id,
            req.user.id,
            {
                activityType: "system",
                body: "Started work on this task.",
            },
            [],
            req.app.get("io")
        );

        return res.json({

            success: true,

            message: "Work started"

        });

    }

    catch (error) {

        console.error(error);

        return res.status(500).json({

            success: false,

            message: "Unable to start work"

        });

    }

};

// ==========================================
// STOP WORK
// ==========================================

const stopWork = async (req, res) => {

    try {

        const gate = await passesProjectGate(req, req.params.id, "TASK_CHANGE_STATUS");

        if (!gate.found) {
            return res.status(404).json({
                success: false,
                message: "Task not found"
            });
        }

        if (!gate.allowed) {
            return res.status(403).json({
                success: false,
                message: "You do not have permission to work on this task"
            });
        }

        const {

            work_description,

            progress,

            status

        } = req.body;

        await stopWorkService(

            req.params.id,

            req.user.id,

            work_description,

            progress,

            status

        );

        const clampedProgress = Math.max(0, Math.min(100, Number(progress) || 0));

        await createActivity(
            req.params.id,
            req.user.id,
            {
                activityType: "system",
                body: `Stopped work on this task. Progress updated to ${clampedProgress}%.`,
            },
            [],
            req.app.get("io")
        );

        return res.json({

            success: true,

            message: "Work log saved successfully"

        });

    }

    catch (error) {

        console.error(error);

        return res.status(500).json({

            success: false,

            message: "Unable to save work log"

        });

    }

};

module.exports = {

    startWork,

    stopWork

};