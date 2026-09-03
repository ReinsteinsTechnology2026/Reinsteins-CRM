require("dotenv").config();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const platformCompanyService = require("./services/platformCompanyService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { buildTenantDbName, isValidTenantDbName } = require("./utils/tenantDbName");
const { PLATFORM_JWT_ISSUER, PLATFORM_JWT_AUDIENCE } = require("./controllers/platformAuthController");

// ==========================================
// PLATFORM COMPANY CREATION SELF-TEST (Phase 2D)
//
// Exercises POST /api/platform/companies over real HTTP against a
// running backend (must already be started separately on
// http://localhost:5000), plus a direct service-level test of the
// rollback/compensation path (the failure-injection hook is
// deliberately not reachable over HTTP).
//
// Creates exactly ONE temporary platform_users row (for auth) and
// ONE temporary companies row + tenant database (for the functional
// test), both deleted at the end. Never touches reinsteins_workhub
// or the Reinsteins company metadata row.
// ==========================================

const BASE_URL = "http://localhost:5000";

const TEST_OWNER_EMAIL = "phase2dtest_owner@groworgs.internal";
const TEST_INACTIVE_EMAIL = "phase2dtest_inactive@groworgs.internal";
const TEST_PASSWORD = "Phase2DTestPassword!2026";

const TEST_COMPANY_SLUG = "groworgs_phase2d_test";
const TEST_COMPANY_NAME = "GROWORGS PHASE2D TEST";
const EXPECTED_TENANT_DB = "tenant_groworgs_phase2d_test";

const ROLLBACK_TEST_SLUG = "groworgs_phase2d_rollback_test";

let failures = 0;
function check(label, condition, detail) {
    if (condition) {
        console.log(`  [PASS] ${label}`);
    } else {
        failures++;
        console.log(`  [FAIL] ${label}${detail ? " -- " + detail : ""}`);
    }
}

async function post(path, body, token) {
    const res = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

(async () => {

    // ---------- Setup: temp platform owner accounts ----------
    console.log("SETUP -- temporary platform owner accounts");
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, 12);

    const owner = await platformUserService.create({
        name: "Phase 2D Test Owner",
        email: TEST_OWNER_EMAIL,
        passwordHash,
        role: "platform_owner",
    });
    console.log(`  Created temp active owner id=${owner.id}`);

    const inactiveOwner = await platformUserService.create({
        name: "Phase 2D Test Inactive Owner",
        email: TEST_INACTIVE_EMAIL,
        passwordHash,
        role: "platform_owner",
    });
    await platformPool.query(`UPDATE platform_users SET status = 'inactive' WHERE id = ?`, [inactiveOwner.id]);
    console.log(`  Created temp inactive owner id=${inactiveOwner.id}\n`);

    const loginRes = await post("/api/platform/auth/login", { email: TEST_OWNER_EMAIL, password: TEST_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: real login for temp owner succeeded", loginRes.status === 200 && !!ownerToken);

    const inactiveToken = jwt.sign(
        { userId: inactiveOwner.id, type: "platform_owner" },
        process.env.PLATFORM_JWT_SECRET,
        { expiresIn: "1h", issuer: PLATFORM_JWT_ISSUER, audience: PLATFORM_JWT_AUDIENCE }
    );

    const tenantShapedToken = jwt.sign(
        { id: 1, employeeId: "TEST-BOUNDARY", role: "admin" },
        process.env.JWT_SECRET,
        { expiresIn: "1h" }
    );

    // ---------- Security checks ----------
    console.log("\nSTEP 1 -- Authorization boundary checks");

    const noAuth = await post("/api/platform/companies", { companyName: "X", companySlug: "xzzz", accessType: "trial" });
    check("1a. no token -> 401", noAuth.status === 401, `got ${noAuth.status}`);

    const tenantAuth = await post("/api/platform/companies", { companyName: "X", companySlug: "xzzz", accessType: "trial" }, tenantShapedToken);
    check("1b. tenant-shaped JWT -> 401", tenantAuth.status === 401, `got ${tenantAuth.status}`);

    const inactiveAuth = await post("/api/platform/companies", { companyName: "X", companySlug: "xzzz", accessType: "trial" }, inactiveToken);
    check("1c. inactive platform owner -> 401", inactiveAuth.status === 401, `got ${inactiveAuth.status}`);

    // ---------- Hostile input checks (before real creation) ----------
    console.log("\nSTEP 2 -- Hostile / invalid input rejection");
    // NOTE: "reinsteins" is deliberately NOT included here -- it is
    // actually a *valid* slug under isValidSlug(), so testing it
    // would attempt to really provision tenant_reinsteins, which
    // Phase 2D explicitly must not do. The reinsteins/tenant_db_name
    // safety is instead proven by STEP 7 below (Reinsteins' platform
    // row stays untouched throughout this entire test run).
    //
    // "UPPERCASE" is also deliberately NOT tested as a rejection here
    // -- the controller normalizes case (trim + toLowerCase) BEFORE
    // validating, per the Phase 2D requirement that the slug be
    // "normalized safely" rather than rejected outright for casing.
    // That normalization path is covered separately in step 2b below.
    const hostileSlugs = [
        "tenant_x`; DROP TABLE users; --",
        "has spaces",
        "-startswithsymbol",
        "a",                 // too short (min 2 chars)
        "x".repeat(50),      // too long (max 40 chars)
    ];
    for (const slug of hostileSlugs) {
        const r = await post("/api/platform/companies", { companyName: "Hostile Test", companySlug: slug, accessType: "trial" }, ownerToken);
        check(`2. rejected slug "${slug.length > 20 ? slug.slice(0, 20) + "..." : slug}"`, r.status === 400, `got ${r.status} ${JSON.stringify(r.body)}`);
    }

    console.log("\nSTEP 2b -- Case normalization (accepted, not rejected)");
    const normSlug = "phase2d_norm_test";
    const normRes = await post("/api/platform/companies", { companyName: "Norm Test", companySlug: "PHASE2D_NORM_TEST", accessType: "trial" }, ownerToken);
    check("2b. uppercase input normalized and accepted (201)", normRes.status === 201, `got ${normRes.status} ${JSON.stringify(normRes.body)}`);
    check("2b. tenant DB uses lowercased slug", normRes.body?.company?.tenantDbName === buildTenantDbName(normSlug),
        `got ${normRes.body?.company?.tenantDbName}`);
    const badAccessType = await post("/api/platform/companies", { companyName: "Bad Access", companySlug: "badaccesstype", accessType: "unlimited" }, ownerToken);
    check("2. rejected invalid accessType", badAccessType.status === 400, `got ${badAccessType.status}`);

    // ---------- Real creation, with forged fields included ----------
    console.log("\nSTEP 3 -- Real company creation (with forged fields present in body)");
    const createRes = await post("/api/platform/companies", {
        companyName: TEST_COMPANY_NAME,
        companySlug: TEST_COMPANY_SLUG,
        accessType: "trial",
        // Forged / out-of-scope fields -- must be silently ignored:
        status: "active",
        tenant_db_name: "reinsteins_workhub",
        id: 99999,
    }, ownerToken);

    check("3. creation succeeded (201)", createRes.status === 201, `got ${createRes.status} ${JSON.stringify(createRes.body)}`);
    const created = createRes.body?.company;
    check("3. tenantDbName generated server-side (not the forged value)", created?.tenantDbName === EXPECTED_TENANT_DB,
        `got ${created?.tenantDbName}`);
    check("3. status is active", created?.status === "active", `got ${created?.status}`);
    check("3. companySlug matches", created?.companySlug === TEST_COMPANY_SLUG);

    console.log("\nSTEP 4 -- Duplicate slug blocked");
    const dupRes = await post("/api/platform/companies", { companyName: "Dup", companySlug: TEST_COMPANY_SLUG, accessType: "trial" }, ownerToken);
    check("4. duplicate slug -> 409", dupRes.status === 409, `got ${dupRes.status}`);

    // ---------- DB-level verification of the created tenant ----------
    console.log("\nSTEP 5 -- Platform + tenant DB verification");
    const companyRow = await platformCompanyService.getCompanyBySlug(TEST_COMPANY_SLUG);
    check("5. companies row exists with correct tenant_db_name", companyRow?.tenant_db_name === EXPECTED_TENANT_DB);

    const dbExists = await tenantProvisioningService.databaseExists(EXPECTED_TENANT_DB);
    check("5. tenant database exists", dbExists === true);

    const comparison = await tenantProvisioningService.compareTenantSchema(process.env.DB_NAME, EXPECTED_TENANT_DB);
    check("5. table count = 37", comparison.targetTableCount === 37, `got ${comparison.targetTableCount}`);
    check("5. table names match source exactly", comparison.tableNamesMatch);
    check("5. foreign keys match (86)", comparison.foreignKeysMatch && comparison.targetForeignKeyCount === 86,
        `got ${comparison.targetForeignKeyCount}`);
    check("5. indexes match", comparison.indexesMatch);

    const rowCounts = await tenantProvisioningService.getRowCounts(EXPECTED_TENANT_DB);
    const nonEmpty = Object.entries(rowCounts).filter(([, c]) => c > 0);
    check("5. all tenant tables empty", nonEmpty.length === 0, JSON.stringify(nonEmpty));

    // ---------- Rollback / compensation test (service-level) ----------
    console.log("\nSTEP 6 -- Rollback/compensation path (direct service-level test)");
    const rollbackTenantDb = buildTenantDbName(ROLLBACK_TEST_SLUG);
    check("6. rollback tenant db name is valid", isValidTenantDbName(rollbackTenantDb));

    const pendingRow = await platformCompanyService.createPendingCompany({
        companyName: "Phase 2D Rollback Test",
        companySlug: ROLLBACK_TEST_SLUG,
        accessType: "trial",
    });
    check("6. pending row created", pendingRow?.status === "pending" && pendingRow?.tenant_db_name === null);

    const brokenStatements = [
        "CREATE TABLE `tenant_test_ok` (`id` int unsigned NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`)) ENGINE=InnoDB",
        "CREATE TABLE this is not valid sql at all",
    ];
    const failedProvision = await tenantProvisioningService.provisionTenantDatabase({
        databaseName: rollbackTenantDb,
        _schemaStatementsForTesting: brokenStatements,
    });
    check("6. provisioning failed as expected", failedProvision.success === false && failedProvision.rolledBack === true);

    const dbGoneAfterFailure = await tenantProvisioningService.databaseExists(rollbackTenantDb);
    check("6. tenant DB not left behind after failure", dbGoneAfterFailure === false);

    const compDeleted = await platformCompanyService.deletePendingCompany(pendingRow.id);
    check("6. compensating delete of pending row succeeded", compDeleted === true);

    const slugFreedAgain = await platformCompanyService.getCompanyBySlug(ROLLBACK_TEST_SLUG);
    check("6. slug is free again after compensation", slugFreedAgain === null);

    // ---------- Reinsteins metadata untouched ----------
    console.log("\nSTEP 7 -- Reinsteins platform metadata unchanged");
    const reinsteinsRow = await platformCompanyService.getCompanyBySlug("reinsteins");
    check("7. Reinsteins row still active/complimentary/tenant_db_name=NULL",
        reinsteinsRow?.status === "active" &&
        reinsteinsRow?.access_type === "complimentary" &&
        reinsteinsRow?.tenant_db_name === null,
        JSON.stringify(reinsteinsRow));

    // ---------- Cleanup ----------
    console.log("\nCLEANUP");
    await tenantProvisioningService.dropProvisionedDatabase(EXPECTED_TENANT_DB);
    console.log(`  Dropped tenant database "${EXPECTED_TENANT_DB}"`);

    await platformPool.query(`DELETE FROM companies WHERE company_slug = ?`, [TEST_COMPANY_SLUG]);
    console.log(`  Deleted company row (slug=${TEST_COMPANY_SLUG})`);

    const normTenantDb = buildTenantDbName(normSlug);
    await tenantProvisioningService.dropProvisionedDatabase(normTenantDb);
    console.log(`  Dropped tenant database "${normTenantDb}"`);

    await platformPool.query(`DELETE FROM companies WHERE company_slug = ?`, [normSlug]);
    console.log(`  Deleted company row (slug=${normSlug})`);

    await platformPool.query(`DELETE FROM platform_users WHERE email IN (?, ?)`, [TEST_OWNER_EMAIL, TEST_INACTIVE_EMAIL]);
    console.log(`  Deleted temp platform owner accounts`);

    const dbStillExists = await tenantProvisioningService.databaseExists(EXPECTED_TENANT_DB);
    const companyStillExists = await platformCompanyService.getCompanyBySlug(TEST_COMPANY_SLUG);
    check("CLEANUP: tenant DB confirmed gone", dbStillExists === false);
    check("CLEANUP: company row confirmed gone", companyStillExists === null);

    const normDbStillExists = await tenantProvisioningService.databaseExists(normTenantDb);
    const normCompanyStillExists = await platformCompanyService.getCompanyBySlug(normSlug);
    check("CLEANUP: norm-test tenant DB confirmed gone", normDbStillExists === false);
    check("CLEANUP: norm-test company row confirmed gone", normCompanyStillExists === null);

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
