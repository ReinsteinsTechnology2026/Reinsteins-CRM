const rateLimit = require("express-rate-limit");

// ==========================================
// LOGIN RATE LIMITING (GrowOrgs Fast Completion Phase, Part 1A)
//
// Applied ONLY to the three login endpoints:
//   POST /api/auth/login
//   POST /api/platform/auth/login
//   POST /api/tenant-auth/:companySlug/login
// Nothing else in the app is rate-limited by this file -- this is
// deliberately not a global/app-wide limiter.
//
// LIMITS: 10 requests per 15-minute window, keyed by IP address
// (express-rate-limit's default keyGenerator). This is the standard
// brute-force baseline for a login endpoint -- generous enough that
// a real user mistyping a password a few times is never blocked, but
// tight enough to make automated credential-stuffing/brute-force
// against a single account impractical.
//
// skipSuccessfulRequests: true -- only FAILED attempts count toward
// the limit. A legitimate user who logs in successfully several
// times in a window (e.g. multiple tabs/devices) is never penalized;
// only repeated failures (the actual brute-force signal) accumulate.
//
// Response: a clean, generic 429 with no information about which
// account, if any, exists or how many attempts remain against it --
// consistent with every login controller's existing pattern of never
// distinguishing "wrong password" from "no such account".
//
// standardHeaders: true / legacyHeaders: false -- exposes standard
// RateLimit-* headers (RFC draft) for well-behaved clients, without
// the older non-standard X-RateLimit-* headers.
// ==========================================

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function createLoginLimiter() {
    return rateLimit({
        windowMs: LOGIN_WINDOW_MS,
        max: LOGIN_MAX_ATTEMPTS,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        message: {
            success: false,
            message: "Too many login attempts. Please try again later.",
        },
        handler: (req, res, _next, options) => {
            res.status(options.statusCode).json(options.message);
        },
    });
}

// Three separate instances (not one shared instance) -- so a burst
// of attempts against, say, the platform owner login can never count
// toward or exhaust a Reinsteins user's own login attempt budget,
// and vice versa. Each endpoint gets its own independent counter.
const authLoginLimiter = createLoginLimiter();
const platformLoginLimiter = createLoginLimiter();
const tenantLoginLimiter = createLoginLimiter();

module.exports = {
    authLoginLimiter,
    platformLoginLimiter,
    tenantLoginLimiter,
};
