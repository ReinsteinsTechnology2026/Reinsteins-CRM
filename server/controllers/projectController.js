const {
    getAllProjects,
    getProjectById,
    getProjectTasks,
    createProject: createProjectService,
    updateProject: updateProjectService,
    deleteProject: deleteProjectService
} = require("../services/projectService");

// ==========================================
// GET ALL PROJECTS
// ==========================================

const getProjects = async (req, res) => {

    try {

        const projects = await getAllProjects({
            id: req.user.id,
            role: req.userAccess?.role,
            systemAccess: req.userAccess?.systemAccess,
        });

        return res.json({
            success: true,
            projects
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch projects"
        });

    }

};

// ==========================================
// GET ONE PROJECT
// ==========================================

const getProject = async (req, res) => {

    try {

        const project = await getProjectById(req.params.id, {
            id: req.user.id,
            role: req.userAccess?.role,
            systemAccess: req.userAccess?.systemAccess,
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: "Project not found"
            });
        }

        return res.json({
            success: true,
            project
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch project"
        });

    }

};

// ==========================================
// GET ALL TASKS FOR A PROJECT (flat, for Kanban)
// Reuses the exact same visibility check as
// getProjectById — if the caller can't see the
// project, they get 404 here too, not a task list.
// ==========================================

const getProjectTaskList = async (req, res) => {

    try {

        const project = await getProjectById(req.params.id, {
            id: req.user.id,
            role: req.userAccess?.role,
            systemAccess: req.userAccess?.systemAccess,
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: "Project not found"
            });
        }

        const tasks = await getProjectTasks(req.params.id);

        return res.json({
            success: true,
            tasks
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch project tasks"
        });

    }

};

// ==========================================
// CREATE PROJECT
// ==========================================

const createProject = async (req, res) => {

    try {

        const { name } = req.body;

        if (!name?.trim()) {
            return res.status(400).json({
                success: false,
                message: "Project name is required"
            });
        }

        const id = await createProjectService(
            req.body,
            req.user.id
        );

        return res.status(201).json({
            success: true,
            message: "Project created successfully",
            id
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to create project"
        });

    }

};

// ==========================================
// UPDATE PROJECT
// ==========================================

const updateProject = async (req, res) => {

    try {

        const existing = await getProjectById(req.params.id, {
            id: req.user.id,
            role: req.userAccess?.role,
            systemAccess: req.userAccess?.systemAccess,
        });

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Project not found"
            });
        }

        await updateProjectService(req.params.id, req.body, req.user.id);

        return res.json({
            success: true,
            message: "Project updated successfully"
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to update project"
        });

    }

};

// ==========================================
// DELETE PROJECT
// ==========================================

const deleteProject = async (req, res) => {

    try {

        const existing = await getProjectById(req.params.id, {
            id: req.user.id,
            role: req.userAccess?.role,
            systemAccess: req.userAccess?.systemAccess,
        });

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Project not found"
            });
        }

        await deleteProjectService(req.params.id);

        return res.json({
            success: true,
            message: "Project deleted successfully"
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to delete project"
        });

    }

};

module.exports = {

    getProjects,
    getProject,
    getProjectTaskList,
    createProject,
    updateProject,
    deleteProject

};
