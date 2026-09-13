const rateLimit = require("express-rate-limit");

const {
    GLOBAL_RATE_LIMIT_WINDOW_MS,
    GLOBAL_RATE_LIMIT_MAX,
    SENSITIVE_RATE_LIMIT_WINDOW_MS,
    SENSITIVE_RATE_LIMIT_MAX,
} = require("../config/securityConfig");

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

// Separate instances (not shared) -- so a burst of attempts against,
// say, the platform owner login can never count toward or exhaust a
// Reinsteins user's own login attempt budget, and vice versa. Each
// endpoint gets its own independent counter.
const authLoginLimiter = createLoginLimiter();
const platformLoginLimiter = createLoginLimiter();
const tenantLoginLimiter = createLoginLimiter();

// Phase 14D -- deliberately its OWN instance, not a reuse of
// platformLoginLimiter, even though /verify-2fa is "the second half"
// of one logical login. A Platform Owner with 2FA enabled who mistypes
// their 6-digit code a couple of times (routine, not suspicious)
// would otherwise burn through the SAME 10-attempt/15-minute budget
// as their password attempts, halving their effective login budget
// for no security benefit -- brute-forcing a TOTP code additionally
// requires having already produced a valid password once to obtain a
// pending token in the first place, which is already a meaningfully
// different threat shape than a raw credential-stuffing attempt
// against /login.
const platformTwoFactorLoginLimiter = createLoginLimiter();

// ==========================================
// PUBLIC DEMO REQUEST RATE LIMITING (Phase 6)
//
// Applied ONLY to POST /api/public/demo-request. Deliberately
// stricter and structured differently from the login limiters above:
//
//   - 5 requests per hour per IP (a real prospect submits this form
//     once, maybe twice if they made a typo -- 5/hour is generous for
//     a genuine user and tight against a scripted spam burst).
//   - skipSuccessfulRequests is NOT set (defaults to false) -- unlike
//     a login attempt, a "successful" demo-request submission is
//     itself the exact thing being spammed, so every submission,
//     success or not, must count toward the limit.
// ==========================================

const DEMO_REQUEST_WINDOW_MS = 60 * 60 * 1000;
const DEMO_REQUEST_MAX_ATTEMPTS = 5;

const demoRequestLimiter = rateLimit({
    windowMs: DEMO_REQUEST_WINDOW_MS,
    max: DEMO_REQUEST_MAX_ATTEMPTS,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many requests. Please try again later.",
    },
    handler: (req, res, _next, options) => {
        res.status(options.statusCode).json(options.message);
    },
});

// ==========================================
// GLOBAL API RATE LIMIT (Phase 14F)
//
// A generous backstop, NOT a brute-force control (the login limiters
// above already own that job) -- sized well above any realistic
// legitimate usage pattern (dashboard polling, Socket.IO fallback
// long-polling, a busy admin with many tabs open) so normal portal
// use is never affected. Applied globally in app.js EXCEPT the
// Razorpay webhook route (that traffic comes from Razorpay's own
// servers, not a browser, and must never be rate-limited alongside
// ordinary users sharing server-side NAT/proxy IPs) and the
// authenticated file-serving route (already protected by its own
// signed, short-lived token -- see app.js).
// ==========================================

const globalApiLimiter = rateLimit({
    windowMs: GLOBAL_RATE_LIMIT_WINDOW_MS,
    max: GLOBAL_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many requests. Please slow down and try again shortly." },
    handler: (req, res, _next, options) => {
        res.status(options.statusCode).json(options.message);
    },
});

// ==========================================
// SENSITIVE ENDPOINT RATE LIMIT (Phase 14F)
//
// Applied to non-login endpoints where a tight attempt budget matters:
// password change, 2FA setup/verify/disable, payment
// verification/checkout, billing contact changes, email retry/test-
// connection. Tighter than the global limiter, looser than the login
// limiters (a legitimate Platform Owner might reasonably attempt a
// few of these in a session; an automated attacker trying many in a
// row should not get far). skipSuccessfulRequests is NOT set --
// unlike login, a successful payment verification attempt is exactly
// as worth rate-limiting as a failed one (repeated legitimate-looking
// verification calls are still a signal worth bounding).
// ==========================================

function createSensitiveLimiter() {
    return rateLimit({
        windowMs: SENSITIVE_RATE_LIMIT_WINDOW_MS,
        max: SENSITIVE_RATE_LIMIT_MAX,
        standardHeaders: true,
        legacyHeaders: false,
        message: { success: false, message: "Too many requests to this endpoint. Please try again later." },
        handler: (req, res, _next, options) => {
            res.status(options.statusCode).json(options.message);
        },
    });
}

// Separate instances per surface -- a burst against the 2FA endpoints
// never eats into the payment-verification budget, and vice versa.
const twoFactorLimiter = createSensitiveLimiter();
const passwordChangeLimiter = createSensitiveLimiter();
const paymentSensitiveLimiter = createSensitiveLimiter();
const billingContactLimiter = createSensitiveLimiter();
const emailActionLimiter = createSensitiveLimiter();

module.exports = {
    authLoginLimiter,
    platformLoginLimiter,
    tenantLoginLimiter,
    platformTwoFactorLoginLimiter,
    demoRequestLimiter,
    globalApiLimiter,
    twoFactorLimiter,
    passwordChangeLimiter,
    paymentSensitiveLimiter,
    billingContactLimiter,
    emailActionLimiter,
};
