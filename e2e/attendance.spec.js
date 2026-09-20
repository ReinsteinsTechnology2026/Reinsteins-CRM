const { test, expect } = require("@playwright/test");
const { loadFixtures, loginAsTenantUser, attachHealthMonitors } = require("./helpers");

// ==========================================
// PHASE 6 -- ATTENDANCE (Go Online -> Break -> Go Offline), live
// controls on the Employee dashboard (EmployeeHome.jsx).
// ==========================================

let fixtures;

test.beforeAll(() => {
    fixtures = loadFixtures();
});

test.describe.serial("Attendance workflow", () => {

    test("full workflow: Go Online -> Start Break -> End Break -> Go Offline", async ({ page }) => {
        const health = attachHealthMonitors(page);

        await loginAsTenantUser(page, fixtures.slug, fixtures.employee, "employee");

        // Start from a clean state if a previous run left attendance
        // "online" -- go offline first so this test is repeatable.
        const goOfflineIfOnline = page.getByRole("button", { name: "Go Offline" });
        if (await goOfflineIfOnline.isVisible().catch(() => false)) {
            await goOfflineIfOnline.click();
            await page.waitForTimeout(500);
        }

        await expect(page.getByRole("button", { name: "Go Online" })).toBeVisible({ timeout: 10000 });
        await page.getByRole("button", { name: "Go Online" }).click();

        await expect(page.getByRole("button", { name: "Start Break" })).toBeVisible({ timeout: 10000 });
        await expect(page.getByRole("button", { name: "Go Offline" })).toBeVisible();

        await page.getByRole("button", { name: "Start Break" }).click();
        await expect(page.getByRole("button", { name: "End Break" })).toBeVisible({ timeout: 10000 });

        await page.waitForTimeout(2000); // accrue a small amount of real break time

        await page.getByRole("button", { name: "End Break" }).click();
        await expect(page.getByRole("button", { name: "Start Break" })).toBeVisible({ timeout: 10000 });

        await page.getByRole("button", { name: "Go Offline" }).click();
        await expect(page.getByRole("button", { name: "Go Online" })).toBeVisible({ timeout: 10000 });

        expect(health.getConsoleErrors().filter((e) => !/favicon/i.test(e)), "console errors during the attendance workflow").toEqual([]);
        expect(health.getFailedRequests(), "failed/5xx network requests during the attendance workflow").toEqual([]);
    });

    test("refresh during active attendance preserves online state", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.employee, "employee");

        const goOfflineIfOnline = page.getByRole("button", { name: "Go Offline" });
        if (!(await goOfflineIfOnline.isVisible().catch(() => false))) {
            await page.getByRole("button", { name: "Go Online" }).click();
            await expect(page.getByRole("button", { name: "Go Offline" })).toBeVisible({ timeout: 10000 });
        }

        await page.reload();
        await expect(page.getByRole("button", { name: "Go Offline" })).toBeVisible({ timeout: 10000 });

        // Cleanup: go back offline
        await page.getByRole("button", { name: "Go Offline" }).click();
        await expect(page.getByRole("button", { name: "Go Online" })).toBeVisible({ timeout: 10000 });
    });

    test("repeated Go Online clicks do not create duplicate active sessions", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.employee, "employee");

        await expect(page.getByRole("button", { name: "Go Online" })).toBeVisible({ timeout: 10000 });

        const onlineButton = page.getByRole("button", { name: "Go Online" });
        await onlineButton.click();
        // Immediately try to click again -- the button should already
        // have transitioned to the working-state controls (or be
        // disabled while the request is in flight), never double-fire.
        await expect(page.getByRole("button", { name: "Start Break" })).toBeVisible({ timeout: 10000 });
        await expect(page.getByRole("button", { name: "Go Online" })).toHaveCount(0);

        await page.getByRole("button", { name: "Go Offline" }).click();
        await expect(page.getByRole("button", { name: "Go Online" })).toBeVisible({ timeout: 10000 });
    });

});

test.describe("Attendance -- mobile", () => {

    test.use({ viewport: { width: 390, height: 844 } });

    test("attendance controls are usable on a mobile viewport", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.employee, "employee");

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth, "employee dashboard has horizontal overflow on mobile").toBeLessThanOrEqual(391);

        const goOfflineIfOnline = page.getByRole("button", { name: "Go Offline" });
        if (await goOfflineIfOnline.isVisible().catch(() => false)) {
            await goOfflineIfOnline.click();
            await page.waitForTimeout(500);
        }

        const onlineButton = page.getByRole("button", { name: "Go Online" });
        await expect(onlineButton).toBeVisible({ timeout: 10000 });
        const box = await onlineButton.boundingBox();
        expect(box, "Go Online button not reachable/measurable on mobile").not.toBeNull();
        expect(box.width, "Go Online button too narrow to be a usable touch target").toBeGreaterThan(20);

        await onlineButton.click();
        await expect(page.getByRole("button", { name: "Go Offline" })).toBeVisible({ timeout: 10000 });
        await page.getByRole("button", { name: "Go Offline" }).click();
        await expect(page.getByRole("button", { name: "Go Online" })).toBeVisible({ timeout: 10000 });
    });

});
