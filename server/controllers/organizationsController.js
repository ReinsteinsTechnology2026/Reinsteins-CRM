const {
    getAllOrganizations,
    getOrganizationById,
    getOrganizationByName,
    createOrganization: createOrganizationService,
} = require("../services/organizationsService");

// ==========================================
// GET ALL ORGANIZATIONS
// Route-gated to role='admin' only (see
// organizationsRoutes.js) -- every organization the
// authorized admin "can manage" is, for Phase 2A,
// every organization that exists. A narrower
// per-organization-admin scope is a later-phase
// decision, not assumed here.
// ==========================================

const getOrganizations = async (req, res) => {

    try {

        const organizations = await getAllOrganizations();

        return res.json({
            success: true,
            organizations
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch organizations"
        });

    }

};

// ==========================================
// GET ONE ORGANIZATION
// ==========================================

const getOrganization = async (req, res) => {

    try {

        const organization = await getOrganizationById(req.params.id);

        if (!organization) {
            return res.status(404).json({
                success: false,
                message: "Organization not found"
            });
        }

        return res.json({
            success: true,
            organization
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch organization"
        });

    }

};

// ==========================================
// CREATE ORGANIZATION
// created_by is always req.user.id, resolved
// server-side -- never trusted from the client body.
// ==========================================

const createOrganization = async (req, res) => {

    try {

        const { name, description, status } = req.body;

        if (!name?.trim()) {
            return res.status(400).json({
                success: false,
                message: "Organization name is required"
            });
        }

        if (status && !["active", "inactive"].includes(status)) {
            return res.status(400).json({
                success: false,
                message: "Invalid status"
            });
        }

        const existing = await getOrganizationByName(name.trim());

        if (existing) {
            return res.status(400).json({
                success: false,
                message: "An organization with this name already exists"
            });
        }

        const id = await createOrganizationService(
            { name: name.trim(), description, status },
            req.user.id
        );

        return res.status(201).json({
            success: true,
            message: "Organization created successfully",
            id
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to create organization"
        });

    }

};

module.exports = {
    getOrganizations,
    getOrganization,
    createOrganization,
};
