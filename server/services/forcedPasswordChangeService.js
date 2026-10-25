const bcrypt = require("bcrypt");

const { validatePasswordPolicy } = require("../utils/passwordPolicy");
const { verifyChallenge, fingerprintMatches } = require("../utils/passwordChangeChallenge");

// ==========================================
// FORCED PASSWORD CHANGE (shared by the tenant and the legacy login)
//
// The caller (a controller) has already worked out WHICH database to use (`pool`) and the
// challenge scope; this holds the rules, so both logins behave identically.
//
// Returns { status, body } for the controller to send; on success it also returns `user`
// (the row, without the password) so the controller can issue its normal session token.
//
// Security properties, all enforced here on the server:
//   * the target user comes ONLY from the verified challenge token -- never from the request
//     body -- so one user cannot change another user's password through this flow;
//   * the challenge is bound to the current password hash (single-use);
//   * the temporary password is verified again with bcrypt;
//   * the new password must satisfy the shared policy and differ from the temporary one;
//   * the update is conditional on (a) the account still being flagged and (b) the stored hash
//     being the one that was verified, so a double submit or a race cannot apply twice;
//   * the password is hashed with bcrypt (cost 12, same as every other write path), and neither
//     passwords nor hashes are ever logged or returned.
// ==========================================

const BCRYPT_ROUNDS = 12;

const fail = (status, message, code) => ({ status, body: { success: false, message, ...(code ? { code } : {}) } });

const CHALLENGE_FAILURES = {
    expired: fail(401, "Your password-change session has expired. Please sign in again.", "CHALLENGE_EXPIRED"),
    default: fail(401, "Invalid password-change request. Please sign in again.", "CHALLENGE_INVALID"),
};

function bearerToken(req) {
    const header = req.headers && req.headers.authorization;

    return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

// Step 1: authenticate the challenge. `scope` is "tenant" or "legacy".
function readChallenge(req, scope) {
    const result = verifyChallenge(bearerToken(req), scope);

    if (!result.ok) return { error: result.reason === "expired" ? CHALLENGE_FAILURES.expired : CHALLENGE_FAILURES.default };

    return { claims: result.claims };
}

// Step 2: apply the change. `pool` is the correct database for this challenge.
async function applyForcedPasswordChange({ pool, claims, temporaryPassword, newPassword, confirmPassword }) {
    if (
        typeof temporaryPassword !== "string" || !temporaryPassword ||
        typeof newPassword !== "string" || !newPassword ||
        typeof confirmPassword !== "string" || !confirmPassword
    ) {
        return fail(400, "Temporary password, new password and confirm password are required.");
    }

    if (newPassword !== confirmPassword) {
        return fail(400, "New password and confirm password do not match.");
    }

    const policy = validatePasswordPolicy(newPassword);

    if (!policy.valid) {
        return fail(400, policy.message);
    }

    const [rows] = await pool.query(
        `SELECT id, employee_id, full_name, email, password, role, status, employment_status, system_access, designation,
                must_change_password
         FROM users WHERE id = ? LIMIT 1`,
        [claims.userId]
    );

    const user = rows[0];

    if (!user || user.status !== "active" || (user.employment_status && user.employment_status !== "active")) {
        return fail(403, "Your account is no longer active. Please contact your administrator.");
    }

    // The challenge only exists for a flagged account; if it is no longer flagged (already
    // changed, or an administrator cleared it) or the hash moved on, the challenge is spent.
    if (user.must_change_password !== true || !fingerprintMatches(claims, user.password)) {
        return CHALLENGE_FAILURES.default;
    }

    if (!(await bcrypt.compare(temporaryPassword, user.password))) {
        return fail(400, "The temporary password is incorrect.");
    }

    if (await bcrypt.compare(newPassword, user.password)) {
        return fail(400, "Your new password must be different from the temporary password.");
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // Conditional update: still flagged AND still the exact hash we verified. A concurrent
    // second submit finds 0 rows and is refused instead of applying twice.
    const [result] = await pool.query(
        `UPDATE users
         SET password = ?, must_change_password = FALSE, password_changed_at = NOW()
         WHERE id = ? AND must_change_password = TRUE AND password = ?`,
        [newHash, user.id, user.password]
    );

    const affected = result && (result.affectedRows ?? result.rowCount ?? 0);

    if (!affected) {
        return CHALLENGE_FAILURES.default;
    }

    const { password: _omitPassword, must_change_password: _omitFlag, ...safeUser } = user;

    return { status: 200, body: { success: true, message: "Password changed successfully." }, user: safeUser };
}

module.exports = { readChallenge, applyForcedPasswordChange, bearerToken };
