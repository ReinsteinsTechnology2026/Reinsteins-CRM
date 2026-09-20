const bcrypt = require("bcrypt");
const path = require("path");
const fs = require("fs");

// ==========================================
// GLOBAL SETUP -- seeds ONE disposable tenant with every role fixture
// the audit needs, via real HTTP calls against the backend (assumed
// already running on http://localhost:5000, pointed at a disposable
// test database -- never a real tenant). Mirrors the exact
// provisioning pattern already used throughout server/_test_*.js.
//
// Writes e2e/.fixtures.json (gitignored -- disposable test
// credentials only, never committed) for every spec file to import.
// ==========================================

const BASE_URL = "http://localhost:5000";
const SLUG = "e2eaudit_a";
const FIXTURES_PATH = path.join(__dirname, ".fixtures.json");

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

module.exports = async function globalSetup() {

    // ---- Reachability check -- fail fast with a clear message ----
    try {
        await fetch(`${BASE_URL}/`);
    } catch (error) {
        throw new Error(
            `Backend not reachable at ${BASE_URL} -- start it first (pointed at a disposable test database) before running Playwright. ${error.message}`
        );
    }

    const platformPool = require("../server/config/platformDb");
    const platformUserService = require("../server/services/platformUserService");
    const { getTenantPool, closeAllTenantPools } = require("../server/config/tenantConnectionManager");
    const { buildTenantDbName } = require("../server/utils/tenantDbName");

    const OWNER_EMAIL = "e2eaudit_owner@groworgs.internal";
    const OWNER_PASSWORD = "E2EAuditOwner!2026Pwd";
    const ADMIN_PASSWORD = "AdminE2E!2026Pwd";
    const dbName = buildTenantDbName(SLUG);

    // Idempotent: re-running global-setup (e.g. while iterating on a
    // single spec file during development) reuses the already-seeded
    // tenant instead of failing on "already exists" -- only a genuinely
    // fresh disposable database goes through full provisioning.
    const [[existingCompany]] = await platformPool.query(
        `SELECT id FROM companies WHERE company_slug = ?`,
        [SLUG]
    );

    let ownerToken, companyId, adminEmployeeId, adminToken;

    if (existingCompany) {

        companyId = existingCompany.id;

        const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
        ownerToken = loginRes.body?.token;
        if (!ownerToken) throw new Error("global-setup: platform owner login failed on existing fixture -- " + JSON.stringify(loginRes.body));

        const pool = getTenantPool(dbName);
        const [[adminRow]] = await pool.query(`SELECT employee_id FROM users WHERE role = 'admin' LIMIT 1`);
        adminEmployeeId = adminRow.employee_id;

        const loginAdmin = await apiPost(`/api/tenant-auth/${SLUG}/login`, { employeeId: adminEmployeeId, password: ADMIN_PASSWORD });
        adminToken = loginAdmin.body?.token;
        if (!adminToken) throw new Error("global-setup: admin login failed on existing fixture -- " + JSON.stringify(loginAdmin.body));

    } else {

        const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
        await platformUserService.create({ name: "E2E Audit Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });

        const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
        ownerToken = loginRes.body?.token;
        if (!ownerToken) throw new Error("global-setup: platform owner login failed -- " + JSON.stringify(loginRes.body));

        const createCo = await apiPost("/api/platform/companies", { companyName: "E2E Audit Company", companySlug: SLUG, accessType: "trial" }, ownerToken);
        companyId = createCo.body?.company?.id;
        if (!companyId) throw new Error("global-setup: company creation failed -- " + JSON.stringify(createCo.body));

        const adminCreate = await apiPost(`/api/platform/companies/${companyId}/admin`, { name: "E2E Admin", email: "admin@e2eaudit.test", password: ADMIN_PASSWORD }, ownerToken);
        adminEmployeeId = adminCreate.body?.admin?.employeeId;
        if (!adminEmployeeId) throw new Error("global-setup: admin creation failed -- " + JSON.stringify(adminCreate.body));

        const loginAdmin = await apiPost(`/api/tenant-auth/${SLUG}/login`, { employeeId: adminEmployeeId, password: ADMIN_PASSWORD });
        adminToken = loginAdmin.body?.token;
        if (!adminToken) throw new Error("global-setup: admin login failed -- " + JSON.stringify(loginAdmin.body));

    }

    const pool = getTenantPool(dbName);

    const EMPLOYEE_PASSWORD = "EmployeeE2E!2026Pwd";
    const employeePasswordHash = await bcrypt.hash(EMPLOYEE_PASSWORD, 10);

    async function seedUser(employeeId, fullName, systemAccess, projectAccessLevel, designation) {
        const [result] = await pool.query(
            `INSERT INTO users (employee_id, full_name, email, password, role, system_access, employment_type, employment_status, status, designation, project_access_level)
             VALUES (?, ?, ?, ?, 'employee', ?, 'employee', 'active', 'active', ?, ?)
             ON CONFLICT (employee_id) DO NOTHING
             RETURNING id`,
            [employeeId, fullName, `${employeeId.toLowerCase()}@e2eaudit.test`, employeePasswordHash, systemAccess, designation, projectAccessLevel]
        );
        if (result[0]) return result[0].id;
        const [[existing]] = await pool.query(`SELECT id FROM users WHERE employee_id = ?`, [employeeId]);
        return existing.id;
    }

    // Fresh tenants get zero designations by design (nothing seeds
    // them at provisioning time) -- the Add Employee form's
    // Designation dropdown is required and populated only from
    // designationsCatalog, so employee-management specs need at
    // least these to exist.
    for (const title of ["Software Engineer", "HR Manager", "Executive", "Team Lead", "Manager", "Department Head", "Staff"]) {
        await pool.query(
            `INSERT INTO designations (title) VALUES (?) ON CONFLICT (title) DO NOTHING`,
            [title]
        );
    }

    const employeeId = await seedUser("E2E001", "E2E Employee", "employee", "basic", "Software Engineer");
    const stakeholderId = await seedUser("E2E002", "E2E Stakeholder", "employee", "stakeholder", "Software Engineer");
    const hrId = await seedUser("E2E003", "E2E HR", "hr", "basic", "HR Manager");
    const executiveId = await seedUser("E2E004", "E2E Executive", "executive", "basic", "Executive");
    const teamLeadId = await seedUser("E2E005", "E2E Team Lead", "team_lead", "basic", "Team Lead");
    const managerId = await seedUser("E2E006", "E2E Manager", "manager", "basic", "Manager");
    const deptHeadId = await seedUser("E2E007", "E2E Dept Head", "department_head", "basic", "Department Head");

    // ---- One project, with Admin/Employee/Stakeholder as members ----
    const [[existingProject]] = await pool.query(`SELECT id FROM projects WHERE name = ?`, ["E2E Audit Project"]);

    let projectId;

    if (existingProject) {

        projectId = existingProject.id;

    } else {

        const createProject = await apiPost("/api/projects", { name: "E2E Audit Project" }, adminToken);
        projectId = createProject.body?.id;
        if (!projectId) throw new Error("global-setup: project creation failed -- " + JSON.stringify(createProject.body));

        const groupsRes = await fetch(`${BASE_URL}/api/projects/${projectId}/groups`, { headers: { Authorization: `Bearer ${adminToken}` } });
        const groupsBody = await groupsRes.json();
        const adminGroupId = groupsBody?.groups?.find((g) => g.name === "Project Administrators")?.id;
        if (!adminGroupId) throw new Error("global-setup: default Project Administrators group not found");

        await apiPost(`/api/projects/${projectId}/members`, { userIds: [employeeId, stakeholderId], securityGroupId: adminGroupId }, adminToken);

    }

    const fixtures = {
        slug: SLUG,
        companyId,
        projectId,
        owner: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
        admin: { employeeId: adminEmployeeId, password: ADMIN_PASSWORD },
        employee: { employeeId: "E2E001", password: EMPLOYEE_PASSWORD, id: employeeId },
        stakeholder: { employeeId: "E2E002", password: EMPLOYEE_PASSWORD, id: stakeholderId },
        hr: { employeeId: "E2E003", password: EMPLOYEE_PASSWORD, id: hrId },
        executive: { employeeId: "E2E004", password: EMPLOYEE_PASSWORD, id: executiveId },
        teamLead: { employeeId: "E2E005", password: EMPLOYEE_PASSWORD, id: teamLeadId },
        manager: { employeeId: "E2E006", password: EMPLOYEE_PASSWORD, id: managerId },
        deptHead: { employeeId: "E2E007", password: EMPLOYEE_PASSWORD, id: deptHeadId },
    };

    fs.writeFileSync(FIXTURES_PATH, JSON.stringify(fixtures, null, 2));

    console.log(`[global-setup] Seeded tenant "${SLUG}" (db=${dbName}, project=${projectId}) -- fixtures written to e2e/.fixtures.json`);

    await closeAllTenantPools();
    // platformPool is a shared module-level pool -- deliberately NOT
    // closed here (globalTeardown, not written, would be the right
    // place; closing it here would break any later reuse within the
    // same process). It's a disposable test database connection, not
    // a leak of anything sensitive.
    void platformPool;

};
