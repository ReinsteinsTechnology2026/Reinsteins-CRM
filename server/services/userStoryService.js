const pool = require("../config/db");

const { setTaskTags } = require("./tagService");
const { deleteLinksForItem } = require("./workItemLinkService");

// ==========================================
// CROSS-PROJECT PARENT VALIDATION
// Same pattern as featureService.js's
// assertEpicBelongsToProject -- a Feature id supplied
// for a User Story's parent is validated against its
// ACTUAL project_id, read fresh from the database,
// never trusted from the request body. null/undefined
// is always valid (a Story with no Feature).
// ==========================================

const CROSS_PROJECT_ERROR = "CrossProjectParentError";

async function assertFeatureBelongsToProject(featureId, projectId) {

    if (featureId === null || featureId === undefined || featureId === "") {
        return;
    }

    const [[feature]] = await pool.query(
        `SELECT project_id FROM features WHERE id = ? LIMIT 1`,
        [featureId]
    );

    if (!feature) {
        const error = new Error("Selected Feature does not exist");
        error.name = CROSS_PROJECT_ERROR;
        throw error;
    }

    if (Number(feature.project_id) !== Number(projectId)) {
        const error = new Error("Selected Feature belongs to a different project");
        error.name = CROSS_PROJECT_ERROR;
        throw error;
    }

}

// ==========================================
// GET USER STORIES FOR A PROJECT (with rollup stats)
// ==========================================

const getUserStoriesByProject = async (projectId) => {

    const [stories] = await pool.query(`
        SELECT
            us.*,
            feature.title AS feature_title,
            owner.full_name AS owner_name,
            creator.full_name AS created_by_name,

            (
                SELECT COUNT(*)
                FROM tasks t
                WHERE t.user_story_id = us.id
            ) AS task_count,

            (
                SELECT COALESCE(ROUND(AVG(t.progress)), 0)
                FROM tasks t
                WHERE t.user_story_id = us.id
            ) AS progress

        FROM user_stories us
        LEFT JOIN features feature
            ON feature.id = us.feature_id
        LEFT JOIN users owner
            ON owner.id = us.owner_id
        LEFT JOIN users creator
            ON creator.id = us.created_by
        WHERE us.project_id = ?
        ORDER BY us.id DESC
    `, [projectId]);

    return stories;

};

// ==========================================
// GET ONE USER STORY (with its tasks)
// ==========================================

const getUserStoryById = async (id) => {

    const [stories] = await pool.query(`
        SELECT
            us.*,
            p.name AS project_name,
            owner.full_name AS owner_name,
            creator.full_name AS created_by_name
        FROM user_stories us
        INNER JOIN projects p
            ON p.id = us.project_id
        LEFT JOIN users owner
            ON owner.id = us.owner_id
        LEFT JOIN users creator
            ON creator.id = us.created_by
        WHERE us.id = ?
        LIMIT 1
    `, [id]);

    if (stories.length === 0) {
        return null;
    }

    const story = stories[0];

    const [tasks] = await pool.query(`
        SELECT
            t.*,
            assignee.full_name AS assigned_to_name,
            assigner.full_name AS assigned_by_name
        FROM tasks t
        LEFT JOIN users assignee
            ON assignee.id = t.assigned_to
        LEFT JOIN users assigner
            ON assigner.id = t.assigned_by
        WHERE t.user_story_id = ?
        ORDER BY t.id DESC
    `, [id]);

    const progress = tasks.length > 0
        ? Math.round(
            tasks.reduce((sum, t) => sum + (t.progress || 0), 0) / tasks.length
        )
        : 0;

    return {

        ...story,

        progress,

        tasks

    };

};

// ==========================================
// CREATE USER STORY
// ==========================================

