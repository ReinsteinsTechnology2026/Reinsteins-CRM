const demoRequestService = require("../services/demoRequestService");

// ==========================================
// PLATFORM DEMO REQUEST CONTROLLER (Phase 7)
//
// Every route using this controller is mounted behind
// platformProtect -- only an authenticated, active Platform Owner
// ever reaches these handlers (mirrors platformCompanyController.js's
// own header comment/convention exactly).
//
// This is lead-management only: nothing here creates a company, a
// tenant database, or a platform user. There is no import of
// platformCompanyService or tenantProvisioningService in this file.
// Turning a lead into a real company is, and remains, the separate,
// deliberate POST /api/platform/companies action.
// ==========================================

const VALID_STATUSES = ["new", "contacted", "closed"];

const toSafeDemoRequest = (row) => ({
    id: row.id,
    name: row.name,
    companyName: row.company_name,
    email: row.email,
    phone: row.phone,
    employeeCount: row.employee_count,
    status: row.status,
    createdAt: row.created_at,
    // Only present when the row came from getDemoRequestById (the
    // list query never selects `message` -- see demoRequestService.js).
    ...(row.message !== undefined ? { message: row.message } : {}),
});

const listDemoRequests = async (_req, res) => {
    try {
        const demoRequests = await demoRequestService.listDemoRequests();
        return res.status(200).json({
            success: true,
            demoRequests: demoRequests.map(toSafeDemoRequest),
        });
    } catch (error) {
        console.error("[platform] listDemoRequests failed:", error);
        return res.status(500).json({ success: false, message: "Failed to load demo requests." });
    }
};

const getDemoRequestDetails = async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, message: "Invalid demo request id." });
        }

        const demoRequest = await demoRequestService.getDemoRequestById(id);
        if (!demoRequest) {
            return res.status(404).json({ success: false, message: "Demo request not found." });
        }

        return res.status(200).json({ success: true, demoRequest: toSafeDemoRequest(demoRequest) });
    } catch (error) {
        console.error("[platform] getDemoRequestDetails failed:", error);
        return res.status(500).json({ success: false, message: "Failed to load demo request." });
    }
};

const updateDemoRequestStatus = async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, message: "Invalid demo request id." });
        }

        // Only `status` is EVER read from the request body -- email,
        // company_name, name, etc. sent alongside it (e.g. a forged
        // { status, email, company_name } payload) are simply never
        // referenced anywhere in this function or in
        // updateDemoRequestStatus() below, so they can never reach
        // the database regardless of what a caller sends.
        const status = req.body?.status;

        if (!VALID_STATUSES.includes(status)) {
            return res.status(400).json({
                success: false,
                message: `status must be one of: ${VALID_STATUSES.join(", ")}.`,
            });
        }

        const updated = await demoRequestService.updateDemoRequestStatus(id, status);

        if (!updated) {
            return res.status(404).json({ success: false, message: "Demo request not found." });
        }

        return res.status(200).json({ success: true, demoRequest: toSafeDemoRequest(updated) });
    } catch (error) {
        console.error("[platform] updateDemoRequestStatus failed:", error);
        return res.status(500).json({ success: false, message: "Failed to update demo request status." });
    }
};

module.exports = {
    listDemoRequests,
    getDemoRequestDetails,
    updateDemoRequestStatus,
};
