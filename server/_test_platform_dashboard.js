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
// PLATFORM OWNER DASHBOARD / COMPANY MANAGEMENT SELF-TEST (Phase 4)
//
// Exercises every new/extended platform API over real HTTP against
// the live backend. Creates exactly one temporary company + tenant
// database + admin, all deleted at the end. Never touches
// reinsteins_workhub.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "dashtest_owner@groworgs.internal";
const OWNER_PASSWORD = "DashTestOwner!2026Pwd";

const SLUG = "dashtest_a";
const DB = buildTenantDbName(SLUG);
const ADMIN_PASSWORD = "DashTestAdmin!2026";

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

    // ---------- Setup ----------
    console.log("SETUP -- platform owner");
    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "Dash Test Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });

    // ---------- A: Platform Owner login works ----------
    console.log("\nTEST A -- Platform Owner login");
    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("A. Platform Owner login works", loginRes.status === 200 && !!ownerToken, JSON.stringify(loginRes.body));

    // ---------- B/C: cross-boundary JWT checks ----------
    console.log("\nTEST B/C -- Cross-boundary JWT checks");
    const legacyTenantToken = jwt.sign({ id: 999999, employeeId: "BOUNDARY-TEST", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const bRes = await apiGet("/api/platform/companies", legacyTenantToken);
    check("B. Tenant user cannot access platform APIs -> 401", bRes.status === 401, `got ${bRes.status}`);

    const cRes = await apiGet("/api/employees/profile/me", ownerToken);
    check("C. Platform JWT cannot access tenant APIs -> 401", cRes.status === 401, `got ${cRes.status}`);

    // ---------- D/E: company list + Reinsteins appears correctly ----------
    console.log("\nTEST D/E -- Company list returns only platform metadata; Reinsteins correct");
    const listRes = await apiGet("/api/platform/companies", ownerToken);
    check("D. Company list succeeds", listRes.status === 200 && Array.isArray(listRes.body?.companies));
    const listBodyStr = JSON.stringify(listRes.body);
    check("D. Company list contains no employee/chat/file/tenant-credential fields",
        !/password|db_password|dbPassword|employee_id|chat_attachments|file_path/i.test(listBodyStr), listBodyStr.slice(0, 300));

    const reinsteins = listRes.body?.companies?.find((c) => c.companySlug === "reinsteins");
    check("E. Reinsteins appears with correct name/status/accessType",
        reinsteins?.companyName === "Reinsteins Technology" &&
        reinsteins?.status === "active" &&
        reinsteins?.accessType === "complimentary",
        JSON.stringify(reinsteins));

    // Dashboard stats sanity
    const statsRes = await apiGet("/api/platform/companies/stats", ownerToken);
    check("D2. Dashboard stats endpoint works", statsRes.status === 200 && typeof statsRes.body?.stats?.total === "number", JSON.stringify(statsRes.body));

    // ---------- F/G: create temporary company + tenant DB provisions ----------
    console.log("\nTEST F/G -- Create temporary company + tenant DB provisioning");
    const createRes = await apiPost("/api/platform/companies", { companyName: "DASH TEST A", companySlug: SLUG, accessType: "trial" }, ownerToken);
    check("F. Temporary company created successfully", createRes.status === 201, JSON.stringify(createRes.body));
    const companyId = createRes.body?.company?.id;
    check("G. Tenant database provisioned with correct name", createRes.body?.company?.tenantDbName === DB, createRes.body?.company?.tenantDbName);
    const dbExists = await tenantProvisioningService.databaseExists(DB);
    check("G2. Tenant database physically exists", dbExists === true);

    // Details endpoint
    const detailsRes = await apiGet(`/api/platform/companies/${companyId}`, ownerToken);
    check("D3. Company details endpoint works, no employee data", detailsRes.status === 200 && detailsRes.body?.company?.firstAdminCreated === false,
        JSON.stringify(detailsRes.body));

    // ---------- H: create the first admin ----------
    console.log("\nTEST H -- Create first admin");
    const adminRes = await apiPost(`/api/platform/companies/${companyId}/admin`, {
        name: "Dash Admin", email: "admin@dashtest-a.test", password: ADMIN_PASSWORD,
    }, ownerToken);
    check("H. First admin created", adminRes.status === 201, JSON.stringify(adminRes.body));
    const adminEmployeeId = adminRes.body?.admin?.employeeId;
    check("H2. Response never includes a password field", adminRes.body?.admin && !("password" in adminRes.body.admin) && !("passwordHash" in adminRes.body.admin));

    const detailsAfterAdmin = await apiGet(`/api/platform/companies/${companyId}`, ownerToken);
    check("H3. Details endpoint now reports firstAdminCreated=true", detailsAfterAdmin.body?.company?.firstAdminCreated === true);

    // Confirm the admin can actually log in via the real tenant-auth flow.
    const tenantLoginBefore = await apiPost(`/api/tenant-auth/${SLUG}/login`, { employeeId: adminEmployeeId, password: ADMIN_PASSWORD });
    check("H4. Newly created admin can log in via tenant-auth", tenantLoginBefore.status === 200, JSON.stringify(tenantLoginBefore.body));

    // ---------- I/J: suspend company ----------
    console.log("\nTEST I/J -- Suspend company; suspended company blocked");
    const suspendRes = await apiPatch(`/api/platform/companies/${companyId}/status`, { action: "suspend" }, ownerToken);
    check("I. Suspend succeeds", suspendRes.status === 200 && suspendRes.body?.company?.status === "suspended", JSON.stringify(suspendRes.body));

    const tenantLoginSuspended = await apiPost(`/api/tenant-auth/${SLUG}/login`, { employeeId: adminEmployeeId, password: ADMIN_PASSWORD });
    check("J. Suspended company cannot authenticate -> 403", tenantLoginSuspended.status === 403, `got ${tenantLoginSuspended.status}`);

    const tenantApiSuspended = await apiGet("/api/employees/profile/me", tenantLoginBefore.body?.token);
    check("J2. Existing tenant token from before suspension can no longer use protected APIs -> 401",
        tenantApiSuspended.status === 401, `got ${tenantApiSuspended.status}`);

    // Suspension must NOT touch the tenant database/employees.
    const dbStillExists = await tenantProvisioningService.databaseExists(DB);
    check("J3. Suspension did not delete the tenant database", dbStillExists === true);

    // ---------- K/L: reactivate company ----------
    console.log("\nTEST K/L -- Reactivate company; works again");
    const reactivateRes = await apiPatch(`/api/platform/companies/${companyId}/status`, { action: "reactivate" }, ownerToken);
    check("K. Reactivate succeeds", reactivateRes.status === 200 && reactivateRes.body?.company?.status === "active", JSON.stringify(reactivateRes.body));

    const tenantLoginAfterReactivate = await apiPost(`/api/tenant-auth/${SLUG}/login`, { employeeId: adminEmployeeId, password: ADMIN_PASSWORD });
    check("L. Company works again after reactivation (login succeeds)", tenantLoginAfterReactivate.status === 200, JSON.stringify(tenantLoginAfterReactivate.body));

    // ---------- M: update access type ----------
    console.log("\nTEST M -- Update access type");
    const accessTypeRes = await apiPatch(`/api/platform/companies/${companyId}/access-type`, { accessType: "paid" }, ownerToken);
    check("M. Access type updated to paid", accessTypeRes.status === 200 && accessTypeRes.body?.company?.accessType === "paid", JSON.stringify(accessTypeRes.body));

    // Invalid action / access type rejected
    const badAction = await apiPatch(`/api/platform/companies/${companyId}/status`, { action: "delete" }, ownerToken);
    check("M2. Invalid status action rejected (400)", badAction.status === 400, `got ${badAction.status}`);
    const badAccessType = await apiPatch(`/api/platform/companies/${companyId}/access-type`, { accessType: "unlimited" }, ownerToken);
    check("M3. Invalid access type rejected (400)", badAccessType.status === 400, `got ${badAccessType.status}`);

    // ---------- N: tenant data never returned from platform APIs ----------
    console.log("\nTEST N -- Tenant data never returned from platform APIs");
    const finalListRes = await apiGet("/api/platform/companies", ownerToken);
    const finalListStr = JSON.stringify(finalListRes.body);
    check("N. Full company list contains no tenant employee/business data",
        !/full_name|conversation|task_id|attendance/i.test(finalListStr));

    // ---------- Reinsteins DB unaffected throughout ----------
    console.log("\nEXTRA -- Reinsteins DB verification");
    const dbPool = require("./config/db");
    const [[{ tbl }]] = await dbPool.query(`SELECT COUNT(*) AS tbl FROM information_schema.tables WHERE table_schema = 'public'`);
    const [[{ users }]] = await dbPool.query(`SELECT COUNT(*) AS users FROM users`);
    check("EXTRA: reinsteins_workhub unchanged", Number(tbl) === 37 && Number(users) === 17, `tables=${tbl} users=${users}`);

    // ---------- O: cleanup ----------
    console.log("\nTEST O -- Cleanup");
    // Phase 13/14 -- see _test_payments.js's cleanup comment for why.
    await platformPool.query(`DELETE FROM email_delivery_logs WHERE company_id = ?`, [companyId]);
    const [[platdashOwnerRow]] = await platformPool.query(`SELECT id FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    if (platdashOwnerRow) await platformPool.query(`DELETE FROM platform_audit_logs WHERE platform_user_id = ?`, [platdashOwnerRow.id]);

    await closeAllTenantPools();
    await tenantProvisioningService.dropProvisionedDatabase(DB);
    await platformPool.query(`DELETE FROM companies WHERE company_slug = ?`, [SLUG]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);

    const dbGoneAfter = await tenantProvisioningService.databaseExists(DB);
    check("O. Temporary tenant database dropped", dbGoneAfter === false);
    const [remaining] = await platformPool.query(`SELECT company_slug FROM companies`);
    check("O2. Only Reinsteins remains in companies", remaining.length === 1 && remaining[0].company_slug === "reinsteins", JSON.stringify(remaining));
    const [remainingOwners] = await platformPool.query(`SELECT email FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    check("O3. Temporary platform owner no longer remains", remainingOwners.length === 0, JSON.stringify(remainingOwners));

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
