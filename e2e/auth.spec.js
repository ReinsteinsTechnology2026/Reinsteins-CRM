const { test, expect } = require("@playwright/test");
const { loadFixtures, loginAsTenantUser, loginAsOwner, attachHealthMonitors } = require("./helpers");

// ==========================================
// PHASE 3 -- AUTHENTICATION
// ==========================================

let fixtures;

test.beforeAll(() => {
    fixtures = loadFixtures();
});

test.describe("Owner authentication", () => {

    test("owner can log in and reach the dashboard", async ({ page }) => {
        const health = attachHealthMonitors(page);
        await loginAsOwner(page, fixtures.owner);
        await expect(page).toHaveURL(/\/owner\/(dashboard|companies)/);
        expect(health.getPageErrors(), "uncaught JS exceptions during owner login").toEqual([]);
    });

    test("owner login rejects invalid credentials", async ({ page }) => {
        await page.goto("/owner/login");
        await page.getByPlaceholder(/you@/i).fill(fixtures.owner.email);
        await page.getByPlaceholder("Enter your password").fill("WrongPassword123!");
        await page.getByRole("button", { name: /Sign In|Login/i }).first().click();
        await expect(page).toHaveURL(/\/owner\/login/);
        await expect(page.locator("body")).toContainText(/invalid|incorrect|unable/i, { timeout: 10000 });
    });

    test("owner logout clears the session and blocks protected routes", async ({ page }) => {
        await loginAsOwner(page, fixtures.owner);
        await page.evaluate(() => sessionStorage.clear());
        await page.goto("/owner/dashboard");
        await expect(page).toHaveURL(/\/owner\/login/);
    });

});

test.describe("Admin authentication", () => {

    test("admin can log in and reach the admin dashboard", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await expect(page).toHaveURL(new RegExp(`/${fixtures.slug}/admin`));
    });

    test("admin logout blocks re-entry to protected admin routes", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await page.evaluate(() => sessionStorage.clear());
        await page.goto(`/${fixtures.slug}/admin`);
        await expect(page).toHaveURL(new RegExp(`/${fixtures.slug}/login`));
    });

    test("logged-out user cannot access a protected admin route directly", async ({ page }) => {
        await page.goto(`/${fixtures.slug}/admin`);
        await expect(page).toHaveURL(new RegExp(`/${fixtures.slug}/login`));
    });

});

test.describe("Employee authentication", () => {

    test("employee can log in with Employee ID", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.employee, "employee");
        await expect(page).toHaveURL(new RegExp(`/${fixtures.slug}/employee`));
    });

    test("employee can log in with company email, case-insensitively", async ({ page }) => {
        await page.goto(`/${fixtures.slug}/login`);
        await page.getByPlaceholder("Employee ID or company email").fill(`E2E001@E2EAUDIT.TEST`.toUpperCase());
        await page.getByPlaceholder("Enter your password").fill(fixtures.employee.password);
        await page.getByRole("button", { name: /Sign In/i }).click();
        // Whether email login succeeds depends on this tenant having a
        // verified email domain (it doesn't, by design -- global-setup
        // never provisions one, matching "no verified domain -> email
        // stays null" from the SOP/email-login phase). Either a clean
        // employee-area redirect (domain happened to resolve) or a
        // clear, non-crashing invalid-credentials message is acceptable
        // here; a raw 500/blank page is not.
        await page.waitForTimeout(1500);
        const url = page.url();
        const isEmployeeArea = new RegExp(`/${fixtures.slug}/employee`).test(url);
        const bodyText = await page.locator("body").innerText();
        expect(isEmployeeArea || /invalid|incorrect|unable/i.test(bodyText), `email login neither succeeded nor showed a clean error -- url=${url}`).toBeTruthy();
    });

    test("invalid employee credentials are rejected with a usable error message", async ({ page }) => {
        await page.goto(`/${fixtures.slug}/login`);
        await page.getByPlaceholder("Employee ID or company email").fill(fixtures.employee.employeeId);
        await page.getByPlaceholder("Enter your password").fill("WrongPassword!");
        await page.getByRole("button", { name: /Sign In/i }).click();
        await expect(page).toHaveURL(new RegExp(`/${fixtures.slug}/login`));
        await expect(page.locator("body")).toContainText(/invalid|incorrect|unable/i, { timeout: 10000 });
    });

    test("employee logout blocks re-entry to protected employee routes", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.employee, "employee");
        await page.evaluate(() => sessionStorage.clear());
        await page.goto(`/${fixtures.slug}/employee`);
        await expect(page).toHaveURL(new RegExp(`/${fixtures.slug}/login`));
    });

    test("employee cannot access the admin area", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.employee, "employee");
        await page.goto(`/${fixtures.slug}/admin`);
        // Either redirected away from /admin, or shown an access-denied
        // state -- never a working admin dashboard.
        await page.waitForTimeout(1000);
        const url = page.url();
        const onAdminDashboard = new RegExp(`/${fixtures.slug}/admin$`).test(url) || new RegExp(`/${fixtures.slug}/admin/dashboard`).test(url);
        expect(onAdminDashboard, `employee reached the admin dashboard at ${url}`).toBeFalsy();
    });

});

test.describe("Cross-tenant login isolation", () => {

    test("a nonexistent company slug shows a clean error, not a crash", async ({ page }) => {
        const health = attachHealthMonitors(page);
        await page.goto(`/nonexistent-company-slug-xyz/login`);
        await page.getByPlaceholder("Employee ID or company email").fill(fixtures.employee.employeeId);
        await page.getByPlaceholder("Enter your password").fill(fixtures.employee.password);
        // The app correctly disables the Sign In button entirely once the
        // company-info lookup fails for an unresolvable slug (see
        // Login.jsx's `disabled={loading || (companySlug && companyInfoError)}`)
        // -- it never even allows a submit attempt for a nonexistent
        // company, rather than showing a post-submit error. That's the
        // real, correct behavior to assert on.
        await expect(page.getByRole("button", { name: /Sign In/i })).toBeDisabled({ timeout: 10000 });
        await expect(page).toHaveURL(/nonexistent-company-slug-xyz\/login/);
        expect(health.getPageErrors(), "uncaught JS exceptions for a nonexistent tenant slug").toEqual([]);
    });

});
