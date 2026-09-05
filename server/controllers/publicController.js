const demoRequestService = require("../services/demoRequestService");

// ==========================================
// PUBLIC CONTROLLER (Phase 6)
//
// Everything here is reachable WITHOUT authentication -- this is the
// public marketing site's only backend surface. Deliberately narrow:
// one endpoint, one table, no path to any tenant or platform data.
//
// submitDemoRequest does NOT create a company, a tenant database, or
// a platform user under any circumstance -- it has no import of
// platformCompanyService, tenantProvisioningService, or
// platformUserService at all, so there is no code path by which
// submitting this form could provision anything. It only ever
// INSERTs one row into demo_requests.
// ==========================================

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const NAME_MAX = 150;
const COMPANY_NAME_MAX = 255;
const EMAIL_MAX = 255;
const PHONE_MAX = 30;
const EMPLOYEE_COUNT_MAX = 50;
const MESSAGE_MAX = 2000;

const submitDemoRequest = async (req, res) => {

    try {

        const nameRaw = req.body?.name;
        const companyNameRaw = req.body?.companyName;
        const emailRaw = req.body?.email;
        const phoneRaw = req.body?.phone;
        const employeeCountRaw = req.body?.employeeCount;
        const messageRaw = req.body?.message;

        if (
            typeof nameRaw !== "string" ||
            nameRaw.trim().length < 2 ||
            nameRaw.trim().length > NAME_MAX
        ) {
            return res.status(400).json({
                success: false,
                message: `Name is required (2-${NAME_MAX} characters).`,
            });
        }

        if (
            typeof companyNameRaw !== "string" ||
            companyNameRaw.trim().length < 2 ||
            companyNameRaw.trim().length > COMPANY_NAME_MAX
        ) {
            return res.status(400).json({
                success: false,
                message: `Company name is required (2-${COMPANY_NAME_MAX} characters).`,
            });
        }

        if (
            typeof emailRaw !== "string" ||
            emailRaw.trim().length > EMAIL_MAX ||
            !EMAIL_PATTERN.test(emailRaw.trim())
        ) {
            return res.status(400).json({
                success: false,
                message: "A valid work email is required.",
            });
        }

        if (phoneRaw !== undefined && phoneRaw !== null) {
            if (typeof phoneRaw !== "string" || phoneRaw.trim().length > PHONE_MAX) {
                return res.status(400).json({
                    success: false,
                    message: `Phone number must be ${PHONE_MAX} characters or fewer.`,
                });
            }
        }

        if (employeeCountRaw !== undefined && employeeCountRaw !== null) {
            if (typeof employeeCountRaw !== "string" || employeeCountRaw.trim().length > EMPLOYEE_COUNT_MAX) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid number of employees value.",
                });
            }
        }

        if (messageRaw !== undefined && messageRaw !== null) {
            if (typeof messageRaw !== "string" || messageRaw.length > MESSAGE_MAX) {
                return res.status(400).json({
                    success: false,
                    message: `Message must be ${MESSAGE_MAX} characters or fewer.`,
                });
            }
        }

        const { id } = await demoRequestService.createDemoRequest({
            name: nameRaw.trim(),
            companyName: companyNameRaw.trim(),
            email: emailRaw.trim().toLowerCase(),
            phone: phoneRaw?.trim() || null,
            employeeCount: employeeCountRaw?.trim() || null,
            message: messageRaw?.trim() || null,
        });

        return res.status(201).json({
            success: true,
            message: "Thank you — your request has been received. Our team will be in touch shortly.",
            referenceId: id,
        });

    } catch (error) {
        // Never leak SQL/internal error details to a public,
        // unauthenticated caller.
        console.error("[public] submitDemoRequest failed:", error);
        return res.status(500).json({
            success: false,
            message: "Unable to submit your request right now. Please try again shortly.",
        });
    }

};

module.exports = {
    submitDemoRequest,
};
