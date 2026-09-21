const {
    getRecycleBinForProject,
    getBatchMembership,
    restoreBatch
} = require("../services/workItemDeletionService");

const {
    hasProjectPermission
} = require("../services/projectPermissionService");

const pool = require("../config/db");

// ==========================================
// GET PROJECT RECYCLE BIN
// Every soft-deleted Epic/Feature/User Story/Task/Sprint within this
// project -- see workItemDeletionService.js for what's included per
// item.
// ==========================================

const getRecycleBin = async (req, res) => {

    try {

        const recycleBin = await getRecycleBinForProject(req.params.id);

        return res.json({
            success: true,
            ...recycleBin
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch recycle bin"
        });

    }

};

// ==========================================
// RESTORE ALL (a cascade-deleted group)
// POST /api/projects/:id/recycle-bin/restore-batch  { batchId }
//
// A batch can span multiple work-item types (e.g. an Epic cascade
// also soft-deleted Features/User Stories/Tasks) -- so the caller
// must hold the *_DELETE permission for EVERY type actually present
// in the batch, not just whichever type happens to be the "root".
// This is checked here, before anything is restored, using the same
// hasProjectPermission engine every other permission check in this
// codebase goes through -- no bypass.
// ==========================================

const restoreBatchHandler = async (req, res) => {

    try {

        const { batchId } = req.body;

        if (!batchId) {
            return res.status(400).json({
                success: false,
                message: "batchId is required"
            });
        }

        const membership = await getBatchMembership(batchId, req.params.id);

        const isEmpty =
            membership.epicIds.length === 0 &&
            membership.featureIds.length === 0 &&
            membership.userStoryIds.length === 0 &&
            membership.taskIds.length === 0;

        if (isEmpty) {
            return res.status(404).json({
                success: false,
                message: "This group was not found in the Recycle Bin for this project"
            });
        }

        const [[row]] = await pool.query(
            `SELECT project_access_level, is_system_administrator FROM users WHERE id = ? LIMIT 1`,
            [req.user.id]
        );
        const user = { id: req.user.id, accessLevel: row?.project_access_level, isSystemAdministrator: row?.is_system_administrator === true };

        const requiredChecks = [];
        if (membership.epicIds.length > 0) requiredChecks.push(["EPIC_DELETE", "Epic"]);
        if (membership.featureIds.length > 0) requiredChecks.push(["FEATURE_DELETE", "Feature"]);
        if (membership.userStoryIds.length > 0) requiredChecks.push(["USER_STORY_DELETE", "User Story"]);
        if (membership.taskIds.length > 0) requiredChecks.push(["TASK_DELETE", "Task"]);

        for (const [permissionKey, label] of requiredChecks) {
            const allowed = await hasProjectPermission(user, req.params.id, permissionKey);
            if (!allowed) {
                return res.status(403).json({
                    success: false,
                    message: `You do not have permission to restore the ${label} item(s) in this group`
                });
            }
        }

        await restoreBatch(batchId, membership);

        return res.json({
            success: true,
            message: "Group restored successfully",
            epicCount: membership.epicIds.length,
            featureCount: membership.featureIds.length,
            userStoryCount: membership.userStoryIds.length,
            taskCount: membership.taskIds.length
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to restore this group"
        });

    }

};

module.exports = {
    getRecycleBin,
    restoreBatchHandler
};
