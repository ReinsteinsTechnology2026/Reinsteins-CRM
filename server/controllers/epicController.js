const {
    CROSS_PROJECT_ERROR,
    getEpicsByProject,
    getEpicById,
    createEpic: createEpicService,
    updateEpic: updateEpicService
} = require("../services/epicService");

const {
    softDeleteEpic,
    restoreEpic: restoreEpicService,
    permanentlyDeleteEpic,
    NOT_SOFT_DELETED_ERROR
} = require("../services/workItemDeletionService");

// ==========================================
// GET EPICS FOR A PROJECT
// ==========================================

const getEpics = async (req, res) => {

    try {

        const epics = await getEpicsByProject(req.params.projectId);

        return res.json({
            success: true,
            epics
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch epics"
        });

    }

};

// ==========================================
// GET ONE EPIC
// ==========================================

const getEpic = async (req, res) => {

    try {

        const epic = await getEpicById(req.params.id);

        if (!epic) {
            return res.status(404).json({
                success: false,
                message: "Epic not found"
            });
        }

        return res.json({
            success: true,
            epic
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch epic"
        });

    }

};

// ==========================================
// CREATE EPIC
// ==========================================

const createEpic = async (req, res) => {

    try {

        const { title } = req.body;

        if (!title?.trim()) {
            return res.status(400).json({
                success: false,
                message: "Epic title is required"
            });
        }

        const id = await createEpicService(
            req.params.projectId,
            req.body,
            req.user.id
        );

        return res.status(201).json({
            success: true,
            message: "Epic created successfully",
            id
        });

    } catch (error) {

        if (error.name === CROSS_PROJECT_ERROR) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to create epic"
        });

    }

};

// ==========================================
// UPDATE EPIC
// ==========================================

const updateEpic = async (req, res) => {

    try {

        const { title } = req.body;

        if (!title?.trim()) {
            return res.status(400).json({
                success: false,
                message: "Epic title is required"
            });
        }

        const existing = await getEpicById(req.params.id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Epic not found"
            });
        }

        await updateEpicService(req.params.id, req.body, existing.project_id, req.user.id);

        return res.json({
            success: true,
            message: "Epic updated successfully"
        });

    } catch (error) {

        if (error.name === CROSS_PROJECT_ERROR) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to update epic"
        });

    }

};

// ==========================================
// DELETE EPIC (soft delete -- moves to Recycle Bin)
// Cascades to this Epic's Features/User Stories/Tasks -- see
// workItemDeletionService.js's header comment for the full reasoning.
// ==========================================

const deleteEpic = async (req, res) => {

    try {

        const result = await softDeleteEpic(req.params.id, req.user.id);

        if (!result) {
            return res.status(404).json({
                success: false,
                message: "Epic not found"
            });
        }

        return res.json({
            success: true,
            message: "Epic moved to Recycle Bin",
            ...result
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to delete epic"
        });

    }

};

// ==========================================
// RESTORE EPIC
// ==========================================

const restoreEpic = async (req, res) => {

    try {

        const restored = await restoreEpicService(req.params.id);

        if (!restored) {
            return res.status(404).json({
                success: false,
                message: "Epic not found in Recycle Bin"
            });
        }

        return res.json({
            success: true,
            message: "Epic restored successfully"
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to restore epic"
        });

    }

};

// ==========================================
// PERMANENTLY DELETE EPIC (from Recycle Bin)
// ==========================================

const permanentDeleteEpic = async (req, res) => {

    try {

        await permanentlyDeleteEpic(req.params.id);

        return res.json({
            success: true,
            message: "Epic permanently deleted"
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
            message: "Unable to permanently delete epic"
        });

    }

};

module.exports = {

    getEpics,
    getEpic,
    createEpic,
    updateEpic,
    deleteEpic,
    restoreEpic,
    permanentDeleteEpic

};
