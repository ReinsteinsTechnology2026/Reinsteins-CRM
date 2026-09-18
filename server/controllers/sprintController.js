const {
    getSprintsByProject,
    getActiveSprintsForUser,
    getSprintById,
    getSprintProjectId,
    createSprint: createSprintService,
    updateSprint: updateSprintService,
    startSprint: startSprintService,
    completeSprint: completeSprintService,
    DUPLICATE_NAME_ERROR,
    INVALID_DATES_ERROR,
    ALREADY_ACTIVE_ERROR
} = require("../services/sprintService");

const {
    createUserStory: createUserStoryService
} = require("../services/userStoryService");

const {
    createProjectLinkedTask
} = require("../services/taskService");

const {
    softDeleteSprint,
    restoreSprint: restoreSprintService,
    permanentlyDeleteSprint,
    ACTIVE_SPRINT_DELETE_ERROR,
    NOT_SOFT_DELETED_ERROR
} = require("../services/workItemDeletionService");

const {
    isEligibleProjectAssignee
} = require("../services/projectPermissionService");

const {
    createActivity
} = require("../services/taskActivityService");

// ==========================================
// ERROR -> HTTP RESPONSE HELPER
// Shared by create/update/start below so the same
// service-level validation errors map to the same
// friendly 400s everywhere they can occur.
// ==========================================

function respondToSprintError(res, error, fallbackMessage) {

    if (
        error.name === DUPLICATE_NAME_ERROR ||
        error.name === INVALID_DATES_ERROR ||
        error.name === ALREADY_ACTIVE_ERROR ||
        error.name === "SprintValidationError"
    ) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }

    console.error(error);

    return res.status(500).json({
        success: false,
        message: fallbackMessage
    });

}

// ==========================================
// GET ACTIVE SPRINTS ACROSS ALL MY PROJECTS
// (dashboard widget) — self-scoped to the caller's
// own project_members rows, same reasoning as
// taskManagementController.getTasks needing no
// separate permission check.
// ==========================================

const getMyActiveSprints = async (req, res) => {

    try {

        const sprints = await getActiveSprintsForUser(req.user.id);

        return res.json({
            success: true,
            sprints
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch active sprints"
        });

    }

};

// ==========================================
// GET SPRINTS FOR A PROJECT
// ==========================================

const getSprints = async (req, res) => {

    try {

        const sprints = await getSprintsByProject(req.params.projectId);

        return res.json({
            success: true,
            sprints
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch sprints"
        });

    }

};

// ==========================================
// GET ONE SPRINT (with its tasks)
// ==========================================

const getSprint = async (req, res) => {

    try {

        const sprint = await getSprintById(req.params.id);

        if (!sprint) {
            return res.status(404).json({
                success: false,
                message: "Sprint not found"
            });
        }

        return res.json({
            success: true,
            sprint
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch sprint"
        });

    }

};

// ==========================================
// CREATE SPRINT
// ==========================================

const createSprint = async (req, res) => {

    try {

        const id = await createSprintService(
            req.params.projectId,
            req.body,
            req.user.id
        );

        return res.status(201).json({
            success: true,
            message: "Sprint created successfully",
            id
        });

    } catch (error) {

        return respondToSprintError(res, error, "Unable to create sprint");

    }

};

// ==========================================
// UPDATE SPRINT
// ==========================================

const updateSprint = async (req, res) => {

    try {

        const existing = await getSprintById(req.params.id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Sprint not found"
            });
        }

        if (existing.status === "completed") {
            return res.status(400).json({
                success: false,
                message: "A completed sprint cannot be edited"
            });
        }

        await updateSprintService(req.params.id, req.body);

        return res.json({
            success: true,
            message: "Sprint updated successfully"
        });

    } catch (error) {

        return respondToSprintError(res, error, "Unable to update sprint");

    }

};

// ==========================================
// START SPRINT
// ==========================================

const startSprint = async (req, res) => {

    try {

        const existing = await getSprintById(req.params.id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Sprint not found"
            });
        }

        if (existing.status !== "planning") {
            return res.status(400).json({
                success: false,
                message: "Only a sprint in Planning can be started"
            });
        }

        await startSprintService(req.params.id, existing.project_id);

        return res.json({
            success: true,
            message: "Sprint started successfully"
        });

    } catch (error) {

        return respondToSprintError(res, error, "Unable to start sprint");

    }

};

// ==========================================
// COMPLETE SPRINT
// ==========================================

const completeSprint = async (req, res) => {

    try {

        const existing = await getSprintById(req.params.id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Sprint not found"
            });
        }

        if (existing.status !== "active") {
            return res.status(400).json({
                success: false,
                message: "Only an active sprint can be completed"
            });
        }

        const result = await completeSprintService(req.params.id);

        const io = req.app.get("io");

        for (const taskId of result.movedTaskIds) {

            await createActivity(
                taskId,
                req.user.id,
                {
                    activityType: "system",
                    body: `Removed from sprint: ${existing.name} (sprint completed)`,
                },
                [],
                io
            );

        }

        return res.json({
            success: true,
            message: "Sprint completed successfully",
            movedTaskCount: result.movedTaskIds.length
        });

    } catch (error) {

        return respondToSprintError(res, error, "Unable to complete sprint");

    }

};

