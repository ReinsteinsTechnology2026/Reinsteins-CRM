const {
    getActiveEmployees,
    getTransferTargets: getTransferTargetsService,
    getProjectMemberEmployees,
    getAllTasks,
    getTaskDetailById,
    getTaskProjectIdRaw,
    createTask: createTaskService,
    createProjectLinkedTask,
    updateTask: updateTaskService,
    updateTaskStatus: updateTaskStatusService,
    assignTaskToSprint: assignTaskToSprintService,
    deleteTask: hardDeleteLegacyTask,
    transferTask: transferTaskService,
    assignTask: assignTaskService,
    approveAndCloseTask: approveAndCloseTaskService,
    sendBackTask: sendBackTaskService
} = require("../services/taskService");

const {
    softDeleteTask,
    restoreTask: restoreTaskService,
    permanentlyDeleteTask,
    NOT_SOFT_DELETED_ERROR
} = require("../services/workItemDeletionService");

const {
    getAssignableScope,
    isWithinScope
} = require("../services/organizationService");

const {
    createActivity
} = require("../services/taskActivityService");

const {
    normalizeTagNames
} = require("../services/tagService");

const {
    getSprintProjectId
} = require("../services/sprintService");

const {
    hasProjectPermission,
    canUserAccessProject,
    isEligibleProjectAssignee
} = require("../services/projectPermissionService");

const { createNotification, getUserFullName } = require("../services/notificationService");

const {
    taskAssignedEmail,
    taskReassignedEmail,
    taskTransferredEmail,
    taskSubmittedForReviewEmail,
    taskApprovedEmail,
    taskSentBackEmail,
    taskSprintChangedEmail,
} = require("../services/emailTemplates");

const pool = require("../config/db");

// ==========================================
// PROJECT PERMISSION GATE (additive only)
//
// Most tasks in this codebase are NOT linked to a
// project (task.project_id is NULL — the original
// "Task Management" flow predates the Project
// module entirely) — for those, this always passes
// unchanged, preserving 100% of existing behavior.
//
// For a task that DOES belong to a project, this
// adds an extra AND-condition on top of the
// existing assignment/transfer rules below — it can
// only make an action MORE restrictive (e.g. a
// Reader who happens to be a task's assignee is
// still blocked), never less. This is what lets
// Contributors/Readers/Stakeholders be enforced on
// the Board without touching the existing
// non-project task authorization at all.
// ==========================================

async function passesProjectPermission(req, task, permissionKey) {

    if (!task.project_id) {
        return true;
    }

    // This controller's routes use the generic requireActiveUser
    // middleware, which doesn't carry project_access_level — read it
    // fresh here rather than widening the widely-shared requireAccess
    // middleware just for this one project-specific check.
    const [[row]] = await pool.query(
        `SELECT project_access_level FROM users WHERE id = ? LIMIT 1`,
        [req.user.id]
    );

    return hasProjectPermission(
        { id: req.user.id, accessLevel: row?.project_access_level },
        task.project_id,
        permissionKey
    );

}

// ==========================================
// TASK ASSIGNMENT AUTHORIZATION
//
// Fixes the pre-existing gap where this
// endpoint had no scoping at all — any
// authenticated user could previously assign a
// task to any other user. req.userAccess is
// populated by the requireActiveUser middleware
// this router now runs behind (see
// taskManagementRoutes.js) — it re-reads
// role/system_access fresh from the database, so
// a demoted user's assignment scope shrinks
// immediately rather than waiting for their JWT
// to expire.
// ==========================================

async function assertAssignable(req, targetUserId) {

    const scope = await getAssignableScope({
        id: req.user.id,
        role: req.userAccess?.role,
        systemAccess: req.userAccess?.systemAccess
    });

    return isWithinScope(scope, targetUserId);

}

// ========================================
// GET ALL EMPLOYEES
// ========================================

const getEmployees = async (req, res) => {

    try {

        // Project-scoped request (Add Task / Edit Task for a
        // project-linked task): eligible assignees are EXPLICIT
        // members of THAT project only -- never the org-wide
        // reporting-hierarchy scope below, which has no concept of
        // project membership. Caller must themselves be a member of
        // the project to see its member list.
        if (req.query.project_id) {

            const projectId = Number(req.query.project_id);

            if (!Number.isInteger(projectId) || projectId <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid project"
                });
            }

            const callerIsMember = await canUserAccessProject({ id: req.user.id }, projectId);

            if (!callerIsMember) {
                return res.status(403).json({
                    success: false,
                    message: "You are not a member of this project"
                });
            }

            const employees = await getProjectMemberEmployees(projectId);

            return res.json({ success: true, employees });

        }

        const allEmployees = await getActiveEmployees();

        const scope = await getAssignableScope({
            id: req.user.id,
            role: req.userAccess?.role,
            systemAccess: req.userAccess?.systemAccess
        });

        // Only ever show employees this caller is actually allowed
        // to assign a task to — the frontend's "assign to" picker
        // must not offer people outside the backend-authorized scope.

        const employees = scope.type === "all"
            ? allEmployees
            : allEmployees.filter((employee) => isWithinScope(scope, employee.id));

        return res.json({
            success: true,
            employees
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch employees"
        });

    }

};

