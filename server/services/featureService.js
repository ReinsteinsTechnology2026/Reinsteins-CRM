const pool = require("../config/db");

const { deleteLinksForItem } = require("./workItemLinkService");
const { createWithGeneratedCode } = require("./workItemCodeService");

// ==========================================
// FEATURE SERVICE
//
// Sits between Epic and User Story. A Feature always
// belongs to exactly one Project (project_id NOT
// NULL, set server-side from the route, never from
// the client body) and OPTIONALLY belongs to one
// Epic (epic_id nullable) -- "may exist directly
// under a Project without an Epic" per the approved
// design.
//
// SECURITY: whenever a caller supplies an epic_id
// (create or update), it is validated here against
// the ACTUAL project_id of that epic row, read fresh
// from the database -- never trusted from the
// request body. A forged epic_id belonging to a
// different project is rejected with a thrown
// "CrossProjectParentError", which the controller
// maps to 400.
// ==========================================

const CROSS_PROJECT_ERROR = "CrossProjectParentError";

// ==========================================
// VALIDATE epic_id BELONGS TO THIS PROJECT
// Returns nothing on success; throws on mismatch or
// a nonexistent epic id. null/undefined epic_id is
// always valid (a Feature with no Epic).
// ==========================================

async function assertEpicBelongsToProject(epicId, projectId) {

    if (epicId === null || epicId === undefined || epicId === "") {
        return;
    }

    const [[epic]] = await pool.query(
        `SELECT project_id FROM epics WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [epicId]
    );

    if (!epic) {
        const error = new Error("Selected Epic does not exist");
        error.name = CROSS_PROJECT_ERROR;
        throw error;
    }

    if (Number(epic.project_id) !== Number(projectId)) {
        const error = new Error("Selected Epic belongs to a different project");
        error.name = CROSS_PROJECT_ERROR;
        throw error;
    }

}

// ==========================================
// GET FEATURES FOR A PROJECT (with rollup stats)
// ==========================================

const getFeaturesByProject = async (projectId) => {

    const [features] = await pool.query(`
        SELECT
            f.*,
            epic.title AS epic_title,
            owner.full_name AS owner_name,
            creator.full_name AS created_by_name,

            (
                SELECT COUNT(*)
                FROM user_stories us
                WHERE us.feature_id = f.id
                AND us.deleted_at IS NULL
            ) AS story_count

        FROM features f
        LEFT JOIN epics epic
            ON epic.id = f.epic_id
        LEFT JOIN users owner
            ON owner.id = f.owner_id
        LEFT JOIN users creator
            ON creator.id = f.created_by
        WHERE f.project_id = ?
        AND f.deleted_at IS NULL
        ORDER BY f.id DESC
    `, [projectId]);

    // story_count is bigint (COUNT(*)) -- pg returns it as a string.
    return features.map((f) => ({
        ...f,
        story_count: Number(f.story_count),
    }));

};

// ==========================================
// GET ONE FEATURE
// ==========================================

const getFeatureById = async (id) => {

    const [features] = await pool.query(`
        SELECT
            f.*,
            p.name AS project_name,
            epic.title AS epic_title,
            owner.full_name AS owner_name,
            creator.full_name AS created_by_name
        FROM features f
        INNER JOIN projects p
            ON p.id = f.project_id
        LEFT JOIN epics epic
            ON epic.id = f.epic_id
        LEFT JOIN users owner
            ON owner.id = f.owner_id
        LEFT JOIN users creator
            ON creator.id = f.created_by
        WHERE f.id = ?
        AND f.deleted_at IS NULL
        LIMIT 1
    `, [id]);

    return features[0] || null;

};

// ==========================================
// CREATE FEATURE
// ==========================================

const createFeature = async (projectId, data, createdBy) => {

    const {
        title,
        description,
        owner_id,
        status,
        priority,
        start_date,
        due_date,
        epic_id,
    } = data;

    await assertEpicBelongsToProject(epic_id, projectId);

    const id = await createWithGeneratedCode("feature", async (featureCode) => {

        const [result] = await pool.query(`
            INSERT INTO features(
                project_id,
                epic_id,
                feature_code,
                title,
                description,
                owner_id,
                created_by,
                status,
                priority,
                start_date,
                due_date
            )
            VALUES(?,?,?,?,?,?,?,?,?,?,?)
            RETURNING id
        `, [

            projectId,
            epic_id || null,
            featureCode,
            title,
            description || null,
            owner_id || null,
            createdBy,
            status || "new",
            priority || "Medium",
            start_date || null,
            due_date || null,

        ]);

        return result[0].id;

    });

    return id;

};

// ==========================================
// UPDATE FEATURE
// project_id itself is never editable via this
// function (not accepted from data at all) -- only
// epic_id (re-parenting within the SAME project,
// validated above) and the feature's own fields.
// ==========================================

const updateFeature = async (id, data, projectId) => {

    const {
        title,
        description,
        owner_id,
        status,
        priority,
        start_date,
        due_date,
        epic_id,
    } = data;

    await assertEpicBelongsToProject(epic_id, projectId);

    await pool.query(`
        UPDATE features
        SET
            title=?,
            description=?,
            owner_id=?,
            status=?,
            priority=?,
            start_date=?,
            due_date=?,
            epic_id=?
        WHERE id=?
    `, [

        title,
        description || null,
        owner_id || null,
        status,
        priority,
        start_date || null,
        due_date || null,
        epic_id || null,
        id,

    ]);

};

// ==========================================
// DELETE FEATURE
// Its User Stories are NOT deleted -- fk_user_stories_feature
// (ON DELETE SET NULL) detaches them back to "no
// Feature" automatically, matching the approved
// "opt-in at every level" design.
// ==========================================

const deleteFeature = async (id) => {

    // See epicService.deleteEpic -- same explicit cleanup, same reason
    // (no DB-level FK can span 4 target tables).
    await deleteLinksForItem("feature", id);

    await pool.query(`DELETE FROM features WHERE id = ?`, [id]);

};

module.exports = {

    CROSS_PROJECT_ERROR,
    assertEpicBelongsToProject,
    getFeaturesByProject,
    getFeatureById,
    createFeature,
    updateFeature,
    deleteFeature,

};
