const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const platformUserService = require("../services/platformUserService");
const platformAuditService = require("../services/platformAuditService");
const platformNotificationService = require("../services/platformNotificationService");
const platformTwoFactorService = require("../services/platformTwoFactorService");
const { validatePasswordPolicy } = require("../utils/passwordPolicy");
const {
    LOGIN_LOCKOUT_THRESHOLD,
    LOGIN_LOCKOUT_DURATION_MINUTES,
    TWO_FACTOR_PENDING_TOKEN_EXPIRY,
} = require("../config/securityConfig");

// ==========================================
// PLATFORM AUTH CONTROLLER (Phase 2B, extended Phase 14)
//
// Completely isolated from server/controllers/authController.js
// (the existing tenant login). Authenticates ONLY against
// groworgs_platform_db.platform_users -- never queries the
// tenant `users` table, never touches JWT_SECRET.
//
// JWT isolation: signed with a SEPARATE secret
// (PLATFORM_JWT_SECRET, distinct from the tenant JWT_SECRET)
// plus a distinct issuer/audience/type. A wrong-secret token
// fails jwt.verify() outright -- it is not merely rejected by
// a downstream "if (type !== ...)" check, so a tenant token can
// never be mistaken for a platform token (or vice versa) even
// if some future code forgot to check the `type` claim. See
// platformAuthMiddleware.js for the verifying side.
//
// Phase 14 additions: account lockout (login), TOTP 2FA (login +
// enrollment endpoints), and token versioning (every JWT this file
// issues now embeds `tokenVersion`; platformAuthMiddleware.js rejects
// a token whose version doesn't match the account's CURRENT
// token_version, invalidating old sessions after a password change or
// 2FA enable/disable without needing a server-side session store).
// ==========================================

const PLATFORM_JWT_ISSUER = "groworgs-platform";
const PLATFORM_JWT_AUDIENCE = "groworgs-platform-owner";
const PLATFORM_JWT_ALGORITHM = "HS256";

function signFullToken(platformUser) {
    return jwt.sign(
        { userId: platformUser.id, type: "platform_owner", tokenVersion: platformUser.token_version },
        process.env.PLATFORM_JWT_SECRET,
        { expiresIn: "8h", issuer: PLATFORM_JWT_ISSUER, audience: PLATFORM_JWT_AUDIENCE, algorithm: PLATFORM_JWT_ALGORITHM }
    );
}

function signPendingTwoFactorToken(platformUserId) {
    return jwt.sign(
        { userId: platformUserId, type: "platform_owner_2fa_pending" },
        process.env.PLATFORM_JWT_SECRET,
        { expiresIn: TWO_FACTOR_PENDING_TOKEN_EXPIRY, issuer: PLATFORM_JWT_ISSUER, audience: PLATFORM_JWT_AUDIENCE, algorithm: PLATFORM_JWT_ALGORITHM }
    );
}

