// ==========================================
// MICROSOFT EMAIL STORE -- the only module that runs SQL for the Microsoft 365 mail feature.
//
// ISOLATION RULES (each one is tested in _test_ms_email_pg.js):
//   * Every query that reads or changes a company's data is scoped by company_id IN THE QUERY, and the company id
//     always comes from the authenticated request (req.tenantCompany), never from a body, query string or URL.
//   * Token columns are NEVER selected by the general readers. Only getConnectionWithTokens() returns them, and only
//     the token service calls it. The list views, the admin screens and the API cannot leak a token.
//   * The OAuth state is consumed in ONE atomic UPDATE ... WHERE consumed_at IS NULL AND expires_at > NOW(): a state
//     works once, only before it expires, so a replayed or stale callback finds nothing.
//   * Times are produced and compared by the database (NOW(), make_interval), so server / database time zones can
//     never make a token or a state look valid when it is not.
//
// `pool` is injectable (every function takes it as the last argument via the factory) so the same code is verified
// against a real PostgreSQL in CI and against an in-process PostgreSQL locally.
// ==========================================

const SAFE_CONNECTION_COLUMNS = `
    id, company_id, tenant_user_id, mailbox_id, ms_tenant_id, ms_user_oid, ms_account, status, scopes,
    access_expires_at, last_refreshed_at, last_error, connected_at, created_at, updated_at
`;

const COMPANY_CONNECTION_COLUMNS = `
    id, company_id, ms_tenant_id, tenant_source, domain_id, status, last_checked_at, last_error, created_by, created_at, updated_at
`;

const MAILBOX_COLUMNS = `
    id, company_id, domain_id, tenant_user_id, email_address, mailbox_provider_id, provisioning_status, status,
    quota_mb, provider, link_state, linked_at, created_at, updated_at
`;

