const crypto = require("crypto");
const jwt = require("jsonwebtoken");

// ==========================================
// PASSWORD-CHANGE CHALLENGE TOKEN
//
// When an account is flagged must_change_password, a correct temporary password does NOT
// produce a session. It produces this short-lived, single-purpose challenge, which the
// forced-change endpoint (and nothing else) accepts.
//
// Why it can never act as a normal session token:
//   * Signed with a key DERIVED from the existing secret (HMAC of the secret and a fixed
//     label), never the raw JWT_SECRET / TENANT_JWT_SECRET. `protect` verifies legacy tokens
//     with the raw JWT_SECRET (no issuer/audience/type check at all) and `tenantProtect`
//     verifies with the raw TENANT_JWT_SECRET, so both reject this token at jwt.verify().
//   * Its own issuer, audience and type, all checked again here.
//   * Short expiry (10 minutes).
//   * Bound to the CURRENT password hash through a fingerprint: once the password changes
//     the same challenge no longer verifies, so it is effectively single-use.
//
// The derived-key approach needs no new environment variable, so a deploy can never be
// broken by a missing secret that did not exist before.
// ==========================================

const CHALLENGE_ISSUER = "workhub-password-change";
const CHALLENGE_AUDIENCE = "workhub-password-change-challenge";
const CHALLENGE_TYPE = "password_change_challenge";
const CHALLENGE_TTL_SECONDS = 10 * 60;
const KEY_LABEL = "workhub/password-change-challenge/v1";

const SCOPES = Object.freeze({ TENANT: "tenant", LEGACY: "legacy" });

function secretFor(scope) {
    const base = scope === SCOPES.TENANT ? process.env.TENANT_JWT_SECRET : process.env.JWT_SECRET;

    if (!base || typeof base !== "string") {
        throw new Error(`password-change challenge: signing secret for the "${scope}" login is not configured`);
    }

    return crypto.createHmac("sha256", base).update(`${KEY_LABEL}/${scope}`).digest();
}

// A short, non-reversible fingerprint of the stored hash. It lets the challenge go stale the
// moment the password changes without keeping any server-side state.
function passwordFingerprint(passwordHash) {
    return crypto.createHash("sha256").update(String(passwordHash || "")).digest("hex").slice(0, 24);
}

function signChallenge({ scope, userId, passwordHash, companyId = null, companySlug = null }) {
    if (!Object.values(SCOPES).includes(scope)) {
        throw new Error("password-change challenge: unknown scope");
    }

    const claims = { userId, scope, type: CHALLENGE_TYPE, pwf: passwordFingerprint(passwordHash) };

    if (scope === SCOPES.TENANT) {
        claims.companyId = companyId;
        claims.companySlug = companySlug;
    }

    return jwt.sign(claims, secretFor(scope), {
        algorithm: "HS256",
        expiresIn: CHALLENGE_TTL_SECONDS,
        issuer: CHALLENGE_ISSUER,
        audience: CHALLENGE_AUDIENCE,
    });
}

// Returns { ok: true, claims } or { ok: false, reason } -- never throws for a bad token.
// reason is one of: missing | invalid | expired | wrong_purpose
function verifyChallenge(token, scope) {
    if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "missing" };

    let decoded;
    try {
        decoded = jwt.verify(token, secretFor(scope), {
            algorithms: ["HS256"],
            issuer: CHALLENGE_ISSUER,
            audience: CHALLENGE_AUDIENCE,
        });
    } catch (error) {
        return { ok: false, reason: error && error.name === "TokenExpiredError" ? "expired" : "invalid" };
    }

    if (
        decoded.type !== CHALLENGE_TYPE ||
        decoded.scope !== scope ||
        !Number.isInteger(decoded.userId) ||
        typeof decoded.pwf !== "string"
    ) {
        return { ok: false, reason: "wrong_purpose" };
    }

    if (scope === SCOPES.TENANT && (!decoded.companyId || typeof decoded.companySlug !== "string")) {
        return { ok: false, reason: "wrong_purpose" };
    }

    return { ok: true, claims: decoded };
}

function fingerprintMatches(claims, passwordHash) {
    const expected = Buffer.from(passwordFingerprint(passwordHash));
    const actual = Buffer.from(String(claims.pwf || ""));

    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = {
    SCOPES,
    CHALLENGE_TTL_SECONDS,
    signChallenge,
    verifyChallenge,
    fingerprintMatches,
    passwordFingerprint,
};
