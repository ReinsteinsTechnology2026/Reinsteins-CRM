const pool = require("../config/db");

const {
    WorkItemLinkError,
    ITEM_TABLES,
    resolveItem,
    getLinksForItem,
    createLink: createLinkService,
    getLinkById,
    deleteLink: deleteLinkService,
} = require("../services/workItemLinkService");

const { hasProjectPermission } = require("../services/projectPermissionService");

const { createActivity } = require("../services/taskActivityService");

// ==========================================
// VIEW PERMISSION PER ITEM TYPE
// Deliberately reuses each item's OWN existing VIEW
// key rather than introducing a WORK_ITEM_LINK_VIEW --
// if you can see the item, you can see its
// relationships (approved decision #1).
// ==========================================

const VIEW_PERMISSION_BY_TYPE = {
    epic: "EPIC_VIEW",
    feature: "FEATURE_VIEW",
    user_story: "USER_STORY_VIEW",
    task: "TASK_VIEW",
};

// ==========================================
// ACCESS CHECK FOR VIEWING ONE ITEM'S LINKS
// Project-linked item (epic/feature/user_story are
// ALWAYS project-linked; task may not be): membership +
// the item's own VIEW key, same pattern as
// taskActivityController.canAccessTask.
// Legacy (non-project) task: admin, or assignee/assigner
// -- mirrors canAccessTask's non-project branch exactly.
// Legacy tasks can never actually HAVE links (the create
// path rejects them), so this only ever produces an
// empty result for that branch, never real data.
// ==========================================

const canViewItem = async (req, type, item) => {

    if (item.project_id) {

        const [[row]] = await pool.query(
            `SELECT project_access_level FROM users WHERE id = ? LIMIT 1`,
            [req.user.id]
        );

        return hasProjectPermission(
            { id: req.user.id, accessLevel: row?.project_access_level },
            item.project_id,
            VIEW_PERMISSION_BY_TYPE[type]
        );

    }

    if (req.user.role === "admin") {
        return true;
    }

    return (
        Number(item.assigned_to) === Number(req.user.id) ||
        Number(item.assigned_by) === Number(req.user.id)
    );

};

// ==========================================
// MANAGE PERMISSION (create/delete) FOR ONE PROJECT
// ==========================================

const canManageInProject = async (req, projectId) => {

    const [[row]] = await pool.query(
        `SELECT project_access_level FROM users WHERE id = ? LIMIT 1`,
        [req.user.id]
    );

    return hasProjectPermission(
        { id: req.user.id, accessLevel: row?.project_access_level },
        projectId,
        "WORK_ITEM_LINK_MANAGE"
    );

};

const ERROR_STATUS = {
    NOT_FOUND: 404,
    NOT_PROJECT_LINKED: 400,
    CROSS_PROJECT: 400,
    SELF_LINK: 400,
    DUPLICATE: 400,
    CIRCULAR_BLOCK: 400,
    INVALID_TYPE: 400,
};

// ==========================================
// TASK ACTIVITY LOGGING FOR A LINK CHANGE
// Task<->Task only (approved decision #11) -- Epic/
// Feature/User Story relationships are never logged
// anywhere, matching the existing "no activity system
// for those levels" architecture. Reuses the exact
// createActivity({activityType: "system", ...}) call
// every other task system event already goes through --
// no new activity type, no schema change.
// ==========================================

const LINK_TYPE_LABEL = { related: "Related", blocks: "Blocks" };

async function logLinkActivity(req, { source, target, linkType, removed }) {

    if (source?.__type !== "task" || target?.__type !== "task") {
        return;
    }

    const io = req.app.get("io");

    const sourceNumber = source.task_number || source.id;
    const targetNumber = target.task_number || target.id;

    const verb = removed ? "Removed link" : "Linked";

    const sourceBody = linkType === "blocks"
        ? `${verb} to Task #${targetNumber} (Blocks)`
        : `${verb} to Task #${targetNumber} (Related)`;

    const targetBody = linkType === "blocks"
        ? `${verb} from Task #${sourceNumber} (Blocked By)`
        : `${verb} to Task #${sourceNumber} (Related)`;

    await createActivity(
        source.id,
        req.user.id,
        { activityType: "system", body: sourceBody },
        [],
        io
    );

    await createActivity(
        target.id,
        req.user.id,
        { activityType: "system", body: targetBody },
        [],
        io
    );

}

