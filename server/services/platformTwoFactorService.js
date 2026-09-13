const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { authenticator } = require("otplib");
const QRCode = require("qrcode");

const { TWO_FACTOR_ISSUER, TWO_FACTOR_BACKUP_CODE_COUNT } = require("../config/securityConfig");

// ==========================================
// PLATFORM TWO-FACTOR SERVICE (Phase 14D)
//
// TOTP via otplib's `authenticator` preset -- the standard RFC 6238
// algorithm (SHA1, 6 digits, 30s step), compatible with Google
// Authenticator / Authy / 1Password / any standard authenticator app.
//
// Deliberately pinned to otplib v12's `authenticator` API (not the
// newer v13 default export) -- v13 is a ground-up async redesign that
// threw internal errors on ordinary verify() calls when evaluated for
// this phase; v12's synchronous authenticator API is the long-
// standing, extremely well-documented, widely-deployed standard for
// this exact use case, and reliability matters more than "latest
// major version" for a security-critical primitive. (v12 does print
// an upstream deprecation notice on install -- functionally correct
// and stable regardless; documented here rather than silently
// swallowed.)
//
// window: 1 -- accepts the current 30s code plus one step before/
// after (a ~90s effective tolerance), the standard, minimal allowance
// for clock drift between the server and the user's phone. Widening
// this further would meaningfully increase the brute-force window
// against a 6-digit code and is not done.
//
// Backup codes are stored as BCRYPT HASHES only (same one-way
// treatment as a password) -- the plaintext codes exist only in the
// single API response at generation time and are never persisted or
// retrievable again.
// ==========================================

authenticator.options = { window: 1 };

function generateSecret() {
    return authenticator.generateSecret();
}

function buildOtpAuthUrl(accountEmail, secret) {
    return authenticator.keyuri(accountEmail, TWO_FACTOR_ISSUER, secret);
}

async function generateQrCodeDataUrl(otpAuthUrl) {
    return QRCode.toDataURL(otpAuthUrl);
}

function verifyTotpCode(code, secret) {
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
        return false;
    }
    try {
        return authenticator.check(code, secret);
    } catch (_error) {
        return false;
    }
}

// 10 codes, each 10 hex characters (uppercase, dash-formatted for
// readability: XXXXX-XXXXX) -- generated via crypto.randomBytes, not
// Math.random(), since these function as one-time passwords.
function generateBackupCodes(count = TWO_FACTOR_BACKUP_CODE_COUNT) {
    const codes = [];
    for (let i = 0; i < count; i += 1) {
        const raw = crypto.randomBytes(5).toString("hex").toUpperCase();
        codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
    }
    return codes;
}

async function hashBackupCodes(codes) {
    const hashed = [];
    for (const code of codes) {
        // eslint-disable-next-line no-await-in-loop
        hashed.push(await bcrypt.hash(code, 10));
    }
    return hashed;
}

// Verifies a submitted backup code against the stored hash array,
// returning the REMAINING hash array with the matched one removed
// (one-time use -- Phase 14's explicit requirement). Returns
// { valid: false } with the array unchanged if no hash matches.
async function verifyAndConsumeBackupCode(submittedCode, hashedCodes) {
    if (!Array.isArray(hashedCodes) || typeof submittedCode !== "string") {
        return { valid: false, remaining: hashedCodes || [] };
    }
    const normalized = submittedCode.trim().toUpperCase();
    for (let i = 0; i < hashedCodes.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const matches = await bcrypt.compare(normalized, hashedCodes[i]);
        if (matches) {
            const remaining = [...hashedCodes.slice(0, i), ...hashedCodes.slice(i + 1)];
            return { valid: true, remaining };
        }
    }
    return { valid: false, remaining: hashedCodes };
}

module.exports = {
    generateSecret,
    buildOtpAuthUrl,
    generateQrCodeDataUrl,
    verifyTotpCode,
    generateBackupCodes,
    hashBackupCodes,
    verifyAndConsumeBackupCode,
};
