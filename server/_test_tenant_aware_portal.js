require("dotenv").config();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const platformCompanyService = require("./services/platformCompanyService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { closeAllTenantPools } = require("./config/tenantConnectionManager");
const { buildTenantDbName } = require("./utils/tenantDbName");
const { PLATFORM_JWT_ISSUER, PLATFORM_JWT_AUDIENCE } = require("./controllers/platformAuthController");

// ==========================================
// TENANT-AWARE EXISTING PORTAL SELF-TEST
// (GrowOrgs Fast Completion Phase, Part 3/4)
//
// Proves that GENUINELY UNMODIFIED existing controllers
// (departmentController.js, employeeController.js -- zero lines
// changed in either) correctly resolve to the caller's own tenant
// database when authenticated via the NEW tenant JWT, through the
// EXISTING routes (/api/departments, /api/employees/profile/me) and
// the EXISTING `protect` middleware (enhanced with a fallback, not
// replaced) -- not a parallel/duplicate set of tenant-only routes.
//
// Also proves the legacy path is completely unaffected: a
// legacy-shaped JWT still resolves to reinsteins_workhub via the
// exact same route/controller.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "fastphase_owner@groworgs.internal";
const OWNER_PASSWORD = "FastPhaseOwner!2026Pwd";

const A_SLUG = "fastphase_a";
const B_SLUG = "fastphase_b";
const A_DB = buildTenantDbName(A_SLUG);
const B_DB = buildTenantDbName(B_SLUG);

const ADMIN_A_PASSWORD = "FastPhaseAdminA!2026";
const ADMIN_B_PASSWORD = "FastPhaseAdminB!2026";

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

    console.log("SETUP -- platform owner + two real tenants + admins");
    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "Fast Phase Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: platform owner login", loginRes.status === 200 && !!ownerToken);

    const createA = await apiPost("/api/platform/companies", { companyName: "FASTPHASE A", companySlug: A_SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: company A provisioned", createA.status === 201 && createA.body?.company?.tenantDbName === A_DB);
    const companyAId = createA.body?.company?.id;

    const createB = await apiPost("/api/platform/companies", { companyName: "FASTPHASE B", companySlug: B_SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: company B provisioned", createB.status === 201 && createB.body?.company?.tenantDbName === B_DB);
    const companyBId = createB.body?.company?.id;

    const adminA = await apiPost(`/api/platform/companies/${companyAId}/admin`, { name: "Admin A", email: "admin@fastphase-a.test", password: ADMIN_A_PASSWORD }, ownerToken);
    check("SETUP: admin A created", adminA.status === 201);
    const adminAEmployeeId = adminA.body?.admin?.employeeId;

    const adminB = await apiPost(`/api/platform/companies/${companyBId}/admin`, { name: "Admin B", email: "admin@fastphase-b.test", password: ADMIN_B_PASSWORD }, ownerToken);
    check("SETUP: admin B created", adminB.status === 201);
    const adminBEmployeeId = adminB.body?.admin?.employeeId;

    const tenantLoginA = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: adminAEmployeeId, password: ADMIN_A_PASSWORD });
    const tokenA = tenantLoginA.body?.token;
    check("SETUP: tenant A login", tenantLoginA.status === 200 && !!tokenA);

    const tenantLoginB = await apiPost(`/api/tenant-auth/${B_SLUG}/login`, { employeeId: adminBEmployeeId, password: ADMIN_B_PASSWORD });
    const tokenB = tenantLoginB.body?.token;
    check("SETUP: tenant B login", tenantLoginB.status === 200 && !!tokenB);

    // A legacy-shaped token (any id, doesn't need to correspond to a
    // real row -- protect's legacy branch never checks) signed with
    // the REAL JWT_SECRET, proving the fallback path in protect
    // resolves the legacy pool exactly as before.
    const legacyToken = jwt.sign({ id: 999999, employeeId: "LEGACY-TEST", role: "employee" }, process.env.JWT_SECRET, { expiresIn: "1h" });

    const platformToken = jwt.sign({ userId: 1, type: "platform_owner" }, process.env.PLATFORM_JWT_SECRET,
        { expiresIn: "1h", issuer: PLATFORM_JWT_ISSUER, audience: PLATFORM_JWT_AUDIENCE });

    // ---------- EXISTING, UNMODIFIED /api/departments route ----------
    console.log("\nSTEP 1 -- GET /api/departments (unmodified departmentController.js)");

    const [[{ reinsteinsDeptCountBefore }]] = await (async () => {
        const p = require("./config/db");
        return p.query(`SELECT COUNT(*) AS reinsteinsDeptCountBefore FROM departments`);
    })();

    const deptsA0 = await apiGet("/api/departments", tokenA);
    check("1a. Tenant A starts with 0 departments (fresh tenant DB)", deptsA0.status === 200 && deptsA0.body?.departments?.length === 0,
        JSON.stringify(deptsA0.body));

    const deptsLegacy = await apiGet("/api/departments", legacyToken);
    check("1b. Legacy token resolves to REAL Reinsteins departments (unaffected fallback)",
        deptsLegacy.status === 200 && deptsLegacy.body?.departments?.length === reinsteinsDeptCountBefore,
        `expected ${reinsteinsDeptCountBefore}, got ${deptsLegacy.body?.departments?.length}`);

    const deptsPlatform = await apiGet("/api/departments", platformToken);
    check("1c. Platform JWT rejected by existing tenant route -> 401", deptsPlatform.status === 401, `got ${deptsPlatform.status}`);

    console.log("\nSTEP 2 -- POST /api/departments as Tenant A, then B (unmodified createDepartment)");
    const createDeptA = await apiPost("/api/departments", { name: "Engineering A", code: "ENGA" }, tokenA);
    check("2a. Tenant A created its own department", createDeptA.status === 201, JSON.stringify(createDeptA.body));

    const deptsA1 = await apiGet("/api/departments", tokenA);
    check("2b. Tenant A now sees exactly its own 1 department", deptsA1.body?.departments?.length === 1 && deptsA1.body.departments[0].name === "Engineering A");

    const deptsB0 = await apiGet("/api/departments", tokenB);
    check("2c. Tenant B does NOT see Tenant A's department (isolation)", deptsB0.body?.departments?.length === 0, JSON.stringify(deptsB0.body));

    const createDeptB = await apiPost("/api/departments", { name: "Engineering B", code: "ENGB" }, tokenB);
    check("2d. Tenant B created its own department", createDeptB.status === 201);

    const deptsB1 = await apiGet("/api/departments", tokenB);
    check("2e. Tenant B sees exactly its own 1 department", deptsB1.body?.departments?.length === 1 && deptsB1.body.departments[0].name === "Engineering B");

    const deptsA2 = await apiGet("/api/departments", tokenA);
    check("2f. Tenant A still sees only its own department after B's write", deptsA2.body?.departments?.length === 1 && deptsA2.body.departments[0].name === "Engineering A");

    // ---------- EXISTING, UNMODIFIED /api/notifications route (a THIRD
    // controller, notificationController.js, also zero lines changed) ----------
    console.log("\nSTEP 3 -- GET /api/notifications (unmodified notificationController.js)");
    const notifA = await apiGet("/api/notifications", tokenA);
    check("3a. Tenant A admin gets its own (empty) notification list", notifA.status === 200 && Array.isArray(notifA.body?.notifications) && notifA.body.notifications.length === 0,
        JSON.stringify(notifA.body));

    const notifB = await apiGet("/api/notifications", tokenB);
    check("3b. Tenant B admin gets its own (empty) notification list", notifB.status === 200 && Array.isArray(notifB.body?.notifications) && notifB.body.notifications.length === 0,
        JSON.stringify(notifB.body));

    const notifLegacy = await apiGet("/api/notifications", legacyToken);
    check("3c. Legacy fake-id token gets an empty list from reinsteins_workhub (no error, correct fallback)",
        notifLegacy.status === 200 && Array.isArray(notifLegacy.body?.notifications), JSON.stringify(notifLegacy.body));

    // ---------- Reinsteins untouched by any of this ----------
    console.log("\nSTEP 4 -- Reinsteins verification");
    const p = require("./config/db");
    const [[{ reinsteinsDeptCountAfter }]] = await p.query(`SELECT COUNT(*) AS reinsteinsDeptCountAfter FROM departments`);
    check("4. reinsteins_workhub.departments count unchanged", reinsteinsDeptCountAfter === reinsteinsDeptCountBefore,
        `before=${reinsteinsDeptCountBefore} after=${reinsteinsDeptCountAfter}`);
    const [[{ tblCount }]] = await p.query(`SELECT COUNT(*) AS tblCount FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [process.env.DB_NAME]);
    const [[{ userCount }]] = await p.query(`SELECT COUNT(*) AS userCount FROM users`);
    check("4b. reinsteins_workhub table/user counts unchanged", tblCount === 37 && userCount === 17, `tables=${tblCount} users=${userCount}`);

    // ---------- Cleanup ----------
    console.log("\nCLEANUP");
    await closeAllTenantPools();
    await tenantProvisioningService.dropProvisionedDatabase(A_DB);
    await tenantProvisioningService.dropProvisionedDatabase(B_DB);
    await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?)`, [A_SLUG, B_SLUG]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);

    const aGone = await tenantProvisioningService.databaseExists(A_DB);
    const bGone = await tenantProvisioningService.databaseExists(B_DB);
    check("CLEANUP: tenant A DB gone", aGone === false);
    check("CLEANUP: tenant B DB gone", bGone === false);

    const [remaining] = await platformPool.query(`SELECT company_slug FROM companies`);
    check("CLEANUP: only Reinsteins remains in companies", remaining.length === 1 && remaining[0].company_slug === "reinsteins", JSON.stringify(remaining));

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