// ==========================================
// GET LINKS FOR ONE ITEM
// GET /api/work-item-links/:sourceType/:sourceId
// ==========================================

const getLinks = async (req, res) => {

    try {

        const { sourceType, sourceId } = req.params;

        if (!ITEM_TABLES[sourceType]) {
            return res.status(400).json({
                success: false,
                message: "Unknown work item type",
            });
        }

        const item = await resolveItem(sourceType, sourceId);

        if (!item) {
            return res.status(404).json({
                success: false,
                message: "Work item not found",
            });
        }

        if (!await canViewItem(req, sourceType, item)) {
            return res.status(403).json({
                success: false,
                message: "You do not have access to this work item",
            });
        }

        const links = await getLinksForItem(sourceType, sourceId);

        return res.json({
            success: true,
            ...links,
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch relationships",
        });

    }

};

// ==========================================
// CREATE LINK
// POST /api/work-item-links
// ==========================================

const createLink = async (req, res) => {

    try {

        const { sourceType, sourceId, targetType, targetId, linkType } = req.body;

        if (!sourceType || !sourceId || !targetType || !targetId || !linkType) {
            return res.status(400).json({
                success: false,
                message: "sourceType, sourceId, targetType, targetId and linkType are all required",
            });
        }

        if (!ITEM_TABLES[sourceType] || !ITEM_TABLES[targetType]) {
            return res.status(400).json({
                success: false,
                message: "Unknown work item type",
            });
        }

        const source = await resolveItem(sourceType, sourceId);

        if (!source) {
            return res.status(404).json({
                success: false,
                message: "Source work item not found",
            });
        }

        if (!source.project_id) {
            return res.status(400).json({
                success: false,
                message: "Legacy work items that are not linked to a project cannot be related",
            });
        }

        if (!await canManageInProject(req, source.project_id)) {
            return res.status(403).json({
                success: false,
                message: "You do not have permission to manage relationships in this project",
            });
        }

        // The service is the AUTHORITATIVE check -- it re-resolves both
        // sides itself and never trusts anything already computed here
        // (including the project_id used for the permission check
        // above). A forged targetId belonging to a different project
        // is rejected here regardless of what the permission check
        // above concluded about the SOURCE's project.
        const result = await createLinkService({
            sourceType,
            sourceId,
            targetType,
            targetId,
            linkType,
            createdBy: req.user.id,
        });

        await logLinkActivity(req, {
            source: { ...result.source, __type: sourceType },
            target: { ...result.target, __type: targetType },
            linkType,
            removed: false,
        });

        return res.status(201).json({
            success: true,
            message: "Relationship created successfully",
            id: result.id,
        });

    } catch (error) {

        if (error instanceof WorkItemLinkError) {
            return res.status(ERROR_STATUS[error.code] || 400).json({
                success: false,
                message: error.message,
            });
        }

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to create relationship",
        });

    }

};

// ==========================================
// DELETE LINK
// DELETE /api/work-item-links/:id
// ==========================================

const deleteLink = async (req, res) => {

    try {

        const link = await getLinkById(req.params.id);

        if (!link) {
            return res.status(404).json({
                success: false,
                message: "Relationship not found",
            });
        }

        if (!await canManageInProject(req, link.project_id)) {
            return res.status(403).json({
                success: false,
                message: "You do not have permission to manage relationships in this project",
            });
        }

        const result = await deleteLinkService(req.params.id);

        if (!result) {
            return res.status(404).json({
                success: false,
                message: "Relationship not found",
            });
        }

        await logLinkActivity(req, {
            source: result.source ? { ...result.source, __type: result.link.source_type } : null,
            target: result.target ? { ...result.target, __type: result.link.target_type } : null,
            linkType: result.link.link_type,
            removed: true,
        });

        return res.json({
            success: true,
            message: "Relationship removed successfully",
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to remove relationship",
        });

    }

};

module.exports = {
    getLinks,
    createLink,
    deleteLink,
};
