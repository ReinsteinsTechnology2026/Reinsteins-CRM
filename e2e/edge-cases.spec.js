const { test, expect } = require("@playwright/test");
const { loadFixtures, loginAsTenantUser, attachHealthMonitors } = require("./helpers");

// ==========================================
// PHASE 16 -- ERROR AND EDGE CASE TESTING
//
// All tests share ONE logged-in page/session (module-level `page`,
// single admin login in beforeAll) instead of logging in fresh per
// test. A prior version logged in ~9 times in under a minute and
// genuinely tripped the login rate limiter (real 429s) -- per this
// audit's explicit constraint, the rate limiter itself must never be
// weakened for testing, so the fix is entirely on the test side (the
// same restructuring already applied to techops.spec.js).
// ==========================================

let fixtures;
let page;

test.beforeAll(async ({ browser }) => {
    fixtures = loadFixtures();
    page = await browser.newPage();
    await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
});

test.afterAll(async () => {
    await page.close();
});

test.describe.serial("Edge cases", () => {

    test.describe("Empty states", () => {

        test("a brand new project shows an empty Backlog state, not an error", async () => {
            const health = attachHealthMonitors(page);
            await page.goto(`/${fixtures.slug}/admin/projects`);
            await page.getByRole("button", { name: /New Project/i }).click();
            await page.getByPlaceholder(/RS Management Portal/i).fill("E2E Empty State Project");
            await page.getByRole("button", { name: "Create Project" }).click();
            // .first() -- "duplicate project names are allowed" (below)
            // deliberately creates a second project with this same name,
            // and reruns against a not-freshly-reset dev DB can leave
            // more; any of them is equally freshly-created/empty here.
            await page.getByText("E2E Empty State Project").first().click();
            await page.waitForURL(/\/admin\/projects\/\d+/, { timeout: 10000 });

            await expect(page.getByText(/No epics, features, or user stories yet/i)).toBeVisible({ timeout: 10000 });
            expect(health.getPageErrors(), "empty Backlog state threw a JS exception").toEqual([]);
        });

        test("Recycle Bin shows an empty state for a project with nothing deleted", async () => {
            await page.goto(`/${fixtures.slug}/admin/projects`);
            await page.getByText("E2E Empty State Project").first().click();
            await page.waitForURL(/\/admin\/projects\/\d+/, { timeout: 10000 });
            await page.getByRole("button", { name: "Recycle Bin" }).click();
            await expect(page.getByText(/Recycle Bin is empty/i)).toBeVisible({ timeout: 10000 });
        });

    });

    test.describe("Invalid / duplicate data", () => {

        test("duplicate project names are allowed (no uniqueness constraint) and don't corrupt the list", async () => {
            await page.goto(`/${fixtures.slug}/admin/projects`);
            await page.getByRole("button", { name: /New Project/i }).click();
            await page.getByPlaceholder(/RS Management Portal/i).fill("E2E Empty State Project"); // same name as above
            await page.getByRole("button", { name: "Create Project" }).click();
            await page.waitForTimeout(1000);
            const matches = await page.getByText("E2E Empty State Project").count();
            expect(matches, "creating a duplicate-named project produced an unexpected count").toBeGreaterThanOrEqual(2);
        });

        test("creating a Sprint with a duplicate name in the same project is rejected with a clear message", async () => {
            const projectsListRes = await page.request.get("http://localhost:5000/api/projects", {
                headers: { Authorization: `Bearer ${await page.evaluate(() => sessionStorage.getItem("token"))}` },
            });
            const project = (await projectsListRes.json()).projects.find((p) => p.name === "E2E Empty State Project");

            await page.goto(`/${fixtures.slug}/admin/projects/${project.id}`);
            await page.getByRole("button", { name: "Sprints" }).click();
            await page.getByRole("button", { name: /Add Sprint/i }).click();
            await page.locator('input[name="name"]').fill("Duplicate Sprint");
            await page.getByRole("button", { name: /Create Sprint/i }).click();
            await expect(page.getByText("Duplicate Sprint")).toBeVisible({ timeout: 10000 });

            await page.getByRole("button", { name: /Add Sprint/i }).click();
            await page.locator('input[name="name"]').fill("Duplicate Sprint");
            await page.getByRole("button", { name: /Create Sprint/i }).click();
            await expect(page.locator("body")).toContainText(/already exists/i, { timeout: 10000 });
        });

    });

    test.describe("Deleted/missing parent records", () => {

        test("opening a permanently-deleted task by direct URL shows a clean not-found state, not a crash", async () => {
            const health = attachHealthMonitors(page);
            await page.goto(`/${fixtures.slug}/admin/task-workspace/999999999`);
            await page.waitForTimeout(1000);
            expect(health.getPageErrors(), "opening a nonexistent task id threw an uncaught exception").toEqual([]);
        });

        test("opening a nonexistent project by direct URL shows a clean state, not a crash", async () => {
            const health = attachHealthMonitors(page);
            await page.goto(`/${fixtures.slug}/admin/projects/999999999`);
            await page.waitForTimeout(1000);
            expect(health.getPageErrors(), "opening a nonexistent project id threw an uncaught exception").toEqual([]);
        });

    });

    test.describe("Repeated actions / refresh mid-workflow", () => {

        test("rapidly double-clicking Create Project only creates it once (or the UI guards against it)", async () => {
            await page.goto(`/${fixtures.slug}/admin/projects`);
            await page.getByRole("button", { name: /New Project/i }).click();
            await page.getByPlaceholder(/RS Management Portal/i).fill("E2E Double Click Project");

            // Two native click events dispatched synchronously in one
            // page.evaluate -- a real fast double-click. Racing two
            // separate Playwright .click() calls on the same locator
            // instead can hang: the first click's success navigates the
            // page away, so the second click's actionability retries
            // wait against a detached element until the test times out.
            await page.getByRole("button", { name: "Create Project" }).evaluate((el) => {
                el.click();
                el.click();
            });
            await page.waitForTimeout(1500);

            await page.goto(`/${fixtures.slug}/admin/projects`);
            const count = await page.getByText("E2E Double Click Project").count();
            expect(count, "double-clicking Create Project created more than one project").toBeLessThanOrEqual(1);
        });

        test("refreshing mid-way through an Add Epic form does not leave the app in a broken state", async () => {
            const health = attachHealthMonitors(page);
            await page.goto(`/${fixtures.slug}/admin/projects`);
            await page.getByText("E2E Empty State Project").first().click();
            await page.waitForURL(/\/admin\/projects\/\d+/, { timeout: 10000 });

            await page.getByRole("button", { name: /Add Epic/i }).click();
            await page.getByPlaceholder(/Customer Onboarding Overhaul/i).fill("Will be abandoned by refresh");
            await page.reload();

            await expect(page.getByRole("button", { name: /Add Epic/i })).toBeVisible({ timeout: 10000 });
            expect(health.getPageErrors(), "refreshing mid-form left the app in a broken state").toEqual([]);
        });

    });

    test.describe("Expired/invalid authentication", () => {

        test("a garbage bearer token is rejected, not treated as authenticated", async () => {
            const res = await page.request.get("http://localhost:5000/api/task-management/tasks", {
                headers: { Authorization: "Bearer this-is-not-a-real-jwt" },
            });
            expect(res.status(), "a garbage bearer token was accepted").toBe(401);
        });

        test("no Authorization header at all is rejected on a protected endpoint", async () => {
            const res = await page.request.get("http://localhost:5000/api/task-management/tasks");
            expect(res.status()).toBe(401);
        });

    });

});
