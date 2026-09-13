const platformPool = require("../config/platformDb");

// ==========================================
// PLATFORM USER SERVICE (Phase 2B, extended Phase 14)
//
// Pure DB logic against groworgs_platform_db.platform_users
// ONLY -- this file never touches the tenant `users` table
// and never imports config/db.js. Mirrors the existing
// service/controller layering convention already used
// throughout server/services/*.js.
//
// Phase 14 additions: account lockout, TOTP 2FA, and token
// versioning. totp_secret and backup_codes (password_hash too) are
// NEVER included in getByEmail/getActiveById -- only the narrow,
// purpose-specific getByIdWithHash/getByIdWithSecrets functions ever
// select them, and neither is ever used to build an API response
// directly (every controller maps to an explicit safe shape).
// ==========================================

const getByEmail = async (email) => {
    const [rows] = await platformPool.query(
        `SELECT id, name, email, password_hash, role, status,
                failed_login_attempts, locked_until, totp_enabled, token_version,
                created_at, updated_at
         FROM platform_users
         WHERE email = ?
         LIMIT 1`,
        [email]
    );
    return rows[0] || null;
};

const getActiveById = async (id) => {
    const [rows] = await platformPool.query(
        `SELECT id, name, email, role, status, totp_enabled, token_version
         FROM platform_users
         WHERE id = ? AND status = 'active'
         LIMIT 1`,
        [id]
    );
    return rows[0] || null;
};

// Includes password_hash -- internal use ONLY (verifying the current
// password before a change), never returned in any API response. Every
// route-facing lookup in this file otherwise deliberately omits this
// column (see getActiveById/getByEmail above).
const getByIdWithHash = async (id) => {
    const [rows] = await platformPool.query(
        `SELECT id, name, email, password_hash, role, status
         FROM platform_users
         WHERE id = ?
         LIMIT 1`,
        [id]
    );
    return rows[0] || null;
};

// Phase 14D -- the ONLY lookup that includes totp_secret/backup_codes.
// Used exclusively by the 2FA setup/confirm/verify/disable flows in
// platformAuthController.js, never by anything that builds a
// client-facing response from the raw row.
const getByIdWithSecrets = async (id) => {
    const [rows] = await platformPool.query(
        `SELECT id, name, email, password_hash, role, status,
                totp_secret, totp_enabled, backup_codes, token_version
         FROM platform_users
         WHERE id = ?
         LIMIT 1`,
        [id]
    );
    return rows[0] || null;
};

const updatePassword = async (id, passwordHash) => {
    const [result] = await platformPool.query(
        `UPDATE platform_users SET password_hash = ? WHERE id = ?`,
        [passwordHash, id]
    );
    return result.affectedRows > 0;
};

// passwordHash must already be hashed (bcrypt) by the caller --
// this service never hashes/compares passwords itself, matching
// the existing convention where authController.js owns bcrypt
// calls directly rather than a service layer doing it silently.

const create = async ({ name, email, passwordHash, role = "platform_owner" }) => {

    const existing = await getByEmail(email);

    if (existing) {
        const error = new Error("A platform user with this email already exists.");
        error.code = "PLATFORM_USER_EMAIL_TAKEN";
        throw error;
    }

    const [result] = await platformPool.query(
        `INSERT INTO platform_users (name, email, password_hash, role, status)
         VALUES (?, ?, ?, ?, 'active')`,
        [name, email, passwordHash, role]
    );

    return { id: result.insertId, name, email, role, status: "active" };

};

// Phase 12N -- fan-out target list for platform-wide notifications
// (subscription lifecycle alerts, etc). Active accounts only, so a
// deactivated Platform Owner stops receiving new alerts the same way
// their login already stops working (getActiveById).
const listActiveOwners = async () => {
    const [rows] = await platformPool.query(
        `SELECT id, name, email FROM platform_users WHERE status = 'active' AND role = 'platform_owner'`
    );
    return rows;
};