const login = async (req, res) => {

    try {

        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: "Email and password are required",
            });
        }

        const platformUser = await platformUserService.getByEmail(email);

        // Same generic message whether the email doesn't exist or the
        // password is wrong -- never reveal which one failed.

        if (!platformUser) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password",
            });
        }

        if (platformUser.status !== "active") {
            return res.status(403).json({
                success: false,
                message: "This Platform Owner account is not active",
            });
        }

        // Phase 14B -- account lockout, checked BEFORE the password
        // comparison so a locked account never even reaches bcrypt
        // (also closes the timing gap that would otherwise exist
        // between "locked" and "not locked" responses).
        if (platformUser.locked_until && new Date(platformUser.locked_until) > new Date()) {
            return res.status(429).json({
                success: false,
                message: "Too many failed login attempts. Please try again later.",
            });
        }

        const passwordMatches = await bcrypt.compare(password, platformUser.password_hash);

        if (!passwordMatches) {
            const newCount = await platformUserService.recordFailedLogin(platformUser.id);
            const midpoint = Math.ceil(LOGIN_LOCKOUT_THRESHOLD / 2);

            if (newCount === midpoint) {
                await platformAuditService.logAction({
                    platformUserId: platformUser.id, actionType: "login_failed_repeated", targetType: "platform_user", targetId: platformUser.id,
                    metadata: { failedAttempts: newCount },
                }).catch((auditError) => console.error("[platform] audit log failed (login_failed_repeated):", auditError.message));
            }

            if (newCount >= LOGIN_LOCKOUT_THRESHOLD) {
                const lockedUntil = new Date(Date.now() + LOGIN_LOCKOUT_DURATION_MINUTES * 60 * 1000);
                await platformUserService.lockAccount(platformUser.id, lockedUntil);

                await platformAuditService.logAction({
                    platformUserId: platformUser.id, actionType: "account_locked", targetType: "platform_user", targetId: platformUser.id,
                    metadata: { failedAttempts: newCount, lockedUntil: lockedUntil.toISOString() },
                }).catch((auditError) => console.error("[platform] audit log failed (account_locked):", auditError.message));

                await platformNotificationService.notifyAllOwners({
                    title: "Platform Owner account locked",
                    message: `${newCount} failed login attempts were made against this account. It is locked until ${lockedUntil.toLocaleString()}.`,
                    type: "account_locked",
                }).catch((notifyError) => console.error("[platform] notification failed (account_locked):", notifyError.message));
            }

            return res.status(401).json({
                success: false,
                message: "Invalid email or password",
            });
        }

        await platformUserService.recordSuccessfulLogin(platformUser.id);

        // Phase 14D -- if 2FA is enabled, password alone is not enough:
        // issue only a short-lived pending token and require a second
        // call (verifyTwoFactorLogin) with a valid TOTP/backup code
        // before the real platform JWT is ever issued.
        if (platformUser.totp_enabled) {
            const twoFactorToken = signPendingTwoFactorToken(platformUser.id);
            return res.json({ success: true, requiresTwoFactor: true, twoFactorToken });
        }

        const token = signFullToken(platformUser);

        return res.json({
            success: true,
            message: "Login successful",
            token,
            platformUser: {
                id: platformUser.id,
                name: platformUser.name,
                email: platformUser.email,
                role: platformUser.role,
            },
        });

    } catch (error) {

        console.error("Platform Login Error:", error.message);

        return res.status(500).json({
            success: false,
            message: "Unable to log in",
        });

    }

};

// ==========================================
// VERIFY 2FA (Phase 14D) -- second step of login when totp_enabled.
// Accepts either a 6-digit TOTP code or a backup code (XXXXX-XXXXX).
// A backup code is consumed (removed) the moment it's used
// successfully -- one-time use, enforced server-side.
// ==========================================

