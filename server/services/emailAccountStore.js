const { createMsEmailStore } = require("./msEmailStore");

// ==========================================
// EMAIL ACCOUNT STORE -- the only module that runs SQL for connected personal / work email accounts.
//
// ISOLATION RULES (each one is tested in _email_accounts_pg_cases.js):
//   * every employee-facing read or change is scoped by BOTH company_id and tenant_user_id IN THE QUERY, taken from the verified
//     session. An account id from a request is only ever a lookup key INSIDE that scope, so one employee can never reach
//     another employee's account by guessing ids (employee ids repeat across companies: tenants have their own user tables);
//   * token columns are selected by exactly two functions (getWithTokens / getWithTokensById); every list and summary uses the safe
//     column list, so no screen or API response can contain a token;
//   * the OAuth state is consumed in ONE atomic UPDATE ... WHERE consumed_at IS NULL AND expires_at > NOW();
//   * times are produced and compared by the database (NOW(), make_interval) so server time zones cannot skew an expiry.
// The signature / preferences and the audit log reuse the existing tables through msEmailStore.
// ==========================================

const SAFE_COLUMNS = `
    id, company_id, tenant_user_id, provider, account_kind, email_address, display_name, provider_tenant_id, status, scopes,
    last_error, last_sync_at, next_sync_at, sync_failures, sync_error, unread_inbox, unread_checked_at, color, connected_at,
    access_expires_at, last_refreshed_at, created_at, updated_at
`;

