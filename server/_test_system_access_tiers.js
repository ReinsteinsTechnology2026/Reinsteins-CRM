require("dotenv").config();
const bcrypt = require("bcrypt");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { buildTenantDbName } = require("./utils/tenantDbName");

// ==========================================
// SYSTEM ACCESS TIERS SELF-TEST (Phase 17b, Part 3)
//
// "Admin" and "Super Admin" were already fully supported end-to-end
// on the backend before this phase -- the users.system_access CHECK
// constraint already allowed them, accessMiddleware.js's
// SYSTEM_ACCESS_LEVELS already listed them, and 7+ route files
// already gated write access with requireAccess("super_admin",
// "admin", ...). The only real gap was the Employees.jsx dropdown
// never offering "Admin" as an option (and "Super Admin" being
// silently unreachable for any tenant-login admin, since the login
// response never included systemAccess at all -- fixed alongside the
// designation fix in tenantAuthController.js). This test locks in
// that the already-correct backend behavior stays correct, and
// exercises the one specific protection PUT /api/organization/users/:id/system-access
// adds on top of the route-level requireAccess gate: only a Super
// Admin may grant/modify Super Admin access.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "satiertest_owner@groworgs.internal";
const OWNER_PASSWORD = "SATierTestOwner!2026Pwd";

const SLUG = "satiertest_co";
const DB_NAME = buildTenantDbName(SLUG);

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

