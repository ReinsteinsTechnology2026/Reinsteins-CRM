require("dotenv").config();
const bcrypt = require("bcrypt");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { buildTenantDbName } = require("./utils/tenantDbName");

// ==========================================
// PROJECT "ADD MEMBER" ELIGIBLE-CANDIDATES SELF-TEST
//
// Real HTTP against the live backend on http://localhost:5000, using
// one throwaway tenant provisioned through the real platform APIs
// (same convention as _test_admin_group_permission_backfill.js /
// _test_techops_hierarchy.js). Never touches reinsteins_workhub or
// any real tenant. Drops everything it creates at the end.
//
// Covers the live bug: the "Add Member" modal used to reuse
// task-management's getTransferTargets() (WHERE role = 'employee'),
// which silently hid every admin-role account -- including a
// tenant's default System Administrator -- from the Add Member
// search. This proves the new GET /projects/:id/eligible-members
// endpoint fixes that while getTransferTargets() itself is untouched.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "eligiblememberstest_owner@groworgs.internal";
const OWNER_PASSWORD = "EligibleMembersOwner!2026Pwd";

const SLUG = "eligiblememberstest_a";
const DB = buildTenantDbName(SLUG);

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
    const res = await fetch(`${BASE_URL}${pathname}`, {
        method: "GET",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

async function insertTestUser(pool, { employeeId, fullName, email, role, systemAccess, employmentStatus, status }) {
    const passwordHash = await bcrypt.hash("FixtureOnly!2026Pwd", 12);
    const [result] = await pool.query(
        `
        INSERT INTO users (employee_id, full_name, email, password, role, system_access, employment_status, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
        `,
        [employeeId, fullName, email, passwordHash, role, systemAccess, employmentStatus, status]
    );
    return result[0].id;
}

(async () => {

    // ---------- Setup ----------
    console.log("SETUP -- platform owner + one tenant + fixture users");

    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "Eligible Members Test Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });

    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: platform owner login succeeded", loginRes.status === 200 && !!ownerToken);

    const createCompany = await apiPost("/api/platform/companies", { companyName: "Eligible Members Test", companySlug: SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: company created", createCompany.status === 201);
    const companyId = createCompany.body?.company?.id;

    // This IS the tenant's default/original provisioning admin --
    // role='admin', system_access='super_admin' -- the real-world
    // "System Administrator" account this whole investigation traced.
    const adminCreate = await apiPost(`/api/platform/companies/${companyId}/admin`, { name: "Default Super Admin", email: "admin@eligiblememberstest.test", password: "AdminPass123!EMa" }, ownerToken);
    const adminEmployeeId = adminCreate.body?.admin?.employeeId;
    const loginAdmin = await apiPost(`/api/tenant-auth/${SLUG}/login`, { employeeId: adminEmployeeId, password: "AdminPass123!EMa" });
    const tokenAdmin = loginAdmin.body?.token;
    check("SETUP: default admin (Super Admin) login succeeded", loginAdmin.status === 200 && !!tokenAdmin);

    const poolA = getTenantPool(DB);

    const regularAdminId = await insertTestUser(poolA, {
        employeeId: "EMT-ADM1", fullName: "Regular Admin Fixture", email: "regular-admin@eligiblememberstest.test",
        role: "admin", systemAccess: "admin", employmentStatus: "active", status: "active",
    });

    const superAdminExtraId = await insertTestUser(poolA, {
        employeeId: "EMT-SADM1", fullName: "Extra Super Admin Fixture", email: "extra-super-admin@eligiblememberstest.test",
        role: "admin", systemAccess: "super_admin", employmentStatus: "active", status: "active",
    });

    const activeEmployeeId = await insertTestUser(poolA, {
        employeeId: "EMT-EMP1", fullName: "Active Employee Fixture", email: "active-employee@eligiblememberstest.test",
        role: "employee", systemAccess: "employee", employmentStatus: "active", status: "active",
    });

    const inactiveEmployeeId = await insertTestUser(poolA, {
        employeeId: "EMT-EMP2", fullName: "Inactive Employee Fixture", email: "inactive-employee@eligiblememberstest.test",
        role: "employee", systemAccess: "employee", employmentStatus: "inactive", status: "inactive",
    });

    check("SETUP: 4 fixture users created", [regularAdminId, superAdminExtraId, activeEmployeeId, inactiveEmployeeId].every((id) => !!id));

    // A project creation makes the default admin a project member (via
    // createProject's creator/owner auto-add) and creates the default
    // "Project Administrators" group, matching real production use.
    const createProject = await apiPost("/api/projects", { name: "Eligible Members Fixture Project" }, tokenAdmin);
    check("SETUP: fixture project created", createProject.status === 201);
    const projectId = createProject.body?.id || createProject.body?.project?.id;
    check("SETUP: project id resolved", !!projectId, JSON.stringify(createProject.body));

    // ==========================================
    // CASE 1 -- the new eligible-members endpoint includes active
    // employee, active admin, and active super admin candidates
    // ==========================================
    console.log("\n1. CASE 1 -- GET /projects/:id/eligible-members");

    const eligibleRes = await apiGet(`/api/projects/${projectId}/eligible-members`, tokenAdmin);
    check("CASE 1: request succeeded", eligibleRes.status === 200, JSON.stringify(eligibleRes.body));

    const eligibleIds = (eligibleRes.body?.employees || []).map((u) => Number(u.id));

    check("CASE 1: active employee appears", eligibleIds.includes(activeEmployeeId));
    check("CASE 1: active (non-super) admin appears", eligibleIds.includes(regularAdminId));
    check("CASE 1: active super admin appears", eligibleIds.includes(superAdminExtraId));
    check("CASE 1: inactive employee does NOT appear", !eligibleIds.includes(inactiveEmployeeId));

    const regularAdminRow = (eligibleRes.body?.employees || []).find((u) => Number(u.id) === regularAdminId);
    check(
        "CASE 1: response includes role/employee_id/full_name fields the modal needs",
        !!regularAdminRow && regularAdminRow.role === "admin" && !!regularAdminRow.employee_id && !!regularAdminRow.full_name,
        JSON.stringify(regularAdminRow)
    );

    // ==========================================
    // CASE 2 -- an admin account that is already a project member is
    // still returned by the backend (exclusion of existing members is
    // deliberately a CLIENT-SIDE concern in AddMemberModal, unchanged
    // by this fix -- the backend endpoint's contract is "every active
    // tenant user", same shape as before for whichever project is
    // being managed).
    // ==========================================
    console.log("\n2. CASE 2 -- backend does not itself exclude existing project members");

    const [[defaultGroup]] = await poolA.query(
        `SELECT id FROM project_security_groups WHERE project_id IS NULL AND name = 'Project Administrators' AND is_default = TRUE LIMIT 1`
    );
    const addMemberRes = await apiPost(`/api/projects/${projectId}/members`, { userIds: [regularAdminId], securityGroupId: defaultGroup.id }, tokenAdmin);
    check("CASE 2 setup: regular admin added as a real project member", addMemberRes.status === 200 || addMemberRes.status === 201, JSON.stringify(addMemberRes.body));

    const eligibleAfterAdd = await apiGet(`/api/projects/${projectId}/eligible-members`, tokenAdmin);
    const eligibleIdsAfterAdd = (eligibleAfterAdd.body?.employees || []).map((u) => Number(u.id));
    check(
        "CASE 2: the now-member admin is still present in the backend candidate list (exclusion stays client-side)",
        eligibleIdsAfterAdd.includes(regularAdminId)
    );

    // ==========================================
    // CASE 3 -- getTransferTargets() / Task Transfer is completely
    // untouched: still employee-role + active only.
    // ==========================================
    console.log("\n3. CASE 3 -- GET /task-management/transfer-targets unchanged");

    const transferRes = await apiGet("/api/task-management/transfer-targets", tokenAdmin);
    check("CASE 3: request succeeded", transferRes.status === 200, JSON.stringify(transferRes.body));

    const transferIds = (transferRes.body?.employees || []).map((u) => Number(u.id));

    check("CASE 3: active employee still appears", transferIds.includes(activeEmployeeId));
    check("CASE 3: regular admin does NOT appear (role restriction preserved)", !transferIds.includes(regularAdminId));
    check("CASE 3: super admin does NOT appear (role restriction preserved)", !transferIds.includes(superAdminExtraId));
    check("CASE 3: inactive employee does NOT appear", !transferIds.includes(inactiveEmployeeId));

    // ---------- Report ----------
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);

    // ---------- Cleanup ----------
    console.log("\nCLEANUP -- dropping test tenant and platform fixtures");

    try {
        await platformPool.query(`DELETE FROM companies WHERE company_slug = ?`, [SLUG]);
    } catch (error) {
        console.error("Cleanup (company) error:", error.message);
    }

    try {
        await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    } catch (error) {
        console.error("Cleanup (platform user) error:", error.message);
    }

    try {
        await platformPool.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
    } catch (error) {
        console.error("Cleanup (tenant database) error:", error.message);
    }

    await closeAllTenantPools();
    await platformPool.end();

    process.exit(failures === 0 ? 0 : 1);

})().catch(async (error) => {
    console.error("TEST SCRIPT ERROR:", error);
    process.exit(1);
});
