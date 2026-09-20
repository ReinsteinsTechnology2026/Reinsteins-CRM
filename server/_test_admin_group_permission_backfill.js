require("dotenv").config();
const { execFileSync } = require("child_process");
const bcrypt = require("bcrypt");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { buildTenantDbName } = require("./utils/tenantDbName");
const { PERMISSION_KEYS } = require("./services/projectPermissionService");

// ==========================================
// DEFAULT "PROJECT ADMINISTRATORS" GROUP -- PERMISSION BACKFILL
// SELF-TEST
//
// Real HTTP against the live backend on http://localhost:5000, using
// two throwaway tenants provisioned through the real platform APIs
// (same convention as _test_techops_hierarchy.js). Never touches
// reinsteins_workhub or any real tenant. Drops everything it creates
// at the end.
//
// Covers the 5 cases from the Add New Work Item live-bug fix:
//   1. Self-healing backfills missing keys with 'allow'
//   2. Calling it again never duplicates or changes existing rows
//   3. The one-off migration script backfills only missing keys
//   4. A non-default security group is never touched
//   5. A different tenant's group is never touched
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "permbackfilltest_owner@groworgs.internal";
const OWNER_PASSWORD = "PermBackfillOwner!2026Pwd";

const A_SLUG = "permbackfilltest_a";
const B_SLUG = "permbackfilltest_b";
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

async function getDefaultGroupId(pool) {
    const [[group]] = await pool.query(
        `SELECT id FROM project_security_groups WHERE project_id IS NULL AND name = 'Project Administrators' AND is_default = TRUE LIMIT 1`
    );
    return group?.id || null;
}

async function getPermissionMap(pool, groupId) {
    const [rows] = await pool.query(
        `SELECT permission_key, value FROM project_permissions WHERE security_group_id = ? AND project_id IS NULL`,
        [groupId]
    );
    const map = {};
    for (const row of rows) map[row.permission_key] = row.value;
    return map;
}

async function deleteKeys(pool, groupId, keys) {
    // IN (?, ?) with individual placeholders -- matching the proven
    // pattern already used elsewhere in this codebase's _test_*.js
    // files (e.g. _test_techops_hierarchy.js's own cleanup), rather
    // than an untested array-bound ANY(?) form.
    const placeholders = keys.map(() => "?").join(", ");
    await pool.query(
        `DELETE FROM project_permissions WHERE security_group_id = ? AND project_id IS NULL AND permission_key IN (${placeholders})`,
        [groupId, ...keys]
    );
}

async function countRowsForKey(pool, groupId, key) {
    const [rows] = await pool.query(
        `SELECT id FROM project_permissions WHERE security_group_id = ? AND project_id IS NULL AND permission_key = ?`,
        [groupId, key]
    );
    return rows.length;
}

