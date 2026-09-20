const { test, expect } = require("@playwright/test");
const bcrypt = require("bcrypt");
const { loadFixtures, loginAsTenantUser } = require("./helpers");

// ==========================================
// PHASE 19 -- MULTI-TENANT SAFETY
//
// Provisions a SECOND disposable tenant (never touching the shared
// fixture tenant or any real data) purely for this spec, to prove
// tenant B cannot reach tenant A's data through any of the surfaces
// this audit covers.
// ==========================================

const BASE_URL = "http://localhost:5000";
let fixturesA;
let tenantB;

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

test.beforeAll(async () => {
    fixturesA = loadFixtures();

    const platformUserService = require("../server/services/platformUserService");
    const OWNER_EMAIL = "e2eaudit_tenantb_owner@groworgs.internal";
    const OWNER_PASSWORD = "E2ETenantBOwner!2026";
    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);

    try {
        await platformUserService.create({ name: "E2E Tenant B Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
    } catch (error) {
        if (error.code !== "PLATFORM_USER_EMAIL_TAKEN") throw error;
    }

    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body.token;

    const SLUG_B = "e2eaudit_b";
    let companyId;

    const platformPool = require("../server/config/platformDb");
    const [[existing]] = await platformPool.query(`SELECT id FROM companies WHERE company_slug = ?`, [SLUG_B]);

    if (existing) {
        companyId = existing.id;
    } else {
        const createCo = await apiPost("/api/platform/companies", { companyName: "E2E Audit Company B", companySlug: SLUG_B, accessType: "trial" }, ownerToken);
        companyId = createCo.body.company.id;
    }

    const ADMIN_PASSWORD = "AdminE2ETenantB!2026";
    let adminEmployeeId;
    const { getTenantPool } = require("../server/config/tenantConnectionManager");
    const { buildTenantDbName } = require("../server/utils/tenantDbName");
    const dbNameB = buildTenantDbName(SLUG_B);
    const poolB = getTenantPool(dbNameB);
    const [[existingAdmin]] = await poolB.query(`SELECT employee_id FROM users WHERE role = 'admin' LIMIT 1`).catch(() => [[null]]);

    if (existingAdmin) {
        adminEmployeeId = existingAdmin.employee_id;
    } else {
        const adminCreate = await apiPost(`/api/platform/companies/${companyId}/admin`, { name: "E2E Admin B", email: "admin@e2eaudit-b.test", password: ADMIN_PASSWORD }, ownerToken);
        adminEmployeeId = adminCreate.body.admin.employeeId;
    }

    const loginAdminB = await apiPost(`/api/tenant-auth/${SLUG_B}/login`, { employeeId: adminEmployeeId, password: ADMIN_PASSWORD });

    tenantB = { slug: SLUG_B, admin: { employeeId: adminEmployeeId, password: ADMIN_PASSWORD }, token: loginAdminB.body.token };
});

test.describe("Tenant isolation", () => {

    test("Tenant B's employee list never contains Tenant A's employees", async ({ page }) => {
        await loginAsTenantUser(page, tenantB.slug, tenantB.admin, "admin");
        const headers = { Authorization: `Bearer ${await page.evaluate(() => sessionStorage.getItem("token"))}` };
        const res = await page.request.get("http://localhost:5000/api/employees", { headers });
        const employees = (await res.json()).employees || [];
        expect(employees.some((e) => e.employee_id === fixturesA.employee.employeeId), "Tenant A's employee id leaked into Tenant B's employee list").toBeFalsy();
    });

    test("Tenant B's projects list never contains Tenant A's projects", async ({ page }) => {
        await loginAsTenantUser(page, tenantB.slug, tenantB.admin, "admin");
        const headers = { Authorization: `Bearer ${await page.evaluate(() => sessionStorage.getItem("token"))}` };
        const res = await page.request.get("http://localhost:5000/api/projects", { headers });
        const projects = (await res.json()).projects || [];
        expect(projects.some((p) => p.name.startsWith("E2E")), "Tenant A's projects leaked into Tenant B's project list").toBeFalsy();
    });

    test("Tenant A's token is rejected by Tenant B's tenant-scoped API", async ({ page }) => {
        await loginAsTenantUser(page, fixturesA.slug, fixturesA.admin, "admin");
        const tenantAToken = await page.evaluate(() => sessionStorage.getItem("token"));

        // Real cross-tenant attempt: use Tenant A's own bearer token
        // against Tenant B's login-verification endpoint (which resolves
        // the token against whichever tenant DB it actually belongs to).
        const res = await page.request.get(`http://localhost:5000/api/tenant-auth/${tenantB.slug}/me`, {
            headers: { Authorization: `Bearer ${tenantAToken}` },
        });
        expect(res.status(), "Tenant A's token was accepted on Tenant B's tenant-scoped auth check").not.toBe(200);
    });

    test("Tenant B cannot fetch Tenant A's Recycle Bin, even with a guessed/forged project id", async ({ page }) => {
        await loginAsTenantUser(page, tenantB.slug, tenantB.admin, "admin");
        const headers = { Authorization: `Bearer ${await page.evaluate(() => sessionStorage.getItem("token"))}` };
        const res = await page.request.get(`http://localhost:5000/api/projects/${fixturesA.projectId}/recycle-bin`, { headers });
        // Tenant isolation here is a physically separate database per
        // tenant, selected by the authenticated tenant context -- the
        // numeric id in the URL is resolved entirely within Tenant B's
        // own database, so this can only ever return Tenant B's own
        // (empty/nonexistent) data, never Tenant A's.
        expect([403, 404]).toContain(res.status());
    });

    test("SOPs uploaded in Tenant A are never visible in Tenant B", async ({ page }) => {
        await loginAsTenantUser(page, tenantB.slug, tenantB.admin, "admin");
        const headers = { Authorization: `Bearer ${await page.evaluate(() => sessionStorage.getItem("token"))}` };
        const res = await page.request.get("http://localhost:5000/api/sops", { headers });
        const sops = (await res.json()).sops || [];
        expect(sops.some((s) => s.title.startsWith("E2E")), "Tenant A's SOPs leaked into Tenant B's SOP library").toBeFalsy();
    });

});