const verifyTwoFactorLogin = async (req, res) => {
    try {
        const { twoFactorToken, code } = req.body || {};

        if (!twoFactorToken || !code || typeof code !== "string") {
            return res.status(400).json({ success: false, message: "Verification code is required." });
        }

        let decoded;
        try {
            decoded = jwt.verify(twoFactorToken, process.env.PLATFORM_JWT_SECRET, {
                issuer: PLATFORM_JWT_ISSUER, audience: PLATFORM_JWT_AUDIENCE, algorithms: [PLATFORM_JWT_ALGORITHM],
            });
        } catch (_verifyError) {
            return res.status(401).json({ success: false, message: "Verification session expired. Please log in again." });
        }

        if (decoded.type !== "platform_owner_2fa_pending" || !decoded.userId) {
            return res.status(401).json({ success: false, message: "Invalid verification session." });
        }

        const user = await platformUserService.getByIdWithSecrets(decoded.userId);
        if (!user || user.status !== "active" || !user.totp_enabled || !user.totp_secret) {
            return res.status(401).json({ success: false, message: "Invalid verification session." });
        }

        const trimmedCode = code.trim();
        let usedBackupCode = false;

        let valid = platformTwoFactorService.verifyTotpCode(trimmedCode, user.totp_secret);

        if (!valid) {
            const backupResult = await platformTwoFactorService.verifyAndConsumeBackupCode(trimmedCode, user.backup_codes);
            if (backupResult.valid) {
                valid = true;
                usedBackupCode = true;
                await platformUserService.setBackupCodes(user.id, backupResult.remaining);
            }
        }

        if (!valid) {
            return res.status(401).json({ success: false, message: "Invalid verification code." });
        }

        if (usedBackupCode) {
            await platformAuditService.logAction({
                platformUserId: user.id, actionType: "backup_code_used", targetType: "platform_user", targetId: user.id,
            }).catch((auditError) => console.error("[platform] audit log failed (backup_code_used):", auditError.message));

            await platformNotificationService.notifyAllOwners({
                title: "Backup code used to sign in",
                message: `A 2FA backup code was used to log in to the Platform Owner account. If this wasn't you, disable 2FA and change your password immediately.`,
                type: "backup_code_used",
            }).catch((notifyError) => console.error("[platform] notification failed (backup_code_used):", notifyError.message));
        }

        const token = signFullToken(user);

        return res.json({
            success: true,
            message: "Login successful",
            token,
            platformUser: { id: user.id, name: user.name, email: user.email, role: user.role },
        });

    } catch (error) {
        console.error("Platform 2FA Verify Error:", error.message);
        return res.status(500).json({ success: false, message: "Unable to verify code." });
    }
};

// ==========================================
// CHANGE PASSWORD (Settings page)
//
// PATCH /api/platform/auth/password -- platformProtect only, so
// req.platformUser is already a verified, active Platform Owner. This
// still independently re-verifies the CURRENT password before
// accepting a new one (never trusts "I'm logged in" alone for a
// credential change) and reuses the exact same bcrypt cost (12) and
// column (password_hash) as login/_create_platform_owner.js -- no
// second hashing scheme, no new table. Never logs or echoes back
// either password.
//
// Phase 14C/14E: password policy now enforced via the shared
// validator, and a successful change bumps token_version -- every
// OTHER already-issued session for this account stops working
// immediately (a real, common "someone changed my password, kick
// everyone else out" security property).
// ==========================================

const changePassword = async (req, res) => {

    try {

        const { currentPassword, newPassword } = req.body || {};

        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                message: "Current password and new password are required",
            });
        }

        const policyResult = validatePasswordPolicy(newPassword);
        if (!policyResult.valid) {
            return res.status(400).json({ success: false, message: policyResult.message });
        }

        const fullUser = await platformUserService.getByIdWithHash(req.platformUser.id);

        if (!fullUser) {
            return res.status(401).json({ success: false, message: "Platform account not found" });
        }

        const currentMatches = await bcrypt.compare(currentPassword, fullUser.password_hash);

        if (!currentMatches) {
            return res.status(401).json({ success: false, message: "Current password is incorrect" });
        }

        const newPasswordHash = await bcrypt.hash(newPassword, 12);

        await platformUserService.updatePassword(fullUser.id, newPasswordHash);
        await platformUserService.incrementTokenVersion(fullUser.id);

        // Never logs either password/hash -- platformAuditService also
        // independently scrubs any forbidden key as defense in depth,
        // but this call site never passes one in the first place.
        await platformAuditService.logAction({
            platformUserId: fullUser.id, actionType: "platform_password_changed", targetType: "platform_user", targetId: fullUser.id,
        }).catch((auditError) => console.error("[platform] audit log failed (platform_password_changed):", auditError.message));

        return res.json({ success: true, message: "Password updated successfully. You will need to log in again on your other devices." });

    } catch (error) {

        console.error("Platform Change Password Error:", error.message);

        return res.status(500).json({ success: false, message: "Unable to update password" });

    }

};

// ==========================================
// TWO-FACTOR ENROLLMENT (Phase 14D) -- all platformProtect-guarded.
// ==========================================

