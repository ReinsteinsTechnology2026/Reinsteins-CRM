const {
    getProjectsByOrganization,
    createProject: createProjectService,
} = require("../services/projectService");

const { getOrganizationById } = require("../services/organizationsService");

// ==========================================
// ORGANIZATION PROJECTS CONTROLLER (Phase 2C)
// Mirrors organizationMembersController.js's shape --
// a thin HTTP layer that reuses the existing
// projectService.js rather than duplicating project
// logic. organization_id is ALWAYS resolved from
// req.params.id (the route), never trusted from the
// request body -- every handler re-confirms the
// organization exists via getOrganizationById first,
// the same pattern used throughout this codebase.
// ==========================================

// ==========================================
// GET PROJECTS FOR AN ORGANIZATION
// ==========================================

const getProjects = async (req, res) => {

    try {

        const organization = await getOrganizationById(req.params.id);

        if (!organization) {
            return res.status(404).json({
                success: false,
                message: "Organization not found"
            });
        }

        const projects = await getProjectsByOrganization(req.params.id);

        return res.json({
            success: true,
            projects
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch organization projects"
        });

    }

};

// ==========================================
// CREATE PROJECT UNDER AN ORGANIZATION
// organization_id is forced from req.params.id --
// anything the client sends in the body (including a
// forged organization_id) is simply never read for
// that purpose.
// ==========================================

const createProject = async (req, res) => {

    try {

        const organization = await getOrganizationById(req.params.id);

        if (!organization) {
            return res.status(404).json({
                success: false,
                message: "Organization not found"
            });
        }

        const { name } = req.body;

        if (!name?.trim()) {
            return res.status(400).json({
                success: false,
                message: "Project name is required"
            });
        }

        const id = await createProjectService(
            req.body,
            req.user.id,
            req.params.id
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

module.exports = {
    getProjects,
    createProject,
};
