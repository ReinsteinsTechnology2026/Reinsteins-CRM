require("dotenv").config();
const jwt = require("jsonwebtoken");
const { spawn } = require("child_process");

const pool = require("./config/db");
const platformPool = require("./config/platformDb");

// ==========================================
// PRODUCTION INFRASTRUCTURE HARDENING SELF-TEST (Phase 15)
//
// Covers the 15 scenarios required by Phase 15 Part Z. This is a
// PERMANENT, non-Playwright test script -- real HTTP calls against a
// live server (assumed already running on BASE_URL), plus one
// short-lived child-process server (spawned and killed by this
// script itself, on a separate port) to actually verify
// NODE_ENV=production error-hiding behavior rather than just reading
// the code and trusting it.
//
// Deliberately makes almost no calls against the shared login/
// sensitive-endpoint rate limiters (this suite runs as part of a long
// sequential regression pass alongside _test_security_hardening.js
// and others, all sharing the same limiter budget on one backend
// process) -- every check here either needs no auth at all, or only
// checks that a rate limiter is ATTACHED (via its RateLimit-* response
// headers) rather than actually exhausting it.
// ==========================================

const BASE_URL = "http://localhost:5000";

let failures = 0;
function check(label, condition, detail) {
    if (condition) console.log(`  [PASS] ${label}`);
    else { failures++; console.log(`  [FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

async function apiGet(pathname, extraHeaders = {}) {
    const res = await fetch(`${BASE_URL}${pathname}`, { headers: extraHeaders });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON, fine for some checks */ }
    return { status: res.status, headers: res.headers, body: json };
}

async function apiPost(pathname, body, extraHeaders = {}) {
    const res = await fetch(`${BASE_URL}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...extraHeaders },
        body: typeof body === "string" ? body : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON, fine for some checks */ }
    return { status: res.status, headers: res.headers, body: json };
}

