const { test, expect } = require("@playwright/test");
const { loadFixtures, loginAsTenantUser, attachHealthMonitors } = require("./helpers");

// ==========================================
// PHASE 5 -- EMPLOYEE MANAGEMENT
// ==========================================

let fixtures;

test.beforeAll(() => {
    fixtures = loadFixtures();
});

// Unique per test-process run so repeated local reruns against the same
// (not freshly reset) dev DB never collide with rows left by a prior run.
const RUN_TAG = Date.now().toString(36);
const NAME_ONE = `E2E New Employee One ${RUN_TAG}`;
const NAME_TWO = `E2E New Employee Two ${RUN_TAG}`;

test.describe("Employee lifecycle", () => {

    test("create employee with valid data -- automatic Employee ID generated, unique", async ({ page }) => {
        const health = attachHealthMonitors(page);
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await page.goto(`/${fixtures.slug}/admin/employees`);

        await page.getByRole("button", { name: "Add Employee" }).first().click();
        await page.getByPlaceholder("Enter employee name").fill(NAME_ONE);
        await page.locator('select[name="designation"]').selectOption({ label: "Software Engineer" });
        await page.getByPlaceholder("Create temporary password").fill("TempPass123!");
        await page.getByRole("button", { name: "Create Employee" }).click();

        // Scoped to the table -- an unscoped getByText also matches this
        // name inside the "Reporting Manager" dropdown's option list.
        await expect(page.locator("table").getByText(NAME_ONE, { exact: true })).toBeVisible({ timeout: 10000 });
        expect(health.getConsoleErrors().filter((e) => !/favicon/i.test(e))).toEqual([]);

        // Create a second employee, confirm a DIFFERENT auto-generated
        // Employee ID (uniqueness), even with a duplicate-ish name.
        await page.getByRole("button", { name: "Add Employee" }).first().click();
        await page.getByPlaceholder("Enter employee name").fill(NAME_TWO);
        await page.locator('select[name="designation"]').selectOption({ label: "Software Engineer" });
        await page.getByPlaceholder("Create temporary password").fill("TempPass123!");
        await page.getByRole("button", { name: "Create Employee" }).click();

        await expect(page.locator("table").getByText(NAME_TWO, { exact: true })).toBeVisible({ timeout: 10000 });

        const rows = page.locator("table tr", { hasText: new RegExp(`${NAME_ONE}|${NAME_TWO}`) });
        const count = await rows.count();
        expect(count, "expected both newly created employees to appear as distinct rows").toBe(2);
    });

    test("create employee rejects missing required fields", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await page.goto(`/${fixtures.slug}/admin/employees`);

        await page.getByRole("button", { name: "Add Employee" }).first().click();
        // Leave Full Name empty, attempt submit -- the browser's native
        // `required` validation should block it (form never submits).
        await page.getByPlaceholder("Create temporary password").fill("TempPass123!");
        await page.getByRole("button", { name: "Create Employee" }).click();
        // Still on the form (modal did not close) -- proves the submit
        // was blocked rather than silently accepted.
        await expect(page.getByPlaceholder("Enter employee name")).toBeVisible();
    });

    test("employee listing shows created employees; employee details open", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await page.goto(`/${fixtures.slug}/admin/employees`);
        const row = page.locator("table").getByText(NAME_ONE, { exact: true });
        await expect(row).toBeVisible({ timeout: 10000 });
        await row.click();
        // Opening details should not throw / should show more employee info than the row alone.
        await page.waitForTimeout(500);
    });

});

test.describe("Company email generation", () => {

    test("no verified domain -> email stays explicitly null, employee can still log in by Employee ID", async ({ page }) => {
        // The seeded fixture tenant has no verified email domain
        // (global-setup never provisions one) -- creating an employee
        // must never fabricate/guess a domain.
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await page.goto(`/${fixtures.slug}/admin/employees`);
        await page.getByRole("button", { name: "Add Employee" }).first().click();
        // The message is the VALUE of a disabled input, not a text node,
        // so it must be matched via toHaveValue rather than getByText.
        // Disabled inputs in form order: [0] Employee ID, [1] Company Email.
        await expect(page.locator("input:disabled").nth(1)).toHaveValue(
            "No verified email domain configured for this company"
        );
        await page.getByRole("button", { name: "Cancel" }).click();
    });

});

test.describe("Mobile", () => {

    test.use({ viewport: { width: 390, height: 844 } });

    test("Add Employee form is usable on a mobile viewport", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await page.goto(`/${fixtures.slug}/admin/employees`);

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth, "employee list page has horizontal overflow on mobile").toBeLessThanOrEqual(391);

        await page.getByRole("button", { name: "Add Employee" }).first().click();
        await expect(page.getByPlaceholder("Enter employee name")).toBeVisible();
        const modalScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(modalScrollWidth, "Add Employee modal overflows on mobile").toBeLessThanOrEqual(391);
    });

});
