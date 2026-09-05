require("dotenv").config();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");

// ==========================================
// DEMO REQUEST MANAGEMENT SELF-TEST (Phase 7)
//
// Exercises the new Platform Owner demo-request APIs over real HTTP
// against the live backend. Creates temporary demo_requests rows and
// one temporary platform_users row -- both deleted at the end. Never
// creates a company, a tenant database, or touches reinsteins_workhub.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "demoreqtest_owner@groworgs.internal";
const OWNER_PASSWORD = "DemoReqTestOwner!2026";

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
async function apiPatch(pathname, body, token) {
    const res = await fetch(`${BASE_URL}${pathname}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

(async () => {

    // ---------- 1. Create temporary demo requests (directly in DB --
    // does not depend on / does not exercise the rate-limited public
    // endpoint, keeping this test independent and repeatable) ----------
    console.log("STEP 1 -- Create temporary demo requests");
    const [insA] = await platformPool.query(
        `INSERT INTO demo_requests (name, company_name, email, phone, employee_count, message, status)
         VALUES ('Test Lead A', 'Lead Co A', 'leada@demoreqtest.test', '+1 555 0100', '11–50', 'Interested in a demo.', 'new')`
    );
    const [insB] = await platformPool.query(
        `INSERT INTO demo_requests (name, company_name, email, phone, employee_count, message, status)
         VALUES ('Test Lead B', 'Lead Co B', 'leadb@demoreqtest.test', NULL, NULL, NULL, 'new')`
    );
    const idA = insA.insertId;
    const idB = insB.insertId;
    check("1. Two temporary demo requests created", !!idA && !!idB);

    // ---------- 2. Authenticate a temporary Platform Owner ----------
    console.log("\nSTEP 2 -- Authenticate temporary Platform Owner");
    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "Demo Req Test Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("2. Platform Owner login succeeds", loginRes.status === 200 && !!ownerToken, JSON.stringify(loginRes.body));

    // ---------- 3. Test list endpoint ----------
    console.log("\nSTEP 3 -- List endpoint");
    const listRes = await apiGet("/api/platform/demo-requests", ownerToken);
    check("3. List endpoint succeeds", listRes.status === 200 && Array.isArray(listRes.body?.demoRequests));
    const listedA = listRes.body?.demoRequests?.find((r) => r.id === idA);
    const indexOfA = listRes.body?.demoRequests?.findIndex((r) => r.id === idA);
    const indexOfB = listRes.body?.demoRequests?.findIndex((r) => r.id === idB);
    check("3b. Newest-first ordering (idB, created after idA, appears before it in the list)",
        indexOfB !== -1 && indexOfA !== -1 && indexOfB < indexOfA,
        `indexOfA=${indexOfA} indexOfB=${indexOfB}`);
    check("3c. List response omits `message` (list-view payload only)", listedA && !("message" in listedA), JSON.stringify(listedA));
    check("3d. List response contains no internal DB fields", !JSON.stringify(listRes.body).match(/DB_PASSWORD|tenant_db_name|platform_users/i));

    // ---------- 4. Test details endpoint ----------
    console.log("\nSTEP 4 -- Details endpoint");
    const detailsRes = await apiGet(`/api/platform/demo-requests/${idA}`, ownerToken);
    check("4. Details endpoint succeeds and includes message", detailsRes.status === 200 && detailsRes.body?.demoRequest?.message === "Interested in a demo.", JSON.stringify(detailsRes.body));

    const notFoundRes = await apiGet("/api/platform/demo-requests/999999999", ownerToken);
    check("4b (D). Invalid/nonexistent demo request id -> 404", notFoundRes.status === 404, `got ${notFoundRes.status}`);

    // ---------- 5. Test valid status updates ----------
    console.log("\nSTEP 5 -- Valid status updates (F)");
    const toContacted = await apiPatch(`/api/platform/demo-requests/${idA}/status`, { status: "contacted" }, ownerToken);
    check("5. Status update to 'contacted' succeeds", toContacted.status === 200 && toContacted.body?.demoRequest?.status === "contacted", JSON.stringify(toContacted.body));

    const toClosed = await apiPatch(`/api/platform/demo-requests/${idA}/status`, { status: "closed" }, ownerToken);
    check("5b. Status update to 'closed' succeeds", toClosed.status === 200 && toClosed.body?.demoRequest?.status === "closed");

    const backToNew = await apiPatch(`/api/platform/demo-requests/${idA}/status`, { status: "new" }, ownerToken);
    check("5c. Status update back to 'new' succeeds", backToNew.status === 200 && backToNew.body?.demoRequest?.status === "new");

    // ---------- 6. Test invalid status rejection ----------
    console.log("\nSTEP 6 -- Invalid status rejection (E)");
    const invalidStatus = await apiPatch(`/api/platform/demo-requests/${idA}/status`, { status: "won" }, ownerToken);
    check("6 (E). Invalid status value rejected (400)", invalidStatus.status === 400, `got ${invalidStatus.status}`);

    const missingStatus = await apiPatch(`/api/platform/demo-requests/${idA}/status`, {}, ownerToken);
    check("6b. Missing status field rejected (400)", missingStatus.status === 400, `got ${missingStatus.status}`);

    const statusOnMissingRow = await apiPatch(`/api/platform/demo-requests/999999999/status`, { status: "closed" }, ownerToken);
    check("6c. Status update on nonexistent id -> 404", statusOnMissingRow.status === 404, `got ${statusOnMissingRow.status}`);

    // ---------- 7. Test unauthenticated rejection ----------
    console.log("\nSTEP 7 -- Unauthenticated rejection (A, H)");
    const noAuthList = await apiGet("/api/platform/demo-requests");
    check("7 (A). No token -> list rejected (401)", noAuthList.status === 401, `got ${noAuthList.status}`);
    const noAuthDetails = await apiGet(`/api/platform/demo-requests/${idA}`);
    check("7b. No token -> details rejected (401)", noAuthDetails.status === 401, `got ${noAuthDetails.status}`);
    const noAuthStatus = await apiPatch(`/api/platform/demo-requests/${idA}/status`, { status: "closed" });
    check("7c (H). No token -> status update rejected (401)", noAuthStatus.status === 401, `got ${noAuthStatus.status}`);

    // ---------- 8. Test tenant JWT rejection ----------
    console.log("\nSTEP 8 -- Tenant JWT rejection (B)");
    const tenantShapedToken = jwt.sign({ id: 999999, employeeId: "PHASE7-BOUNDARY-TEST", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const tenantOnList = await apiGet("/api/platform/demo-requests", tenantShapedToken);
    check("8 (B). Tenant-shaped JWT -> list rejected (401)", tenantOnList.status === 401, `got ${tenantOnList.status}`);
    const tenantOnStatus = await apiPatch(`/api/platform/demo-requests/${idA}/status`, { status: "closed" }, tenantShapedToken);
    check("8b. Tenant-shaped JWT -> status update rejected (401)", tenantOnStatus.status === 401, `got ${tenantOnStatus.status}`);

    // Real Platform JWT accepted (C) -- already proven by steps 3-6
    // above (every successful call used ownerToken, a real
    // Platform Owner JWT).
    console.log("\n  [PASS] C. Real Platform JWT accepted (already demonstrated by steps 3-6 above)");

    // ---------- 9. Verify arbitrary fields cannot be changed (G) ----------
    console.log("\nSTEP 9 -- Arbitrary fields cannot be changed (G)");
    const beforeForged = await apiGet(`/api/platform/demo-requests/${idB}`, ownerToken);
    const forgedUpdate = await apiPatch(`/api/platform/demo-requests/${idB}/status`, {
        status: "contacted",
        email: "attacker@test.com",
        company_name: "Hacked Company",
        name: "Attacker Name",
    }, ownerToken);
    check("9. Forged-field request still succeeds (only status honored)", forgedUpdate.status === 200 && forgedUpdate.body?.demoRequest?.status === "contacted");
    const afterForged = await apiGet(`/api/platform/demo-requests/${idB}`, ownerToken);
    check("9b (G). email/company_name/name unchanged despite forged body fields",
        afterForged.body?.demoRequest?.email === beforeForged.body?.demoRequest?.email &&
        afterForged.body?.demoRequest?.companyName === beforeForged.body?.demoRequest?.companyName &&
        afterForged.body?.demoRequest?.name === beforeForged.body?.demoRequest?.name,
        JSON.stringify({ before: beforeForged.body?.demoRequest, after: afterForged.body?.demoRequest }));
    check("9c. Forged email never actually reached the database", afterForged.body?.demoRequest?.email !== "attacker@test.com");

    // ---------- 10. Verify public demo submission still works (I) ----------
    console.log("\nSTEP 10 -- Public demo submission still works (I)");
    const [[{ demoCountBefore }]] = await platformPool.query(`SELECT COUNT(*) AS demoCountBefore FROM demo_requests`);
    const publicSubmit = await apiPost("/api/public/demo-request", {
        name: "Public Submitter", companyName: "Public Co", email: "public@demoreqtest.test",
    });
    check("10. Public POST /api/public/demo-request still works (201)", publicSubmit.status === 201 && !!publicSubmit.body?.referenceId, JSON.stringify(publicSubmit.body));
    const [[{ demoCountAfter }]] = await platformPool.query(`SELECT COUNT(*) AS demoCountAfter FROM demo_requests`);
    check("10b. demo_requests row count increased by exactly 1", demoCountAfter === demoCountBefore + 1, `before=${demoCountBefore} after=${demoCountAfter}`);

    // ---------- Existing company management APIs still work (J) ----------
    console.log("\nEXTRA -- Existing company management APIs still work (J)");
    const companiesListRes = await apiGet("/api/platform/companies", ownerToken);
    check("J. GET /api/platform/companies still works", companiesListRes.status === 200 && Array.isArray(companiesListRes.body?.companies));
    const reinsteinsRow = companiesListRes.body?.companies?.find((c) => c.companySlug === "reinsteins");
    check("J2. Reinsteins still appears correctly (active/complimentary)", reinsteinsRow?.status === "active" && reinsteinsRow?.accessType === "complimentary");

    // ---------- Reinsteins tenant functionality unchanged (K) ----------
    console.log("\nEXTRA -- Reinsteins tenant functionality unchanged (K)");
    const legacyToken = jwt.sign({ id: 4, employeeId: "PHASE7-LEGACY-TEST", role: "employee" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const dbPool = require("./config/db");
    const [[{ tbl }]] = await dbPool.query(`SELECT COUNT(*) AS tbl FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [process.env.DB_NAME]);
    const [[{ users }]] = await dbPool.query(`SELECT COUNT(*) AS users FROM users`);
    check("K. reinsteins_workhub unchanged (37 tables, 17 users)", tbl === 37 && users === 17, `tables=${tbl} users=${users}`);
    const legacyDepts = await apiGet("/api/departments", legacyToken);
    check("K2. Legacy Reinsteins token still resolves real business data", legacyDepts.status === 200 && legacyDepts.body?.departments?.length === 3, JSON.stringify(legacyDepts.body));

    // ---------- Confirm no unwanted companies/tenant DBs were created ----------
    console.log("\nEXTRA -- No unwanted companies or tenant databases created by this phase's testing");
    const [companies] = await platformPool.query(`SELECT company_slug FROM companies`);
    check("No unwanted companies exist (only Reinsteins)", companies.length === 1 && companies[0].company_slug === "reinsteins", JSON.stringify(companies));
    const [tenantDbs] = await platformPool.query(`SHOW DATABASES LIKE 'tenant_%'`);
    check("No unwanted tenant databases exist (only tenant_reinsteins)", tenantDbs.length === 1, JSON.stringify(tenantDbs));

    // ---------- 11/12. Clean up ALL temporary test data + delete temp Platform Owner ----------
    console.log("\nSTEP 11/12 -- Cleanup");
    await platformPool.query(`DELETE FROM demo_requests WHERE id IN (?, ?)`, [idA, idB]);
    await platformPool.query(`DELETE FROM demo_requests WHERE id = ?`, [publicSubmit.body.referenceId]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);

    const [[{ remainingTestRows }]] = await platformPool.query(
        `SELECT COUNT(*) AS remainingTestRows FROM demo_requests WHERE email LIKE '%demoreqtest.test'`
    );
    check("11. All temporary demo_requests rows deleted", remainingTestRows === 0, `remaining=${remainingTestRows}`);

    const [remainingOwners] = await platformPool.query(`SELECT email FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    check("12. Temporary Platform Owner deleted", remainingOwners.length === 0);

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