async function apiGet(pathname, token) {
    const res = await fetch(`${BASE_URL}${pathname}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

(async () => {

    console.log("SETUP -- platform owner + one tenant + employee fixtures");

    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "SA Tier Test Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });

    const ownerLogin = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = ownerLogin.body?.token;
    check("SETUP: platform owner login succeeded", ownerLogin.status === 200 && !!ownerToken);

    const createCo = await apiPost("/api/platform/companies", { companyName: "SA Tier Test Co", companySlug: SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: company created", createCo.status === 201);
    const companyId = createCo.body?.company?.id;

    const adminCreate = await apiPost(`/api/platform/companies/${companyId}/admin`, { name: "Root Admin", email: "root@satiertest.test", password: "RootPass123!SA" }, ownerToken);
    check("SETUP: role=admin account created", adminCreate.status === 201);
    const rootAdminEmployeeId = adminCreate.body?.admin?.employeeId;

    const rootAdminLogin = await apiPost(`/api/tenant-auth/${SLUG}/login`, { employeeId: rootAdminEmployeeId, password: "RootPass123!SA" });
    const rootAdminToken = rootAdminLogin.body?.token;
    check("SETUP: role=admin login succeeded", rootAdminLogin.status === 200 && !!rootAdminToken);

    // Login response shape check (Part 2/3 combined fix).
    check(
        "SETUP: role=admin login response includes systemAccess",
        rootAdminLogin.body?.user?.systemAccess !== undefined,
        JSON.stringify(rootAdminLogin.body?.user)
    );

    const pool = getTenantPool(DB_NAME);
    const employeePasswordHash = await bcrypt.hash("Employee123!SA", 10);

    async function seedEmployee(employeeId, fullName, systemAccess) {
        const [result] = await pool.query(
            `INSERT INTO users (employee_id, full_name, email, password, role, system_access, employment_status, status)
             VALUES (?, ?, ?, ?, 'employee', ?, 'active', 'active') RETURNING id`,
            [employeeId, fullName, `${employeeId.toLowerCase()}@satiertest.test`, employeePasswordHash, systemAccess]
        );
        return result[0].id;
    }

    const plainEmployeeId = await seedEmployee("SA001", "Plain Employee", "employee");
    const sysAdminUserId = await seedEmployee("SA002", "System Admin", "admin");
    const superAdminUserId = await seedEmployee("SA003", "System Super Admin", "super_admin");
    const targetUserId = await seedEmployee("SA004", "Promotion Target", "employee");

    check("SETUP: employee fixtures created", !!(plainEmployeeId && sysAdminUserId && superAdminUserId && targetUserId));

    async function loginAs(employeeId) {
        const res = await apiPost(`/api/tenant-auth/${SLUG}/login`, { employeeId, password: "Employee123!SA" });
        return res.body?.token;
    }

    const tokenPlainEmployee = await loginAs("SA001");
    const tokenSysAdmin = await loginAs("SA002");
    const tokenSuperAdmin = await loginAs("SA003");
    check("SETUP: fixture logins succeeded", !!(tokenPlainEmployee && tokenSysAdmin && tokenSuperAdmin));

    // ---------- 1. Valid system_access values accepted end-to-end ----------
    console.log("\nTEST 1 -- Valid system_access values (including admin/super_admin) are accepted");
    const validValues = ["employee", "team_lead", "manager", "department_head", "hr", "executive", "admin"];
    for (const value of validValues) {
        const res = await apiPatch(`/api/organization/users/${targetUserId}/system-access`, { systemAccess: value }, rootAdminToken);
        check(`1. role=admin can set system_access='${value}' -> 200`, res.status === 200, JSON.stringify(res.body));
    }

    const invalidValue = await apiPatch(`/api/organization/users/${targetUserId}/system-access`, { systemAccess: "not_a_real_tier" }, rootAdminToken);
    check("1b. Invalid system_access value rejected -> 400", invalidValue.status === 400, JSON.stringify(invalidValue.body));

    // ---------- 2. Admin authorization ----------
    console.log("\nTEST 2 -- system_access='admin' (role still 'employee') can reach admin-gated org routes");
    const sysAdminManagesEmployee = await apiPatch(`/api/organization/users/${targetUserId}/system-access`, { systemAccess: "hr" }, tokenSysAdmin);
    check("2. system_access='admin' can change another user's system_access -> 200", sysAdminManagesEmployee.status === 200, JSON.stringify(sysAdminManagesEmployee.body));

    const plainEmployeeBlocked = await apiPatch(`/api/organization/users/${targetUserId}/system-access`, { systemAccess: "hr" }, tokenPlainEmployee);
    check("2b. Plain employee is rejected from the same route -> 403", plainEmployeeBlocked.status === 403, JSON.stringify(plainEmployeeBlocked.body));

    // ---------- 3. Super Admin authorization -- the one extra protection this endpoint adds ----------
    console.log("\nTEST 3 -- Only Super Admin may grant/modify Super Admin");
    const sysAdminTriesGrantSuperAdmin = await apiPatch(`/api/organization/users/${targetUserId}/system-access`, { systemAccess: "super_admin" }, tokenSysAdmin);
    check(
        "3a. An ordinary Admin (system_access='admin') CANNOT grant super_admin -> 403",
        sysAdminTriesGrantSuperAdmin.status === 403,
        JSON.stringify(sysAdminTriesGrantSuperAdmin.body)
    );

    const superAdminGrantsSuperAdmin = await apiPatch(`/api/organization/users/${targetUserId}/system-access`, { systemAccess: "super_admin" }, tokenSuperAdmin);
    check("3b. A Super Admin CAN grant super_admin -> 200", superAdminGrantsSuperAdmin.status === 200, JSON.stringify(superAdminGrantsSuperAdmin.body));

    const sysAdminTriesDemoteSuperAdmin = await apiPatch(`/api/organization/users/${targetUserId}/system-access`, { systemAccess: "employee" }, tokenSysAdmin);
    check(
        "3c. An ordinary Admin cannot even DEMOTE an existing super_admin -> 403",
        sysAdminTriesDemoteSuperAdmin.status === 403,
        JSON.stringify(sysAdminTriesDemoteSuperAdmin.body)
    );

    // Restore target back to plain employee via the super admin, for a
    // clean slate (not strictly required since the tenant DB is
    // dropped at the end, but keeps this test's intent obvious).
    await apiPatch(`/api/organization/users/${targetUserId}/system-access`, { systemAccess: "employee" }, tokenSuperAdmin);

    // ---------- 4. Tenant isolation ----------
    console.log("\nTEST 4 -- Tenant isolation: a system_access='admin' account never reaches another tenant's data");
    const crossTenantAttempt = await apiGet("/api/employees", tokenSysAdmin);
    check("4a. system_access='admin' can list ITS OWN tenant's employees -> 200", crossTenantAttempt.status === 200, JSON.stringify(crossTenantAttempt.body));
    const employeeIds = (crossTenantAttempt.body?.employees || []).map((e) => e.employee_id);
    check(
        "4b. Returned employees are exactly this tenant's own fixtures (no cross-tenant leakage)",
        employeeIds.includes("SA001") && employeeIds.includes("SA002") && employeeIds.includes("SA003") && employeeIds.includes("SA004"),
        JSON.stringify(employeeIds)
    );

    // ---------- 5. Existing Employee/Manager/HR/etc. behavior does not regress ----------
    console.log("\nTEST 5 -- Existing lower-tier system_access behavior unchanged");
    const employeeCannotSetAccess = await apiPatch(`/api/organization/users/${plainEmployeeId}/system-access`, { systemAccess: "manager" }, tokenPlainEmployee);
    check("5. Plain employee still cannot change ANY system_access (including their own) -> 403", employeeCannotSetAccess.status === 403, JSON.stringify(employeeCannotSetAccess.body));

    // ---------- 6. Platform Owner remains separate ----------
    console.log("\nTEST 6 -- Platform Owner token is rejected by tenant-scoped org routes, and vice versa");
    const ownerOnTenantRoute = await apiPatch(`/api/organization/users/${targetUserId}/system-access`, { systemAccess: "hr" }, ownerToken);
    check("6a. Platform Owner JWT rejected by tenant org route -> 401", ownerOnTenantRoute.status === 401, JSON.stringify(ownerOnTenantRoute.body));

    const superAdminOnPlatformRoute = await apiPost("/api/platform/companies", { companyName: "Should not create", companySlug: "shouldnotcreate_sa", accessType: "trial" }, tokenSuperAdmin);
    check("6b. Tenant Super Admin JWT rejected by Platform Owner route -> 401", superAdminOnPlatformRoute.status === 401, JSON.stringify(superAdminOnPlatformRoute.body));

    // ---------- Cleanup ----------
    console.log("\nCLEANUP");
    await closeAllTenantPools();
    await tenantProvisioningService.dropProvisionedDatabase(DB_NAME);
    console.log(`  Dropped "${DB_NAME}"`);

    await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?)`, [SLUG, "shouldnotcreate_sa"]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    console.log(`  Deleted company row(s) and temp platform owner`);

    const dbGone = await tenantProvisioningService.databaseExists(DB_NAME);
    check("CLEANUP: tenant DB gone", dbGone === false);

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
