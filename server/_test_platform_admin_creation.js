require("dotenv").config();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const platformCompanyService = require("./services/platformCompanyService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const tenantUserService = require("./services/tenantUserService");
const { getTenantPoolForCompany, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { PLATFORM_JWT_ISSUER, PLATFORM_JWT_AUDIENCE } = require("./controllers/platformAuthController");

// ==========================================
// PLATFORM COMPANY ADMIN CREATION SELF-TEST (Phase 2E)
//
// Exercises POST /api/platform/companies (Phase 2D, reused as-is)
// and POST /api/platform/companies/:companyId/admin (Phase 2E) over
// real HTTP against a running backend on http://localhost:5000.
//
// Creates two temporary platform_users rows, two temporary
// companies (each with a real provisioned tenant database), and a
// handful of tenant admin users -- all deleted/dropped at the end.
// Never touches reinsteins_workhub or the Reinsteins company row.
// ==========================================

const BASE_URL = "http://localhost:5000";

const OWNER_EMAIL = "phase2etest_owner@groworgs.internal";
const INACTIVE_EMAIL = "phase2etest_inactive@groworgs.internal";
const OWNER_PASSWORD = "Phase2ETestPassword!2026";

const MAIN_SLUG = "groworgs_phase2e_test";
const MAIN_NAME = "GROWORGS PHASE2E TEST";
const MAIN_TENANT_DB = "tenant_groworgs_phase2e_test";

const CROSS_SLUG = "groworgs_phase2e_test_cross";
const CROSS_NAME = "GROWORGS PHASE2E TEST CROSS";
const CROSS_TENANT_DB = "tenant_groworgs_phase2e_test_cross";

const SHARED_ADMIN_EMAIL = "shared.admin@phase2e.test";

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
    const res = await fetch(`${BASE_URL}${path}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status };
}

(async () => {

    // ---------- Setup ----------
    console.log("SETUP -- temporary platform owner accounts");
    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    const owner = await platformUserService.create({ name: "Phase 2E Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
    const inactiveOwner = await platformUserService.create({ name: "Phase 2E Inactive Owner", email: INACTIVE_EMAIL, passwordHash, role: "platform_owner" });
    await platformPool.query(`UPDATE platform_users SET status = 'inactive' WHERE id = ?`, [inactiveOwner.id]);

    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: login for temp owner succeeded", loginRes.status === 200 && !!ownerToken);

    const inactiveToken = jwt.sign({ userId: inactiveOwner.id, type: "platform_owner" }, process.env.PLATFORM_JWT_SECRET,
        { expiresIn: "1h", issuer: PLATFORM_JWT_ISSUER, audience: PLATFORM_JWT_AUDIENCE });
    const tenantShapedToken = jwt.sign({ id: 1, employeeId: "TEST-BOUNDARY", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

    // ---------- Create the two real test companies via the real Phase 2D API ----------
    console.log("\nSETUP -- creating two real test companies");
    const mainCreate = await apiPost("/api/platform/companies", { companyName: MAIN_NAME, companySlug: MAIN_SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: main company created", mainCreate.status === 201 && mainCreate.body?.company?.tenantDbName === MAIN_TENANT_DB);
    const mainCompanyId = mainCreate.body?.company?.id;

    const crossCreate = await apiPost("/api/platform/companies", { companyName: CROSS_NAME, companySlug: CROSS_SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: cross company created", crossCreate.status === 201 && crossCreate.body?.company?.tenantDbName === CROSS_TENANT_DB);
    const crossCompanyId = crossCreate.body?.company?.id;

    // ---------- STEP 1: authorization boundary checks ----------
    console.log("\nSTEP 1 -- Authorization boundary checks");
    const adminPath = `/api/platform/companies/${mainCompanyId}/admin`;
    const goodBody = { name: "Main Admin", email: "admin@phase2e-main.test", password: "AdminPass123!", phone: "1234567890" };

    const noAuth = await apiPost(adminPath, goodBody);
    check("1a. no token -> 401", noAuth.status === 401, `got ${noAuth.status}`);

    const tenantAuth = await apiPost(adminPath, goodBody, tenantShapedToken);
    check("1b. tenant-shaped JWT -> 401", tenantAuth.status === 401, `got ${tenantAuth.status}`);

    const inactiveAuth = await apiPost(adminPath, goodBody, inactiveToken);
    check("1c. inactive platform owner -> 401", inactiveAuth.status === 401, `got ${inactiveAuth.status}`);

    // ---------- STEP 2: invalid company id ----------
    console.log("\nSTEP 2 -- Invalid / nonexistent company id");
    const badIdRes = await apiPost("/api/platform/companies/99999999/admin", goodBody, ownerToken);
    check("2. nonexistent company id -> 404", badIdRes.status === 404, `got ${badIdRes.status}`);

    // ---------- STEP 3: real admin creation, with forged fields present ----------
    console.log("\nSTEP 3 -- Real admin creation for main company (forged fields present)");
    const createRes = await apiPost(adminPath, {
        ...goodBody,
        role: "super_admin",
        system_access: "super_admin",
        tenant_db_name: "reinsteins_workhub",
        status: "pending",
    }, ownerToken);
    check("3. creation succeeded (201)", createRes.status === 201, `got ${createRes.status} ${JSON.stringify(createRes.body)}`);
    const createdAdmin = createRes.body?.admin;
    check("3. response has no password/passwordHash field", createdAdmin && !("password" in createdAdmin) && !("passwordHash" in createdAdmin));
    check("3. role is admin", createdAdmin?.role === "admin");
    check("3. systemAccess is super_admin", createdAdmin?.systemAccess === "super_admin");
    check("3. employeeId generated", typeof createdAdmin?.employeeId === "string" && createdAdmin.employeeId.startsWith("ADM"));

    // ---------- STEP 4: admin exists ONLY in tenant DB, not platform DB ----------
    console.log("\nSTEP 4 -- Admin isolation verification");
    const mainCompanyRow = await platformCompanyService.getCompanyById(mainCompanyId);
    const mainTenantPool = getTenantPoolForCompany(mainCompanyRow);

    const [tenantRows] = await mainTenantPool.query(`SELECT id, employee_id, email, role, system_access, status, password FROM users WHERE email = ?`, [goodBody.email]);
    check("4. admin row exists in tenant DB", tenantRows.length === 1);
    check("4. password is a bcrypt hash, not plaintext", tenantRows[0]?.password?.startsWith("$2"), tenantRows[0]?.password);
    check("4. tenant DB row shows the forged fields were ignored (role=admin not super_admin literal-mismatch check n/a; system_access=super_admin as designed)",
        tenantRows[0]?.role === "admin" && tenantRows[0]?.system_access === "super_admin");

    const [platformUserRows] = await platformPool.query(`SELECT id FROM platform_users WHERE email = ?`, [goodBody.email]);
    check("4. admin does NOT exist in groworgs_platform_db.platform_users", platformUserRows.length === 0);

    // ---------- STEP 5: only one "first admin" allowed ----------
    console.log("\nSTEP 5 -- Second admin-creation call is blocked");
    const secondAdminRes = await apiPost(adminPath, { name: "Second Admin", email: "second@phase2e-main.test", password: "AdminPass123!" }, ownerToken);
    check("5. second call blocked (409, already has admin)", secondAdminRes.status === 409, `got ${secondAdminRes.status}`);

    // ---------- STEP 6: duplicate email within the SAME tenant (service-level) ----------
    console.log("\nSTEP 6 -- Duplicate email within the same tenant DB (direct service-level test)");
    try {
        await tenantUserService.createFirstAdmin(mainTenantPool, {
            name: "Duplicate Attempt", email: goodBody.email, phone: null, passwordHash: await bcrypt.hash("AnotherPass123!", 12),
        });
        check("6. duplicate email rejected", false, "insert unexpectedly succeeded");
    } catch (dupError) {
        check("6. duplicate email rejected with TENANT_EMAIL_TAKEN", dupError.code === "TENANT_EMAIL_TAKEN", dupError.message);
    }

    // ---------- STEP 7: cross-tenant email reuse is allowed ----------
    console.log("\nSTEP 7 -- Same email allowed across two different tenants");
    const crossAdminRes = await apiPost(`/api/platform/companies/${crossCompanyId}/admin`,
        { name: "Cross Admin", email: SHARED_ADMIN_EMAIL, password: "AdminPass123!" }, ownerToken);
    check("7a. admin created in cross company", crossAdminRes.status === 201, `got ${crossAdminRes.status} ${JSON.stringify(crossAdminRes.body)}`);

    // Reuse the SAME email directly against the main tenant (service-level, bypassing the "only one admin" HTTP rule which has already been proven separately) to prove cross-tenant email reuse is not blocked at the data layer either.
    try {
        await tenantUserService.createFirstAdmin(mainTenantPool, {
            name: "Shared Email In Main Tenant", email: SHARED_ADMIN_EMAIL, phone: null, passwordHash: await bcrypt.hash("AdminPass123!", 12),
        });
        check("7b. same email accepted in a second tenant database", true);
    } catch (crossError) {
        check("7b. same email accepted in a second tenant database", false, crossError.message);
    }

    // ---------- STEP 8: missing tenant_db_name -> blocked ----------
    console.log("\nSTEP 8 -- Missing tenant_db_name blocked");
    await platformPool.query(`UPDATE companies SET tenant_db_name = NULL WHERE id = ?`, [crossCompanyId]);
    const missingDbRes = await apiPost(`/api/platform/companies/${crossCompanyId}/admin`, { name: "Missing DB Test", email: "x@x.test", password: "AdminPass123!" }, ownerToken);
    check("8. missing tenant_db_name -> 409", missingDbRes.status === 409, `got ${missingDbRes.status} ${JSON.stringify(missingDbRes.body)}`);
    await platformPool.query(`UPDATE companies SET tenant_db_name = ? WHERE id = ?`, [CROSS_TENANT_DB, crossCompanyId]);

    // ---------- STEP 9: suspended company -> blocked ----------
    console.log("\nSTEP 9 -- Suspended company blocked");
    await platformPool.query(`UPDATE companies SET status = 'suspended' WHERE id = ?`, [crossCompanyId]);
    const suspendedRes = await apiPost(`/api/platform/companies/${crossCompanyId}/admin`, { name: "Suspended Test", email: "y@y.test", password: "AdminPass123!" }, ownerToken);
    check("9. suspended company -> 409", suspendedRes.status === 409, `got ${suspendedRes.status} ${JSON.stringify(suspendedRes.body)}`);
    await platformPool.query(`UPDATE companies SET status = 'active' WHERE id = ?`, [crossCompanyId]);

    // ---------- STEP 10: arbitrary tenant DB name in body is ignored ----------
    console.log("\nSTEP 10 -- Arbitrary tenant_db_name in body cannot redirect the write");
    const [[{ userCountBeforeInjection }]] = await (async () => {
        const mysql = require("mysql2/promise");
        const c = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
        const r = await c.query(`SELECT COUNT(*) AS userCountBeforeInjection FROM users`);
        await c.end();
        return r;
    })();
    check("10. reinsteins_workhub user count unaffected by forged tenant_db_name in step 3's body", userCountBeforeInjection === 17, `got ${userCountBeforeInjection}`);

    // ---------- STEP 11: tenant JWT cannot access platform APIs; platform JWT cannot access tenant APIs ----------
    console.log("\nSTEP 11 -- Cross-boundary JWT checks");
    const tenantOnPlatform = await apiPost("/api/platform/companies", { companyName: "X", companySlug: "shouldnotcreate", accessType: "trial" }, tenantShapedToken);
    check("11a. tenant JWT rejected by platform company-creation route", tenantOnPlatform.status === 401, `got ${tenantOnPlatform.status}`);

    const platformOnTenant = await apiGet("/api/meetings", ownerToken);
    check("11b. platform JWT rejected by existing tenant route", platformOnTenant.status === 401, `got ${platformOnTenant.status}`);

    // ---------- Cleanup ----------
    console.log("\nCLEANUP");
    await closeAllTenantPools();

    await tenantProvisioningService.dropProvisionedDatabase(MAIN_TENANT_DB);
    await tenantProvisioningService.dropProvisionedDatabase(CROSS_TENANT_DB);
    console.log(`  Dropped tenant databases "${MAIN_TENANT_DB}" and "${CROSS_TENANT_DB}"`);

    await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?)`, [MAIN_SLUG, CROSS_SLUG]);
    console.log(`  Deleted company rows`);

    await platformPool.query(`DELETE FROM platform_users WHERE email IN (?, ?)`, [OWNER_EMAIL, INACTIVE_EMAIL]);
    console.log(`  Deleted temp platform owner accounts`);

    const mainDbGone = await tenantProvisioningService.databaseExists(MAIN_TENANT_DB);
    const crossDbGone = await tenantProvisioningService.databaseExists(CROSS_TENANT_DB);
    const mainCompanyGone = await platformCompanyService.getCompanyBySlug(MAIN_SLUG);
    const crossCompanyGone = await platformCompanyService.getCompanyBySlug(CROSS_SLUG);
    check("CLEANUP: main tenant DB gone", mainDbGone === false);
    check("CLEANUP: cross tenant DB gone", crossDbGone === false);
    check("CLEANUP: main company row gone", mainCompanyGone === null);
    check("CLEANUP: cross company row gone", crossCompanyGone === null);

    const [remainingTenantDbs] = await platformPool.query(`SHOW DATABASES LIKE 'tenant_%'`);
    check("CLEANUP: no tenant_* databases left anywhere", remainingTenantDbs.length === 0, JSON.stringify(remainingTenantDbs));

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