const createUserStory = async (projectId, data, createdBy) => {

    const {

        title,
        description,
        owner_id,
        status,
        priority,
        start_date,
        due_date,
        tags,
        feature_id

    } = data;

    await assertFeatureBelongsToProject(feature_id, projectId);

    const [result] = await pool.query(`
        INSERT INTO user_stories(
            project_id,
            feature_id,
            title,
            description,
            owner_id,
            created_by,
            status,
            priority,
            start_date,
            due_date,
            tags
        )
        VALUES(?,?,?,?,?,?,?,?,?,?,?)
        RETURNING id
    `, [

        projectId,
        feature_id || null,
        title,
        description || null,
        owner_id || null,
        createdBy,
        status || "new",
        priority || "Medium",
        start_date || null,
        due_date || null,
        tags || null

    ]);

    return result[0].id;

};

// ==========================================
// UPDATE USER STORY
// ==========================================

const updateUserStory = async (id, data, projectId) => {

    const {

        title,
        description,
        owner_id,
        status,
        priority,
        start_date,
        due_date,
        tags,
        feature_id

    } = data;

    await assertFeatureBelongsToProject(feature_id, projectId);

    await pool.query(`
        UPDATE user_stories
        SET
            title=?,
            description=?,
            owner_id=?,
            status=?,
            priority=?,
            start_date=?,
            due_date=?,
            tags=?,
            feature_id=?
        WHERE id=?
    `, [

        title,
        description || null,
        owner_id || null,
        status,
        priority,
        start_date || null,
        due_date || null,
        tags || null,
        feature_id || null,
        id

    ]);

};

// ==========================================
// CREATE TASK UNDER A USER STORY
//
// Mirrors taskService.createTask's task-number
// logic, kept as its own copy here so the
// existing admin Task Management create flow
// (taskService.js) is never touched.
// ==========================================

const createTaskForUserStory = async (storyId, data, assignedBy) => {

    const [stories] = await pool.query(`
        SELECT id, project_id
        FROM user_stories
        WHERE id = ?
        LIMIT 1
    `, [storyId]);

    if (stories.length === 0) {
        return null;
    }

    const { project_id } = stories[0];

    const {

        title,
        description,
        assigned_to,
        priority,
        due_date,
        estimated_hours,
        tags,
        tagNames

    } = data;

    const [rows] = await pool.query(`
        SELECT task_number
        FROM tasks
        ORDER BY id DESC
        LIMIT 1
    `);

    let nextTaskNumber = 1;

    if (rows.length > 0 && rows[0].task_number != null) {

        const current = String(rows[0].task_number);

        const number = parseInt(
            current.replace(/\D/g, ""),
            10
        );

        nextTaskNumber = Number.isNaN(number)
            ? 1
            : number + 1;

    }

    const [result] = await pool.query(`
        INSERT INTO tasks(
            task_number,
            user_id,
            project_id,
            user_story_id,
            assigned_to,
            assigned_by,
            task_title,
            task_description,
            priority,
            status,
            due_date,
            estimated_hours,
            tags,
            progress
        )
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        RETURNING id
    `, [

        nextTaskNumber,
        Number(assignedBy),
        project_id,
        storyId,
        Number(assigned_to),
        Number(assignedBy),
        title,
        description,
        priority || "Medium",
        "backlog",
        due_date || null,
        estimated_hours || null,
        tags || null,
        0

    ]);

    await setTaskTags(result[0].id, tagNames);

    return result[0].id;

};

// ==========================================
// DELETE USER STORY
// Tasks under this Story are NOT deleted -- tasks.user_story_id
// is ON DELETE SET NULL, so they detach and fall back to
// "No User Story", same hierarchy semantics as Epic/Feature
// delete. Any Work Item Link involving this Story (either
// side) is cleaned up explicitly first, same as
// epicService.deleteEpic / featureService.deleteFeature.
// ==========================================

const deleteUserStory = async (id) => {

    await deleteLinksForItem("user_story", id);

    await pool.query(`DELETE FROM user_stories WHERE id = ?`, [id]);

};

module.exports = {

    CROSS_PROJECT_ERROR,
    getUserStoriesByProject,
    getUserStoryById,
    createUserStory,
    updateUserStory,
    createTaskForUserStory,
    deleteUserStory

};
