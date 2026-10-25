// ==========================================
// PASSWORD STATE OF AN ALREADY-ISSUED SESSION TOKEN
//
// Every authenticated request (REST via protect / tenantProtect, and the Socket.IO handshake)
// already loads the user's row. This is the one rule they all apply to that row:
//
//   * must_change_password = true  -> no normal session is valid. A session token issued
//     before the account was flagged (e.g. an 8-hour login that was still open when the
//     one-time reset was rolled out) stops working at once; the user must sign in again and
//     go through the forced password change.
//   * the token was issued before the last forced password change (password_changed_at)
//     -> it is a stale credential and is refused (credential rotation).
//
// Both answers are HTTP 401, which the existing client interceptor already treats as "session
// over, clear it and sign in again" -- no new client behaviour is needed for old tabs.
// ==========================================

const PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED";
const SESSION_SUPERSEDED = "SESSION_SUPERSEDED";

// `row`: { must_change_password, password_changed_at } (either may be undefined for a user
// that predates the columns -- then nothing is enforced for that user).
// `issuedAtSeconds`: the JWT `iat` claim.
function checkPasswordSessionState(row, issuedAtSeconds) {
    if (row && row.must_change_password === true) {
        return {
            allowed: false,
            code: PASSWORD_CHANGE_REQUIRED,
            message: "You must change your temporary password. Please sign in again to set a new password.",
        };
    }

    if (row && row.password_changed_at) {
        const changedAtSeconds = Math.floor(new Date(row.password_changed_at).getTime() / 1000);

        if (Number.isFinite(changedAtSeconds) && (!Number.isFinite(issuedAtSeconds) || issuedAtSeconds < changedAtSeconds)) {
            return {
                allowed: false,
                code: SESSION_SUPERSEDED,
                message: "Your password was changed. Please sign in again.",
            };
        }
    }

    return { allowed: true };
}

module.exports = { checkPasswordSessionState, PASSWORD_CHANGE_REQUIRED, SESSION_SUPERSEDED };