function createMsEmailStore(pool = require("../config/platformDb")) {
    // ---------- company-level Microsoft 365 connection ----------

    async function getCompanyConnection(companyId) {
        const [rows] = await pool.query(
            `SELECT ${COMPANY_CONNECTION_COLUMNS} FROM email_ms_company_connections WHERE company_id = ? LIMIT 1`,
            [companyId]
        );
        return rows[0] || null;
    }

    async function upsertCompanyConnection(companyId, { msTenantId, domainId, tenantSource = "domain_discovery", status, lastError = null, createdBy = null }) {
        const [rows] = await pool.query(
            `INSERT INTO email_ms_company_connections (company_id, ms_tenant_id, tenant_source, domain_id, status, last_checked_at, last_error, created_by)
             VALUES (?, ?, ?, ?, ?, NOW(), ?, ?)
             ON CONFLICT (company_id) DO UPDATE SET
                 ms_tenant_id = EXCLUDED.ms_tenant_id, tenant_source = EXCLUDED.tenant_source, domain_id = EXCLUDED.domain_id,
                 status = EXCLUDED.status, last_checked_at = NOW(), last_error = EXCLUDED.last_error, updated_at = NOW()
             RETURNING ${COMPANY_CONNECTION_COLUMNS}`,
            [companyId, msTenantId, tenantSource, domainId, status, lastError, createdBy]
        );
        return rows[0];
    }

    async function setCompanyConnectionStatus(companyId, status, lastError = null) {
        const [rows] = await pool.query(
            `UPDATE email_ms_company_connections SET status = ?, last_error = ?, last_checked_at = NOW(), updated_at = NOW()
             WHERE company_id = ? RETURNING ${COMPANY_CONNECTION_COLUMNS}`,
            [status, lastError, companyId]
        );
        return rows[0] || null;
    }

    // ---------- mailboxes (the existing table, plus the new provider columns) ----------

    async function getMailbox(companyId, mailboxId) {
        const [rows] = await pool.query(`SELECT ${MAILBOX_COLUMNS} FROM mailboxes WHERE id = ? AND company_id = ? LIMIT 1`, [mailboxId, companyId]);
        return rows[0] || null;
    }

    async function getOwnMailbox(companyId, tenantUserId) {
        // ORDER BY makes the choice deterministic if an employee ever has more than one mailbox row.
        const [rows] = await pool.query(
            `SELECT ${MAILBOX_COLUMNS} FROM mailboxes WHERE company_id = ? AND tenant_user_id = ?
             ORDER BY (provider = 'microsoft365') DESC, id ASC LIMIT 1`,
            [companyId, tenantUserId]
        );
        return rows[0] || null;
    }

    // A single employee may be linked through only ONE mailbox. This is enforced here (the legacy table has no unique key).
    async function findLinkedMailboxForUser(companyId, tenantUserId, exceptMailboxId = null) {
        const [rows] = await pool.query(
            `SELECT id FROM mailboxes WHERE company_id = ? AND tenant_user_id = ? AND provider = 'microsoft365' AND id <> COALESCE(?, -1) LIMIT 1`,
            [companyId, tenantUserId, exceptMailboxId]
        );
        return rows[0] || null;
    }

    async function setMailboxLink(companyId, mailboxId, { provider, linkState, provisioningStatus, linkedAt }) {
        const [rows] = await pool.query(
            `UPDATE mailboxes SET provider = ?, link_state = ?, provisioning_status = COALESCE(?, provisioning_status),
                    linked_at = CASE WHEN ? THEN NOW() ELSE linked_at END, updated_at = NOW()
             WHERE id = ? AND company_id = ? RETURNING ${MAILBOX_COLUMNS}`,
            [provider, linkState, provisioningStatus || null, Boolean(linkedAt), mailboxId, companyId]
        );
        return rows[0] || null;
    }

    async function clearMailboxLink(companyId, mailboxId) {
        const [rows] = await pool.query(
            `UPDATE mailboxes SET provider = 'none', link_state = 'unlinked', provisioning_status = 'pending_infrastructure', linked_at = NULL, updated_at = NOW()
             WHERE id = ? AND company_id = ? RETURNING ${MAILBOX_COLUMNS}`,
            [mailboxId, companyId]
        );
        return rows[0] || null;
    }

    async function listMailboxesWithConnection(companyId) {
        const [rows] = await pool.query(
            `SELECT m.id, m.company_id, m.domain_id, m.tenant_user_id, m.email_address, m.status, m.provisioning_status,
                    m.provider, m.link_state, m.linked_at, m.created_at,
                    c.status AS connection_status, c.ms_account, c.connected_at, c.last_error AS connection_error, c.last_refreshed_at
             FROM mailboxes m
             LEFT JOIN email_ms_user_connections c ON c.mailbox_id = m.id AND c.company_id = m.company_id
             WHERE m.company_id = ? ORDER BY m.created_at DESC, m.id DESC`,
            [companyId]
        );
        return rows;
    }

    // ---------- OAuth state ----------

    async function createOAuthState({ companyId, tenantUserId, mailboxId, stateHash, nonceHash, verifierEnc, returnPortal, ttlSeconds }) {
        await pool.query(`DELETE FROM email_ms_oauth_states WHERE expires_at < NOW() - interval '1 day'`);
        await pool.query(
            `INSERT INTO email_ms_oauth_states (state_hash, company_id, tenant_user_id, mailbox_id, nonce_hash, code_verifier_enc, return_portal, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW() + make_interval(secs => ?))`,
            [stateHash, companyId, tenantUserId, mailboxId, nonceHash, verifierEnc, returnPortal === "admin" ? "admin" : "employee", ttlSeconds]
        );
    }

    // Atomic, single use. Returns the row only if the state existed, was unused and had not expired.
    async function consumeOAuthState(stateHash) {
        const [rows] = await pool.query(
            `UPDATE email_ms_oauth_states SET consumed_at = NOW()
             WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > NOW()
             RETURNING company_id, tenant_user_id, mailbox_id, nonce_hash, code_verifier_enc, return_portal`,
            [stateHash]
        );
        return rows[0] || null;
    }

    // ---------- per-employee Microsoft connection ----------

    async function getConnection(companyId, tenantUserId) {
        const [rows] = await pool.query(
            `SELECT ${SAFE_CONNECTION_COLUMNS} FROM email_ms_user_connections WHERE company_id = ? AND tenant_user_id = ? LIMIT 1`,
            [companyId, tenantUserId]
        );
        return rows[0] || null;
    }

    // The ONLY reader of token columns. `token_fresh` is decided by the database clock (valid for another 2 minutes).
    async function getConnectionWithTokens(companyId, tenantUserId) {
        const [rows] = await pool.query(
            `SELECT ${SAFE_CONNECTION_COLUMNS}, access_token_enc, refresh_token_enc,
                    (access_token_enc IS NOT NULL AND access_expires_at IS NOT NULL AND access_expires_at > NOW() + interval '120 seconds') AS token_fresh
             FROM email_ms_user_connections WHERE company_id = ? AND tenant_user_id = ? LIMIT 1`,
            [companyId, tenantUserId]
        );
        return rows[0] || null;
    }

    async function upsertConnection({ companyId, tenantUserId, mailboxId, msTenantId, msUserOid, msAccount, scopes, accessTokenEnc, refreshTokenEnc, expiresInSeconds }) {
        const [rows] = await pool.query(
            `INSERT INTO email_ms_user_connections
                 (company_id, tenant_user_id, mailbox_id, ms_tenant_id, ms_user_oid, ms_account, status, scopes,
                  access_token_enc, refresh_token_enc, access_expires_at, last_refreshed_at, last_error, connected_at)
             VALUES (?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?, NOW() + make_interval(secs => ?), NOW(), NULL, NOW())
             ON CONFLICT (company_id, tenant_user_id) DO UPDATE SET
                 mailbox_id = EXCLUDED.mailbox_id, ms_tenant_id = EXCLUDED.ms_tenant_id, ms_user_oid = EXCLUDED.ms_user_oid,
                 ms_account = EXCLUDED.ms_account, status = 'connected', scopes = EXCLUDED.scopes,
                 access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
                 access_expires_at = EXCLUDED.access_expires_at, last_refreshed_at = NOW(), last_error = NULL,
                 connected_at = NOW(), updated_at = NOW()
             RETURNING ${SAFE_CONNECTION_COLUMNS}`,
            [companyId, tenantUserId, mailboxId, msTenantId, msUserOid, msAccount, scopes, accessTokenEnc, refreshTokenEnc, expiresInSeconds]
        );
        return rows[0];
    }

    async function updateTokens(companyId, tenantUserId, { accessTokenEnc, refreshTokenEnc, expiresInSeconds }) {
        await pool.query(
            `UPDATE email_ms_user_connections SET access_token_enc = ?, refresh_token_enc = COALESCE(?, refresh_token_enc),
                    access_expires_at = NOW() + make_interval(secs => ?), last_refreshed_at = NOW(), last_error = NULL, status = 'connected', updated_at = NOW()
             WHERE company_id = ? AND tenant_user_id = ?`,
            [accessTokenEnc, refreshTokenEnc || null, expiresInSeconds, companyId, tenantUserId]
        );
    }

    // reauth_required also WIPES the tokens: a dead refresh token has no further use and must not linger.
    async function markReauthRequired(companyId, tenantUserId, reason) {
        await pool.query(
            `UPDATE email_ms_user_connections SET status = 'reauth_required', access_token_enc = NULL, refresh_token_enc = NULL,
                    access_expires_at = NULL, last_error = ?, updated_at = NOW()
             WHERE company_id = ? AND tenant_user_id = ?`,
            [String(reason || "").slice(0, 300), companyId, tenantUserId]
        );
    }

    async function recordConnectionError(companyId, tenantUserId, message) {
        await pool.query(
            `UPDATE email_ms_user_connections SET last_error = ?, updated_at = NOW() WHERE company_id = ? AND tenant_user_id = ?`,
            [String(message || "").slice(0, 300), companyId, tenantUserId]
        );
    }

    async function deleteConnection(companyId, tenantUserId) {
        const [rows] = await pool.query(
            `DELETE FROM email_ms_user_connections WHERE company_id = ? AND tenant_user_id = ? RETURNING mailbox_id`,
            [companyId, tenantUserId]
        );
        return rows[0] || null;
    }

    async function deleteConnectionByMailbox(companyId, mailboxId) {
        const [rows] = await pool.query(
            `DELETE FROM email_ms_user_connections WHERE company_id = ? AND mailbox_id = ? RETURNING tenant_user_id`,
            [companyId, mailboxId]
        );
        return rows[0] || null;
    }

    async function deleteAllConnectionsForCompany(companyId) {
        const [rows] = await pool.query(`DELETE FROM email_ms_user_connections WHERE company_id = ? RETURNING mailbox_id`, [companyId]);
        return rows;
    }

    async function connectionHealth(companyId) {
        const [rows] = await pool.query(
            `SELECT status, COUNT(*) AS "count" FROM email_ms_user_connections WHERE company_id = ? GROUP BY status`,
            [companyId]
        );
        const summary = { connected: 0, reauth_required: 0, disabled: 0 };
        for (const row of rows) summary[row.status] = Number(row.count);
        return summary;
    }

    // ---------- per-employee preferences ----------

    async function getUserSettings(companyId, tenantUserId) {
        const [rows] = await pool.query(
            `SELECT signature_html, signature_enabled, favorite_folders FROM email_ms_user_settings WHERE company_id = ? AND tenant_user_id = ? LIMIT 1`,
            [companyId, tenantUserId]
        );
        const row = rows[0];
        let favorites = [];
        try {
            favorites = row ? JSON.parse(row.favorite_folders) : [];
        } catch (_error) {
            favorites = [];
        }
        return {
            signatureHtml: row ? row.signature_html || "" : "",
            signatureEnabled: row ? Boolean(row.signature_enabled) : false,
            favoriteFolders: Array.isArray(favorites) ? favorites : [],
        };
    }

    async function saveUserSettings(companyId, tenantUserId, { signatureHtml, signatureEnabled, favoriteFolders }) {
        await pool.query(
            `INSERT INTO email_ms_user_settings (company_id, tenant_user_id, signature_html, signature_enabled, favorite_folders)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (company_id, tenant_user_id) DO UPDATE SET
                 signature_html = EXCLUDED.signature_html, signature_enabled = EXCLUDED.signature_enabled,
                 favorite_folders = EXCLUDED.favorite_folders, updated_at = NOW()`,
            [companyId, tenantUserId, signatureHtml, Boolean(signatureEnabled), JSON.stringify(favoriteFolders || [])]
        );
    }

    // ---------- audit ----------

    // `detail` is a small object of NON-SENSITIVE facts (never message content, never a token).
    async function writeAudit({ companyId, actorUserId = null, action, targetType = null, targetId = null, detail = null }) {
        await pool.query(
            `INSERT INTO email_audit_log (company_id, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
            [companyId, actorUserId, action, targetType, targetId == null ? null : String(targetId).slice(0, 64), detail ? JSON.stringify(detail).slice(0, 1000) : null]
        );
    }

    async function listAudit(companyId, { limit = 50, beforeId = null } = {}) {
        const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
        const [rows] = await pool.query(
            `SELECT id, actor_user_id, action, target_type, target_id, detail, created_at FROM email_audit_log
             WHERE company_id = ? AND id < COALESCE(?, 9223372036854775807) ORDER BY id DESC LIMIT ?`,
            [companyId, beforeId, safeLimit]
        );
        return rows;
    }

    return {
        getCompanyConnection,
        upsertCompanyConnection,
        setCompanyConnectionStatus,
        getMailbox,
        getOwnMailbox,
        findLinkedMailboxForUser,
        setMailboxLink,
        clearMailboxLink,
        listMailboxesWithConnection,
        createOAuthState,
        consumeOAuthState,
        getConnection,
        getConnectionWithTokens,
        upsertConnection,
        updateTokens,
        markReauthRequired,
        recordConnectionError,
        deleteConnection,
        deleteConnectionByMailbox,
        deleteAllConnectionsForCompany,
        connectionHealth,
        getUserSettings,
        saveUserSettings,
        writeAudit,
        listAudit,
    };
}

module.exports = { createMsEmailStore };
