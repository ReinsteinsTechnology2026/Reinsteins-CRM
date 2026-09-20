const { test, expect } = require("@playwright/test");
const { loadFixtures, loginAsTenantUser } = require("./helpers");
const { VIEWPORTS } = require("./viewports");

// ==========================================
// PHASE 14 -- TechOps modal at mobile size (forms/modals fitting on
// small screens). Split out of responsiveness.spec.js into its own
// file so it always runs in a fresh, short-lived Playwright worker --
// as the last test in that file's long single-worker sweep (49 prior
// tests, 2.5+ minutes), it was reliably flaky, and reliably passed in
// isolation. Not an app defect: this same Create Project flow is
// exercised at mobile widths elsewhere in this suite without issue.
// ==========================================

let fixtures;

test.beforeAll(() => {
    fixtures = loadFixtures();
});

test.describe("TechOps modal on mobile", () => {

    test("Create Project modal fits within the viewport width", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await page.setViewportSize(VIEWPORTS.mobile375);
        await page.goto(`/${fixtures.slug}/admin/projects`);
        await page.getByRole("button", { name: /New Project/i }).click();
        await expect(page.getByPlaceholder(/RS Management Portal/i)).toBeVisible({ timeout: 10000 });

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth, "Create Project modal overflows at 375px width").toBeLessThanOrEqual(376);
    });

});
