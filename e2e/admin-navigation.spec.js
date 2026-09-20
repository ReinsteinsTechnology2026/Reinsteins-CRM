const { test, expect } = require("@playwright/test");
const { loadFixtures, loginAsTenantUser } = require("./helpers");
const { VIEWPORTS } = require("./viewports");

// ==========================================
// REGRESSION: Admin sidebar "TechOps" button must open Projects
// directly, not the Organizations list. Prior behavior routed
// "TechOps" -> /admin/organizations (a mislabeled nav target left
// over from an earlier phase); this asserts the corrected target and
// that Organizations itself is untouched and still independently
// reachable.
// ==========================================

let fixtures;

test.beforeAll(() => {
    fixtures = loadFixtures();
});

test.describe("Admin sidebar navigation", () => {

    test("TechOps opens Projects directly, not Organizations", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await page.goto(`/${fixtures.slug}/admin`);

        await page.getByRole("button", { name: "TechOps" }).click();
        await expect(page).toHaveURL(new RegExp(`/${fixtures.slug}/admin/projects$`));

        // The "TechOps" nav item itself should read as active on the
        // Projects route.
        await expect(page.getByRole("button", { name: "TechOps" })).toHaveClass(/active/);
    });

    test("Organizations remains independently reachable and unaffected", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await page.goto(`/${fixtures.slug}/admin/organizations`);

        await expect(page.getByRole("heading", { name: "Organizations" })).toBeVisible({ timeout: 10000 });
    });

    test("TechOps -> Projects -> Project workspace exposes Epic/Feature/User Story/Task, Sprints, Recycle Bin", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await page.goto(`/${fixtures.slug}/admin`);
        await page.getByRole("button", { name: "TechOps" }).click();
        await expect(page).toHaveURL(new RegExp(`/${fixtures.slug}/admin/projects$`));

        await page.getByRole("button", { name: /New Project/i }).click();
        await page.getByPlaceholder(/RS Management Portal/i).fill("E2E Nav Fix Project");
        await page.getByRole("button", { name: "Create Project" }).click();
        await page.getByText("E2E Nav Fix Project").first().click();
        await page.waitForURL(/\/admin\/projects\/\d+/, { timeout: 10000 });

        await expect(page.getByRole("button", { name: /Add Epic/i })).toBeVisible({ timeout: 10000 });
        await expect(page.getByRole("button", { name: "Sprints" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Recycle Bin" })).toBeVisible();
    });

    for (const [name, viewport] of [["laptop1280", VIEWPORTS.laptop1280], ["mobile390", VIEWPORTS.mobile390]]) {

        test(`TechOps -> Projects navigation works at ${name}`, async ({ page }) => {
            await page.setViewportSize(viewport);
            await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
            await page.goto(`/${fixtures.slug}/admin`);

            // Mobile: sidebar is a closed drawer by default -- open it first.
            const hamburger = page.getByRole("button", { name: "Open navigation menu" });
            if (await hamburger.isVisible().catch(() => false)) {
                await hamburger.click();
            }
            await page.getByRole("button", { name: "TechOps" }).click();

            await expect(page).toHaveURL(new RegExp(`/${fixtures.slug}/admin/projects$`));
            const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
            expect(scrollWidth, `Projects page overflows at ${name}`).toBeLessThanOrEqual(viewport.width + 1);
        });

    }

});
