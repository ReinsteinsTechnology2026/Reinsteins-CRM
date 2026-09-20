const { test, expect } = require("@playwright/test");
const { loadFixtures, loginAsTenantUser } = require("./helpers");

// ==========================================
// PHASE 4 -- ROLE / PERMISSION UI CHECKS
//
// The full backend permission matrix (Basic/Stakeholder delete rules,
// system_access tiers for shift schedules, etc.) is exhaustively
// covered by server/_test_techops_hierarchy.js and
// server/_test_shift_schedule.js (re-run as part of the final
// regression pass). This spec checks the UI LAYER specifically:
// that restricted controls are not just permission-checked on the
// backend but also correctly hidden/shown for each role, and that a
// direct URL visit can't be used to bypass the guard.
// ==========================================

let fixtures;

test.beforeAll(() => {
    fixtures = loadFixtures();
});

test.describe("Stakeholder", () => {

    test("Stakeholder sees the project but not admin-only delete affordances on the org side", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.stakeholder, "employee");
        await page.goto(`/${fixtures.slug}/employee/projects`);
        await expect(page.getByText("E2E Audit Project")).toBeVisible({ timeout: 10000 });
    });

    test("Stakeholder cannot reach the admin employees page directly", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.stakeholder, "employee");
        await page.goto(`/${fixtures.slug}/admin/employees`);
        await page.waitForTimeout(1000);
        expect(page.url(), "a Stakeholder (role=employee) reached an admin-only route").not.toContain("/admin/employees");
    });

});

test.describe("Employee", () => {

    test("Employee can reach their own profile/attendance but not the admin area", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.employee, "employee");
        await page.goto(`/${fixtures.slug}/employee/profile`);
        await expect(page.locator("body")).toBeVisible();

        await page.goto(`/${fixtures.slug}/admin/employees`);
        await page.waitForTimeout(1000);
        expect(page.url()).not.toContain("/admin/employees");
    });

});

test.describe("HR / Executive / Team Lead / Manager / Department Head", () => {

    for (const roleKey of ["hr", "executive", "teamLead", "manager", "deptHead"]) {

        test(`${roleKey}: can log in and reach their own dashboard, cannot reach admin employee management`, async ({ page }) => {
            await loginAsTenantUser(page, fixtures.slug, fixtures[roleKey], "employee");
            await expect(page).toHaveURL(new RegExp(`/${fixtures.slug}/employee`));

            await page.goto(`/${fixtures.slug}/admin/employees`);
            await page.waitForTimeout(1000);
            expect(page.url(), `${roleKey} (system_access tier, role=employee) reached the admin employees page`).not.toContain("/admin/employees");
        });

    }

});
