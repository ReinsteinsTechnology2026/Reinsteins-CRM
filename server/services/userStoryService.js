const pool = require("../config/db");

const { setTaskTags } = require("./tagService");
const { deleteLinksForItem } = require("./workItemLinkService");
const { createWithGeneratedCode, generateNextTaskNumber } = require("./workItemCodeService");
const { isEligibleProjectAssignee } = require("./projectPermissionService");

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
        `SELECT project_id FROM features WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
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
// ASSIGNMENT ELIGIBILITY (for the STORY's own assigned_to -- separate
// from the Task-level assigned_to already handled by
// createTaskForUserStory below). Same rule/reasoning as
// epicService.js/featureService.js's assertEligibleAssignee.
// ==========================================

async function assertEligibleAssignee(assignedTo, projectId) {

    if (assignedTo === null || assignedTo === undefined || assignedTo === "") {
        return;
    }

    const eligible = await isEligibleProjectAssignee(Number(assignedTo), projectId);

    if (!eligible) {
        const error = new Error("Selected user must be an active member of this project");
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
            assignee.full_name AS assigned_to_name,
            assigner.full_name AS assigned_by_name,
            sp.name AS sprint_name,

            (
                SELECT COUNT(*)
                FROM tasks t
                WHERE t.user_story_id = us.id
                AND t.deleted_at IS NULL
            ) AS task_count,

            (
                SELECT COALESCE(ROUND(AVG(t.progress)), 0)
                FROM tasks t
                WHERE t.user_story_id = us.id
                AND t.deleted_at IS NULL
            ) AS progress

        FROM user_stories us
        LEFT JOIN features feature
            ON feature.id = us.feature_id
        LEFT JOIN users owner
            ON owner.id = us.owner_id
        LEFT JOIN users creator
            ON creator.id = us.created_by
        LEFT JOIN users assignee
            ON assignee.id = us.assigned_to
        LEFT JOIN users assigner
            ON assigner.id = us.assigned_by
        LEFT JOIN sprints sp
            ON sp.id = us.sprint_id
        WHERE us.project_id = ?
        AND us.deleted_at IS NULL
        ORDER BY us.id DESC
    `, [projectId]);

    // task_count (COUNT) and progress (ROUND(AVG(...))) come back
    // from pg as strings -- normalize to numbers.
    return stories.map((s) => ({
        ...s,
        task_count: Number(s.task_count),
        progress: Number(s.progress) || 0,
    }));

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
            creator.full_name AS created_by_name,
            assignee.full_name AS assigned_to_name,
            assigner.full_name AS assigned_by_name,
            sp.name AS sprint_name
        FROM user_stories us
        INNER JOIN projects p
            ON p.id = us.project_id
        LEFT JOIN users owner
            ON owner.id = us.owner_id
        LEFT JOIN users creator
            ON creator.id = us.created_by
        LEFT JOIN users assignee
            ON assignee.id = us.assigned_to
        LEFT JOIN users assigner
            ON assigner.id = us.assigned_by
        LEFT JOIN sprints sp
            ON sp.id = us.sprint_id
        WHERE us.id = ?
        AND us.deleted_at IS NULL
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
        AND t.deleted_at IS NULL
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
// VALIDATE sprint_id BELONGS TO THIS PROJECT
// Same pattern as assertFeatureBelongsToProject above -- a Sprint id
// supplied for a User Story is validated against its ACTUAL
// project_id, never trusted from the request body. null/undefined is
// always valid (a Story with no Sprint -- Backlog).
// ==========================================

async function assertSprintBelongsToProject(sprintId, projectId) {

    if (sprintId === null || sprintId === undefined || sprintId === "") {
        return;
    }

    const [[sprint]] = await pool.query(
        `SELECT project_id FROM sprints WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [sprintId]
    );

    if (!sprint) {
        const error = new Error("Selected Sprint does not exist");
        error.name = CROSS_PROJECT_ERROR;
        throw error;
    }

    if (Number(sprint.project_id) !== Number(projectId)) {
        const error = new Error("Selected Sprint belongs to a different project");
        error.name = CROSS_PROJECT_ERROR;
        throw error;
    }

}

// ==========================================
// CREATE USER STORY
// May optionally be created directly inside a Sprint (sprint_id in
// data, validated against the SAME project as feature_id above) --
// this is what powers Sprint -> "Create User Story".
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
        feature_id,
        sprint_id,
        assigned_to

    } = data;

    await assertFeatureBelongsToProject(feature_id, projectId);
    await assertSprintBelongsToProject(sprint_id, projectId);
    await assertEligibleAssignee(assigned_to, projectId);

    const assignedBy = assigned_to ? createdBy : null;

    const id = await createWithGeneratedCode("user_story", async (storyCode) => {

        const [result] = await pool.query(`
            INSERT INTO user_stories(
                project_id,
                feature_id,
                sprint_id,
                story_code,
                title,
                description,
                owner_id,
                created_by,
                status,
                priority,
                start_date,
                due_date,
                tags,
                assigned_to,
                assigned_by
            )
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            RETURNING id
        `, [

            projectId,
            feature_id || null,
            sprint_id || null,
            storyCode,
            title,
            description || null,
            owner_id || null,
            createdBy,
            status || "new",
            priority || "Medium",
            start_date || null,
            due_date || null,
            tags || null,
            assigned_to || null,
            assignedBy

        ]);

        return result[0].id;

    });

    return id;

};

// ==========================================
// ASSIGN USER STORY TO SPRINT (or back to Backlog)
// Mirrors taskService.assignTaskToSprint exactly -- same "touches
// ONLY sprint_id" reasoning, same backlog<->sprint<->sprint coverage
// in one endpoint. Used both for "Add existing User Story to Sprint"
// and for moving a User Story between Sprints; never duplicates the
// row or changes its id/story_code/hierarchy -- only this one column.
// ==========================================

const assignUserStoryToSprint = async (id, sprintId) => {

    await pool.query(
        `UPDATE user_stories SET sprint_id = ? WHERE id = ?`,
        [sprintId, id]
    );

};

// ==========================================
// UPDATE USER STORY
// ==========================================

const updateUserStory = async (id, data, projectId, updatedBy) => {

    const {

        title,
        description,
        owner_id,
        status,
        priority,
        start_date,
        due_date,
        tags,
        feature_id,
        assigned_to

    } = data;

    await assertFeatureBelongsToProject(feature_id, projectId);
    await assertEligibleAssignee(assigned_to, projectId);

    // Same reassignment semantics as epicService.updateEpic /
    // featureService.updateFeature -- Assigned By becomes whoever
    // performs THIS change.
    const assignedBy = assigned_to ? updatedBy : null;

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
            feature_id=?,
            assigned_to=?,
            assigned_by=?
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
        assigned_to || null,
        assignedBy,
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
        AND deleted_at IS NULL
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

    const nextTaskNumber = await generateNextTaskNumber();

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
    assertEligibleAssignee,
    getUserStoriesByProject,
    getUserStoryById,
    createUserStory,
    updateUserStory,
    assignUserStoryToSprint,
    createTaskForUserStory,
    deleteUserStory

};
