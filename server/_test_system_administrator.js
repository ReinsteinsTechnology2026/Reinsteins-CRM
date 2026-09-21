require("dotenv").config();
const bcrypt = require("bcrypt");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { buildTenantDbName } = require("./utils/tenantDbName");
const { PERMISSION_KEYS } = require("./services/projectPermissionService");
const { backfillTenant, columnExists, indexExists } = require("./_migrate_backfill_system_administrator");

// ==========================================
// TRUE TENANT-LEVEL SYSTEM ADMINISTRATOR -- SELF-TEST
//
// Real HTTP against the live backend on http://localhost:5000, using
// two throwaway tenants provisioned through the real platform APIs
// (same convention as _test_admin_group_permission_backfill.js).
// Never touches reinsteins_workhub or any real tenant. Drops
// everything it creates at the end.
//
// getEffectivePermissions()/hasProjectPermission()/canUserAccessProject()
// are deliberately NEVER called directly from this script -- they read
// through config/db.js's AsyncLocalStorage-resolved tenant pool, which
// only resolves correctly inside a real Express request handled by
// tenantAuthMiddleware. Every behavioral assertion here goes through
// real HTTP instead; only fixture setup/verification uses
// getTenantPool(dbName) directly (safe -- explicit pool, no ambient
// context needed), same as the existing _test_*.js convention.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "sysadmintest_owner@groworgs.internal";
const OWNER_PASSWORD = "SysAdminTestOwner!2026Pwd";

