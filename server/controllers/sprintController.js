const {
    getSprintsByProject,
    getActiveSprintsForUser,
    getSprintById,
    createSprint: createSprintService,
    updateSprint: updateSprintService,
    startSprint: startSprintService,
    completeSprint: completeSprintService,
    deleteSprint: deleteSprintService,
    DUPLICATE_NAME_ERROR,
    INVALID_DATES_ERROR,
    ALREADY_ACTIVE_ERROR
} = require("../services/sprintService");

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
// DELETE SPRINT
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

        await deleteSprintService(req.params.id);

        return res.json({
            success: true,
            message: "Sprint deleted successfully"
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to delete sprint"
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
    deleteSprint

};