const getTwoFactorStatus = async (req, res) => {
    try {
        const user = await platformUserService.getByIdWithSecrets(req.platformUser.id);
        if (!user) {
            return res.status(404).json({ success: false, message: "Platform account not found." });
        }
        return res.json({
            success: true,
            enabled: Boolean(user.totp_enabled),
            backupCodesRemaining: Array.isArray(user.backup_codes) ? user.backup_codes.length : 0,
        });
    } catch (error) {
        console.error("[platform] getTwoFactorStatus failed:", error.message);
        return res.status(500).json({ success: false, message: "Unable to load 2FA status." });
    }
};

// POST /2fa/setup -- requires current password, generates a new
// secret and stores it as PENDING (totp_enabled stays false until
// confirmTwoFactor below verifies a real code from it). The secret
// and QR code are returned ONLY in this one response -- never again.
const setupTwoFactor = async (req, res) => {
    try {
        const { password } = req.body || {};
        if (!password) {
            return res.status(400).json({ success: false, message: "Current password is required." });
        }

        const user = await platformUserService.getByIdWithSecrets(req.platformUser.id);
        if (!user) {
            return res.status(404).json({ success: false, message: "Platform account not found." });
        }
        if (user.totp_enabled) {
            return res.status(409).json({ success: false, message: "Two-factor authentication is already enabled. Disable it first to set up again." });
        }

        const passwordMatches = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatches) {
            return res.status(401).json({ success: false, message: "Current password is incorrect." });
        }

        const secret = platformTwoFactorService.generateSecret();
        await platformUserService.setPendingTwoFactorSecret(user.id, secret);

        const otpAuthUrl = platformTwoFactorService.buildOtpAuthUrl(user.email, secret);
        const qrCodeDataUrl = await platformTwoFactorService.generateQrCodeDataUrl(otpAuthUrl);

        return res.json({ success: true, secret, otpAuthUrl, qrCodeDataUrl });
    } catch (error) {
        console.error("[platform] setupTwoFactor failed:", error.message);
        return res.status(500).json({ success: false, message: "Unable to start 2FA setup." });
    }
};

// POST /2fa/confirm -- verifies the FIRST real code from an
// authenticator app before activating 2FA (Phase 14D requirement).
// Backup codes are generated and returned ONLY in this one response.
const confirmTwoFactor = async (req, res) => {
    try {
        const { code } = req.body || {};
        if (!code || typeof code !== "string") {
            return res.status(400).json({ success: false, message: "Verification code is required." });
        }

        const user = await platformUserService.getByIdWithSecrets(req.platformUser.id);
        if (!user || !user.totp_secret || user.totp_enabled) {
            return res.status(409).json({ success: false, message: "No pending 2FA setup found. Start setup again." });
        }

        const valid = platformTwoFactorService.verifyTotpCode(code.trim(), user.totp_secret);
        if (!valid) {
            return res.status(400).json({ success: false, message: "Invalid verification code. Please try again." });
        }

        const backupCodes = platformTwoFactorService.generateBackupCodes();
        const hashedBackupCodes = await platformTwoFactorService.hashBackupCodes(backupCodes);
        await platformUserService.enableTwoFactor(user.id, hashedBackupCodes);

        await platformAuditService.logAction({
            platformUserId: user.id, actionType: "2fa_enabled", targetType: "platform_user", targetId: user.id,
        }).catch((auditError) => console.error("[platform] audit log failed (2fa_enabled):", auditError.message));

        await platformNotificationService.notifyAllOwners({
            title: "Two-factor authentication enabled",
            message: "Two-factor authentication was enabled for the Platform Owner account.",
            type: "2fa_enabled",
        }).catch((notifyError) => console.error("[platform] notification failed (2fa_enabled):", notifyError.message));

        return res.json({ success: true, message: "Two-factor authentication enabled.", backupCodes });
    } catch (error) {
        console.error("[platform] confirmTwoFactor failed:", error.message);
        return res.status(500).json({ success: false, message: "Unable to confirm 2FA setup." });
    }
};

