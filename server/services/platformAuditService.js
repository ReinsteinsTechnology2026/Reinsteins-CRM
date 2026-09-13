const platformPool = require("../config/platformDb");

// ==========================================
// PLATFORM AUDIT SERVICE (Phase 12J)
//
// Pure DB logic against groworgs_platform_db.platform_audit_logs
// ONLY. `metadata` is caller-supplied but this module enforces a
// strict deny-list scrub before every INSERT -- no call site needs to
// remember not to pass a password/hash/token, because this is the one
// place that would catch it regardless. Every call site (controllers)
// still only builds metadata from fields that are safe by design
// (names, ids, statuses, amounts) -- this is defense in depth, not
// the only safeguard.
// ==========================================

// Keys that must never appear in stored metadata, matched
// case-insensitively against every key at any nesting depth.
const FORBIDDEN_KEY_PATTERN = /password|passwordhash|password_hash|token|secret|jwt|authorization|credential/i;

function scrubMetadata(value) {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(scrubMetadata);
    if (typeof value === "object") {
        const clean = {};
        for (const [key, val] of Object.entries(value)) {
            if (FORBIDDEN_KEY_PATTERN.test(key)) continue;
            clean[key] = scrubMetadata(val);
        }
        return clean;
    }
    return value;
}

const logAction = async ({ platformUserId, actionType, targetType, targetId = null, companyId = null, metadata = null, ipAddress = null }) => {
    const safeMetadata = metadata ? scrubMetadata(metadata) : null;
    await platformPool.query(
        `INSERT INTO platform_audit_logs (platform_user_id, action_type, target_type, target_id, company_id, metadata, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [platformUserId, actionType, targetType, targetId, companyId, safeMetadata ? JSON.stringify(safeMetadata) : null, ipAddress]
    );
};

const VALID_SORT = { newest: "a.created_at DESC", oldest: "a.created_at ASC" };

const listLogs = async ({ actionType, companyId, dateFrom, dateTo, search, sortBy, limit = 100 } = {}) => {
    const conditions = [];
    const params = [];

    if (actionType) {
        conditions.push(`a.action_type = ?`);
        params.push(actionType);
    }
    if (companyId) {
        conditions.push(`a.company_id = ?`);
        params.push(companyId);
    }
    if (dateFrom) {
        conditions.push(`a.created_at >= ?`);
        params.push(dateFrom);
    }
    if (dateTo) {
        conditions.push(`a.created_at <= ?`);
        params.push(dateTo);
    }
    if (search) {
        conditions.push(`(pu.name LIKE ? OR pu.email LIKE ? OR c.company_name LIKE ?)`);
        const term = `%${search}%`;
        params.push(term, term, term);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const orderClause = VALID_SORT[sortBy] || VALID_SORT.newest;
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);

    const [rows] = await platformPool.query(
        `SELECT a.id, a.platform_user_id, a.action_type, a.target_type, a.target_id, a.company_id,
                a.metadata, a.created_at,
                pu.name AS platform_user_name, pu.email AS platform_user_email,
                c.company_name, c.company_slug
         FROM platform_audit_logs a
         LEFT JOIN platform_users pu ON pu.id = a.platform_user_id
         LEFT JOIN companies c ON c.id = a.company_id
         ${whereClause}
         ORDER BY ${orderClause}
         LIMIT ${safeLimit}`,
        params
    );
    return rows;
};

module.exports = {
    logAction,
    listLogs,
    scrubMetadata,
};
