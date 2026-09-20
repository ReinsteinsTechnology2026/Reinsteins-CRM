const emailDomainService = require("../services/emailDomainService");
const mailboxService = require("../services/mailboxService");

// ==========================================
// TENANT EMAIL CONTROLLER (Phase 16A)
//
// Every handler below reads company identity EXCLUSIVELY from
// req.tenantCompany (set by tenantAuthMiddleware.js from the verified
// JWT) -- never from req.body/req.params/req.query. That is what
// makes "Company A requesting Company B's domain/mailbox" fail at the
// database query itself (every service call below passes
// req.tenantCompany.id as the scoping companyId), not something this
// controller has to remember to check per-route.
// ==========================================

// Maps a service-thrown error.code to the right HTTP status. Domain/
// mailbox services always throw a real Error with a `.code`; any
// error WITHOUT a recognized code here is treated as unexpected and
// falls through to the generic 500 in each handler's catch block.
const ERROR_STATUS = {
    DOMAIN_INVALID_FORMAT: 400,
    DOMAIN_ALREADY_REGISTERED: 409,
    DOMAIN_LIMIT_REACHED: 403,
    DOMAIN_NOT_FOUND: 404,
    DOMAIN_NOT_VERIFIED: 409,
    DOMAIN_DISABLED: 409,
    DOMAIN_HAS_MAILBOXES: 409,
    EMPLOYEE_NOT_FOUND: 404,
    EMPLOYEE_NOT_ACTIVE: 409,
    MAILBOX_LIMIT_REACHED: 403,
    MAILBOX_INVALID_LOCAL_PART: 400,
    MAILBOX_ADDRESS_TAKEN: 409,
};

function respondToServiceError(res, error, fallbackLog) {
    const status = ERROR_STATUS[error.code];
    if (status) {
        return res.status(status).json({ success: false, message: error.message, code: error.code });
    }
    console.error(fallbackLog, error);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
}

// ==========================================
// DOMAINS
// ==========================================

const createDomain = async (req, res) => {
    try {
        const { domain } = req.body;
        const created = await emailDomainService.createDomain(
            req.tenantCompany.id,
            domain,
            req.tenantCompany.plan_id
        );
        return res.status(201).json({ success: true, domain: created });
    } catch (error) {
        return respondToServiceError(res, error, "Create Email Domain Error:");
    }
};

const listDomains = async (req, res) => {
    try {
        const domains = await emailDomainService.listDomainsForCompany(req.tenantCompany.id);
        return res.status(200).json({ success: true, domains });
    } catch (error) {
        console.error("List Email Domains Error:", error);
        return res.status(500).json({ success: false, message: "Unable to load domains" });
    }
};

const getDomainDnsInstructions = async (req, res) => {
    try {
        const domain = await emailDomainService.getDomainForCompany(req.params.id, req.tenantCompany.id);
        if (!domain) {
            return res.status(404).json({ success: false, message: "Domain not found" });
        }
        return res.status(200).json({ success: true, dns: emailDomainService.buildDnsInstructions(domain) });
    } catch (error) {
        console.error("Get Domain DNS Instructions Error:", error);
        return res.status(500).json({ success: false, message: "Unable to load DNS instructions" });
    }
};

const verifyDomain = async (req, res) => {
    try {
        const result = await emailDomainService.verifyDomain(req.params.id, req.tenantCompany.id);
        return res.status(200).json({ success: true, domain: result });
    } catch (error) {
        return respondToServiceError(res, error, "Verify Email Domain Error:");
    }
};

const deleteDomain = async (req, res) => {
    try {
        const deleted = await emailDomainService.deleteDomain(req.params.id, req.tenantCompany.id);
        if (!deleted) {
            return res.status(404).json({ success: false, message: "Domain not found" });
        }
        return res.status(200).json({ success: true, message: "Domain removed" });
    } catch (error) {
        return respondToServiceError(res, error, "Delete Email Domain Error:");
    }
};

// ==========================================
// MAILBOXES
// ==========================================

const createMailbox = async (req, res) => {
    try {
        const { domainId, tenantUserId, localPart } = req.body;
        const mailbox = await mailboxService.createMailbox({
            companyId: req.tenantCompany.id,
            planId: req.tenantCompany.plan_id,
            tenantPool: req.tenantDb,
            domainId,
            tenantUserId,
            localPart,
        });
        return res.status(201).json({ success: true, mailbox });
    } catch (error) {
        return respondToServiceError(res, error, "Create Mailbox Error:");
    }
};

const listMailboxes = async (req, res) => {
    try {
        const mailboxes = await mailboxService.listMailboxesForCompany(req.tenantCompany.id);
        return res.status(200).json({ success: true, mailboxes });
    } catch (error) {
        console.error("List Mailboxes Error:", error);
        return res.status(500).json({ success: false, message: "Unable to load mailboxes" });
    }
};

const getMailboxById = async (req, res) => {
    try {
        const mailbox = await mailboxService.getMailboxForCompany(req.params.id, req.tenantCompany.id);
        if (!mailbox) {
            return res.status(404).json({ success: false, message: "Mailbox not found" });
        }
        return res.status(200).json({ success: true, mailbox });
    } catch (error) {
        console.error("Get Mailbox Error:", error);
        return res.status(500).json({ success: false, message: "Unable to load mailbox" });
    }
};

// Any authenticated employee's own mailbox -- deliberately does NOT
// take an :id from the URL at all (Phase 16A Step 12: "Employee can
// only access their own mailbox" / "Company A guessing another
// mailbox ID"). Scoped by tenant_user_id = req.user.id, which comes
// only from the verified JWT.
const getMyMailbox = async (req, res) => {
    try {
        const mailbox = await mailboxService.getOwnMailbox(req.tenantCompany.id, req.user.id);
        if (!mailbox) {
            return res.status(404).json({ success: false, message: "You do not have a mailbox yet. Ask your admin to create one." });
        }
        return res.status(200).json({ success: true, mailbox });
    } catch (error) {
        console.error("Get My Mailbox Error:", error);
        return res.status(500).json({ success: false, message: "Unable to load your mailbox" });
    }
};

const ALLOWED_MAILBOX_STATUSES = ["active", "suspended", "disabled"];

const updateMailboxStatus = async (req, res) => {
    try {
        const { status } = req.body;
        if (!ALLOWED_MAILBOX_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, message: `Status must be one of: ${ALLOWED_MAILBOX_STATUSES.join(", ")}` });
        }
        const mailbox = await mailboxService.setMailboxStatus(req.params.id, req.tenantCompany.id, status);
        if (!mailbox) {
            return res.status(404).json({ success: false, message: "Mailbox not found" });
        }
        return res.status(200).json({ success: true, mailbox });
    } catch (error) {
        console.error("Update Mailbox Status Error:", error);
        return res.status(500).json({ success: false, message: "Unable to update mailbox" });
    }
};

const deleteMailbox = async (req, res) => {
    try {
        const deleted = await mailboxService.deleteMailbox(req.params.id, req.tenantCompany.id);
        if (!deleted) {
            return res.status(404).json({ success: false, message: "Mailbox not found" });
        }
        return res.status(200).json({ success: true, message: "Mailbox removed" });
    } catch (error) {
        console.error("Delete Mailbox Error:", error);
        return res.status(500).json({ success: false, message: "Unable to delete mailbox" });
    }
};

module.exports = {
    createDomain,
    listDomains,
    getDomainDnsInstructions,
    verifyDomain,
    deleteDomain,
    createMailbox,
    listMailboxes,
    getMailboxById,
    getMyMailbox,
    updateMailboxStatus,
    deleteMailbox,
};