// POST /2fa/disable -- requires BOTH current password AND a valid
// TOTP/backup code (Phase 14D: "disable only after proper verification").
const disableTwoFactor = async (req, res) => {
    try {
        const { password, code } = req.body || {};
        if (!password || !code) {
            return res.status(400).json({ success: false, message: "Current password and a verification code are required." });
        }

        const user = await platformUserService.getByIdWithSecrets(req.platformUser.id);
        if (!user || !user.totp_enabled) {
            return res.status(409).json({ success: false, message: "Two-factor authentication is not currently enabled." });
        }

        const passwordMatches = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatches) {
            return res.status(401).json({ success: false, message: "Current password is incorrect." });
        }

        const trimmedCode = String(code).trim();
        let valid = platformTwoFactorService.verifyTotpCode(trimmedCode, user.totp_secret);
        if (!valid) {
            const backupResult = await platformTwoFactorService.verifyAndConsumeBackupCode(trimmedCode, user.backup_codes);
            valid = backupResult.valid;
        }
        if (!valid) {
            return res.status(401).json({ success: false, message: "Invalid verification code." });
        }

        await platformUserService.disableTwoFactor(user.id);

        await platformAuditService.logAction({
            platformUserId: user.id, actionType: "2fa_disabled", targetType: "platform_user", targetId: user.id,
        }).catch((auditError) => console.error("[platform] audit log failed (2fa_disabled):", auditError.message));

        await platformNotificationService.notifyAllOwners({
            title: "Two-factor authentication disabled",
            message: "Two-factor authentication was disabled for the Platform Owner account. If this wasn't you, secure the account immediately.",
            type: "2fa_disabled",
        }).catch((notifyError) => console.error("[platform] notification failed (2fa_disabled):", notifyError.message));

        return res.json({ success: true, message: "Two-factor authentication disabled. You will need to log in again on your other devices." });
    } catch (error) {
        console.error("[platform] disableTwoFactor failed:", error.message);
        return res.status(500).json({ success: false, message: "Unable to disable 2FA." });
    }
};

// POST /2fa/backup-codes/regenerate -- requires current password.
// Old codes are invalidated the instant this succeeds (overwritten,
// not merged) -- returned in plaintext ONLY in this one response.
const regenerateBackupCodes = async (req, res) => {
    try {
        const { password } = req.body || {};
        if (!password) {
            return res.status(400).json({ success: false, message: "Current password is required." });
        }

        const user = await platformUserService.getByIdWithSecrets(req.platformUser.id);
        if (!user || !user.totp_enabled) {
            return res.status(409).json({ success: false, message: "Two-factor authentication is not currently enabled." });
        }

        const passwordMatches = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatches) {
            return res.status(401).json({ success: false, message: "Current password is incorrect." });
        }

        const backupCodes = platformTwoFactorService.generateBackupCodes();
        const hashedBackupCodes = await platformTwoFactorService.hashBackupCodes(backupCodes);
        await platformUserService.setBackupCodes(user.id, hashedBackupCodes);

        await platformAuditService.logAction({
            platformUserId: user.id, actionType: "backup_codes_regenerated", targetType: "platform_user", targetId: user.id,
        }).catch((auditError) => console.error("[platform] audit log failed (backup_codes_regenerated):", auditError.message));

        return res.json({ success: true, backupCodes });
    } catch (error) {
        console.error("[platform] regenerateBackupCodes failed:", error.message);
        return res.status(500).json({ success: false, message: "Unable to regenerate backup codes." });
    }
};

module.exports = {
    login,
    verifyTwoFactorLogin,
    changePassword,
    getTwoFactorStatus,
    setupTwoFactor,
    confirmTwoFactor,
    disableTwoFactor,
    regenerateBackupCodes,
    PLATFORM_JWT_ISSUER,
    PLATFORM_JWT_AUDIENCE,
    PLATFORM_JWT_ALGORITHM,
};
