const platformAuditService = require("../services/platformAuditService");

// ==========================================
// PLATFORM AUDIT CONTROLLER (Phase 12J/12K)
//
// Read-only surface over platform_audit_logs -- nothing here writes;
// every write happens at the call site of the action being audited
// (platformCompanyController.js, platformPlanController.js,
// platformPaymentController.js, platformAuthController.js), via
// platformAuditService.logAction directly. Mounted behind
// platformProtect like every other platform route.
// ==========================================

const VALID_ACTION_TYPES = [
    "company_created", "company_suspended", "company_reactivated", "company_deleted",
    "plan_created", "plan_updated", "plan_disabled", "plan_enabled",
    "subscription_changed", "payment_recorded", "payment_status_changed", "platform_password_changed",
    "billing_contact_updated", "billing_contact_removed", "email_retried", "smtp_test_triggered",
    // Phase 14 -- security events.
    "login_failed_repeated", "account_locked", "2fa_enabled", "2fa_disabled",
    "backup_code_used", "backup_codes_regenerated",
];

const toSafeLog = (row) => ({
    id: row.id,
    platformUserId: row.platform_user_id,
    platformUserName: row.platform_user_name,
    platformUserEmail: row.platform_user_email,
    actionType: row.action_type,
    targetType: row.target_type,
    targetId: row.target_id,
    companyId: row.company_id,
    companyName: row.company_name,
    companySlug: row.company_slug,
    metadata: row.metadata,
    createdAt: row.created_at,
});

const listLogs = async (req, res) => {
    try {
        const { actionType, companyId, dateFrom, dateTo, search, sortBy } = req.query;

        if (actionType && !VALID_ACTION_TYPES.includes(actionType)) {
            return res.status(400).json({ success: false, message: "Invalid actionType filter." });
        }

        let companyIdNum;
        if (companyId !== undefined) {
            companyIdNum = Number(companyId);
            if (!Number.isInteger(companyIdNum) || companyIdNum <= 0) {
                return res.status(400).json({ success: false, message: "Invalid companyId filter." });
            }
        }

        const rows = await platformAuditService.listLogs({
            actionType: actionType || undefined,
            companyId: companyIdNum,
            dateFrom: dateFrom || undefined,
            dateTo: dateTo || undefined,
            search: typeof search === "string" ? search.trim() : undefined,
            sortBy: sortBy || undefined,
        });

        return res.status(200).json({ success: true, logs: rows.map(toSafeLog), actionTypes: VALID_ACTION_TYPES });
    } catch (error) {
        console.error("[platform] listLogs failed:", error);
        return res.status(500).json({ success: false, message: "Failed to load audit logs." });
    }
};

module.exports = { listLogs, VALID_ACTION_TYPES };
