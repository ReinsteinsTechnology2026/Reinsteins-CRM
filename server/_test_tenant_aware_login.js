require("dotenv").config();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const platformCompanyService = require("./services/platformCompanyService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { closeAllTenantPools } = require("./config/tenantConnectionManager");
const { PLATFORM_JWT_ISSUER, PLATFORM_JWT_AUDIENCE } = require("./controllers/platformAuthController");
const { TENANT_JWT_ISSUER, TENANT_JWT_AUDIENCE } = require("./controllers/tenantAuthController");

// ==========================================
// COMPANY-AWARE TENANT LOGIN SELF-TEST (Phase 2F)
//
// Exercises POST /api/tenant-auth/:companySlug/login and the
// tenantProtect middleware (via GET /api/tenant-auth/me) over real
// HTTP against a running backend on http://localhost:5000, using two
// throwaway companies provisioned through the REAL Phase 2D/2E APIs.
//
// Never touches reinsteins_workhub. Deletes/drops everything it
// creates at the end.
// ==========================================

const BASE_URL = "http://localhost:5000";

const OWNER_EMAIL = "phase2ftest_owner@groworgs.internal";
const OWNER_PASSWORD = "Phase2FTestPassword!2026";

const A_NAME = "PHASE2F A";
const B_NAME = "PHASE2F B";

// Deliberately DIFFERENT passwords for Admin A and Admin B. Both
// tenant databases independently generate employee_id starting from
// "ADM001" (per-tenant numbering, not global), so if both admins
// also shared a password, a "cross-tenant" login attempt using A's
// employeeId+password against B's route would coincidentally succeed
// as Admin B's own (identical-looking) credentials -- proving
// nothing about isolation. Distinct passwords make a false positive
// here impossible: only a genuine data-isolation failure could make
// step 7 below succeed.
const ADMIN_A_PASSWORD = "AdminPass123!Phase2F_A";
const ADMIN_B_PASSWORD = "AdminPass456!Phase2F_B";

let failures = 0;
function check(label, condition, detail) {
    if (condition) console.log(`  [PASS] ${label}`);
    else { failures++; console.log(`  [FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

async function apiPost(path, body, token) {
    const res = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

async function apiGet(path, token) {
    const res = await fetch(`${BASE_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

(async () => {

    const { buildTenantDbName } = require("./utils/tenantDbName");
    // NOTE: isValidSlug forbids hyphens, so the *company slug* used
    // throughout this test is actually "phase2f_a"/"phase2f_b"
    // (underscore), matching the platform's own slug rules -- the
    // Phase 2F prompt's example URLs ("phase2f-a") are illustrative,
    // not a literal requirement to accept hyphens.
    const REAL_A_SLUG = "phase2f_a";
    const REAL_B_SLUG = "phase2f_b";
    const REAL_A_DB = buildTenantDbName(REAL_A_SLUG);
    const REAL_B_DB = buildTenantDbName(REAL_B_SLUG);

    // ---------- Setup: platform owner ----------
    console.log("SETUP -- temporary platform owner + two real tenant companies");
    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    const owner = await platformUserService.create({ name: "Phase 2F Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: platform owner login succeeded", loginRes.status === 200 && !!ownerToken);

    // ---------- Setup: two real companies (Phase 2D) ----------
    const createA = await apiPost("/api/platform/companies", { companyName: A_NAME, companySlug: REAL_A_SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: company A created", createA.status === 201 && createA.body?.company?.tenantDbName === REAL_A_DB);
    const companyAId = createA.body?.company?.id;

    const createB = await apiPost("/api/platform/companies", { companyName: B_NAME, companySlug: REAL_B_SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: company B created", createB.status === 201 && createB.body?.company?.tenantDbName === REAL_B_DB);
    const companyBId = createB.body?.company?.id;

    // ---------- Setup: first admin in each (Phase 2E) ----------
    const ADMIN_A_EMAIL = "admin@phase2f-a.test";
    const ADMIN_B_EMAIL = "admin@phase2f-b.test";

    const adminACreate = await apiPost(`/api/platform/companies/${companyAId}/admin`, { name: "Admin A", email: ADMIN_A_EMAIL, password: ADMIN_A_PASSWORD }, ownerToken);
    check("SETUP: admin A created", adminACreate.status === 201);
    const adminAEmployeeId = adminACreate.body?.admin?.employeeId;

    const adminBCreate = await apiPost(`/api/platform/companies/${companyBId}/admin`, { name: "Admin B", email: ADMIN_B_EMAIL, password: ADMIN_B_PASSWORD }, ownerToken);
    check("SETUP: admin B created", adminBCreate.status === 201);
    const adminBEmployeeId = adminBCreate.body?.admin?.employeeId;

    check("SETUP: both tenants independently generated the same employee_id (expected -- per-tenant numbering, not global)",
        adminAEmployeeId === adminBEmployeeId, `A=${adminAEmployeeId} B=${adminBEmployeeId}`);

    console.log(`  Admin A employeeId=${adminAEmployeeId}, Admin B employeeId=${adminBEmployeeId}\n`);

    // ---------- STEP 1/2: tenant login succeeds for both ----------
    console.log("STEP 1/2 -- Tenant A and Tenant B login succeed");
    const loginA = await apiPost(`/api/tenant-auth/${REAL_A_SLUG}/login`, { employeeId: adminAEmployeeId, password: ADMIN_A_PASSWORD });
    check("1. Tenant A login succeeds (200)", loginA.status === 200, `got ${loginA.status} ${JSON.stringify(loginA.body)}`);
    check("1. Tenant A response company.slug correct", loginA.body?.company?.slug === REAL_A_SLUG);
    const tokenA = loginA.body?.token;

    const loginB = await apiPost(`/api/tenant-auth/${REAL_B_SLUG}/login`, { employeeId: adminBEmployeeId, password: ADMIN_B_PASSWORD });
    check("2. Tenant B login succeeds (200)", loginB.status === 200, `got ${loginB.status} ${JSON.stringify(loginB.body)}`);
    const tokenB = loginB.body?.token;

    // ---------- STEP 3/4: wrong credentials ----------
    console.log("\nSTEP 3/4 -- Wrong password / wrong employee id");
    const wrongPass = await apiPost(`/api/tenant-auth/${REAL_A_SLUG}/login`, { employeeId: adminAEmployeeId, password: "WrongPassword!" });
    check("3. wrong password -> 401", wrongPass.status === 401, `got ${wrongPass.status}`);

    const wrongId = await apiPost(`/api/tenant-auth/${REAL_A_SLUG}/login`, { employeeId: "NOSUCHID999", password: ADMIN_A_PASSWORD });
    check("4. wrong employee id -> 401", wrongId.status === 401, `got ${wrongId.status}`);

    // ---------- STEP 5: unknown company ----------
    console.log("\nSTEP 5 -- Unknown company");
    const unknownCompany = await apiPost(`/api/tenant-auth/no_such_company_zzz/login`, { employeeId: adminAEmployeeId, password: ADMIN_A_PASSWORD });
    check("5. unknown company -> 404", unknownCompany.status === 404, `got ${unknownCompany.status}`);

    // ---------- STEP 6: suspended company ----------
    console.log("\nSTEP 6 -- Suspended company");
    await platformPool.query(`UPDATE companies SET status = 'suspended' WHERE id = ?`, [companyAId]);
    const suspendedLogin = await apiPost(`/api/tenant-auth/${REAL_A_SLUG}/login`, { employeeId: adminAEmployeeId, password: ADMIN_A_PASSWORD });
    check("6. suspended company login -> 403", suspendedLogin.status === 403, `got ${suspendedLogin.status}`);
    await platformPool.query(`UPDATE companies SET status = 'active' WHERE id = ?`, [companyAId]);

    // ---------- STEP 7: Tenant A credentials against Tenant B route ----------
    console.log("\nSTEP 7 -- Tenant A credentials do not work against Tenant B");
    const crossLogin = await apiPost(`/api/tenant-auth/${REAL_B_SLUG}/login`, { employeeId: adminAEmployeeId, password: ADMIN_A_PASSWORD });
    check("7. Tenant A creds rejected on Tenant B route -> 401", crossLogin.status === 401, `got ${crossLogin.status}`);

    // ---------- STEP 8: Tenant A token cannot impersonate Tenant B ----------
    console.log("\nSTEP 8 -- Tenant A token cannot access/impersonate Tenant B context");
    const meWithA = await apiGet("/api/tenant-auth/me", tokenA);
    check("8a. /me with token A resolves company A", meWithA.status === 200 && meWithA.body?.company?.slug === REAL_A_SLUG, JSON.stringify(meWithA.body));

    // Attempt to override via body/query -- tenantProtect must ignore these entirely
    const meWithASpoofed = await fetch(`${BASE_URL}/api/tenant-auth/me?companySlug=${REAL_B_SLUG}&companyId=${companyBId}`, {
        headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
    });
    const meSpoofedBody = await meWithASpoofed.json().catch(() => null);
    check("8b. spoofed query params do not change resolved company", meSpoofedBody?.company?.slug === REAL_A_SLUG, JSON.stringify(meSpoofedBody));

    // ---------- STEP 9/10: platform vs tenant JWT cross-rejection ----------
    console.log("\nSTEP 9/10 -- Platform JWT / Tenant JWT cross-rejection");
    const platformOnTenantMe = await apiGet("/api/tenant-auth/me", ownerToken);
    check("9. Platform JWT rejected by tenant-auth /me -> 401", platformOnTenantMe.status === 401, `got ${platformOnTenantMe.status}`);

    const tenantOnPlatformCreate = await apiPost("/api/platform/companies", { companyName: "X", companySlug: "shouldnotcreate2f", accessType: "trial" }, tokenA);
    check("10a. Tenant JWT rejected by Platform API -> 401", tenantOnPlatformCreate.status === 401, `got ${tenantOnPlatformCreate.status}`);

    const tenantOnLegacyTenantRoute = await apiGet("/api/meetings", tokenA);
    check("10b. Tenant JWT (new) rejected by EXISTING Reinsteins-protected route -> 401",
        tenantOnLegacyTenantRoute.status === 401, `got ${tenantOnLegacyTenantRoute.status}`);

    // ---------- STEP 11/12: response never leaks sensitive data ----------
    console.log("\nSTEP 11/12 -- No password/credential leakage");
    check("11. login response has no password field", loginA.body?.user && !("password" in loginA.body.user) && !("passwordHash" in loginA.body.user));
    const bodyStr = JSON.stringify(loginA.body);
    check("12. login response contains no DB host/user/password/tenant_db_name",
        !/tenant_db_name|DB_HOST|DB_PASSWORD|dbHost|dbPassword/i.test(bodyStr), bodyStr);

    // ---------- STEP 13: arbitrary tenant DB selection blocked ----------
    console.log("\nSTEP 13 -- Arbitrary tenant DB selection via body is ignored");
    const injectionAttempt = await apiPost(`/api/tenant-auth/${REAL_A_SLUG}/login`, {
        employeeId: adminAEmployeeId, password: ADMIN_A_PASSWORD,
        tenant_db_name: "reinsteins_workhub", companyId: 1, companySlug: "reinsteins",
    });
    check("13. login still resolves to company A despite forged fields", injectionAttempt.body?.company?.slug === REAL_A_SLUG, JSON.stringify(injectionAttempt.body));

    // ---------- Existing Reinsteins login untouched ----------
    console.log("\nEXTRA -- Existing /api/auth/login still functions (structurally, no real creds used)");
    const legacyLoginCheck = await apiPost("/api/auth/login", { employeeId: "NONEXISTENT_TEST_ID_ZZZ", password: "whatever" });
    check("EXTRA: legacy login endpoint still responds correctly (401, unchanged behavior)", legacyLoginCheck.status === 401, `got ${legacyLoginCheck.status}`);

    // ---------- Reinsteins DB before/after ----------
    console.log("\nEXTRA -- Reinsteins DB verification");
    const tenantConn = require("./config/db");
    const [[{ tblCount }]] = await tenantConn.query(`SELECT COUNT(*) AS "tblCount" FROM information_schema.tables WHERE table_schema = 'public'`);
    const [[{ userCount }]] = await tenantConn.query(`SELECT COUNT(*) AS "userCount" FROM users`);
    check("EXTRA: reinsteins_workhub table count = 37", Number(tblCount) === 37, `got ${tblCount}`);
    check("EXTRA: reinsteins_workhub user count = 17", Number(userCount) === 17, `got ${userCount}`);

    // ---------- Cleanup ----------
    console.log("\nCLEANUP");
    await closeAllTenantPools();
    await tenantProvisioningService.dropProvisionedDatabase(REAL_A_DB);
    await tenantProvisioningService.dropProvisionedDatabase(REAL_B_DB);
    console.log(`  Dropped "${REAL_A_DB}" and "${REAL_B_DB}"`);

    await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?)`, [REAL_A_SLUG, REAL_B_SLUG]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    console.log(`  Deleted company rows and temp platform owner`);

    const aGone = await tenantProvisioningService.databaseExists(REAL_A_DB);
    const bGone = await tenantProvisioningService.databaseExists(REAL_B_DB);
    const companyAGone = await platformCompanyService.getCompanyBySlug(REAL_A_SLUG);
    const companyBGone = await platformCompanyService.getCompanyBySlug(REAL_B_SLUG);
    check("CLEANUP: tenant A DB gone", aGone === false);
    check("CLEANUP: tenant B DB gone", bGone === false);
    check("CLEANUP: company A row gone", companyAGone === null);
    check("CLEANUP: company B row gone", companyBGone === null);

    const [remaining] = await platformPool.query(`SELECT company_slug FROM companies`);
    check("CLEANUP: only Reinsteins remains in companies", remaining.length === 1 && remaining[0].company_slug === "reinsteins", JSON.stringify(remaining));

    const [remainingTenantDbs] = await platformPool.query(`SELECT datname FROM pg_database WHERE datname LIKE 'tenant_%'`);
    check("CLEANUP: no tenant_* databases left anywhere", remainingTenantDbs.length === 0, JSON.stringify(remainingTenantDbs));

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
