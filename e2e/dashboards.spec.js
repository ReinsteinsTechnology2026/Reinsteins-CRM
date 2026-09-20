const { test, expect } = require("@playwright/test");
const { loadFixtures, loginAsTenantUser, attachHealthMonitors } = require("./helpers");

// ==========================================
// PHASE 13 -- DASHBOARDS
// ==========================================

let fixtures;

test.beforeAll(() => {
    fixtures = loadFixtures();
});

test.describe("Dashboards", () => {

    test("Admin dashboard loads statistics with no console/network errors", async ({ page }) => {
        const health = attachHealthMonitors(page);
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await expect(page).toHaveURL(new RegExp(`/${fixtures.slug}/admin`));
        await page.waitForTimeout(1500);

        await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 10000 });
        expect(health.getFailedRequests(), "failed/5xx requests on the admin dashboard").toEqual([]);
        expect(health.getPageErrors(), "uncaught JS exceptions on the admin dashboard").toEqual([]);
    });

    test("Employee dashboard loads with no console/network errors", async ({ page }) => {
        const health = attachHealthMonitors(page);
        await loginAsTenantUser(page, fixtures.slug, fixtures.employee, "employee");
        await page.waitForTimeout(1500);

        expect(health.getFailedRequests(), "failed/5xx requests on the employee dashboard").toEqual([]);
        expect(health.getPageErrors(), "uncaught JS exceptions on the employee dashboard").toEqual([]);
    });

    test("Project Overview dashboard (TechOps) loads with real stats and no errors", async ({ page }) => {
        const health = attachHealthMonitors(page);
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await page.goto(`/${fixtures.slug}/admin/projects`);
        await page.getByText("E2E Audit Project").first().click();
        await page.waitForURL(/\/admin\/projects\/\d+/, { timeout: 10000 });

        await page.getByRole("button", { name: "Overview" }).click();
        await expect(page.getByText(/Total Tasks/i)).toBeVisible({ timeout: 10000 });

        expect(health.getFailedRequests(), "failed/5xx requests on the Project Overview tab").toEqual([]);
    });

    test("Analytics tab handles the empty/no-sprint state without crashing", async ({ page }) => {
        const health = attachHealthMonitors(page);
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await page.goto(`/${fixtures.slug}/admin/projects`);
        await page.getByRole("button", { name: /New Project/i }).click();
        await page.getByPlaceholder(/RS Management Portal/i).fill("E2E Empty Analytics Project");
        await page.getByRole("button", { name: "Create Project" }).click();
        await page.getByText("E2E Empty Analytics Project").click();
        await page.waitForURL(/\/admin\/projects\/\d+/, { timeout: 10000 });

        await page.getByRole("button", { name: "Analytics" }).click();
        await expect(page.getByText(/No sprints yet/i)).toBeVisible({ timeout: 10000 });
        expect(health.getPageErrors(), "Analytics tab threw with no sprints present").toEqual([]);
    });

});

test.describe("Dashboards -- tablet/mobile", () => {

    test.use({ viewport: { width: 768, height: 1024 } });

    test("Admin dashboard cards do not overflow on tablet", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await page.waitForTimeout(1000);
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(769);
    });

});