// ========================================
// GET TRANSFER TARGETS
// Unscoped list of every active Employee/Intern,
// used only by the Transfer modal — task CREATION
// assignment above stays scope-limited, unchanged.
// ========================================

const getTransferTargets = async (req, res) => {

    try {

        const employees = await getTransferTargetsService();

        return res.json({
            success: true,
            employees
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch transfer targets"
        });

    }

};

// ========================================
// GET ALL TASKS
// ========================================

const getTasks = async (req, res) => {

    try {

        const tasks = await getAllTasks(req.user);

        return res.json({

            success: true,

            tasks,

            role: req.user.role,

            userId: req.user.id

        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({

            success: false,

            message: "Unable to fetch tasks"

        });

    }

};

// ========================================
// GET ONE TASK (Task Workspace)
// ========================================

const getTaskById = async (req, res) => {

    try {

        const task = await getTaskDetailById(req.params.id);

        if (!task) {
            return res.status(404).json({
                success: false,
                message: "Task not found"
            });
        }

        // Project-linked task: membership + TASK_VIEW decide access on
        // their own — role/admin status grants nothing here (same rule
        // as everywhere else in the Project module). Non-project tasks
        // keep the original assignee/assigner/admin rule, unchanged.

        if (task.project_id) {

            if (!await passesProjectPermission(req, task, "TASK_VIEW")) {
                return res.status(403).json({
                    success: false,
                    message: "You do not have access to this task"
                });
            }

        } else {

            const isAdmin = req.user.role === "admin";

            const isParticipant =
                Number(task.assigned_to) === Number(req.user.id) ||
                Number(task.assigned_by) === Number(req.user.id);

            if (!isAdmin && !isParticipant) {
                return res.status(403).json({
                    success: false,
                    message: "You do not have access to this task"
                });
            }

        }

        return res.json({
            success: true,
            task
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch task"
        });

    }

};

// ========================================
// CREATE TASK
// ========================================

const createTask = async (req, res) => {

    try {

        const assignedTo = Number(req.body.assigned_to);

        const allowed = await assertAssignable(req, assignedTo);

        if (!allowed) {
            return res.status(403).json({
                success: false,
                message: "You are not authorized to assign a task to this person"
            });
        }

        await createTaskService({

            ...req.body,

            assigned_by: req.user.id

        });

        return res.json({

            success: true,

            message: "Task created successfully"

        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({

            success: false,

            message: "Unable to create task"

        });

    }

};

// ========================================
// UPDATE TASK
// ========================================

const updateTask = async (req, res) => {

    try {

        const task = await getTaskDetailById(req.params.id);

        if (!task) {
            return res.status(404).json({
                success: false,
                message: "Task not found"
            });
        }

        // Same branch as getTaskById above: project-linked task ->
        // membership + TASK_EDIT decide access on their own. Non-
        // project task -> admin or assignee/assigner, the same
        // ownership rule getTaskById/changeTaskStatus/transferTask
        // already enforce for legacy tasks (P0 fix: this branch was
        // previously missing here, so passesProjectPermission's
        // unconditional `true` for project_id === null let ANY active
        // employee edit ANY other employee's legacy task).

        if (task.project_id) {

            if (!await passesProjectPermission(req, task, "TASK_EDIT")) {
                return res.status(403).json({
                    success: false,
                    message: "You do not have permission to edit this task"
                });
            }

        } else {

            const isAdmin = req.user.role === "admin";

            const isParticipant =
                Number(task.assigned_to) === Number(req.user.id) ||
                Number(task.assigned_by) === Number(req.user.id);

            if (!isAdmin && !isParticipant) {
                return res.status(403).json({
                    success: false,
                    message: "You do not have permission to edit this task"
                });
            }

        }

        // Project-linked task whose assigned_to is being changed to a
        // new value: the new assignee must be an active, EXPLICIT
        // member of the task's own project -- same rule the dedicated
        // assignTask endpoint already enforces, applied here since
        // this generic Edit-form save is the other path that can
        // change assigned_to (P0 fix: previously unvalidated).
        if (
            task.project_id &&
            req.body.assigned_to !== undefined &&
            req.body.assigned_to !== null &&
            req.body.assigned_to !== "" &&
            Number(req.body.assigned_to) !== Number(task.assigned_to)
        ) {

            const eligible = await isEligibleProjectAssignee(
                Number(req.body.assigned_to),
                task.project_id
            );

            if (!eligible) {
                return res.status(400).json({
                    success: false,
                    message: "Selected user must be an active member of this project"
                });
            }

        }

        await updateTaskService(

            req.params.id,

            req.body

        );

        // ==========================================
        // ACTIVITY LOGGING (post-success only)
        // Diffs req.body against the task row already
        // fetched above (pre-update) to log only what
        // actually changed. Status and tags get their
        // own dedicated entries; every other changed
        // field is bundled into one "Updated this task"
        // entry, matching how one Edit-form save is one
        // user action.
        // ==========================================

        const io = req.app.get("io");

        const fieldChanges = [];

        if (
            req.body.title !== undefined &&
            req.body.title !== task.task_title
        ) {
            fieldChanges.push(`Title: "${task.task_title}" → "${req.body.title}"`);
        }

        if (
            req.body.description !== undefined &&
            req.body.description !== task.task_description
        ) {
            fieldChanges.push("Description updated");
        }

        if (
            req.body.priority !== undefined &&
            req.body.priority !== task.priority
        ) {
            fieldChanges.push(`Priority: ${task.priority} → ${req.body.priority}`);
        }

        const oldDueDate = task.due_date
            ? new Date(task.due_date).toISOString().slice(0, 10)
            : null;

        const newDueDate = req.body.due_date
            ? String(req.body.due_date).slice(0, 10)
            : null;

        if (req.body.due_date !== undefined && oldDueDate !== newDueDate) {
            fieldChanges.push(`Due date: ${oldDueDate || "None"} → ${newDueDate || "None"}`);
        }

        if (
            req.body.assigned_to !== undefined &&
            Number(req.body.assigned_to) !== Number(task.assigned_to)
        ) {

            const [[newAssignee]] = await pool.query(
                `SELECT full_name FROM users WHERE id = ? LIMIT 1`,
                [Number(req.body.assigned_to)]
            );

            fieldChanges.push(
                `Assigned to: ${task.assigned_to_name || "Unassigned"} → ${newAssignee?.full_name || "Unassigned"}`
            );

            // Same assign/reassign notification as the dedicated
            // assignTask endpoint below -- this Edit-form save is a
            // third path that can change assigned_to, and previously
            // sent no notification at all for that change.
            if (Number(req.body.assigned_to) !== Number(req.user.id)) {

                const isReassignmentViaEdit = Boolean(task.assigned_to);

                const editActorName = await getUserFullName(req.user.id);

                const editAssignEmailData = {
                    taskTitle: task.task_title,
                    taskNumber: task.task_number || task.id,
                    projectName: task.project_name,
                    actorName: editActorName,
                    taskId: task.id,
                };

                await createNotification({
                    req,
                    userId: Number(req.body.assigned_to),
                    title: isReassignmentViaEdit ? "Task reassigned to you" : "Task assigned to you",
                    message: `"${task.task_title}" has been ${isReassignmentViaEdit ? "reassigned" : "assigned"} to you.`,
                    type: isReassignmentViaEdit ? "task_reassigned" : "task_assigned",
                    referenceType: "task",
                    referenceId: task.id,
                    email: isReassignmentViaEdit
                        ? taskReassignedEmail(editAssignEmailData)
                        : taskAssignedEmail(editAssignEmailData),
                });

            }

        }

        if (fieldChanges.length > 0) {

            await createActivity(
                req.params.id,
                req.user.id,
                {
                    activityType: "system",
                    body: `Updated this task.\n${fieldChanges.map((line) => `• ${line}`).join("\n")}`,
                },
                [],
                io
            );

        }

        if (req.body.status !== undefined && req.body.status !== task.status) {

            const statusBody = req.body.status === "pending_review"
                ? "Submitted this task for review."
                : `Status changed from ${task.status} to ${req.body.status}.`;

            await createActivity(
                req.params.id,
                req.user.id,
                {
                    activityType: "status_change",
                    body: statusBody,
                },
                [],
                io
            );

            // "Submit for review" notifies the person who assigned
            // this task (the natural reviewer for the simple/legacy
            // case) -- skipped when that happens to be the same
            // person submitting (a self-assigned task), so nobody
            // gets notified of their own action.
            if (
                req.body.status === "pending_review" &&
                task.assigned_by &&
                Number(task.assigned_by) !== Number(req.user.id)
            ) {

                const submitterName = await getUserFullName(req.user.id);

                await createNotification({
                    req,
                    userId: task.assigned_by,
                    title: "Task submitted for review",
                    message: `"${task.task_title}" was submitted for your review.`,
                    type: "task_submitted_for_review",
                    referenceType: "task",
                    referenceId: task.id,
                    email: taskSubmittedForReviewEmail({
                        taskTitle: task.task_title,
                        taskNumber: task.task_number || task.id,
                        projectName: task.project_name,
                        actorName: submitterName,
                        taskId: task.id,
                    }),
                });

            }

        }

        if (req.body.tagNames !== undefined) {

            const oldNames = (task.taskTags || []).map((tag) => tag.name);
            const newNames = normalizeTagNames(req.body.tagNames);

            const oldSet = new Set(oldNames.map((name) => name.toLowerCase()));
            const newSet = new Set(newNames.map((name) => name.toLowerCase()));

            const added = newNames.filter((name) => !oldSet.has(name.toLowerCase()));
            const removed = oldNames.filter((name) => !newSet.has(name.toLowerCase()));

            if (added.length > 0 || removed.length > 0) {

                const tagLines = [];

                if (added.length > 0) {
                    tagLines.push(`Added tag${added.length > 1 ? "s" : ""}: ${added.join(", ")}`);
                }

                if (removed.length > 0) {
                    tagLines.push(`Removed tag${removed.length > 1 ? "s" : ""}: ${removed.join(", ")}`);
                }

                await createActivity(
                    req.params.id,
                    req.user.id,
                    {
                        activityType: "system",
                        body: tagLines.join("\n"),
                    },
                    [],
                    io
                );

            }

        }

        return res.json({

            success: true,

            message: "Task updated successfully"

        });

    } catch (error) {

        console.error(error);

        if (error.name === "TagValidationError") {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        return res.status(500).json({

            success: false,

            message: "Unable to update task"

        });

    }

};

// ========================================
// UPDATE TASK STATUS ONLY (Kanban move)
// Deliberately separate from the generic
// updateTask above, which does a full-field
// UPDATE and would corrupt title/description/
// assignee if called with a partial payload.
// Allowed for the task's current assignee (moving
// their own work) or anyone whose assignable scope
// already reaches that assignee.
// ========================================

const changeTaskStatus = async (req, res) => {

    try {

        const { status } = req.body;

        const task = await getTaskDetailById(req.params.id);

        if (!task) {
            return res.status(404).json({
                success: false,
                message: "Task not found"
            });
        }

        const isOwnTask = Number(task.assigned_to) === Number(req.user.id);

        const allowed =
            (isOwnTask || await assertAssignable(req, task.assigned_to)) &&
            await passesProjectPermission(req, task, "TASK_CHANGE_STATUS");

        if (!allowed) {
            return res.status(403).json({
                success: false,
                message: "You are not authorized to update this task's status"
            });
        }

        await updateTaskStatusService(req.params.id, status);

        await createActivity(
            req.params.id,
            req.user.id,
            {
                activityType: "status_change",
                body: `Status changed from ${task.status} to ${status}.`,
            },
            [],
            req.app.get("io")
        );

        return res.json({
            success: true,
            message: "Task status updated successfully"
        });

    } catch (error) {

        console.error(error);

        return res.status(400).json({
            success: false,
            message: error.message === "Invalid task status"
                ? "Invalid task status"
                : "Unable to update task status"
        });

    }

};

// ========================================
// ASSIGN TASK TO SPRINT (or back to Backlog)
// Deliberately separate from generic updateTask,
// same reasoning as changeTaskStatus — a partial,
// single-field mutation driven by Sprint planning
// UI / a "Move to Sprint" control, not a full-form
// edit.
//
// Gated by TASK_EDIT with NO ownership requirement
// (unlike changeTaskStatus) — Sprint planning is
// normally done by whoever runs planning, not by
// each task's individual assignee, matching how the
// generic updateTask field-diff already lets any
// TASK_EDIT holder touch any task in the project.
//
// Only ever available for project-linked tasks —
// Sprints don't exist for the legacy non-project
// task flow. sprint_id === null clears the task back
// to the Backlog.
// ========================================

const assignTaskToSprint = async (req, res) => {

    try {

        const { sprint_id } = req.body;

        const task = await getTaskDetailById(req.params.id);

        if (!task) {
            return res.status(404).json({
                success: false,
                message: "Task not found"
            });
        }

        if (!task.project_id) {
            return res.status(400).json({
                success: false,
                message: "Sprints are only available for project-linked tasks"
            });
        }

        if (!await passesProjectPermission(req, task, "TASK_EDIT")) {
            return res.status(403).json({
                success: false,
                message: "You do not have permission to change this task's sprint"
            });
        }

        let targetSprint = null;

        if (sprint_id !== null && sprint_id !== undefined) {

            targetSprint = await getSprintProjectId(sprint_id);

            if (!targetSprint) {
                return res.status(404).json({
                    success: false,
                    message: "Sprint not found"
                });
            }

            if (Number(targetSprint.project_id) !== Number(task.project_id)) {
                return res.status(400).json({
                    success: false,
                    message: "This sprint does not belong to the same project as this task"
                });
            }

        }

        if (Number(task.sprint_id || 0) === Number(sprint_id || 0)) {
            return res.status(400).json({
                success: false,
                message: "Task is already in this sprint"
            });
        }

        await assignTaskToSprintService(req.params.id, sprint_id || null);

        const oldLabel = task.sprint_name || "Backlog";
        const newLabel = targetSprint?.name || "Backlog";

        let body;

        if (!task.sprint_id && targetSprint) {
            body = `Added to sprint: ${newLabel}`;
        } else if (task.sprint_id && !targetSprint) {
            body = `Removed from sprint: ${oldLabel}`;
        } else {
            body = `Moved from sprint ${oldLabel} to ${newLabel}`;
        }

        await createActivity(
            req.params.id,
            req.user.id,
            {
                activityType: "system",
                body,
            },
            [],
            req.app.get("io")
        );

        // Only the task's own assignee is notified (if any, and if
        // they aren't the one making the change themselves).
        if (task.assigned_to && Number(task.assigned_to) !== Number(req.user.id)) {

            const sprintChangeText = body.charAt(0).toLowerCase() + body.slice(1);

            await createNotification({
                req,
                userId: task.assigned_to,
                title: "Sprint assignment updated",
                message: `"${task.task_title}" was ${sprintChangeText}.`,
                type: "task_sprint_changed",
                referenceType: "task",
                referenceId: task.id,
                email: taskSprintChangedEmail({
                    taskTitle: task.task_title,
                    taskNumber: task.task_number || task.id,
                    projectName: task.project_name,
                    sprintChangeText,
                    taskId: task.id,
                }),
            });

        }

        return res.json({
            success: true,
            message: "Task sprint updated successfully"
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to update task's sprint"
        });

    }

};

// ========================================
// DELETE TASK
// ========================================

const deleteTask = async (req, res) => {

    try {

        const task = await getTaskDetailById(req.params.id);

        if (!task) {
            return res.status(404).json({
                success: false,
                message: "Task not found"
            });
        }

        // Same branch as getTaskById/updateTask above (P0 fix — see
        // updateTask's comment for the vulnerability this closes).

        if (task.project_id) {

            if (!await passesProjectPermission(req, task, "TASK_DELETE")) {
                return res.status(403).json({
                    success: false,
                    message: "You do not have permission to delete this task"
                });
            }

        } else {

            const isAdmin = req.user.role === "admin";

            const isParticipant =
                Number(task.assigned_to) === Number(req.user.id) ||
                Number(task.assigned_by) === Number(req.user.id);

            if (!isAdmin && !isParticipant) {
                return res.status(403).json({
                    success: false,
                    message: "You do not have permission to delete this task"
                });
            }

        }

        // Project-linked task: soft delete -- moves to the project's
        // Recycle Bin (restorable). Legacy non-project task: unchanged
        // hard delete -- the Recycle Bin is project-scoped, and this
        // flow predates the Project module entirely, so a soft delete
        // with no restore UI anywhere would be a silent regression.
        if (task.project_id) {
            await softDeleteTask(req.params.id, req.user.id);
        } else {
            await hardDeleteLegacyTask(req.params.id);
        }

        return res.json({

            success: true,

            message: task.project_id ? "Task moved to Recycle Bin" : "Task deleted successfully"

        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({

            success: false,

            message: "Unable to delete task"

        });

    }

};

// ========================================
// RESTORE TASK (from Recycle Bin -- project-linked tasks only)
// ========================================

const restoreTask = async (req, res) => {

    try {

        const task = await getTaskProjectIdRaw(req.params.id);

        if (!task) {
            return res.status(404).json({
                success: false,
                message: "Task not found in Recycle Bin"
            });
        }

        if (!await passesProjectPermission(req, task, "TASK_DELETE")) {
            return res.status(403).json({
                success: false,
                message: "You do not have permission to restore this task"
            });
        }

        const restored = await restoreTaskService(req.params.id);

        if (!restored) {
            return res.status(404).json({
                success: false,
                message: "Task not found in Recycle Bin"
            });
        }

        return res.json({
            success: true,
            message: "Task restored successfully"
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to restore task"
        });

    }

};

// ========================================
// PERMANENTLY DELETE TASK (from Recycle Bin)
// ========================================

const permanentDeleteTask = async (req, res) => {

    try {

        const task = await getTaskProjectIdRaw(req.params.id);

        if (!task) {
            return res.status(404).json({
                success: false,
                message: "Task not found in Recycle Bin"
            });
        }

        if (!await passesProjectPermission(req, task, "TASK_DELETE")) {
            return res.status(403).json({
                success: false,
                message: "You do not have permission to permanently delete this task"
            });
        }

        await permanentlyDeleteTask(req.params.id);

        return res.json({
            success: true,
            message: "Task permanently deleted"
        });

    } catch (error) {

        if (error.name === NOT_SOFT_DELETED_ERROR) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to permanently delete task"
        });

    }

};

// ========================================
// CREATE TASK DIRECTLY UNDER A PROJECT
// POST /api/projects/:id/tasks -- User Story is OPTIONAL here (a task
// may belong to a Project without going through a User Story). Both
// user_story_id and sprint_id, if supplied, are validated server-side
// against THIS project (taskService.assertUserStoryBelongsToProject /
// assertSprintBelongsToProject) -- never trusted from the client.
// ========================================

const createProjectTask = async (req, res) => {

    try {

        const { title, description, assigned_to } = req.body;

        if (!title?.trim() || !description?.trim() || !assigned_to) {
            return res.status(400).json({
                success: false,
                message: "Title, description and assignee are required"
            });
        }

        const eligible = await isEligibleProjectAssignee(Number(assigned_to), req.params.id);

        if (!eligible) {
            return res.status(400).json({
                success: false,
                message: "Selected user must be an active member of this project"
            });
        }

        const taskId = await createProjectLinkedTask(
            req.params.id,
            req.body,
            req.user.id
        );

        await createActivity(
            taskId,
            req.user.id,
            {
                activityType: "system",
                body: "Created this task.",
            },
            [],
            req.app.get("io")
        );

        return res.status(201).json({
            success: true,
            message: "Task created successfully",
            id: taskId
        });

    } catch (error) {

        if (error.name === "CrossProjectParentError") {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        console.error(error);

        if (error.name === "TagValidationError") {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        return res.status(500).json({
            success: false,
            message: "Unable to create task"
        });

    }

};

// ========================================
// TRANSFER TASK
//
// Simplified, direct-only transfer:
//   - The task's CURRENT assignee may transfer it
//     to any active Employee/Intern immediately.
//   - Admin/Super Admin may transfer any task to
//     any active Employee/Intern.
//   - Anyone else is rejected — a normal user can
//     never reassign someone else's task.
// No approval step, no pending state — the move
// happens immediately, exactly like the rest of
// the existing task_assignments-based transfer
// flow already did before the request/approval
// workflow was layered on top of it.
// ========================================

const transferTask = async (req, res) => {

    try {

        const { assigned_to, remarks } = req.body;

        const proposedAssigneeId = Number(assigned_to);

        const task = await getTaskDetailById(req.params.id);

        if (!task) {
            return res.status(404).json({
                success: false,
                message: "Task not found"
            });
        }

        const isCurrentAssignee = Number(task.assigned_to) === Number(req.user.id);

        const isAdmin =
            req.user.role === "admin" ||
            ["super_admin", "admin"].includes(req.userAccess?.systemAccess);

        if (!isCurrentAssignee && !isAdmin) {
            return res.status(403).json({
                success: false,
                message: "You are not authorized to transfer this task"
            });
        }

        if (!await passesProjectPermission(req, task, "TASK_TRANSFER")) {
            return res.status(403).json({
                success: false,
                message: "You are not authorized to transfer this task"
            });
        }

        const [assigneeRows] = await pool.query(
            `SELECT id, full_name, role, employment_status FROM users WHERE id = ? LIMIT 1`,
            [proposedAssigneeId]
        );

        if (
            assigneeRows.length === 0 ||
            assigneeRows[0].role !== "employee" ||
            assigneeRows[0].employment_status !== "active"
        ) {
            return res.status(400).json({
                success: false,
                message: "Selected assignee must be an active employee or intern"
            });
        }

        if (proposedAssigneeId === Number(task.assigned_to)) {
            return res.status(400).json({
                success: false,
                message: "This task is already assigned to that person"
            });
        }

        await transferTaskService(
            req.params.id,
            req.user.id,
            proposedAssigneeId,
            remarks || ""
        );

        await createActivity(
            req.params.id,
            req.user.id,
            {
                activityType: "system",
                body: `Transferred this task to ${assigneeRows[0].full_name}.${remarks ? ` Note: ${remarks}` : ""}`,
            },
            [],
            req.app.get("io")
        );

        const transferActorName = await getUserFullName(req.user.id);

        await createNotification({
            req,
            userId: proposedAssigneeId,
            title: "Task transferred to you",
            message: `"${task.task_title}" has been transferred to you.`,
            type: "task_transferred",
            referenceType: "task",
            referenceId: task.id,
            email: taskTransferredEmail({
                taskTitle: task.task_title,
                taskNumber: task.task_number || task.id,
                projectName: task.project_name,
                actorName: transferActorName,
                taskId: task.id,
            }),
        });

        return res.json({

            success: true,

            message: "Task transferred successfully"

        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({

            success: false,

            message: "Unable to transfer task"

        });

    }

};

// ========================================
// ASSIGN / REASSIGN TASK
//
// Project-management action, deliberately separate
// from transferTask above:
//   - Only available for project-linked tasks
//     (task.project_id set) -- non-project tasks
//     keep using their existing assignment paths
//     (Edit / Transfer) completely unchanged.
//   - The caller does NOT need to be the current
//     assignee -- gated purely by the project's
//     TASK_ASSIGN permission (membership + group +
//     access-level ceiling, via hasProjectPermission
//     -- same centralized engine as every other
//     project permission, no bypass).
//   - The new assignee must be an ACTIVE user who is
//     an EXPLICIT member of the SAME project --
//     never the org-wide active-employee pool
//     transferTask uses.
//   - Logged via task_activity (the same "system"
//     activity type transferTask's own log entry
//     uses), NOT task_assignments -- that table is
//     transfer-specific history, not a generic log
//     (see taskService.js transferTask/assignTask).
// ========================================

const assignTask = async (req, res) => {

    try {

        const proposedAssigneeId = Number(req.body.assigned_to);

        const task = await getTaskDetailById(req.params.id);

        if (!task) {
            return res.status(404).json({
                success: false,
                message: "Task not found"
            });
        }

        if (!task.project_id) {
            return res.status(400).json({
                success: false,
                message: "Assign/Reassign is only available for project-linked tasks. Use Transfer for this task."
            });
        }

        if (!Number.isInteger(proposedAssigneeId) || proposedAssigneeId <= 0) {
            return res.status(400).json({
                success: false,
                message: "Select a valid user to assign"
            });
        }

        // Caller must be a member of THIS project AND have TASK_ASSIGN
        // -- hasProjectPermission already denies outright if there is
        // no project_members row for req.user.id, regardless of role,
        // system_access, or designation. No bypass exists here.

        const [[callerRow]] = await pool.query(
            `SELECT project_access_level FROM users WHERE id = ? LIMIT 1`,
            [req.user.id]
        );

        const callerAllowed = await hasProjectPermission(
            { id: req.user.id, accessLevel: callerRow?.project_access_level },
            task.project_id,
            "TASK_ASSIGN"
        );

        if (!callerAllowed) {
            return res.status(403).json({
                success: false,
                message: "You do not have permission to assign this task"
            });
        }

        if (proposedAssigneeId === Number(task.assigned_to)) {
            return res.status(400).json({
                success: false,
                message: "This task is already assigned to that person"
            });
        }

        const [assigneeRows] = await pool.query(
            `SELECT id, full_name, employment_status FROM users WHERE id = ? LIMIT 1`,
            [proposedAssigneeId]
        );

        if (assigneeRows.length === 0 || assigneeRows[0].employment_status !== "active") {
            return res.status(400).json({
                success: false,
                message: "Selected user must be an active user"
            });
        }

        // Explicit project membership -- never organization hierarchy,
        // department scope, reporting manager, executive/admin/super
        // admin access, or designation as a substitute.

        const assigneeIsMember = await canUserAccessProject(
            { id: proposedAssigneeId },
            task.project_id
        );

        if (!assigneeIsMember) {
            return res.status(400).json({
                success: false,
                message: "Selected user must be a member of this project"
            });
        }

        await assignTaskService(req.params.id, proposedAssigneeId);

        const actionLabel = task.assigned_to ? "Reassigned" : "Assigned";

        await createActivity(
            req.params.id,
            req.user.id,
            {
                activityType: "system",
                body: task.assigned_to
                    ? `Reassigned this task from ${task.assigned_to_name || "Unassigned"} to ${assigneeRows[0].full_name}.`
                    : `Assigned this task to ${assigneeRows[0].full_name}.`,
            },
            [],
            req.app.get("io")
        );

        const isReassignment = Boolean(task.assigned_to);

        const assignActorName = await getUserFullName(req.user.id);

        const assignEmailData = {
            taskTitle: task.task_title,
            taskNumber: task.task_number || task.id,
            projectName: task.project_name,
            actorName: assignActorName,
            taskId: task.id,
        };

        await createNotification({
            req,
            userId: proposedAssigneeId,
            title: isReassignment ? "Task reassigned to you" : "Task assigned to you",
            message: `"${task.task_title}" has been ${actionLabel.toLowerCase()} to you.`,
            type: isReassignment ? "task_reassigned" : "task_assigned",
            referenceType: "task",
            referenceId: task.id,
            email: isReassignment
                ? taskReassignedEmail(assignEmailData)
                : taskAssignedEmail(assignEmailData),
        });

        return res.json({
            success: true,
            message: `Task ${actionLabel.toLowerCase()} successfully`
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to assign task"
        });

    }

};

// ========================================
// APPROVE & CLOSE TASK
//
// Project-linked task: authorization is now
// TASK_CHANGE_STATUS via the same additive
// passesProjectPermission gate used everywhere else
// in this controller (membership + access-level
// ceiling + security group -- no role/system_access
// exception). Approve/Send Back are pure status
// transitions (pending_review -> closed / ->
// in_progress), so they reuse TASK_CHANGE_STATUS
// rather than a new permission key, matching the
// Kanban/work-timer precedent.
//
// Non-project task: the exact original
// adminOnly-equivalent rule (role === "admin") is
// preserved unchanged -- this used to be enforced by
// adminOnly route middleware, now moved in here so it
// can be skipped specifically (and only) for
// project-linked tasks, exactly like every other
// branch in this file.
//
// The pending_review precondition below was
// previously enforced ONLY by the frontend hiding the
// button -- it is now also checked here so that
// granting TASK_CHANGE_STATUS to more project members
// can never let someone approve/send-back a task that
// isn't actually pending review. No new status values
// are introduced; VALID_STATUSES is unchanged.
// ========================================

const approveTask = async (req, res) => {

    try {

        const task = await getTaskDetailById(req.params.id);

        if (!task) {
            return res.status(404).json({
                success: false,
                message: "Task not found"
            });
        }

        if (task.project_id) {

            // Review separation: the task's own assignee may never
            // approve their own submission, regardless of security
            // group or role -- ownership-based, not role-based, same
            // isOwnTask comparison already used by changeTaskStatus.
            const isOwnTask = Number(task.assigned_to) === Number(req.user.id);

            if (isOwnTask || !await passesProjectPermission(req, task, "TASK_CHANGE_STATUS")) {
                return res.status(403).json({
                    success: false,
                    message: "You do not have permission to approve this task"
                });
            }

        } else if (req.user.role !== "admin") {

            return res.status(403).json({
                success: false,
                message: "Administrator access required"
            });

        }

        if (task.status !== "pending_review") {
            return res.status(400).json({
                success: false,
                message: "Only a task pending review can be approved"
            });
        }

        await approveAndCloseTaskService(req.params.id);

        await createActivity(
            req.params.id,
            req.user.id,
            {
                activityType: "status_change",
                body: "Approved and closed this task.",
            },
            [],
            req.app.get("io")
        );

        if (task.assigned_to) {

            const approverName = await getUserFullName(req.user.id);

            await createNotification({
                req,
                userId: task.assigned_to,
                title: "Task approved and closed",
                message: `"${task.task_title}" was approved and closed.`,
                type: "task_approved",
                referenceType: "task",
                referenceId: task.id,
                email: taskApprovedEmail({
                    taskTitle: task.task_title,
                    taskNumber: task.task_number || task.id,
                    projectName: task.project_name,
                    actorName: approverName,
                    taskId: task.id,
                }),
            });

        }

        return res.json({

            success: true,

            message: "Task approved and closed successfully"

        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({

            success: false,

            message: "Unable to approve task"

        });

    }

};

// ========================================
// SEND TASK BACK TO EMPLOYEE
// Same authorization pattern as approveTask above.
// ========================================

const sendBackTask = async (req, res) => {

    try {

        const task = await getTaskDetailById(req.params.id);

        if (!task) {
            return res.status(404).json({
                success: false,
                message: "Task not found"
            });
        }

        if (task.project_id) {

            // Review separation: same isOwnTask exclusion as
            // approveTask above -- the assignee cannot send their own
            // task back either, only a different authorized reviewer.
            const isOwnTask = Number(task.assigned_to) === Number(req.user.id);

            if (isOwnTask || !await passesProjectPermission(req, task, "TASK_CHANGE_STATUS")) {
                return res.status(403).json({
                    success: false,
                    message: "You do not have permission to send back this task"
                });
            }

        } else if (req.user.role !== "admin") {

            return res.status(403).json({
                success: false,
                message: "Administrator access required"
            });

        }

        if (task.status !== "pending_review") {
            return res.status(400).json({
                success: false,
                message: "Only a task pending review can be sent back"
            });
        }

        await sendBackTaskService(req.params.id);

        await createActivity(
            req.params.id,
            req.user.id,
            {
                activityType: "status_change",
                body: "Sent this task back for changes.",
            },
            [],
            req.app.get("io")
        );

        if (task.assigned_to) {

            const senderBackName = await getUserFullName(req.user.id);

            await createNotification({
                req,
                userId: task.assigned_to,
                title: "Task sent back for changes",
                message: `"${task.task_title}" was sent back for changes.`,
                type: "task_sent_back",
                referenceType: "task",
                referenceId: task.id,
                email: taskSentBackEmail({
                    taskTitle: task.task_title,
                    taskNumber: task.task_number || task.id,
                    projectName: task.project_name,
                    actorName: senderBackName,
                    taskId: task.id,
                }),
            });

        }

        return res.json({

            success: true,

            message: "Task sent back to employee successfully"

        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({

            success: false,

            message: "Unable to send back task"

        });

    }

};

module.exports = {

    getEmployees,

    getTransferTargets,

    getTasks,

    getTaskById,

    createTask,

    updateTask,

    changeTaskStatus,

    assignTaskToSprint,

    deleteTask,

    restoreTask,

    permanentDeleteTask,

    createProjectTask,

    transferTask,

    assignTask,

    approveTask,

    sendBackTask

};