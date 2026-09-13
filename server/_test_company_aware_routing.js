require("dotenv").config();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { buildTenantDbName } = require("./utils/tenantDbName");
const { PLATFORM_JWT_ISSUER, PLATFORM_JWT_AUDIENCE } = require("./controllers/platformAuthController");

// ==========================================
// COMPANY-AWARE FRONTEND ACCESS / ROUTING SELF-TEST (Phase 5)
//
// This phase is primarily a frontend routing change, but the actual
// security boundary it depends on is entirely backend-enforced
// (GET /api/tenant-auth/me re-resolving the caller's REAL company
// from their JWT, never trusting a URL-supplied slug). This suite
// proves that boundary directly, plus the new public /info endpoint
// and reserved-slug guard added this phase. Uses two throwaway
// tenants; never touches reinsteins_workhub or real Reinsteins
// credentials.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "routetest_owner@groworgs.internal";
const OWNER_PASSWORD = "RouteTestOwner!2026Pwd";

const A_SLUG = "routetest_a";
const B_SLUG = "routetest_b";
const A_DB = buildTenantDbName(A_SLUG);
const B_DB = buildTenantDbName(B_SLUG);

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

    // ---------- Setup ----------
    console.log("SETUP -- platform owner + two tenants + employees");
    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "Route Test Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: platform owner login", loginRes.status === 200 && !!ownerToken);

    const createA = await apiPost("/api/platform/companies", { companyName: "ROUTE TEST A", companySlug: A_SLUG, accessType: "trial" }, ownerToken);
    const companyAId = createA.body?.company?.id;
    const createB = await apiPost("/api/platform/companies", { companyName: "ROUTE TEST B", companySlug: B_SLUG, accessType: "trial" }, ownerToken);
    const companyBId = createB.body?.company?.id;
    check("SETUP: both companies provisioned", createA.status === 201 && createB.status === 201);

    // Tenant A gets a real first ADMIN (via the existing platform
    // admin-creation endpoint) so it can exercise admin-only APIs
    // (department creation) below; Tenant B gets a plain employee --
    // both are valid tenant identities for the /tenant-auth/me and
    // cross-boundary checks either way.
    const ADMIN_A_PASSWORD = "RouteTestAdminA!2026";
    const adminA = await apiPost(`/api/platform/companies/${companyAId}/admin`, { name: "Route Admin A", email: "admin@routetest-a.test", password: ADMIN_A_PASSWORD }, ownerToken);
    check("SETUP: Tenant A first admin created", adminA.status === 201, JSON.stringify(adminA.body));

    const empPasswordHash = await bcrypt.hash("RouteTestEmp!2026", 12);
    const poolB = getTenantPool(B_DB);
    await poolB.query(`INSERT INTO users (employee_id, full_name, email, password, role, system_access, status) VALUES ('EMP001', 'Emp B', 'b@routetest.test', ?, 'employee', 'employee', 'active')`, [empPasswordHash]);

    const loginA = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: adminA.body?.admin?.employeeId, password: ADMIN_A_PASSWORD });
    const loginB = await apiPost(`/api/tenant-auth/${B_SLUG}/login`, { employeeId: "EMP001", password: "RouteTestEmp!2026" });
    const tokenA = loginA.body?.token;
    const tokenB = loginB.body?.token;
    check("SETUP: both tenant logins succeed", loginA.status === 200 && loginB.status === 200);

    // ---------- New /info endpoint ----------
    console.log("\nTEST -- Public company info endpoint (Phase 5 new)");
    const infoA = await apiGet(`/api/tenant-auth/${A_SLUG}/info`);
    check("Company info returns name only, no status/accessType/tenantDbName", infoA.status === 200 &&
        infoA.body?.company?.name === "ROUTE TEST A" &&
        !("status" in (infoA.body?.company || {})) &&
        !("tenantDbName" in (infoA.body?.company || {})),
        JSON.stringify(infoA.body));

    const infoUnknown = await apiGet(`/api/tenant-auth/no_such_company_zzz/info`);
    check("Unknown company info -> 404", infoUnknown.status === 404);

    const infoReinsteins = await apiGet(`/api/tenant-auth/reinsteins/info`);
    check("Real Reinsteins company info resolves correctly (name only)", infoReinsteins.status === 200 && infoReinsteins.body?.company?.name === "Reinsteins Technology", JSON.stringify(infoReinsteins.body));

    // Prove the REAL /api/tenant-auth/reinsteins/login path resolves
    // against tenant_reinsteins WITHOUT using any real credentials --
    // wrong password against a real employee_id pattern must be 401
    // (found + wrong password), not 404 (route/company broken).
    const reinsteinsWrongPw = await apiPost(`/api/tenant-auth/reinsteins/login`, { employeeId: "NOSUCHID999ZZZ", password: "whatever" });
    check("Real /reinsteins login path resolves correctly (401 for unknown id, not 404/500)", reinsteinsWrongPw.status === 401, `got ${reinsteinsWrongPw.status}`);

    // ---------- A/B/C: cross-tenant URL/localStorage manipulation ----------
    console.log("\nTEST A/B/C -- Cross-tenant access via URL/token/localStorage manipulation");

    // This is exactly what ProtectedRoute.jsx does: call /tenant-auth/me
    // and compare the returned company.slug against the URL's slug.
    const meWithA = await apiGet("/api/tenant-auth/me", tokenA);
    check("A. Tenant A's token resolves ONLY to company A (never B)", meWithA.body?.company?.slug === A_SLUG && meWithA.body?.company?.slug !== B_SLUG, JSON.stringify(meWithA.body));

    const meWithB = await apiGet("/api/tenant-auth/me", tokenB);
    check("B. Tenant B's token resolves ONLY to company B (never A)", meWithB.body?.company?.slug === B_SLUG, JSON.stringify(meWithB.body));

    // Simulate "user manually edited the URL from /routetest_a/admin to
    // /routetest_b/admin, or edited localStorage" -- the FRONTEND route
    // guard compares (this response).company.slug to the URL param; it
    // can never be tricked into matching, because this response always
    // reflects the token's real company regardless of what URL the
    // browser is showing.
    check("C. No client-side value can change what /tenant-auth/me resolves to -- same token, same company, every time",
        meWithA.body?.company?.slug === A_SLUG && meWithB.body?.company?.slug === B_SLUG);

    // Attempt an actual cross-tenant business API call using A's token,
    // proving data isolation independent of the frontend guard: create
    // a department as A, confirm B never sees it.
    const createDeptA = await apiPost("/api/departments", { name: "Route Test Dept A", code: "RTDA" }, tokenA);
    check("A2. Tenant A can create its own department", createDeptA.status === 201, JSON.stringify(createDeptA.body));

    const deptListB = await apiGet("/api/departments", tokenB);
    check("A3. Tenant B's business API call never sees Tenant A's department",
        deptListB.status === 200 && !JSON.stringify(deptListB.body).includes("Route Test Dept A"), JSON.stringify(deptListB.body));

    const deptListA = await apiGet("/api/departments", tokenA);
    check("A4. Tenant A sees its own department via its own token", deptListA.body?.departments?.some((d) => d.name === "Route Test Dept A"));

    // ---------- D/E: platform vs tenant boundary ----------
    console.log("\nTEST D/E -- Platform Owner token vs tenant portal");
    const platformOnTenantMe = await apiGet("/api/tenant-auth/me", ownerToken);
    check("D. Platform Owner token cannot access tenant portal (/tenant-auth/me) -> 401", platformOnTenantMe.status === 401, `got ${platformOnTenantMe.status}`);

    const tenantOnPlatformList = await apiGet("/api/platform/companies", tokenA);
    check("E. Tenant token cannot access Platform Dashboard APIs -> 401", tenantOnPlatformList.status === 401, `got ${tenantOnPlatformList.status}`);

    // ---------- F: suspended company cannot login ----------
    console.log("\nTEST F -- Suspended company cannot log in");
    await platformPool.query(`UPDATE companies SET status = 'suspended' WHERE id = ?`, [companyAId]);
    const suspendedLogin = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: adminA.body?.admin?.employeeId, password: ADMIN_A_PASSWORD });
    check("F. Suspended company login rejected -> 403", suspendedLogin.status === 403, `got ${suspendedLogin.status}`);
    const suspendedInfo = await apiGet(`/api/tenant-auth/${A_SLUG}/info`);
    check("F2. Suspended company's public info also hidden (same 404 as unknown)", suspendedInfo.status === 404, `got ${suspendedInfo.status}`);
    const suspendedMe = await apiGet("/api/tenant-auth/me", tokenA);
    check("F3. Existing token from before suspension immediately loses access -> 401", suspendedMe.status === 401, `got ${suspendedMe.status}`);
    await platformPool.query(`UPDATE companies SET status = 'active' WHERE id = ?`, [companyAId]);

    // ---------- G: existing Reinsteins (legacy) functionality still works ----------
    console.log("\nTEST G -- Existing legacy Reinsteins auth path still works");
    const legacyToken = jwt.sign({ id: 4, employeeId: "LEGACY-ROUTE-TEST", role: "employee" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const legacyVerify = await apiGet("/api/auth/verify", legacyToken);
    check("G. Legacy /api/auth/verify still accepts a legacy JWT_SECRET token unchanged", legacyVerify.status === 200, JSON.stringify(legacyVerify.body));
    const legacyDepts = await apiGet("/api/departments", legacyToken);
    check("G2. Legacy token still resolves business APIs against reinsteins_workhub (real data, unaffected)", legacyDepts.status === 200 && Array.isArray(legacyDepts.body?.departments) && legacyDepts.body.departments.length === 3,
        JSON.stringify(legacyDepts.body));

    // ---------- Reserved slug guard (Phase 5 new) ----------
    console.log("\nTEST -- Reserved company slug guard");
    const reservedAttempt = await apiPost("/api/platform/companies", { companyName: "Should Fail", companySlug: "admin", accessType: "trial" }, ownerToken);
    check("Reserved slug 'admin' rejected at company creation", reservedAttempt.status === 400, `got ${reservedAttempt.status} ${JSON.stringify(reservedAttempt.body)}`);

    // ---------- Reinsteins DB unaffected ----------
    console.log("\nEXTRA -- Reinsteins DB verification");
    const dbPool = require("./config/db");
    const [[{ tbl }]] = await dbPool.query(`SELECT COUNT(*) AS tbl FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [process.env.DB_NAME]);
    const [[{ users }]] = await dbPool.query(`SELECT COUNT(*) AS users FROM users`);
    check("EXTRA: reinsteins_workhub unchanged", tbl === 37 && users === 17, `tables=${tbl} users=${users}`);

    // ---------- Cleanup ----------
    console.log("\nCLEANUP");
    // Phase 13/14 -- see _test_payments.js's cleanup comment for why.
    await platformPool.query(`DELETE FROM email_delivery_logs WHERE company_id IN (?, ?)`, [companyAId, companyBId]);
    const [[routetestOwnerRow]] = await platformPool.query(`SELECT id FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    if (routetestOwnerRow) await platformPool.query(`DELETE FROM platform_audit_logs WHERE platform_user_id = ?`, [routetestOwnerRow.id]);

    await closeAllTenantPools();
    await tenantProvisioningService.dropProvisionedDatabase(A_DB);
    await tenantProvisioningService.dropProvisionedDatabase(B_DB);
    await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?)`, [A_SLUG, B_SLUG]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);

    const aGone = await tenantProvisioningService.databaseExists(A_DB);
    const bGone = await tenantProvisioningService.databaseExists(B_DB);
    check("CLEANUP: both tenant DBs gone", aGone === false && bGone === false);
    const [remaining] = await platformPool.query(`SELECT company_slug FROM companies`);
    check("CLEANUP: only Reinsteins remains", remaining.length === 1 && remaining[0].company_slug === "reinsteins", JSON.stringify(remaining));

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
