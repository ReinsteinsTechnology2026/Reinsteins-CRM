require("dotenv").config();
const jwt = require("jsonwebtoken");

const platformPool = require("./config/platformDb");
const { PLATFORM_JWT_ISSUER, PLATFORM_JWT_AUDIENCE } = require("./controllers/platformAuthController");

// ==========================================
// PUBLIC WEBSITE / DEMO REQUEST SELF-TEST (Phase 6)
//
// Covers scenarios B-I from the Phase 6 request. Scenario A (public
// pages reachable without auth) and J (production build) are
// verified structurally (route wiring has no auth guard on any
// public route; the earlier `npm run build` succeeded with 883
// modules) rather than by literal browser navigation, per "do not
// use Playwright". No temporary tenant/company needed -- this phase
// touches only groworgs_platform_db.demo_requests plus re-confirms
// existing auth boundaries.
// ==========================================

const BASE_URL = "http://localhost:5000";

let failures = 0;
function check(label, condition, detail) {
    if (condition) console.log(`  [PASS] ${label}`);
    else { failures++; console.log(`  [FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

async function apiPost(pathname, body, token) {
    const res = await fetch(`${BASE_URL}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}
async function apiGet(pathname, token) {
    const res = await fetch(`${BASE_URL}${pathname}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

(async () => {

    // ---------- Baseline: companies table + demo_requests count ----------
    const [[{ companiesBefore }]] = await platformPool.query(`SELECT COUNT(*) AS companiesBefore FROM companies`);
    const [[{ demoRequestsBefore }]] = await platformPool.query(`SELECT COUNT(*) AS demoRequestsBefore FROM demo_requests`);

    // ---------- B: tenant pages remain protected ----------
    console.log("TEST B -- Tenant APIs remain protected");
    const noAuthTenantMe = await apiGet("/api/tenant-auth/me");
    check("B. GET /api/tenant-auth/me with no token -> 401", noAuthTenantMe.status === 401, `got ${noAuthTenantMe.status}`);
    const noAuthVerify = await apiGet("/api/auth/verify");
    check("B2. GET /api/auth/verify with no token -> 401", noAuthVerify.status === 401, `got ${noAuthVerify.status}`);
    const noAuthDepartments = await apiGet("/api/departments");
    check("B3. GET /api/departments with no token -> 401", noAuthDepartments.status === 401, `got ${noAuthDepartments.status}`);

    // ---------- C: platform pages remain protected ----------
    console.log("\nTEST C -- Platform Dashboard APIs remain protected");
    const noAuthPlatformMe = await apiGet("/api/platform/auth/me");
    check("C. GET /api/platform/auth/me with no token -> 401", noAuthPlatformMe.status === 401, `got ${noAuthPlatformMe.status}`);
    const noAuthPlatformCompanies = await apiGet("/api/platform/companies");
    check("C2. GET /api/platform/companies with no token -> 401", noAuthPlatformCompanies.status === 401, `got ${noAuthPlatformCompanies.status}`);

    // ---------- A (structural): public demo-request endpoint reachable with NO auth ----------
    console.log("\nTEST A -- Public API reachable without authentication (structural proof for public pages)");
    const infoNoAuth = await apiGet("/api/tenant-auth/reinsteins/info");
    check("A. Public company-info endpoint reachable with no token", infoNoAuth.status === 200, `got ${infoNoAuth.status}`);

    // ---------- D/E/F: single budget-aware sequence ----------
    // IMPORTANT: demoRequestLimiter counts EVERY request that reaches
    // this route (valid or not) against the same 5-per-hour/IP
    // budget, since the limiter runs before the controller. Testing
    // validation and rate-limiting as separate, independent bursts
    // would make them collide (they'd share one counter) -- so this
    // is deliberately ONE sequence of exactly 6 requests: 3 invalid
    // (proving D/E), 2 valid (proving normal submission + G/H), then
    // a 6th (any shape) that must be rejected purely for being over
    // the limit (proving F).
    console.log("\nTEST D/E/F -- Demo request validation + rate limiting (one 6-request budget)");

    const missingFields = await apiPost("/api/public/demo-request", { name: "Test" });
    check("D. Missing required fields rejected (400)", missingFields.status === 400, `got ${missingFields.status}`);

    const badEmail = await apiPost("/api/public/demo-request", { name: "Test User", companyName: "Test Co", email: "not-an-email" });
    check("E. Invalid email rejected (400)", badEmail.status === 400, `got ${badEmail.status}`);

    const tooLongMessage = await apiPost("/api/public/demo-request", {
        name: "Test User", companyName: "Test Co", email: "test@example.com", message: "x".repeat(2500),
    });
    check("E2. Oversized message field rejected (400)", tooLongMessage.status === 400, `got ${tooLongMessage.status}`);

    const validSubmit = await apiPost("/api/public/demo-request", {
        name: "Jane Prospect",
        companyName: "Prospect Co",
        email: "jane@prospectco.test",
        phone: "+1 555 0199",
        employeeCount: "11–50",
        message: "Interested in a demo.",
    });
    check("Valid demo request succeeds (201)", validSubmit.status === 201 && !!validSubmit.body?.referenceId, JSON.stringify(validSubmit.body));

    const secondValidSubmit = await apiPost("/api/public/demo-request", {
        name: "Second Prospect", companyName: "Second Co", email: "second@prospectco.test",
    });
    check("A second valid demo request also succeeds (201) -- still within budget", secondValidSubmit.status === 201, JSON.stringify(secondValidSubmit.body));

    const sixthRequest = await apiPost("/api/public/demo-request", {
        name: "Sixth Request", companyName: "Sixth Co", email: "sixth@prospectco.test",
    });
    check("F. 6th request in the window is rate-limited (429), regardless of being well-formed", sixthRequest.status === 429, `got ${sixthRequest.status}`);

    // ---------- G: demo request does NOT create a company ----------
    console.log("\nTEST G -- Demo request does not create a company");
    const [[{ companiesAfter }]] = await platformPool.query(`SELECT COUNT(*) AS companiesAfter FROM companies`);
    check("G. companies table row count unchanged after demo requests", companiesAfter === companiesBefore, `before=${companiesBefore} after=${companiesAfter}`);
    const [[{ demoRequestsAfter }]] = await platformPool.query(`SELECT COUNT(*) AS demoRequestsAfter FROM demo_requests`);
    check("G2. demo_requests row count increased by exactly 2 (the two valid submissions)", demoRequestsAfter === demoRequestsBefore + 2, `before=${demoRequestsBefore} after=${demoRequestsAfter}`);
    const [[storedRow]] = await platformPool.query(`SELECT status FROM demo_requests WHERE id = ?`, [validSubmit.body.referenceId]);
    check("G3. Stored request defaults to status='new'", storedRow?.status === "new", JSON.stringify(storedRow));

    // ---------- H: public APIs expose no tenant/platform secrets ----------
    console.log("\nTEST H -- Public API responses expose no secrets");
    const submitBodyStr = JSON.stringify(validSubmit.body);
    check("H. Demo-request response contains no DB/JWT/tenant fields",
        !/password|secret|tenant_db_name|DB_HOST|DB_PASSWORD|platform_users|JWT_SECRET/i.test(submitBodyStr), submitBodyStr);
    const companyInfoStr = JSON.stringify(infoNoAuth.body);
    check("H2. Public company-info response contains no status/accessType/tenantDbName", !/status|accessType|tenantDbName|tenant_db_name/i.test(companyInfoStr), companyInfoStr);

    // Clean up the rows created by this sequence.
    await platformPool.query(`DELETE FROM demo_requests WHERE email IN (?, ?)`, ["jane@prospectco.test", "second@prospectco.test"]);

    // ---------- I: existing Reinsteins functionality still works ----------
    console.log("\nTEST I -- Existing Reinsteins functionality unaffected");
    const legacyToken = jwt.sign({ id: 4, employeeId: "PHASE6-LEGACY-TEST", role: "employee" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const legacyVerify = await apiGet("/api/auth/verify", legacyToken);
    check("I. Legacy /api/auth/verify still works", legacyVerify.status === 200);
    const legacyDepts = await apiGet("/api/departments", legacyToken);
    check("I2. Legacy token still resolves real Reinsteins business data", legacyDepts.status === 200 && legacyDepts.body?.departments?.length === 3, JSON.stringify(legacyDepts.body));

    const reinsteinsLoginRoute = await apiPost("/api/tenant-auth/reinsteins/login", { employeeId: "NOSUCHID999ZZZ", password: "whatever" });
    check("I3. /reinsteins/login route still resolves correctly (401, not 404)", reinsteinsLoginRoute.status === 401, `got ${reinsteinsLoginRoute.status}`);

    // Note: routes/publicRoutes.js applies no auth middleware at all
    // to POST /demo-request (confirmed by direct file inspection --
    // no protect/platformProtect/tenantProtect import), so a Platform
    // Owner or tenant token sent alongside it is simply never read.
    // Not re-exercised live here to avoid burning more of the
    // 5-per-hour rate-limit budget this same test run already used
    // for the D/E/F sequence above.

    // ---------- Reinsteins DB verification ----------
    console.log("\nEXTRA -- Reinsteins DB verification");
    const dbPool = require("./config/db");
    const [[{ tbl }]] = await dbPool.query(`SELECT COUNT(*) AS tbl FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [process.env.DB_NAME]);
    const [[{ users }]] = await dbPool.query(`SELECT COUNT(*) AS users FROM users`);
    check("EXTRA: reinsteins_workhub unchanged", tbl === 37 && users === 17, `tables=${tbl} users=${users}`);

    // ---------- Final cleanup verification ----------
    const [[{ demoRequestsFinal }]] = await platformPool.query(`SELECT COUNT(*) AS demoRequestsFinal FROM demo_requests`);
    console.log(`\nCLEANUP: demo_requests row count back to baseline: ${demoRequestsFinal === demoRequestsBefore} (before=${demoRequestsBefore}, final=${demoRequestsFinal})`);

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