const A_SLUG = "sysadmintest_a";
const B_SLUG = "sysadmintest_b";
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
    const res = await fetch(`${BASE_URL}${pathname}`, {
        method: "GET",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

async function insertTestUser(pool, { employeeId, fullName, email, password, role, systemAccess }) {
    const passwordHash = await bcrypt.hash(password, 12);
    const [result] = await pool.query(
        `
        INSERT INTO users (employee_id, full_name, email, password, role, system_access, employment_status, status)
        VALUES (?, ?, ?, ?, ?, ?, 'active', 'active')
        RETURNING id
        `,
        [employeeId, fullName, email, passwordHash, role, systemAccess]
    );
    return result[0].id;
}

(async () => {

    // ---------- Setup ----------
    console.log("SETUP -- platform owner + tenant A (with its provisioned System Administrator)");

    const ownerPasswordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "SysAdmin Test Owner", email: OWNER_EMAIL, passwordHash: ownerPasswordHash, role: "platform_owner" });

    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: platform owner login succeeded", loginRes.status === 200 && !!ownerToken);

    const createA = await apiPost("/api/platform/companies", { companyName: "SysAdmin Test A", companySlug: A_SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: tenant A company created", createA.status === 201);
    const companyAId = createA.body?.company?.id;

    const adminACreate = await apiPost(`/api/platform/companies/${companyAId}/admin`, { name: "Flagged Admin A", email: "admin@sysadmintest-a.test", password: "AdminPass123!SAa" }, ownerToken);
    const adminAEmployeeId = adminACreate.body?.admin?.employeeId;
    const loginAdminA = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: adminAEmployeeId, password: "AdminPass123!SAa" });
    const tokenAdminA = loginAdminA.body?.token;
    check("SETUP: tenant A's first admin login succeeded", loginAdminA.status === 200 && !!tokenAdminA);

    const poolA = getTenantPool(A_DB);
    const [[flaggedAdminRow]] = await poolA.query(`SELECT id FROM users WHERE employee_id = ?`, [adminAEmployeeId]);
    const flaggedAdminId = flaggedAdminRow.id;

    // ==========================================
    // CASE 3 -- provisioning's first admin is marked System Administrator
    // ==========================================
    console.log("\n3. CASE 3 -- createFirstAdmin() marks the new admin as System Administrator");

    const [[flaggedRow]] = await poolA.query(`SELECT is_system_administrator FROM users WHERE id = ?`, [flaggedAdminId]);
    check("CASE 3: is_system_administrator = TRUE on the tenant's first admin", flaggedRow.is_system_administrator === true);

    // ==========================================
    // CASE 1 & 2 -- exactly one System Administrator per tenant, DB-enforced
    // ==========================================
    console.log("\n1&2. CASE 1&2 -- unique partial index rejects a second System Administrator");

    const secondAdminId = await insertTestUser(poolA, {
        employeeId: "SAT-ADM2", fullName: "Second Admin Fixture", email: "second-admin@sysadmintest-a.test",
        password: "FixtureOnly!2026Pwd", role: "admin", systemAccess: "admin",
    });

    let secondFlagRejected = false;
    try {
        await poolA.query(`UPDATE users SET is_system_administrator = TRUE WHERE id = ?`, [secondAdminId]);
    } catch (error) {
        secondFlagRejected = error.code === "23505";
    }
    check("CASE 1&2: setting a second is_system_administrator=TRUE row was rejected by the DB", secondFlagRejected);

    const [flaggedCountRows] = await poolA.query(`SELECT id FROM users WHERE is_system_administrator = TRUE`);
    check("CASE 1&2: exactly one flagged row remains, still the original admin", flaggedCountRows.length === 1 && Number(flaggedCountRows[0].id) === Number(flaggedAdminId));

    // ==========================================
    // CASE 4 -- schema provisioning for an already-existing tenant,
    // THEN Reinsteins-style backfill identifies by full_name, never
    // created_at
    // ==========================================
    console.log("\n4. CASE 4 -- migration adds the missing column/index to an already-existing tenant, then correctly backfills by name");

    const createB = await apiPost("/api/platform/companies", { companyName: "SysAdmin Test B", companySlug: B_SLUG, accessType: "trial" }, ownerToken);
    check("CASE 4 setup: tenant B company created", createB.status === 201);
    const companyBId = createB.body?.company?.id;

    const adminBCreate = await apiPost(`/api/platform/companies/${companyBId}/admin`, { name: "Earliest Admin (wrong name)", email: "admin@sysadmintest-b.test", password: "AdminPass123!SAb" }, ownerToken);
    const adminBEmployeeId = adminBCreate.body?.admin?.employeeId;
    check("CASE 4 setup: tenant B's first admin created", adminBCreate.status === 201);

    const poolB = getTenantPool(B_DB);

    // Simulate "a tenant that predates this feature entirely" -- newly
    // provisioned tenants get is_system_administrator from
    // tenantSchema.postgresql.sql already, so drop it (and its
    // dependent partial index, which Postgres removes automatically
    // along with the column) to reproduce the real-world starting
    // state for every already-provisioned tenant, including the real
    // Reinsteins database.
    await poolB.query(`ALTER TABLE users DROP COLUMN is_system_administrator`);

    check("CASE 4 setup: column genuinely does not exist yet", !(await columnExists(poolB, "users", "is_system_administrator")));
    check("CASE 4 setup: index genuinely does not exist yet", !(await indexExists(poolB, "uq_users_one_system_administrator")));

    // A SECOND admin, correctly named -- this is the one that must
    // win, proving identification is by full_name, not created_at
    // (the first admin above is both earlier AND still role='admin',
    // and would be the wrong pick under a naive "earliest admin" rule).
    // Insertable even without the column existing yet -- insertTestUser
    // never references is_system_administrator, and the column (once
    // added) defaults every row, including this one, to FALSE.
    const correctlyNamedAdminId = await insertTestUser(poolB, {
        employeeId: "SBT-ADM2", fullName: "System Administrator", email: "real-sysadmin@sysadmintest-b.test",
        password: "FixtureOnly!2026Pwd", role: "admin", systemAccess: "super_admin",
    });

    await backfillTenant("reinsteins", B_DB);

    check("CASE 4: migration added the missing column", await columnExists(poolB, "users", "is_system_administrator"));
    check("CASE 4: migration added the missing partial unique index", await indexExists(poolB, "uq_users_one_system_administrator"));

    const [[backfilledCorrect]] = await poolB.query(`SELECT is_system_administrator FROM users WHERE id = ?`, [correctlyNamedAdminId]);
    const [[backfilledWrong]] = await poolB.query(`SELECT is_system_administrator FROM users WHERE employee_id = ?`, [adminBEmployeeId]);
    check("CASE 4: the account named exactly 'System Administrator' was flagged", backfilledCorrect.is_system_administrator === true);
    check("CASE 4: the earlier-created, wrongly-named admin was NOT flagged", backfilledWrong.is_system_administrator === false);

    // Running it again must be a safe no-op: schema steps skip (already
    // present), and the data step skips because exactly one flagged
    // row already exists -- no error, no change, no duplicate.
    let secondRunThrew = false;
    try {
        await backfillTenant("reinsteins", B_DB);
    } catch (_error) {
        secondRunThrew = true;
    }
    check("CASE 4: running the migration a second time does not throw", !secondRunThrew);

    const [[backfilledCorrectAfterRerun]] = await poolB.query(`SELECT is_system_administrator FROM users WHERE id = ?`, [correctlyNamedAdminId]);
    const [stillOnlyOneFlagged] = await poolB.query(`SELECT id FROM users WHERE is_system_administrator = TRUE`);
    check("CASE 4: the correct account is still flagged after a second run", backfilledCorrectAfterRerun.is_system_administrator === true);
    check("CASE 4: still exactly one flagged account after a second run (idempotent)", stillOnlyOneFlagged.length === 1 && Number(stillOnlyOneFlagged[0].id) === Number(correctlyNamedAdminId));

    // ==========================================
    // CASE 5-8 -- System Administrator bypass: no membership required,
    // full permissions, ACCESS_LEVEL_CEILINGS bypassed, TechOps reachable
    // ==========================================
    console.log("\n5-8. CASES 5-8 -- System Administrator bypasses membership, ceilings, and reaches TechOps");

    const createProject = await apiPost("/api/projects", { name: "SysAdmin Bypass Fixture Project" }, tokenAdminA);
    check("CASE 5-8 setup: project created", createProject.status === 201);
    const otherProjectId = createProject.body?.id || createProject.body?.project?.id;

    // Remove the flagged admin's own membership row (createProject
    // auto-added it as creator) -- simulating a project they were
    // NEVER added to, the exact scenario this whole feature exists for.
    await poolA.query(`DELETE FROM project_members WHERE project_id = ? AND user_id = ?`, [otherProjectId, flaggedAdminId]);
    const [membershipAfterDelete] = await poolA.query(`SELECT id FROM project_members WHERE project_id = ? AND user_id = ?`, [otherProjectId, flaggedAdminId]);
    check("CASE 5-8 setup: flagged admin genuinely has no project_members row", membershipAfterDelete.length === 0);

    const myPermsRes = await apiGet(`/api/projects/${otherProjectId}/my-permissions`, tokenAdminA);
    check("CASE 5: GET my-permissions succeeds without membership", myPermsRes.status === 200, JSON.stringify(myPermsRes.body));
    check("CASE 5: isMember reported true", myPermsRes.body?.isMember === true);
    check(
        "CASE 6: every PERMISSION_KEYS entry is true",
        PERMISSION_KEYS.every((key) => myPermsRes.body?.permissions?.[key] === true),
        JSON.stringify(myPermsRes.body?.permissions)
    );

    const createEpicRes = await apiPost(`/api/epics/project/${otherProjectId}`, { title: "SysAdmin bypass epic" }, tokenAdminA);
    check("CASE 8: TechOps (Epic creation) reachable without membership", createEpicRes.status === 201, JSON.stringify(createEpicRes.body));

    // ACCESS_LEVEL_CEILINGS bypass -- cap the flagged admin's own
    // project_access_level to 'stakeholder' (which would normally deny
    // EPIC_CREATE/FEATURE_CREATE/PROJECT_EDIT) and confirm it's still
    // fully granted.
    await poolA.query(`UPDATE users SET project_access_level = 'stakeholder' WHERE id = ?`, [flaggedAdminId]);
    const myPermsCeilingRes = await apiGet(`/api/projects/${otherProjectId}/my-permissions`, tokenAdminA);
    check(
        "CASE 7: EPIC_CREATE/FEATURE_CREATE/PROJECT_EDIT still true even with project_access_level='stakeholder'",
        myPermsCeilingRes.body?.permissions?.EPIC_CREATE === true &&
        myPermsCeilingRes.body?.permissions?.FEATURE_CREATE === true &&
        myPermsCeilingRes.body?.permissions?.PROJECT_EDIT === true,
        JSON.stringify(myPermsCeilingRes.body?.permissions)
    );
    await poolA.query(`UPDATE users SET project_access_level = 'basic' WHERE id = ?`, [flaggedAdminId]);

    // ==========================================
    // CASE 9-11 -- a non-flagged Super Admin/Admin/Employee is still
    // denied without membership (the critical negative test)
    // ==========================================
    console.log("\n9-11. CASES 9-11 -- non-System-Administrators remain denied without membership");

    const superAdminId = await insertTestUser(poolA, {
        employeeId: "SAT-SUP1", fullName: "Non-Flagged Super Admin", email: "nonflagged-superadmin@sysadmintest-a.test",
        password: "FixtureOnly!2026Pwd", role: "admin", systemAccess: "super_admin",
    });
    const loginSuperAdmin = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: "SAT-SUP1", password: "FixtureOnly!2026Pwd" });
    const tokenSuperAdmin = loginSuperAdmin.body?.token;
    check("CASE 9 setup: non-flagged Super Admin login succeeded", loginSuperAdmin.status === 200 && !!tokenSuperAdmin);

    const employeeId2 = await insertTestUser(poolA, {
        employeeId: "SAT-EMP1", fullName: "Plain Employee Fixture", email: "plain-employee@sysadmintest-a.test",
        password: "FixtureOnly!2026Pwd", role: "employee", systemAccess: "employee",
    });
    const loginEmployee = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: "SAT-EMP1", password: "FixtureOnly!2026Pwd" });
    const tokenEmployee = loginEmployee.body?.token;
    check("CASE 11 setup: plain employee login succeeded", loginEmployee.status === 200 && !!tokenEmployee);

    const loginSecondAdmin = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: "SAT-ADM2", password: "FixtureOnly!2026Pwd" });
    const tokenSecondAdmin = loginSecondAdmin.body?.token;
    check("CASE 10 setup: non-flagged Admin login succeeded", loginSecondAdmin.status === 200 && !!tokenSecondAdmin);

    const superAdminPerms = await apiGet(`/api/projects/${otherProjectId}/my-permissions`, tokenSuperAdmin);
    check("CASE 9: non-flagged Super Admin without membership is denied (isMember false)", superAdminPerms.body?.isMember === false, JSON.stringify(superAdminPerms.body));
    check(
        "CASE 9: every permission false for the non-flagged Super Admin",
        PERMISSION_KEYS.every((key) => superAdminPerms.body?.permissions?.[key] === false)
    );

    const adminPerms = await apiGet(`/api/projects/${otherProjectId}/my-permissions`, tokenSecondAdmin);
    check("CASE 10: plain Admin without membership is denied (isMember false)", adminPerms.body?.isMember === false, JSON.stringify(adminPerms.body));

    const employeePerms = await apiGet(`/api/projects/${otherProjectId}/my-permissions`, tokenEmployee);
    check("CASE 11: Employee without membership is denied (isMember false)", employeePerms.body?.isMember === false, JSON.stringify(employeePerms.body));

    const employeeEpicAttempt = await apiPost(`/api/epics/project/${otherProjectId}`, { title: "Should be denied" }, tokenEmployee);
    check("CASE 11: Employee's own TechOps write attempt is denied (403)", employeeEpicAttempt.status === 403, JSON.stringify(employeeEpicAttempt.body));

    // ==========================================
    // CASE 12 -- existing membership-based behavior is unchanged for a
    // real, properly-added member
    // ==========================================
    console.log("\n12. CASE 12 -- ordinary project membership still resolves exactly as before");

    const [[defaultGroup]] = await poolA.query(
        `SELECT id FROM project_security_groups WHERE project_id IS NULL AND name = 'Project Administrators' AND is_default = TRUE LIMIT 1`
    );
    const addMemberRes = await apiPost(`/api/projects/${otherProjectId}/members`, { userIds: [employeeId2], securityGroupId: defaultGroup.id }, tokenAdminA);
    check("CASE 12 setup: employee added as a real project member", addMemberRes.status === 200 || addMemberRes.status === 201, JSON.stringify(addMemberRes.body));

    const memberPerms = await apiGet(`/api/projects/${otherProjectId}/my-permissions`, tokenEmployee);
    check("CASE 12: a properly-added member resolves isMember true", memberPerms.body?.isMember === true);
    check(
        "CASE 12: a properly-added member of the full-access default group gets every permission",
        PERMISSION_KEYS.every((key) => memberPerms.body?.permissions?.[key] === true),
        JSON.stringify(memberPerms.body?.permissions)
    );

    // ==========================================
    // CASE 13 -- default Project Administrators backfill unaffected
    // ==========================================
    console.log("\n13. CASE 13 -- default group's own permission backfill is unaffected");

    const [permRows] = await poolA.query(
        `SELECT permission_key, value FROM project_permissions WHERE security_group_id = ? AND project_id IS NULL`,
        [defaultGroup.id]
    );
    const permMap = {};
    for (const row of permRows) permMap[row.permission_key] = row.value;
    check(
        "CASE 13: default group still has every PERMISSION_KEYS entry set to 'allow'",
        PERMISSION_KEYS.every((key) => permMap[key] === "allow"),
        JSON.stringify(permMap)
    );

    // ---------- Report ----------
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);

    // ---------- Cleanup ----------
    console.log("\nCLEANUP -- dropping test tenants and platform fixtures");

    try {
        await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?)`, [A_SLUG, B_SLUG]);
    } catch (error) {
        console.error("Cleanup (companies) error:", error.message);
    }

    try {
        await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    } catch (error) {
        console.error("Cleanup (platform user) error:", error.message);
    }

    try {
        await platformPool.query(`DROP DATABASE IF EXISTS "${A_DB}" WITH (FORCE)`);
        await platformPool.query(`DROP DATABASE IF EXISTS "${B_DB}" WITH (FORCE)`);
    } catch (error) {
        console.error("Cleanup (tenant databases) error:", error.message);
    }

    await closeAllTenantPools();
    await platformPool.end();

    process.exit(failures === 0 ? 0 : 1);

})().catch(async (error) => {
    console.error("TEST SCRIPT ERROR:", error);
    process.exit(1);
});
