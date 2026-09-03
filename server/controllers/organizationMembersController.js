const {
    getOrganizationMembers,
    getEligibleEmployees,
    addOrganizationMember: addOrganizationMemberService,
    removeOrganizationMember: removeOrganizationMemberService,
} = require("../services/organizationMemberService");

const { getOrganizationById } = require("../services/organizationsService");

// ==========================================
// ORGANIZATION MEMBERS CONTROLLER (Phase 2B)
// A thin HTTP layer over the existing Phase 1
// organizationMemberService.js -- no membership
// business logic lives here, it all already exists
// and is reused as-is (add/remove/eligibility rules,
// the one-organization-per-person constraint, the
// project-membership cascade on removal).
//
// organization_id is ALWAYS resolved from
// req.params.id (the route), never from the request
// body -- every handler below re-confirms the
// organization exists via getOrganizationById before
// acting, the same "resolve the real parent, never
// trust the client" pattern used throughout this
// codebase (epics/features/stories/tasks).
// ==========================================

// ==========================================
// GET ORGANIZATION MEMBERS
// ==========================================

const getMembers = async (req, res) => {

    try {

        const organization = await getOrganizationById(req.params.id);

        if (!organization) {
            return res.status(404).json({
                success: false,
                message: "Organization not found"
            });
        }

        const members = await getOrganizationMembers(req.params.id);

        return res.json({
            success: true,
            members
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch organization members"
        });

    }

};

// ==========================================
// GET ELIGIBLE EMPLOYEES
// ==========================================

const getEligible = async (req, res) => {

    try {

        const organization = await getOrganizationById(req.params.id);

        if (!organization) {
            return res.status(404).json({
                success: false,
                message: "Organization not found"
            });
        }

        const employees = await getEligibleEmployees();

        return res.json({
            success: true,
            employees
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch eligible employees"
        });

    }

};

// ==========================================
// ADD MEMBER
// userId is the only thing trusted from the client
// body -- organization_id comes from the route,
// added_by is always req.user.id.
// ==========================================

const addMember = async (req, res) => {

    try {

        const organization = await getOrganizationById(req.params.id);

        if (!organization) {
            return res.status(404).json({
                success: false,
                message: "Organization not found"
            });
        }

        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "Select an employee to add"
            });
        }

        const result = await addOrganizationMemberService(req.params.id, userId, req.user.id);

        if (!result.success) {

            const messages = {
                not_found: "Selected user does not exist",
                not_active: "Selected user must be an active employee",
                different_organization: "This employee already belongs to a different organization",
            };

            return res.status(400).json({
                success: false,
                message: messages[result.reason] || "Unable to add member"
            });

        }

        return res.status(result.reason === "added" ? 201 : 200).json({
            success: true,
            message: result.reason === "already_member"
                ? "This employee is already a member of this organization"
                : "Member added successfully"
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to add member"
        });

    }

};

// ==========================================
// REMOVE MEMBER
// ==========================================

const removeMember = async (req, res) => {

    try {

        const organization = await getOrganizationById(req.params.id);

        if (!organization) {
            return res.status(404).json({
                success: false,
                message: "Organization not found"
            });
        }

        const result = await removeOrganizationMemberService(req.params.id, req.params.userId);

        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: "This user is not a member of this organization"
            });
        }

        return res.json({
            success: true,
            message: "Member removed from the organization",
            removedProjectMemberships: result.removedProjectMemberships
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to remove member"
        });

    }

};

module.exports = {
    getMembers,
    getEligible,
    addMember,
    removeMember,
};