// ==========================================
// ACCOUNT LOCKOUT (Phase 14B)
//
// Guarded, atomic increment -- MySQL applies `failed_login_attempts
// + 1` server-side in one UPDATE, so two near-simultaneous failed
// attempts can't race and under-count. Locking is a pure consequence
// of the resulting count reaching the threshold, decided by the
// CALLER (platformAuthController.js) after reading the updated row,
// keeping the "what counts as locked" policy in one place
// (config/securityConfig.js) rather than duplicated here.
// ==========================================

const recordFailedLogin = async (id) => {
    await platformPool.query(
        `UPDATE platform_users SET failed_login_attempts = failed_login_attempts + 1, last_failed_login_at = NOW() WHERE id = ?`,
        [id]
    );
    const [rows] = await platformPool.query(
        `SELECT failed_login_attempts FROM platform_users WHERE id = ?`,
        [id]
    );
    return rows[0]?.failed_login_attempts ?? 0;
};

const lockAccount = async (id, lockedUntil) => {
    await platformPool.query(`UPDATE platform_users SET locked_until = ? WHERE id = ?`, [lockedUntil, id]);
};

const recordSuccessfulLogin = async (id) => {
    await platformPool.query(
        `UPDATE platform_users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = ?`,
        [id]
    );
};

// Not wired to any API endpoint in this phase (a self-service
// "unlock" would defeat the lockout's own purpose) -- exists for a
// future ops script / support workflow, and for this phase's own test
// suite to reset state between scenarios. Recovery for a real locked-
// out Platform Owner is the automatic expiry of locked_until.
const unlockAccount = async (id) => {
    await platformPool.query(
        `UPDATE platform_users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?`,
        [id]
    );
};

// ==========================================
// TOKEN VERSIONING (Phase 14E)
//
// Incremented after any security-relevant event (password change, 2FA
// enabled, 2FA disabled) -- platformAuthMiddleware.js compares this
// against the `tokenVersion` claim embedded in the JWT at login time,
// so an already-issued token stops working immediately after one of
// these events, without needing a server-side session/blacklist store.
// ==========================================

const incrementTokenVersion = async (id) => {
    await platformPool.query(`UPDATE platform_users SET token_version = token_version + 1 WHERE id = ?`, [id]);
};

// ==========================================
// TWO-FACTOR AUTHENTICATION (Phase 14D)
// ==========================================

// Stores a secret WITHOUT enabling 2FA yet -- the "pending enrollment"
// state (Phase 14D requirement: "verify the first TOTP code before
// activating"). totp_enabled stays false until confirmTwoFactor
// below flips it.
const setPendingTwoFactorSecret = async (id, secret) => {
    await platformPool.query(`UPDATE platform_users SET totp_secret = ? WHERE id = ?`, [secret, id]);
};

// Activates 2FA (secret already stored by setPendingTwoFactorSecret,
// re-confirmed by the caller's TOTP check before calling this) and
// stores the hashed backup codes. Bumps token_version -- enabling 2FA
// is a security-relevant event, per Phase 14E.
const enableTwoFactor = async (id, hashedBackupCodes) => {
    await platformPool.query(
        `UPDATE platform_users SET totp_enabled = TRUE, backup_codes = ?, token_version = token_version + 1 WHERE id = ?`,
        [JSON.stringify(hashedBackupCodes), id]
    );
};

const disableTwoFactor = async (id) => {
    await platformPool.query(
        `UPDATE platform_users SET totp_enabled = FALSE, totp_secret = NULL, backup_codes = NULL, token_version = token_version + 1 WHERE id = ?`,
        [id]
    );
};

const setBackupCodes = async (id, hashedBackupCodes) => {
    await platformPool.query(`UPDATE platform_users SET backup_codes = ? WHERE id = ?`, [JSON.stringify(hashedBackupCodes), id]);
};

module.exports = {
    getByEmail,
    getActiveById,
    getByIdWithHash,
    getByIdWithSecrets,
    updatePassword,
    create,
    listActiveOwners,
    recordFailedLogin,
    lockAccount,
    recordSuccessfulLogin,
    unlockAccount,
    incrementTokenVersion,
    setPendingTwoFactorSecret,
    enableTwoFactor,
    disableTwoFactor,
    setBackupCodes,
};
