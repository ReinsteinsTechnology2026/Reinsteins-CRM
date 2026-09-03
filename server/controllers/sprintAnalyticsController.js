const {
    getSprintAnalytics: getSprintAnalyticsService
} = require("../services/sprintAnalyticsService");

// ==========================================
// GET SPRINT ANALYTICS
// Read-only. Authorization (membership + TASK_VIEW,
// with the project resolved from the sprint id
// server-side) is handled entirely by the
// requireProjectPermission middleware in
// sprintRoutes.js before this ever runs -- this
// controller only exists to call the service and
// shape the response, same division of
// responsibility as every other sprint endpoint.
// ==========================================

const getSprintAnalytics = async (req, res) => {

    try {

        const analytics = await getSprintAnalyticsService(req.params.id);

        if (!analytics) {
            return res.status(404).json({
                success: false,
                message: "Sprint not found"
            });
        }

        return res.json({
            success: true,
            analytics
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch sprint analytics"
        });

    }

};

module.exports = {
    getSprintAnalytics
};
