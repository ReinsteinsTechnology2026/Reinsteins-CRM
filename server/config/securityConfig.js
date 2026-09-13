// ==========================================
// SECURITY CONFIGURATION (Phase 14)
//
// Centralized -- no lockout threshold, lockout duration, password
// rule, or body-size limit is ever hardcoded elsewhere. Overridable
// via environment variables, same convention as config/lifecycleConfig.js
// and config/emailConfig.js.
// ==========================================

// Account lockout (Platform Owner only -- see Phase 14 report for why
// this is scoped to the platform_users table and not extended to
// every tenant's own users table in this phase).
const LOGIN_LOCKOUT_THRESHOLD = Number(process.env.LOGIN_LOCKOUT_THRESHOLD) || 5;
const LOGIN_LOCKOUT_DURATION_MINUTES = Number(process.env.LOGIN_LOCKOUT_DURATION_MINUTES) || 15;

// Password policy -- applied server-side to every password-setting
// endpoint (Platform Owner change-password, legacy/tenant employee
// change-password and registration). Never re-validated against
// already-stored hashes, so no existing account is ever locked out by
// a policy change.
const PASSWORD_MIN_LENGTH = Number(process.env.PASSWORD_MIN_LENGTH) || 10;
const PASSWORD_REQUIRE_UPPERCASE = process.env.PASSWORD_REQUIRE_UPPERCASE !== "false";
const PASSWORD_REQUIRE_LOWERCASE = process.env.PASSWORD_REQUIRE_LOWERCASE !== "false";
const PASSWORD_REQUIRE_DIGIT = process.env.PASSWORD_REQUIRE_DIGIT !== "false";

// Two-factor authentication.
const TWO_FACTOR_ISSUER = "ZioVenture";
const TWO_FACTOR_PENDING_TOKEN_EXPIRY = "5m";
const TWO_FACTOR_BACKUP_CODE_COUNT = 10;

// Request body size limits -- explicit rather than relying on
// express.json()'s implicit 100kb default, so the limit is documented
// and intentional. File uploads go through multer's own per-route
// size limits (5MB profile photos, 50MB attachments) and are
// unaffected by this -- this only bounds ordinary JSON/form bodies.
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "2mb";

// Global API rate limit -- deliberately generous (this is NOT a
// brute-force control, the per-endpoint limiters in
// middleware/rateLimiters.js already handle that) -- just a baseline
// backstop against a single client hammering the API, sized well
// above any realistic legitimate portal usage pattern (dashboards
// polling, Socket.IO fallback, etc.) so it never interferes with
// normal use.
const GLOBAL_RATE_LIMIT_WINDOW_MS = Number(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS) || 5 * 60 * 1000;
const GLOBAL_RATE_LIMIT_MAX = Number(process.env.GLOBAL_RATE_LIMIT_MAX) || 600;

// Stricter limits for sensitive, non-login endpoints (password
// change, 2FA, payment verification/checkout, billing contact,
// email retry/test-connection) -- tighter than the global limit,
// looser than the login limiters (those already exist and are
// unchanged).
const SENSITIVE_RATE_LIMIT_WINDOW_MS = Number(process.env.SENSITIVE_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const SENSITIVE_RATE_LIMIT_MAX = Number(process.env.SENSITIVE_RATE_LIMIT_MAX) || 20;

// Reverse-proxy trust (Phase 15D) -- Express's default (trust proxy
// disabled) is only correct when this process receives connections
// directly from the internet. Deployed behind ANY reverse proxy
// (Render, a Vercel edge function, Nginx, a load balancer) without
// this set, every request's req.ip resolves to the PROXY's own IP,
// which silently collapses the IP-keyed login/rate limiters (see
// rateLimiters.js) into ONE shared bucket for every real visitor --
// one user's failed logins would lock out everyone else's login
// attempts too. Left unset (false) by default so local dev, which has
// no proxy in front, is completely unaffected. Once deployed behind a
// single reverse proxy hop, set TRUST_PROXY=1 (Express interprets a
// numeric string as "trust this many hops from the client"); consult
// Express's own trust-proxy docs for other topologies.
const TRUST_PROXY = process.env.TRUST_PROXY || false;

module.exports = {
    LOGIN_LOCKOUT_THRESHOLD,
    LOGIN_LOCKOUT_DURATION_MINUTES,
    PASSWORD_MIN_LENGTH,
    PASSWORD_REQUIRE_UPPERCASE,
    PASSWORD_REQUIRE_LOWERCASE,
    PASSWORD_REQUIRE_DIGIT,
    TWO_FACTOR_ISSUER,
    TWO_FACTOR_PENDING_TOKEN_EXPIRY,
    TWO_FACTOR_BACKUP_CODE_COUNT,
    JSON_BODY_LIMIT,
    GLOBAL_RATE_LIMIT_WINDOW_MS,
    GLOBAL_RATE_LIMIT_MAX,
    SENSITIVE_RATE_LIMIT_WINDOW_MS,
    SENSITIVE_RATE_LIMIT_MAX,
    TRUST_PROXY,
};
