const {
    getEpicsByProject,
    getEpicById,
    createEpic: createEpicService,
    updateEpic: updateEpicService,
    deleteEpic: deleteEpicService
} = require("../services/epicService");

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

        await updateEpicService(req.params.id, req.body);

        return res.json({
            success: true,
            message: "Epic updated successfully"
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to update epic"
        });

    }

};

// ==========================================
// DELETE EPIC
// ==========================================

const deleteEpic = async (req, res) => {

    try {

        const existing = await getEpicById(req.params.id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Epic not found"
            });
        }

        await deleteEpicService(req.params.id);

        return res.json({
            success: true,
            message: "Epic deleted successfully"
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to delete epic"
        });

    }

};

module.exports = {

    getEpics,
    getEpic,
    createEpic,
    updateEpic,
    deleteEpic

};
