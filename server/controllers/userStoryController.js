const {
    CROSS_PROJECT_ERROR,
    getUserStoriesByProject,
    getUserStoryById,
    createUserStory: createUserStoryService,
    updateUserStory: updateUserStoryService,
    assignUserStoryToSprint: assignUserStoryToSprintService,
    createTaskForUserStory,
} = require("../services/userStoryService");

const {
    softDeleteUserStory,
    restoreUserStory: restoreUserStoryService,
    permanentlyDeleteUserStory,
    NOT_SOFT_DELETED_ERROR
} = require("../services/workItemDeletionService");

const {
    isEligibleProjectAssignee,
} = require("../services/projectPermissionService");

const {
    getSprintProjectId
} = require("../services/sprintService");

const {
    createActivity
} = require("../services/taskActivityService");

const { createNotification } = require("../services/notificationService");

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

        await updateUserStoryService(req.params.id, req.body, existing.project_id, req.user.id);

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
// DELETE USER STORY (soft delete -- moves to Recycle Bin)
// Cascades to this Story's Tasks.
// ==========================================

const deleteUserStory = async (req, res) => {

    try {

        const result = await softDeleteUserStory(req.params.id, req.user.id);

        if (!result) {
            return res.status(404).json({
                success: false,
                message: "User story not found"
            });
        }

        return res.json({
            success: true,
            message: "User story moved to Recycle Bin",
            ...result
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to delete user story"
        });

    }

};

// ==========================================
// RESTORE USER STORY
// ==========================================

const restoreUserStory = async (req, res) => {

    try {

        const restored = await restoreUserStoryService(req.params.id);

        if (!restored) {
            return res.status(404).json({
                success: false,
                message: "User story not found in Recycle Bin"
            });
        }

        return res.json({
            success: true,
            message: "User story restored successfully"
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to restore user story"
        });

    }

};

// ==========================================
// PERMANENTLY DELETE USER STORY (from Recycle Bin)
// ==========================================

const permanentDeleteUserStory = async (req, res) => {

    try {

        await permanentlyDeleteUserStory(req.params.id);

        return res.json({
            success: true,
            message: "User story permanently deleted"
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
            message: "Unable to permanently delete user story"
        });

    }

};

// ==========================================
// ASSIGN USER STORY TO SPRINT (or back to Backlog)
// Mirrors taskManagementController.assignTaskToSprint -- same
// "touches only sprint_id", same backlog<->sprint<->sprint coverage
// in one endpoint. Powers both "Add existing User Story to Sprint"
// and moving a Story between Sprints. Only ever available for
// project-linked stories (all User Stories are project-linked).
// sprint_id === null clears the story back to the Backlog.
// ==========================================

const assignUserStoryToSprint = async (req, res) => {

    try {

        const { sprint_id } = req.body;

        const story = await getUserStoryById(req.params.id);

        if (!story) {
            return res.status(404).json({
                success: false,
                message: "User story not found"
            });
        }

        let targetSprint = null;

        if (sprint_id !== null && sprint_id !== undefined) {

            targetSprint = await getSprintProjectId(sprint_id);

            if (!targetSprint) {
                return res.status(404).json({
                    success: false,
                    message: "Sprint not found"
                });
            }

            if (Number(targetSprint.project_id) !== Number(story.project_id)) {
                return res.status(400).json({
                    success: false,
                    message: "This sprint does not belong to the same project as this user story"
                });
            }

        }

        if (Number(story.sprint_id || 0) === Number(sprint_id || 0)) {
            return res.status(400).json({
                success: false,
                message: "User story is already in this sprint"
            });
        }

        await assignUserStoryToSprintService(req.params.id, sprint_id || null);

        const oldLabel = story.sprint_name || "Backlog";
        const newLabel = targetSprint?.name || "Backlog";

        let body;

        if (!story.sprint_id && targetSprint) {
            body = `Added to sprint: ${newLabel}`;
        } else if (story.sprint_id && !targetSprint) {
            body = `Removed from sprint: ${oldLabel}`;
        } else {
            body = `Moved from sprint ${oldLabel} to ${newLabel}`;
        }

        if (story.owner_id && Number(story.owner_id) !== Number(req.user.id)) {

            const sprintChangeText = body.charAt(0).toLowerCase() + body.slice(1);

            await createNotification({
                req,
                userId: story.owner_id,
                title: "Sprint assignment updated",
                message: `"${story.title}" was ${sprintChangeText}.`,
                type: "user_story_sprint_changed",
                referenceType: "user_story",
                referenceId: story.id,
            });

        }

        return res.json({
            success: true,
            message: "User story sprint updated successfully"
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to update user story's sprint"
        });

    }

};

module.exports = {

    getUserStories,
    getUserStory,
    createUserStory,
    updateUserStory,
    assignUserStoryToSprint,
    createTask,
    deleteUserStory,
    restoreUserStory,
    permanentDeleteUserStory

};