(async () => {

    // ---------- Setup ----------
    console.log("SETUP -- platform owner + two tenants");

    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "Perm Backfill Test Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });

    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: platform owner login succeeded", loginRes.status === 200 && !!ownerToken);

    const createA = await apiPost("/api/platform/companies", { companyName: "Perm Backfill Test A", companySlug: A_SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: company A created", createA.status === 201);
    const companyAId = createA.body?.company?.id;

    const createB = await apiPost("/api/platform/companies", { companyName: "Perm Backfill Test B", companySlug: B_SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: company B created", createB.status === 201);
    const companyBId = createB.body?.company?.id;

    const adminACreate = await apiPost(`/api/platform/companies/${companyAId}/admin`, { name: "Admin A", email: "admin@permbackfilltest-a.test", password: "AdminPass123!PBa" }, ownerToken);
    const adminAEmployeeId = adminACreate.body?.admin?.employeeId;
    const loginAdminA = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: adminAEmployeeId, password: "AdminPass123!PBa" });
    const tokenAdminA = loginAdminA.body?.token;
    check("SETUP: admin A login succeeded", loginAdminA.status === 200 && !!tokenAdminA);

    const adminBCreate = await apiPost(`/api/platform/companies/${companyBId}/admin`, { name: "Admin B", email: "admin@permbackfilltest-b.test", password: "AdminPass123!PBb" }, ownerToken);
    const adminBEmployeeId = adminBCreate.body?.admin?.employeeId;
    const loginAdminB = await apiPost(`/api/tenant-auth/${B_SLUG}/login`, { employeeId: adminBEmployeeId, password: "AdminPass123!PBb" });
    const tokenAdminB = loginAdminB.body?.token;
    check("SETUP: admin B login succeeded", loginAdminB.status === 200 && !!tokenAdminB);

    const poolA = getTenantPool(A_DB);
    const poolB = getTenantPool(B_DB);

    // A project creation for each tenant is what triggers
    // ensureDefaultProjectAdministratorsGroupId() for the FIRST time --
    // creating each tenant's default group fresh, with every current
    // PERMISSION_KEYS entry granted 'allow'. This matches exactly how
    // it works in real production use, and gives us a real,
    // fully-correct starting point to then deliberately break.
    const createProjectA0 = await apiPost("/api/projects", { name: "Perm Backfill Fixture Project A" }, tokenAdminA);
    check("SETUP: initial Project created for tenant A (creates the default group)", createProjectA0.status === 201);

    const createProjectB0 = await apiPost("/api/projects", { name: "Perm Backfill Fixture Project B" }, tokenAdminB);
    check("SETUP: initial Project created for tenant B (creates its own default group)", createProjectB0.status === 201);

    const groupIdA = await getDefaultGroupId(poolA);
    const groupIdB = await getDefaultGroupId(poolB);
    check("SETUP: tenant A has a default Project Administrators group", !!groupIdA);
    check("SETUP: tenant B has a default Project Administrators group", !!groupIdB);

    const fullMapA0 = await getPermissionMap(poolA, groupIdA);
    check(
        "SETUP: tenant A's fresh group already has every current PERMISSION_KEY",
        PERMISSION_KEYS.every((key) => fullMapA0[key] === "allow"),
        JSON.stringify(fullMapA0)
    );

    // ==========================================
    // CASE 1 -- self-healing backfills missing keys with 'allow'
    // ==========================================
    console.log("\n1. CASE 1 -- self-healing backfills EPIC_CREATE/FEATURE_CREATE");

    await deleteKeys(poolA, groupIdA, ["EPIC_CREATE", "FEATURE_CREATE"]);
    const afterDelete = await getPermissionMap(poolA, groupIdA);
    check("CASE 1 setup: EPIC_CREATE/FEATURE_CREATE genuinely removed", !("EPIC_CREATE" in afterDelete) && !("FEATURE_CREATE" in afterDelete));

    // Creating another project re-invokes ensureDefaultProjectAdministratorsGroupId()
    // against the ALREADY-EXISTING group -- the exact code path being tested.
    const createProjectA1 = await apiPost("/api/projects", { name: "Perm Backfill Case1 Project" }, tokenAdminA);
    check("CASE 1: Project creation succeeded (triggers the self-heal)", createProjectA1.status === 201);

    const afterHeal = await getPermissionMap(poolA, groupIdA);
    check("CASE 1: EPIC_CREATE now exists with 'allow'", afterHeal.EPIC_CREATE === "allow", JSON.stringify(afterHeal));
    check("CASE 1: FEATURE_CREATE now exists with 'allow'", afterHeal.FEATURE_CREATE === "allow", JSON.stringify(afterHeal));

    // ==========================================
    // CASE 2 -- calling it again never duplicates or changes existing rows
    // ==========================================
    console.log("\n2. CASE 2 -- repeat self-heal does not duplicate or change rows");

    const beforeRepeat = await getPermissionMap(poolA, groupIdA);

    const createProjectA2 = await apiPost("/api/projects", { name: "Perm Backfill Case2 Project" }, tokenAdminA);
    check("CASE 2: Project creation succeeded (triggers self-heal again)", createProjectA2.status === 201);

    const afterRepeat = await getPermissionMap(poolA, groupIdA);
    check(
        "CASE 2: no permission value changed after a repeat self-heal",
        JSON.stringify(beforeRepeat) === JSON.stringify(afterRepeat),
        `before=${JSON.stringify(beforeRepeat)} after=${JSON.stringify(afterRepeat)}`
    );

    let noDuplicates = true;
    for (const key of PERMISSION_KEYS) {
        const count = await countRowsForKey(poolA, groupIdA, key);
        if (count !== 1) { noDuplicates = false; check(`CASE 2: exactly one row for ${key}`, false, `found ${count}`); }
    }
    check("CASE 2: every permission key has exactly one row (no duplicates)", noDuplicates);

    // ==========================================
    // CASE 3 -- the one-off migration script backfills only missing keys
    // ==========================================
    console.log("\n3. CASE 3 -- migration script backfills only missing keys");

    await deleteKeys(poolA, groupIdA, ["EPIC_CREATE", "FEATURE_CREATE"]);
    const beforeMigration = await getPermissionMap(poolA, groupIdA);
    check("CASE 3 setup: EPIC_CREATE/FEATURE_CREATE removed again", !("EPIC_CREATE" in beforeMigration) && !("FEATURE_CREATE" in beforeMigration));

    execFileSync(process.execPath, ["_migrate_backfill_admin_group_permissions.js"], {
        cwd: __dirname,
        env: process.env,
        stdio: "inherit",
    });

    const afterMigration = await getPermissionMap(poolA, groupIdA);
    check("CASE 3: migration restored EPIC_CREATE as 'allow'", afterMigration.EPIC_CREATE === "allow");
    check("CASE 3: migration restored FEATURE_CREATE as 'allow'", afterMigration.FEATURE_CREATE === "allow");
    check(
        "CASE 3: migration did not change any OTHER already-present key's value",
        PERMISSION_KEYS
            .filter((key) => key !== "EPIC_CREATE" && key !== "FEATURE_CREATE")
            .every((key) => beforeMigration[key] === afterMigration[key]),
        `before=${JSON.stringify(beforeMigration)} after=${JSON.stringify(afterMigration)}`
    );

    // Idempotency: run it again immediately, confirm no duplicates / no changes.
    const beforeSecondMigrationRun = await getPermissionMap(poolA, groupIdA);
    execFileSync(process.execPath, ["_migrate_backfill_admin_group_permissions.js"], {
        cwd: __dirname,
        env: process.env,
        stdio: "inherit",
    });
    const afterSecondMigrationRun = await getPermissionMap(poolA, groupIdA);
    check(
        "CASE 3: running the migration a second time changes nothing",
        JSON.stringify(beforeSecondMigrationRun) === JSON.stringify(afterSecondMigrationRun)
    );

    // ==========================================
    // CASE 4 -- a non-default security group is never touched
    // ==========================================
    console.log("\n4. CASE 4 -- non-default security group is never touched");

    const [customGroupInsert] = await poolA.query(
        `INSERT INTO project_security_groups (project_id, name, description, is_default) VALUES (NULL, 'Custom Restricted Group', 'Deliberately narrow -- fixture for isolation check', FALSE) RETURNING id`
    );
    const customGroupId = customGroupInsert[0].id;

    // Deliberately grant only a SUBSET, and explicitly deny EPIC_CREATE --
    // simulating a tenant's own intentionally-restrictive custom group.
    await poolA.query(
        `INSERT INTO project_permissions (security_group_id, project_id, permission_key, value) VALUES (?, NULL, 'PROJECT_VIEW', 'allow'), (?, NULL, 'EPIC_CREATE', 'deny')`,
        [customGroupId, customGroupId]
    );
    const customGroupBefore = await getPermissionMap(poolA, customGroupId);

    execFileSync(process.execPath, ["_migrate_backfill_admin_group_permissions.js"], {
        cwd: __dirname,
        env: process.env,
        stdio: "inherit",
    });
    // Also re-trigger the in-code self-heal path via another project creation.
    await apiPost("/api/projects", { name: "Perm Backfill Case4 Project" }, tokenAdminA);

    const customGroupAfter = await getPermissionMap(poolA, customGroupId);
    check(
        "CASE 4: the custom (non-default) group's rows are completely unchanged",
        JSON.stringify(customGroupBefore) === JSON.stringify(customGroupAfter),
        `before=${JSON.stringify(customGroupBefore)} after=${JSON.stringify(customGroupAfter)}`
    );
    check(
        "CASE 4: the custom group's deliberate EPIC_CREATE='deny' was never overwritten to 'allow'",
        customGroupAfter.EPIC_CREATE === "deny"
    );
    check(
        "CASE 4: the custom group was never granted keys it doesn't have (e.g. FEATURE_CREATE still absent)",
        !("FEATURE_CREATE" in customGroupAfter)
    );

    // ==========================================
    // CASE 5 -- a different tenant is not affected by another tenant's permissions
    // ==========================================
    console.log("\n5. CASE 5 -- tenant B is unaffected by tenant A's breakage/repair");

    const groupBBefore = await getPermissionMap(poolB, groupIdB);
    check(
        "CASE 5: tenant B's default group still has every key, untouched by anything done to tenant A",
        PERMISSION_KEYS.every((key) => groupBBefore[key] === "allow"),
        JSON.stringify(groupBBefore)
    );

    const [[groupBRow]] = await poolB.query(
        `SELECT id FROM project_security_groups WHERE project_id IS NULL AND name = 'Project Administrators' AND is_default = TRUE LIMIT 1`
    );
    check("CASE 5: tenant B has exactly one default group (migration didn't create extras)", !!groupBRow);
    const [allDefaultGroupsB] = await poolB.query(
        `SELECT id FROM project_security_groups WHERE project_id IS NULL AND is_default = TRUE`
    );
    check("CASE 5: tenant B has exactly one is_default group total", allDefaultGroupsB.length === 1, `found ${allDefaultGroupsB.length}`);

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
