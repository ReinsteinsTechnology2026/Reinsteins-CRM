const {
    PASSWORD_MIN_LENGTH,
    PASSWORD_REQUIRE_UPPERCASE,
    PASSWORD_REQUIRE_LOWERCASE,
    PASSWORD_REQUIRE_DIGIT,
} = require("../config/securityConfig");

// ==========================================
// PASSWORD POLICY (Phase 14C)
//
// One shared validator, reused by every password-setting endpoint
// (Platform Owner change-password, legacy/tenant employee change-
// password and registration) instead of each one enforcing its own
// ad-hoc length check. Only ever applied to a NEW password being set
// -- never re-validated against an already-stored hash, so no
// existing account's ability to log in with its current password is
// ever affected by this.
// ==========================================

function validatePasswordPolicy(password) {
    if (typeof password !== "string") {
        return { valid: false, message: "Password is required." };
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
        return { valid: false, message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` };
    }
    if (PASSWORD_REQUIRE_UPPERCASE && !/[A-Z]/.test(password)) {
        return { valid: false, message: "Password must include at least one uppercase letter." };
    }
    if (PASSWORD_REQUIRE_LOWERCASE && !/[a-z]/.test(password)) {
        return { valid: false, message: "Password must include at least one lowercase letter." };
    }
    if (PASSWORD_REQUIRE_DIGIT && !/[0-9]/.test(password)) {
        return { valid: false, message: "Password must include at least one number." };
    }
    return { valid: true, message: null };
}

module.exports = { validatePasswordPolicy };