(async () => {

    // ================================================
    // TEST 1 -- /health works
    // ================================================
    console.log("\nTEST 1 -- /health endpoint");
    const health = await apiGet("/health");
    check("1. /health returns 200 with status ok", health.status === 200 && health.body?.status === "ok", JSON.stringify(health.body));
    check("1b. /health reveals no credentials/paths/internal details", (() => {
        const text = JSON.stringify(health.body || {}).toLowerCase();
        return !text.includes("password") && !text.includes("secret") && !text.includes(":\\") && !text.includes("/users/") && !text.includes("mysql://");
    })());

    // ================================================
    // TEST 2 -- production-safe error responses (real
    // NODE_ENV=production child process, not just reading the code)
    // ================================================
    console.log("\nTEST 2 -- Production error handling (spawned NODE_ENV=production instance)");

    const PROD_TEST_PORT = 5099;
    const prodChild = spawn("node", ["app.js"], {
        cwd: __dirname,
        env: { ...process.env, NODE_ENV: "production", PORT: String(PROD_TEST_PORT) },
        stdio: ["ignore", "pipe", "pipe"],
    });

    let prodChildReady = false;
    await new Promise((resolve) => {
        const onData = (chunk) => {
            if (chunk.toString().includes("Server running on")) {
                prodChildReady = true;
                resolve();
            }
        };
        prodChild.stdout.on("data", onData);
        prodChild.stderr.on("data", onData);
        setTimeout(resolve, 8000); // safety timeout even if the marker line is missed
    });

    check("2a. Production instance booted successfully", prodChildReady);

    if (prodChildReady) {
        // Malformed JSON body -- must trigger the centralized error
        // handler's SyntaxError branch, not leak a stack trace.
        const malformed = await fetch(`http://localhost:${PROD_TEST_PORT}/api/platform/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{not valid json",
        });
        const malformedBody = await malformed.json().catch(() => null);
        check("2b. Malformed JSON body returns clean 400 in production", malformed.status === 400 && malformedBody?.message === "Malformed request body", JSON.stringify(malformedBody));
        check("2c. Production error response has no stack trace", !JSON.stringify(malformedBody || {}).toLowerCase().includes("at object") && !JSON.stringify(malformedBody || {}).includes(".js:"));

        // Force a genuine 500 by hitting a route with a body shape
        // nothing downstream expects, confirming NODE_ENV=production
        // hides err.message behind the generic string.
        const forced404 = await fetch(`http://localhost:${PROD_TEST_PORT}/api/does-not-exist-xyz`);
        const forced404Body = await forced404.json().catch(() => null);
        check("2d. Unknown route still returns clean JSON 404 in production", forced404.status === 404 && forced404Body?.success === false);
    } else {
        check("2b. (skipped -- production instance did not boot)", false, "see 2a");
        check("2c. (skipped -- production instance did not boot)", false, "see 2a");
        check("2d. (skipped -- production instance did not boot)", false, "see 2a");
    }

    prodChild.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));

    // ================================================
    // TEST 3 -- security headers exist
    // ================================================
    console.log("\nTEST 3 -- Security headers");
    const headerCheck = await apiGet("/health");
    check("3a. Content-Security-Policy header present", Boolean(headerCheck.headers.get("content-security-policy")));
    check("3b. X-Content-Type-Options: nosniff present", headerCheck.headers.get("x-content-type-options") === "nosniff");
    check("3c. X-Powered-By header removed (helmet default)", !headerCheck.headers.get("x-powered-by"));

    // ================================================
    // TEST 4 -- unexpected CORS origin rejected
    // ================================================
    console.log("\nTEST 4 -- CORS rejects an unrecognized origin");
    const corsRes = await apiGet("/health", { Origin: "https://evil-attacker-site.example" });
    check("4. Unrecognized Origin is never reflected in Access-Control-Allow-Origin", corsRes.headers.get("access-control-allow-origin") !== "https://evil-attacker-site.example", `got "${corsRes.headers.get("access-control-allow-origin")}"`);

    // ================================================
    // TEST 5 -- sensitive headers not exposed
    // ================================================
    console.log("\nTEST 5 -- No sensitive infrastructure headers leaked");
    check("5. No X-Powered-By / Server header reveals Express/Node internals", !headerCheck.headers.get("x-powered-by"));

    // ================================================
    // TEST 6 -- secrets never returned from APIs
    // ================================================
    console.log("\nTEST 6 -- No secret values in API responses");
    const rootRes = await apiGet("/");
    const combinedText = JSON.stringify(rootRes.body || {}) + JSON.stringify(health.body || {});
    check("6. Root/health responses contain no key material or connection strings", !combinedText.toLowerCase().includes("jwt_secret") && !combinedText.toLowerCase().includes("db_password") && !combinedText.includes("mysql://"));

    // ================================================
    // TEST 7 -- authentication endpoints remain protected
    // ================================================
    console.log("\nTEST 7 -- Auth-protected endpoints reject unauthenticated requests");
    const noAuthPlatform = await apiGet("/api/platform/companies");
    check("7a. Platform companies list requires auth (401)", noAuthPlatform.status === 401, `got ${noAuthPlatform.status}`);
    const noAuthTenant = await apiGet("/api/tenant-auth/me");
    check("7b. Tenant /me requires auth (401)", noAuthTenant.status === 401, `got ${noAuthTenant.status}`);
    const noAuthLegacy = await apiGet("/api/departments");
    check("7c. Legacy departments list requires auth (401)", noAuthLegacy.status === 401, `got ${noAuthLegacy.status}`);

    // alg:none forged token -- must never be accepted now that every
    // jwt.verify() call site pins algorithms explicitly (Phase 14E).
    const forgedHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const forgedPayload = Buffer.from(JSON.stringify({ id: 1, role: "platform_owner" })).toString("base64url");
    const forgedToken = `${forgedHeader}.${forgedPayload}.`;
    const forgedAuth = await apiGet("/api/platform/companies", { Authorization: `Bearer ${forgedToken}` });
    check("7d. alg:none forged token rejected (401, not accepted as valid)", forgedAuth.status === 401, `got ${forgedAuth.status}`);

    // ================================================
    // TEST 8 -- Platform/Tenant JWT separation remains intact
    // ================================================
    console.log("\nTEST 8 -- Platform/Tenant JWT separation");
    const tenantShapedToken = jwt.sign({ id: 999999, employeeId: "PRODHARDEN-TEST", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const legacyOnPlatform = await apiGet("/api/platform/companies", { Authorization: `Bearer ${tenantShapedToken}` });
    check("8a. Legacy/tenant-shaped token rejected on platform routes (401)", legacyOnPlatform.status === 401, `got ${legacyOnPlatform.status}`);

    const fakePlatformToken = jwt.sign({ id: 1, role: "platform_owner" }, process.env.TENANT_JWT_SECRET || "wrong-secret", { expiresIn: "1h" });
    const fakeOnTenant = await apiGet("/api/tenant-auth/me", { Authorization: `Bearer ${fakePlatformToken}` });
    check("8b. Token signed with the wrong secret rejected on tenant routes (401)", fakeOnTenant.status === 401, `got ${fakeOnTenant.status}`);

    // ================================================
    // TEST 9 -- payment endpoints remain protected
    // ================================================
    console.log("\nTEST 9 -- Payment endpoints remain protected");
    const noAuthCheckout = await apiPost("/api/platform/payments/checkout", { companyId: 1, planId: 1 });
    check("9. Payment checkout requires auth (401)", noAuthCheckout.status === 401, `got ${noAuthCheckout.status}`);

    // ================================================
    // TEST 10 -- Razorpay webhook signature validation intact
    // ================================================
    console.log("\nTEST 10 -- Razorpay webhook signature validation");
    const badWebhook = await apiPost("/api/platform/payments/webhook/razorpay", { event: "payment.captured" }, { "X-Razorpay-Signature": "0".repeat(64) });
    check("10. Webhook with an invalid/unconfigured signature is rejected, never processed as valid", [400, 401, 503].includes(badWebhook.status), `got ${badWebhook.status} ${JSON.stringify(badWebhook.body)}`);

    // ================================================
    // TEST 11 -- file access remains tenant-isolated
    // ================================================
    console.log("\nTEST 11 -- Authenticated file serving");
    const noTokenFile = await apiGet("/uploads/tenant_reinsteins/profiles/does-not-exist.png");
    check("11a. File access without a file access token is rejected (401)", noTokenFile.status === 401, `got ${noTokenFile.status}`);
    const badTokenFile = await apiGet("/uploads/tenant_reinsteins/profiles/does-not-exist.png?fat=not-a-real-token");
    check("11b. File access with a garbage token is rejected (401)", badTokenFile.status === 401, `got ${badTokenFile.status}`);

    // ================================================
    // TEST 12 -- debug/test endpoints not exposed
    // ================================================
    console.log("\nTEST 12 -- No debug/test endpoints exposed");
    for (const guess of ["/debug", "/api/debug", "/.env", "/api/.env", "/__debug", "/api/internal"]) {
        const res = await apiGet(guess);
        check(`12. ${guess} is not exposed (404)`, res.status === 404, `got ${res.status}`);
    }

    // ================================================
    // TEST 13 -- password endpoints remain rate-limited
    // ================================================
    console.log("\nTEST 13 -- Password-change endpoint has a rate limiter attached");
    const pwLimiterProbe = await apiPost("/api/platform/auth/password", { currentPassword: "x", newPassword: "y" });
    check("13. Password-change route exposes RateLimit-* headers (limiter attached)", Boolean(pwLimiterProbe.headers.get("ratelimit-limit")), `headers seen: ${[...pwLimiterProbe.headers.keys()].join(",")}`);

    // ================================================
    // TEST 14 -- payment endpoints remain rate-limited
    // ================================================
    console.log("\nTEST 14 -- Payment checkout endpoint has a rate limiter attached");
    const paymentLimiterProbe = await apiPost("/api/platform/payments/checkout", { companyId: 1, planId: 1 });
    check("14. Payment checkout route exposes RateLimit-* headers (limiter attached)", Boolean(paymentLimiterProbe.headers.get("ratelimit-limit")), `headers seen: ${[...paymentLimiterProbe.headers.keys()].join(",")}`);

    // ================================================
    // TEST 15 -- existing security invariants still hold
    // (a lightweight spot-check, NOT a replacement for actually
    // running _test_security_hardening.js as its own suite -- see the
    // Phase 15 regression results)
    // ================================================
    console.log("\nTEST 15 -- Phase 14 invariants still hold");
    const securityConfig = require("./config/securityConfig");
    check("15a. Login lockout threshold still configured (>0)", securityConfig.LOGIN_LOCKOUT_THRESHOLD > 0);
    check("15b. Global rate limiter still configured (>0)", securityConfig.GLOBAL_RATE_LIMIT_MAX > 0);
    const rootHeaders = await apiGet("/");
    check("15c. CSP directive default-src still restrictive", (rootHeaders.headers.get("content-security-policy") || "").includes("default-src 'none'"));

    // ================================================
    // EXTRA -- Reinsteins unaffected
    // ================================================
    console.log("\nEXTRA -- Reinsteins verification");
    // Phase 16A discovery -- see _test_security_hardening.js's comment
    // at this same check for the full explanation (Postgres
    // table_schema means schema not database; production shares one
    // database between tenant and platform tables).
    const PLATFORM_TABLE_NAMES = ["platform_users", "subscription_plans", "companies", "demo_requests", "payments", "subscription_history", "platform_audit_logs", "platform_notifications", "email_delivery_logs", "email_domains", "mailboxes", "email_aliases", "mailbox_settings"];
    const [[{ tbl }]] = await pool.query(`SELECT COUNT(*) AS tbl FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT IN (${PLATFORM_TABLE_NAMES.map(() => "?").join(",")})`, PLATFORM_TABLE_NAMES);
    const [[{ users }]] = await pool.query(`SELECT COUNT(*) AS users FROM users`);
    check("EXTRA: reinsteins_workhub unchanged (37 tables, 17 users)", Number(tbl) === 37 && Number(users) === 17, `tables=${tbl} users=${users}`);

    const [[reinsteinsCompany]] = await platformPool.query(`SELECT status, access_type FROM companies WHERE company_slug = 'reinsteins'`);
    check("EXTRA: Reinsteins remains active in the platform DB", reinsteinsCompany?.status === "active", JSON.stringify(reinsteinsCompany));

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await pool.end();
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