// ==========================================
// DELETE SPRINT (soft delete -- moves to Recycle Bin)
// Does NOT cascade to its Tasks/User Stories (a Sprint is a planning
// layer over the hierarchy, not part of it) -- they are detached back
// to the Backlog instead, exactly like a normal sprint completion. An
// active sprint cannot be deleted (must be completed first) -- see
// workItemDeletionService.js's header comment for the full reasoning.
// ==========================================

const deleteSprint = async (req, res) => {

    try {

        const existing = await getSprintById(req.params.id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Sprint not found"
            });
        }

        const result = await softDeleteSprint(req.params.id, req.user.id);

        if (!result) {
            return res.status(404).json({
                success: false,
                message: "Sprint not found"
            });
        }

        const io = req.app.get("io");

        for (const taskId of result.detachedTaskIds) {

            await createActivity(
                taskId,
                req.user.id,
                {
                    activityType: "system",
                    body: `Removed from sprint: ${existing.name} (sprint deleted)`,
                },
                [],
                io
            );

        }

        return res.json({
            success: true,
            message: "Sprint moved to Recycle Bin",
            detachedTaskCount: result.detachedTaskIds.length,
            detachedUserStoryCount: result.detachedUserStoryIds.length
        });

    } catch (error) {

        if (error.name === ACTIVE_SPRINT_DELETE_ERROR) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to delete sprint"
        });

    }

};

// ==========================================
// RESTORE SPRINT
// Does NOT re-attach the Tasks/User Stories that were detached to the
// Backlog when it was deleted -- see workItemDeletionService.js.
// ==========================================

const restoreSprint = async (req, res) => {

    try {

        const restored = await restoreSprintService(req.params.id);

        if (!restored) {
            return res.status(404).json({
                success: false,
                message: "Sprint not found in Recycle Bin"
            });
        }

        return res.json({
            success: true,
            message: "Sprint restored successfully"
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to restore sprint"
        });

    }

};

// ==========================================
// PERMANENTLY DELETE SPRINT (from Recycle Bin)
// ==========================================

const permanentDeleteSprint = async (req, res) => {

    try {

        await permanentlyDeleteSprint(req.params.id);

        return res.json({
            success: true,
            message: "Sprint permanently deleted"
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
            message: "Unable to permanently delete sprint"
        });

    }

};

// ==========================================
// CREATE USER STORY DIRECTLY IN A SPRINT
// POST /api/sprints/:id/user-stories -- Sprint is auto-selected
// (sprint_id forced from the route, never trusted from the body).
// feature_id, if supplied, is still validated against the sprint's
// own project (see userStoryService.assertFeatureBelongsToProject).
// ==========================================

const createUserStoryInSprint = async (req, res) => {

    try {

        const { title } = req.body;

        if (!title?.trim()) {
            return res.status(400).json({
                success: false,
                message: "User story title is required"
            });
        }

        const sprint = await getSprintProjectId(req.params.id);

        if (!sprint) {
            return res.status(404).json({
                success: false,
                message: "Sprint not found"
            });
        }

        const id = await createUserStoryService(
            sprint.project_id,
            { ...req.body, sprint_id: req.params.id },
            req.user.id
        );

        return res.status(201).json({
            success: true,
            message: "User story created successfully",
            id
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to create user story"
        });

    }

};

// ==========================================
// CREATE TASK DIRECTLY IN A SPRINT
// POST /api/sprints/:id/tasks -- Sprint is auto-selected (sprint_id
// forced from the route). user_story_id, if supplied, is optional and
// validated against the sprint's own project (see
// taskService.assertUserStoryBelongsToProject).
// ==========================================

const createTaskInSprint = async (req, res) => {

    try {

        const { title, description, assigned_to } = req.body;

        if (!title?.trim() || !description?.trim() || !assigned_to) {
            return res.status(400).json({
                success: false,
                message: "Title, description and assignee are required"
            });
        }

        const sprint = await getSprintProjectId(req.params.id);

        if (!sprint) {
            return res.status(404).json({
                success: false,
                message: "Sprint not found"
            });
        }

        const eligible = await isEligibleProjectAssignee(Number(assigned_to), sprint.project_id);

        if (!eligible) {
            return res.status(400).json({
                success: false,
                message: "Selected user must be an active member of this project"
            });
        }

        const taskId = await createProjectLinkedTask(
            sprint.project_id,
            { ...req.body, sprint_id: req.params.id },
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

module.exports = {

    getMyActiveSprints,
    getSprints,
    getSprint,
    createSprint,
    updateSprint,
    startSprint,
    completeSprint,
    deleteSprint,
    restoreSprint,
    permanentDeleteSprint,
    createUserStoryInSprint,
    createTaskInSprint

};
