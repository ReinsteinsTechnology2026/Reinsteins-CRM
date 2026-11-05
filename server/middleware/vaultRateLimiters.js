const rateLimit = require("express-rate-limit");

// ==========================================
// ZIOVAULT -- rate limits
//
// Keyed by tenant + USER (not by IP: many colleagues share an office address, and an attacker with one stolen session must not get a
// fresh budget by changing address). Separate budgets so a burst of one kind never starves another.
//   unlock    fetching one's own key envelopes (the thing an attacker with a stolen session would try to repeat)
//   recovery  recovery material, password change, recovery rotation, restoring an older envelope
//   share     creating/changing shares and memberships
//   secret    receiving a secret ciphertext, reveal/copy reports
//   write     everything else that writes
// ==========================================

const keyFor = (req) => `${(req.tenantCompany && req.tenantCompany.id) || "legacy"}:${(req.user && req.user.id) || "anonymous"}`;

function limiter({ windowMs, max }) {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: keyFor,
        validate: { keyGeneratorIpFallback: false },
        handler: (_req, res) => res.status(429).json({ success: false, code: "RATE_LIMITED", message: "Too many requests. Please wait a moment and try again." }),
    });
}

const MINUTE = 60 * 1000;

function createVaultLimiters(overrides = {}) {
    const defaults = {
        unlock: { windowMs: 15 * MINUTE, max: 30 },
        recovery: { windowMs: 60 * MINUTE, max: 10 },
        share: { windowMs: 60 * MINUTE, max: 120 },
        secret: { windowMs: 15 * MINUTE, max: 600 },
        write: { windowMs: 15 * MINUTE, max: 600 },
    };
    const out = {};
    for (const [name, base] of Object.entries(defaults)) out[name] = limiter({ ...base, ...(overrides[name] || {}) });
    return out;
}

module.exports = { createVaultLimiters };
