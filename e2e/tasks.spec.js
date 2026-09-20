const { test, expect } = require("@playwright/test");
const { loadFixtures, loginAsTenantUser, attachHealthMonitors } = require("./helpers");

// ==========================================
// PHASE 7 -- TASKS (legacy, non-project "My Tasks" flow --
// project-linked task creation/editing is covered in techops.spec.js)
// ==========================================

let fixtures;

test.beforeAll(() => {
    fixtures = loadFixtures();
});

test.describe("Legacy task management", () => {

    test("Admin can create a task, employee sees it in their task list", async ({ page }) => {
        const health = attachHealthMonitors(page);
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");

        const longTitle = "E2E Long Task Title ".repeat(6).trim();
        const longDescription = "E2E long description content designed to stress-test wrapping and layout. ".repeat(10).trim();

        const headers = { Authorization: `Bearer ${await page.evaluate(() => sessionStorage.getItem("token"))}` };
        const createRes = await page.request.post("http://localhost:5000/api/task-management/create", {
            headers: { ...headers, "Content-Type": "application/json" },
            data: {
                title: longTitle,
                description: longDescription,
                assigned_to: fixtures.employee.id,
                priority: "High",
                status: "New",
            },
        });
        expect(createRes.status()).toBeLessThan(300);

        await loginAsTenantUser(page, fixtures.slug, fixtures.employee, "employee");
        await page.goto(`/${fixtures.slug}/employee/tasks`);
        await expect(page.locator("body")).toContainText("E2E Long Task Title", { timeout: 10000 });

        expect(health.getPageErrors(), "uncaught JS exceptions rendering a long task title/description").toEqual([]);
    });

    test("long task titles/descriptions do not break the layout", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.employee, "employee");
        await page.goto(`/${fixtures.slug}/employee/tasks`);
        await page.waitForTimeout(500);

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        const viewportWidth = await page.evaluate(() => window.innerWidth);
        expect(scrollWidth, "a long task title/description caused page-level horizontal scroll").toBeLessThanOrEqual(viewportWidth + 1);
    });

});

test.describe("Tasks -- mobile", () => {

    test.use({ viewport: { width: 390, height: 844 } });

    test("employee task list is usable on mobile", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.employee, "employee");
        await page.goto(`/${fixtures.slug}/employee/tasks`);
        await page.waitForTimeout(500);

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(391);
    });

});
