const {
    CROSS_PROJECT_ERROR,
    getFeaturesByProject,
    getFeatureById,
    createFeature: createFeatureService,
    updateFeature: updateFeatureService
} = require("../services/featureService");

const {
    softDeleteFeature,
    restoreFeature: restoreFeatureService,
    permanentlyDeleteFeature,
    NOT_SOFT_DELETED_ERROR
} = require("../services/workItemDeletionService");

// ==========================================
// GET FEATURES FOR A PROJECT
// ==========================================

const getFeatures = async (req, res) => {

    try {

        const features = await getFeaturesByProject(req.params.projectId);

        return res.json({
            success: true,
            features
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch features"
        });

    }

};

// ==========================================
// GET ONE FEATURE
// ==========================================

const getFeature = async (req, res) => {

    try {

        const feature = await getFeatureById(req.params.id);

        if (!feature) {
            return res.status(404).json({
                success: false,
                message: "Feature not found"
            });
        }

        return res.json({
            success: true,
            feature
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch feature"
        });

    }

};

// ==========================================
// CREATE FEATURE
// May be created under an Epic (epic_id in body) or
// directly under the Project (epic_id omitted). The
// epic_id, if supplied, is validated against the
// SAME project server-side inside the service --
// never trusted as-is from the client.
// ==========================================

const createFeature = async (req, res) => {

    try {

        const { title } = req.body;

        if (!title?.trim()) {
            return res.status(400).json({
                success: false,
                message: "Feature title is required"
            });
        }

        const id = await createFeatureService(
            req.params.projectId,
            req.body,
            req.user.id
        );

        return res.status(201).json({
            success: true,
            message: "Feature created successfully",
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
            message: "Unable to create feature"
        });

    }

};

// ==========================================
// UPDATE FEATURE
// Re-parenting to a different Epic is allowed here
// (epic_id in body) but validated server-side against
// THIS feature's own existing project_id, never a
// project_id supplied by the client.
// ==========================================

const updateFeature = async (req, res) => {

    try {

        const { title } = req.body;

        if (!title?.trim()) {
            return res.status(400).json({
                success: false,
                message: "Feature title is required"
            });
        }

        const existing = await getFeatureById(req.params.id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Feature not found"
            });
        }

        await updateFeatureService(req.params.id, req.body, existing.project_id, req.user.id);

        return res.json({
            success: true,
            message: "Feature updated successfully"
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
            message: "Unable to update feature"
        });

    }

};

// ==========================================
// DELETE FEATURE (soft delete -- moves to Recycle Bin)
// Cascades to this Feature's User Stories/Tasks.
// ==========================================

const deleteFeature = async (req, res) => {

    try {

        const result = await softDeleteFeature(req.params.id, req.user.id);

        if (!result) {
            return res.status(404).json({
                success: false,
                message: "Feature not found"
            });
        }

        return res.json({
            success: true,
            message: "Feature moved to Recycle Bin",
            ...result
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to delete feature"
        });

    }

};

// ==========================================
// RESTORE FEATURE
// ==========================================

const restoreFeature = async (req, res) => {

    try {

        const restored = await restoreFeatureService(req.params.id);

        if (!restored) {
            return res.status(404).json({
                success: false,
                message: "Feature not found in Recycle Bin"
            });
        }

        return res.json({
            success: true,
            message: "Feature restored successfully"
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to restore feature"
        });

    }

};

// ==========================================
// PERMANENTLY DELETE FEATURE (from Recycle Bin)
// ==========================================

const permanentDeleteFeature = async (req, res) => {

    try {

        await permanentlyDeleteFeature(req.params.id);

        return res.json({
            success: true,
            message: "Feature permanently deleted"
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
            message: "Unable to permanently delete feature"
        });

    }

};

module.exports = {

    getFeatures,
    getFeature,
    createFeature,
    updateFeature,
    deleteFeature,
    restoreFeature,
    permanentDeleteFeature

};
