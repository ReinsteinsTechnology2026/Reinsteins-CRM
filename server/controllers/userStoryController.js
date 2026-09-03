const {
    CROSS_PROJECT_ERROR,
    getUserStoriesByProject,
    getUserStoryById,
    createUserStory: createUserStoryService,
    updateUserStory: updateUserStoryService,
    createTaskForUserStory,
    deleteUserStory: deleteUserStoryService
} = require("../services/userStoryService");

const {
    isEligibleProjectAssignee,
} = require("../services/projectPermissionService");

const {
    createActivity
} = require("../services/taskActivityService");

const pool = require("../config/db");

// ==========================================
// GET USER STORIES FOR A PROJECT
// ==========================================

const getUserStories = async (req, res) => {

    try {

        const stories = await getUserStoriesByProject(req.params.projectId);

        return res.json({
            success: true,
            userStories: stories
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch user stories"
        });

    }

};

// ==========================================
// GET ONE USER STORY
// ==========================================

const getUserStory = async (req, res) => {

    try {

        const story = await getUserStoryById(req.params.id);

        if (!story) {
            return res.status(404).json({
                success: false,
                message: "User story not found"
            });
        }

        return res.json({
            success: true,
            userStory: story
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch user story"
        });

    }

};

// ==========================================
// CREATE USER STORY
// ==========================================

const createUserStory = async (req, res) => {

    try {

        const { title } = req.body;

        if (!title?.trim()) {
            return res.status(400).json({
                success: false,
                message: "User story title is required"
            });
        }

        const id = await createUserStoryService(
            req.params.projectId,
            req.body,
            req.user.id
        );

        return res.status(201).json({
            success: true,
            message: "User story created successfully",
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
            message: "Unable to create user story"
        });

    }

};

// ==========================================
// UPDATE USER STORY
// ==========================================

const updateUserStory = async (req, res) => {

    try {

        const existing = await getUserStoryById(req.params.id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "User story not found"
            });
        }

        await updateUserStoryService(req.params.id, req.body, existing.project_id);

        return res.json({
            success: true,
            message: "User story updated successfully"
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
            message: "Unable to update user story"
        });

    }

};

// ==========================================
// CREATE TASK UNDER A USER STORY
// ==========================================

const createTask = async (req, res) => {

    try {

        const { title, description, assigned_to } = req.body;

        if (!title?.trim() || !description?.trim() || !assigned_to) {
            return res.status(400).json({
                success: false,
                message: "Title, description and assignee are required"
            });
        }

        // The assignee must be an EXPLICIT member of THIS story's
        // project -- never the assigner's own org-wide reporting-
        // hierarchy scope (that scope has no concept of project
        // membership and is used only for legacy, non-project tasks).
        // Same rule taskManagementController's assignTask/updateTask
        // already enforce for project-linked tasks. The story's real
        // project_id is re-read from the database, never trusted from
        // the client.

        const [[story]] = await pool.query(
            `SELECT project_id FROM user_stories WHERE id = ? LIMIT 1`,
            [req.params.id]
        );

        if (!story) {
            return res.status(404).json({
                success: false,
                message: "User story not found"
            });
        }

        const eligible = await isEligibleProjectAssignee(Number(assigned_to), story.project_id);

        if (!eligible) {
            return res.status(400).json({
                success: false,
                message: "Selected user must be an active member of this project"
            });
        }

        const taskId = await createTaskForUserStory(
            req.params.id,
            req.body,
            req.user.id
        );

        if (!taskId) {
            return res.status(404).json({
                success: false,
                message: "User story not found"
            });
        }

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

// ==========================================
// DELETE USER STORY
// ==========================================

const deleteUserStory = async (req, res) => {

    try {

        const existing = await getUserStoryById(req.params.id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "User story not found"
            });
        }

        await deleteUserStoryService(req.params.id);

        return res.json({
            success: true,
            message: "User story deleted successfully"
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to delete user story"
        });

    }

};

module.exports = {

    getUserStories,
    getUserStory,
    createUserStory,
    updateUserStory,
    createTask,
    deleteUserStory

};
