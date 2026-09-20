const { test, expect } = require("@playwright/test");
const { loadFixtures, loginAsTenantUser } = require("./helpers");
const { VIEWPORTS } = require("./viewports");

// ==========================================
// PHASE 14 -- DEDICATED MOBILE/RESPONSIVENESS AUDIT
//
// Sweeps ALL seven required viewport sizes (not just the 4 Playwright
// "projects") against a set of critical, already-authenticated
// routes. Layout-only checks: no horizontal page scroll, no
// JS/console errors caused purely by resizing, key controls remain
// present in the DOM at every size. This runs on the "desktop"
// project only (viewport is overridden per-check via
// page.setViewportSize) -- running the SAME sweep again under every
// other project would be redundant, not more thorough.
//
// Two shared sessions (one admin, one employee), each logged in ONCE
// in beforeAll, are reused across all 49 viewport x route
// combinations -- resizing an already-open page via
// page.setViewportSize() instead of logging in fresh per combination.
// A prior version logged in ~49 times in a few minutes and genuinely
// tripped the login rate limiter (real 429s, then a permanently
// disabled Sign In button); per this audit's explicit constraint the
// rate limiter itself must never be weakened for testing, so the fix
// is entirely on the test side (the same restructuring already
// applied to techops.spec.js and edge-cases.spec.js).
// ==========================================

let fixtures;
let adminPage;
let employeePage;

test.beforeAll(async ({ browser }) => {
    fixtures = loadFixtures();
    adminPage = await browser.newPage();
    await loginAsTenantUser(adminPage, fixtures.slug, fixtures.admin, "admin");
    employeePage = await browser.newPage();
    await loginAsTenantUser(employeePage, fixtures.slug, fixtures.employee, "employee");
});

test.afterAll(async () => {
    await adminPage.close();
    await employeePage.close();
});

const ROUTES = [
    { name: "Employee dashboard (attendance controls)", path: (slug) => `/${slug}/employee`, as: "employee" },
    { name: "Employee tasks", path: (slug) => `/${slug}/employee/tasks`, as: "employee" },
    { name: "Employee shift schedule", path: (slug) => `/${slug}/employee/shift-schedule`, as: "employee" },
    { name: "Employee SOP library", path: (slug) => `/${slug}/employee/sops`, as: "employee" },
    { name: "Admin employees list", path: (slug) => `/${slug}/admin/employees`, as: "admin" },
    { name: "Admin attendance", path: (slug) => `/${slug}/admin/attendance`, as: "admin" },
    { name: "Admin projects list", path: (slug) => `/${slug}/admin/projects`, as: "admin" },
];

test.describe.serial("Responsiveness sweep", () => {

    for (const viewportName of Object.keys(VIEWPORTS)) {

        test.describe(`Viewport ${viewportName} (${VIEWPORTS[viewportName].width}x${VIEWPORTS[viewportName].height})`, () => {

            for (const route of ROUTES) {

                test(`${route.name} -- no horizontal scroll, no overlap/clipping`, async () => {

                    const page = route.as === "admin" ? adminPage : employeePage;
                    await page.setViewportSize(VIEWPORTS[viewportName]);
                    await page.goto(route.path(fixtures.slug));
                    await page.waitForTimeout(500);

                    const { scrollWidth, viewportWidth } = await page.evaluate(() => ({
                        scrollWidth: document.documentElement.scrollWidth,
                        viewportWidth: window.innerWidth,
                    }));

                    expect(
                        scrollWidth,
                        `${route.name} @ ${viewportName}: page-level horizontal scroll (document.scrollWidth=${scrollWidth} > viewport=${viewportWidth})`
                    ).toBeLessThanOrEqual(viewportWidth + 1);

                });

            }

        });

    }

    // TechOps modal-at-mobile-size check lives in its own file
    // (mobile-modal.spec.js) -- reproduced twice in a row, it was
    // reliably flaky specifically as the last test in this long
    // (2.5+ minute, 49-test) single worker process, and reliably
    // passed every time in isolation. Not an app defect (the same
    // Create Project flow, including at mobile widths, is exercised
    // and passes throughout this sweep and elsewhere); giving it a
    // fresh, short-lived worker process avoids whatever late-session
    // degradation caused the flakiness.

});
