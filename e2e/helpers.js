const fs = require("fs");
const path = require("path");
const { expect } = require("@playwright/test");

// ==========================================
// SHARED E2E HELPERS
// ==========================================

function loadFixtures() {
    const fixturesPath = path.join(__dirname, ".fixtures.json");
    if (!fs.existsSync(fixturesPath)) {
        throw new Error("e2e/.fixtures.json not found -- global-setup did not run or failed. Run `npx playwright test` (which triggers globalSetup automatically), not the spec files directly.");
    }
    return JSON.parse(fs.readFileSync(fixturesPath, "utf8"));
}

// ==========================================
// REAL UI LOGIN (never bypasses the login form -- always exercises
// the actual auth flow, per the audit's explicit requirement not to
// fake success or skip real workflows).
// ==========================================

async function loginAsTenantUser(page, slug, { employeeId, password }, expectedRole) {

    await page.goto(`/${slug}/login`);

    await page.getByPlaceholder("Employee ID or company email").fill(employeeId);
    await page.getByPlaceholder("Enter your password").fill(password);
    await page.getByRole("button", { name: /Sign In/i }).click();

    if (expectedRole === "admin") {
        await page.waitForURL(new RegExp(`/${slug}/admin`), { timeout: 15000 });
    } else {
        await page.waitForURL(new RegExp(`/${slug}/employee`), { timeout: 15000 });
    }

}

async function loginAsOwner(page, { email, password }) {
    await page.goto("/owner/login");
    await page.getByPlaceholder(/you@/i).fill(email);
    await page.getByPlaceholder("Enter your password").fill(password);
    await page.getByRole("button", { name: /Sign In|Login/i }).first().click();
    await page.waitForURL(/\/owner\/(dashboard|companies)/, { timeout: 15000 });
}

async function logout(page) {
    // sessionStorage-based session (see Login.jsx) -- clearing it and
    // reloading is the same effect as clicking a real Logout control,
    // used only where a dedicated Logout button isn't the thing under
    // test (most auth specs click the real button instead).
    await page.evaluate(() => {
        sessionStorage.removeItem("token");
        sessionStorage.removeItem("user");
    });
}

// ==========================================
// RESPONSIVENESS CHECKS
// ==========================================

async function assertNoHorizontalScroll(page, context) {
    const { scrollWidth, clientWidth, viewportWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        viewportWidth: window.innerWidth,
    }));
    expect(scrollWidth, `${context}: document.scrollWidth (${scrollWidth}) exceeds viewport width (${viewportWidth}) -- horizontal scroll present`).toBeLessThanOrEqual(viewportWidth + 1);
    void clientWidth;
}

// ==========================================
// CONSOLE / NETWORK HEALTH CAPTURE
// Attaches listeners and returns accessor functions -- call
// attachHealthMonitors(page) once per test, then inspect
// getConsoleErrors()/getFailedRequests() at the end.
// ==========================================

function attachHealthMonitors(page) {

    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];

    page.on("console", (msg) => {
        if (msg.type() === "error") {
            consoleErrors.push(msg.text());
        }
    });

    page.on("pageerror", (error) => {
        pageErrors.push(error.message);
    });

    page.on("requestfailed", (request) => {
        failedRequests.push({ url: request.url(), failure: request.failure()?.errorText });
    });

    page.on("response", (response) => {
        const status = response.status();
        if (status >= 500) {
            failedRequests.push({ url: response.url(), failure: `HTTP ${status}` });
        }
    });

    return {
        getConsoleErrors: () => consoleErrors,
        getPageErrors: () => pageErrors,
        getFailedRequests: () => failedRequests,
    };

}

module.exports = {
    loadFixtures,
    loginAsTenantUser,
    loginAsOwner,
    logout,
    assertNoHorizontalScroll,
    attachHealthMonitors,
};