function createEmailAccountStore(pool = require("../config/platformDb")) {
    const base = createMsEmailStore(pool);

    // ---------- reading (employee scope) ----------
    async function list(companyId, userId) {
        const [rows] = await pool.query(
            `SELECT ${SAFE_COLUMNS} FROM email_accounts WHERE company_id = ? AND tenant_user_id = ? ORDER BY connected_at ASC, id ASC`,
            [companyId, userId]
        );
        return rows;
    }

    async function get(companyId, userId, accountId) {
        const [rows] = await pool.query(
            `SELECT ${SAFE_COLUMNS} FROM email_accounts WHERE id = ? AND company_id = ? AND tenant_user_id = ? LIMIT 1`,
            [accountId, companyId, userId]
        );
        return rows[0] || null;
    }

    const TOKEN_SELECT = `${SAFE_COLUMNS}, provider_account_id, access_token_enc, refresh_token_enc, sync_cursor,
        (access_token_enc IS NOT NULL AND access_expires_at IS NOT NULL AND access_expires_at > NOW() + interval '120 seconds') AS token_fresh`;

    // The employee-scoped reader of token columns.
    async function getWithTokens(companyId, userId, accountId) {
        const [rows] = await pool.query(
            `SELECT ${TOKEN_SELECT} FROM email_accounts WHERE id = ? AND company_id = ? AND tenant_user_id = ? LIMIT 1`,
            [accountId, companyId, userId]
        );
        return rows[0] || null;
    }

    // The background sync's reader (it works from rows it selected itself, never from a request).
    async function getWithTokensById(accountId) {
        const [rows] = await pool.query(`SELECT ${TOKEN_SELECT} FROM email_accounts WHERE id = ? LIMIT 1`, [accountId]);
        return rows[0] || null;
    }

    async function findByIdentity(companyId, userId, provider, providerAccountId) {
        const [rows] = await pool.query(
            `SELECT id FROM email_accounts WHERE company_id = ? AND tenant_user_id = ? AND provider = ? AND provider_account_id = ? LIMIT 1`,
            [companyId, userId, provider, providerAccountId]
        );
        return rows[0] || null;
    }

    // Is this provider identity connected by ANYONE (any company)? Used to decide whether revoking a Google grant is safe.
    async function existsProviderAccount(provider, providerAccountId) {
        const [rows] = await pool.query(`SELECT 1 AS "x" FROM email_accounts WHERE provider = ? AND provider_account_id = ? LIMIT 1`, [provider, providerAccountId]);
        return rows.length > 0;
    }

    async function count(companyId, userId) {
        const [[row]] = await pool.query(`SELECT COUNT(*) AS "n" FROM email_accounts WHERE company_id = ? AND tenant_user_id = ?`, [companyId, userId]);
        return Number(row.n);
    }

    // ---------- connecting ----------
    async function upsert({ companyId, userId, provider, kind, email, displayName, providerAccountId, providerTenantId, scopes, accessTokenEnc, refreshTokenEnc, expiresInSeconds }) {
        const [rows] = await pool.query(
            `INSERT INTO email_accounts
                 (company_id, tenant_user_id, provider, account_kind, email_address, display_name, provider_account_id, provider_tenant_id, status, scopes,
                  access_token_enc, refresh_token_enc, access_expires_at, last_refreshed_at, last_error, sync_failures, sync_error, next_sync_at, connected_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?, NOW() + make_interval(secs => ?), NOW(), NULL, 0, NULL, NOW(), NOW())
             ON CONFLICT (company_id, tenant_user_id, provider, provider_account_id) DO UPDATE SET
                 account_kind = EXCLUDED.account_kind, email_address = EXCLUDED.email_address,
                 display_name = COALESCE(EXCLUDED.display_name, email_accounts.display_name), provider_tenant_id = EXCLUDED.provider_tenant_id,
                 status = 'connected', scopes = EXCLUDED.scopes, access_token_enc = EXCLUDED.access_token_enc,
                 refresh_token_enc = EXCLUDED.refresh_token_enc, access_expires_at = EXCLUDED.access_expires_at, last_refreshed_at = NOW(),
                 last_error = NULL, sync_failures = 0, sync_error = NULL, next_sync_at = NOW(), connected_at = NOW(), updated_at = NOW()
             RETURNING ${SAFE_COLUMNS}`,
            [companyId, userId, provider, kind, email, displayName, providerAccountId, providerTenantId, scopes, accessTokenEnc, refreshTokenEnc, expiresInSeconds]
        );
        return rows[0];
    }

    async function updateTokens(accountId, { accessTokenEnc, refreshTokenEnc, expiresInSeconds }) {
        await pool.query(
            `UPDATE email_accounts SET access_token_enc = ?, refresh_token_enc = COALESCE(?, refresh_token_enc),
                    access_expires_at = NOW() + make_interval(secs => ?), last_refreshed_at = NOW(), last_error = NULL, status = 'connected', updated_at = NOW()
             WHERE id = ?`,
            [accessTokenEnc, refreshTokenEnc || null, expiresInSeconds, accountId]
        );
    }

    // A dead refresh token has no further use and must not linger: reauth_required also WIPES the stored tokens.
    async function markReauth(accountId, reason) {
        await pool.query(
            `UPDATE email_accounts SET status = 'reauth_required', access_token_enc = NULL, refresh_token_enc = NULL, access_expires_at = NULL,
                    last_error = ?, updated_at = NOW() WHERE id = ?`,
            [String(reason || "").slice(0, 300), accountId]
        );
    }

    async function recordError(accountId, message) {
        await pool.query(`UPDATE email_accounts SET last_error = ?, updated_at = NOW() WHERE id = ?`, [String(message || "").slice(0, 300), accountId]);
    }

    async function updateProfile(companyId, userId, accountId, { displayName, color }) {
        const [rows] = await pool.query(
            `UPDATE email_accounts SET display_name = COALESCE(?, display_name), color = COALESCE(?, color), updated_at = NOW()
             WHERE id = ? AND company_id = ? AND tenant_user_id = ? RETURNING ${SAFE_COLUMNS}`,
            [displayName === undefined ? null : displayName, color === undefined ? null : color, accountId, companyId, userId]
        );
        return rows[0] || null;
    }

    async function remove(companyId, userId, accountId) {
        const [rows] = await pool.query(`DELETE FROM email_accounts WHERE id = ? AND company_id = ? AND tenant_user_id = ? RETURNING id, provider, account_kind`, [accountId, companyId, userId]);
        return rows[0] || null;
    }

    // ---------- OAuth state ----------
    async function createState({ companyId, userId, provider, accountId, stateHash, nonceHash, verifierEnc, returnPortal, ttlSeconds }) {
        await pool.query(`DELETE FROM email_account_oauth_states WHERE expires_at < NOW() - interval '1 day'`);
        await pool.query(
            `INSERT INTO email_account_oauth_states (state_hash, company_id, tenant_user_id, provider, account_id, nonce_hash, code_verifier_enc, return_portal, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW() + make_interval(secs => ?))`,
            [stateHash, companyId, userId, provider, accountId || null, nonceHash, verifierEnc, returnPortal === "admin" ? "admin" : "employee", ttlSeconds]
        );
    }

    // Atomic and single use: returns the row only if the state existed, was unused and had not expired.
    async function consumeState(stateHash) {
        const [rows] = await pool.query(
            `UPDATE email_account_oauth_states SET consumed_at = NOW()
             WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > NOW()
             RETURNING company_id, tenant_user_id, provider, account_id, nonce_hash, code_verifier_enc, return_portal`,
            [stateHash]
        );
        return rows[0] || null;
    }

    // ---------- sync bookkeeping ----------
    // CLAIMS due accounts in one atomic statement: each claimed row's next_sync_at is pushed out by a lease, and FOR UPDATE SKIP
    // LOCKED means two server processes can never claim the same account. If a sync crashes, the lease simply runs out and the
    // account is picked up again. (This is also what keeps two overlapping cycles from syncing one account twice.)
    async function claimDue(limit, leaseSeconds = 300) {
        const [rows] = await pool.query(
            `UPDATE email_accounts SET next_sync_at = NOW() + make_interval(secs => ?)
             WHERE id IN (
                 SELECT id FROM email_accounts
                 WHERE status = 'connected' AND (next_sync_at IS NULL OR next_sync_at <= NOW())
                 ORDER BY next_sync_at ASC NULLS FIRST LIMIT ? FOR UPDATE SKIP LOCKED
             )
             RETURNING id, company_id, tenant_user_id, provider`,
            [leaseSeconds, limit]
        );
        return rows;
    }

    async function syncSucceeded(accountId, { cursor, unread, nextInSeconds, note = null }) {
        await pool.query(
            `UPDATE email_accounts SET sync_cursor = COALESCE(?, sync_cursor), unread_inbox = ?, unread_checked_at = NOW(), last_sync_at = NOW(),
                    next_sync_at = NOW() + make_interval(secs => ?), sync_failures = 0, sync_error = ?, updated_at = NOW() WHERE id = ?`,
            [cursor == null ? null : String(cursor), unread, nextInSeconds, note, accountId]
        );
    }

    async function syncFailed(accountId, message, nextInSeconds) {
        await pool.query(
            `UPDATE email_accounts SET sync_failures = sync_failures + 1, sync_error = ?, next_sync_at = NOW() + make_interval(secs => ?), updated_at = NOW() WHERE id = ?`,
            [String(message || "").slice(0, 300), nextInSeconds, accountId]
        );
    }

    async function syncNow(accountId) {
        await pool.query(`UPDATE email_accounts SET next_sync_at = NOW() WHERE id = ? AND status = 'connected'`, [accountId]);
    }

    async function setUnread(accountId, unread) {
        await pool.query(`UPDATE email_accounts SET unread_inbox = ?, unread_checked_at = NOW() WHERE id = ?`, [unread, accountId]);
    }

    async function connectedByEmail(provider, email) {
        const [rows] = await pool.query(
            `SELECT id, company_id, tenant_user_id FROM email_accounts WHERE provider = ? AND LOWER(email_address) = LOWER(?) AND status = 'connected'`,
            [provider, email]
        );
        return rows;
    }

    // ---------- new-mail events: the duplicate guard ----------
    async function recordEvent(accountId, providerMessageId) {
        const [rows] = await pool.query(
            `INSERT INTO email_new_mail_events (account_id, provider_message_id) VALUES (?, ?) ON CONFLICT (account_id, provider_message_id) DO NOTHING RETURNING id`,
            [accountId, String(providerMessageId).slice(0, 255)]
        );
        return rows.length > 0; // true only the FIRST time this message is seen for this account
    }

    async function purgeEvents(days = 14) {
        await pool.query(`DELETE FROM email_new_mail_events WHERE created_at < NOW() - make_interval(days => ?)`, [days]);
    }

    // ---------- push subscriptions ----------
    async function getSubscription(accountId) {
        const [rows] = await pool.query(`SELECT * FROM email_push_subscriptions WHERE account_id = ? LIMIT 1`, [accountId]);
        return rows[0] || null;
    }

    async function saveSubscription(accountId, { provider, subscriptionId, clientStateHash, resource, expiresAt, status = "active", lastError = null }) {
        await pool.query(
            `INSERT INTO email_push_subscriptions (account_id, provider, subscription_id, client_state_hash, resource, expires_at, status, last_error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (account_id) DO UPDATE SET provider = EXCLUDED.provider, subscription_id = EXCLUDED.subscription_id,
                 client_state_hash = COALESCE(EXCLUDED.client_state_hash, email_push_subscriptions.client_state_hash), resource = EXCLUDED.resource,
                 expires_at = EXCLUDED.expires_at, status = EXCLUDED.status, last_error = EXCLUDED.last_error, updated_at = NOW()`,
            [accountId, provider, subscriptionId || null, clientStateHash || null, resource || null, expiresAt || null, status, lastError]
        );
    }

    async function findSubscription(subscriptionId) {
        const [rows] = await pool.query(
            `SELECT s.account_id, s.client_state_hash, s.provider, a.company_id, a.tenant_user_id
             FROM email_push_subscriptions s JOIN email_accounts a ON a.id = s.account_id WHERE s.subscription_id = ? LIMIT 1`,
            [String(subscriptionId).slice(0, 255)]
        );
        return rows[0] || null;
    }

    async function touchNotification(accountId) {
        await pool.query(`UPDATE email_push_subscriptions SET last_notification_at = NOW() WHERE account_id = ?`, [accountId]);
    }

    // Subscriptions that expire within the next `seconds` (or have no expiry known) and belong to a connected account.
    async function subscriptionsExpiringWithin(seconds, limit = 100) {
        const [rows] = await pool.query(
            `SELECT s.account_id, s.provider, s.subscription_id FROM email_push_subscriptions s JOIN email_accounts a ON a.id = s.account_id
             WHERE a.status = 'connected' AND s.status = 'active' AND (s.expires_at IS NULL OR s.expires_at < NOW() + make_interval(secs => ?)) LIMIT ?`,
            [seconds, limit]
        );
        return rows;
    }

    async function connectedWithoutSubscription(provider, limit = 100) {
        const [rows] = await pool.query(
            `SELECT a.id FROM email_accounts a LEFT JOIN email_push_subscriptions s ON s.account_id = a.id
             WHERE a.provider = ? AND a.status = 'connected' AND s.id IS NULL LIMIT ?`,
            [provider, limit]
        );
        return rows;
    }

    // ---------- admin view: CONNECTION STATUS only (no mail, no counts, no addresses beyond what the caller masks) ----------
    async function listForCompany(companyId) {
        const [rows] = await pool.query(
            `SELECT id, tenant_user_id, provider, account_kind, email_address, status, last_sync_at, sync_error, last_error, connected_at
             FROM email_accounts WHERE company_id = ? ORDER BY connected_at DESC, id DESC`,
            [companyId]
        );
        return rows;
    }

    async function getForCompany(companyId, accountId) {
        const [rows] = await pool.query(`SELECT ${SAFE_COLUMNS} FROM email_accounts WHERE id = ? AND company_id = ? LIMIT 1`, [accountId, companyId]);
        return rows[0] || null;
    }

    async function removeForCompany(companyId, accountId) {
        const [rows] = await pool.query(`DELETE FROM email_accounts WHERE id = ? AND company_id = ? RETURNING id, tenant_user_id, provider`, [accountId, companyId]);
        return rows[0] || null;
    }

    return {
        ...base,
        list,
        get,
        getWithTokens,
        getWithTokensById,
        findByIdentity,
        existsProviderAccount,
        count,
        upsert,
        updateTokens,
        markReauth,
        recordError,
        updateProfile,
        remove,
        createState,
        consumeState,
        claimDue,
        syncSucceeded,
        syncFailed,
        syncNow,
        setUnread,
        connectedByEmail,
        recordEvent,
        purgeEvents,
        getSubscription,
        saveSubscription,
        findSubscription,
        touchNotification,
        subscriptionsExpiringWithin,
        connectedWithoutSubscription,
        listForCompany,
        getForCompany,
        removeForCompany,
    };
}

module.exports = { createEmailAccountStore, SAFE_COLUMNS };
