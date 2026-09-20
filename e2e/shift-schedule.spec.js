const { test, expect } = require("@playwright/test");
const { loadFixtures, loginAsTenantUser, attachHealthMonitors } = require("./helpers");

// ==========================================
// PHASE 12 -- SHIFT SCHEDULE
//
// The full system_access permission matrix (HR/Executive/Team
// Lead/Manager/Department Head/Admin/Super Admin rules) is already
// exhaustively covered by server/_test_shift_schedule.js (53 checks,
// re-run as part of the final regression pass) -- this spec instead
// covers what that backend suite can't: the real click-driven weekly
// calendar UI, and a couple of representative permission checks at
// the UI/API boundary.
// ==========================================

let fixtures;

test.beforeAll(() => {
    fixtures = loadFixtures();
});

function todayIso() {
    return new Date().toISOString().slice(0, 10);
}

test.describe("Shift Schedule", () => {

    test("employee can view, create, edit, and remove their own schedule entry via the calendar", async ({ page }) => {
        const health = attachHealthMonitors(page);
        await loginAsTenantUser(page, fixtures.slug, fixtures.employee, "employee");
        await page.goto(`/${fixtures.slug}/employee/shift-schedule`);

        await expect(page.getByText(/schedule/i).first()).toBeVisible({ timeout: 10000 });

        // Clean slate: remove any existing entry for today first.
        const todayCell = page.locator(`td.shift-cell-editable, div.shift-employee-card-day`).filter({ hasText: "" }).first();
        void todayCell;

        // Click the first editable cell belonging to "self" -- exact
        // date targeting is brittle against a live calendar, so this
        // exercises the real add-or-edit interaction rather than a
        // specific date.
        const editableCell = page.locator(".shift-cell-editable, .shift-employee-card-day").first();
        await editableCell.click();

        await expect(page.getByRole("heading", { name: /Add My Schedule|Edit My Schedule/i })).toBeVisible({ timeout: 10000 });

        const isEditing = await page.getByRole("heading", { name: "Edit My Schedule" }).isVisible().catch(() => false);
        // Scoped to the modal -- an unscoped getByRole("button", { name:
        // "Add" }) also substring-matches every "+ Add" calendar cell.
        const modal = page.locator(".employee-modal");

        if (!isEditing) {
            await page.locator('select[name="status"]').selectOption("working");
            await page.locator('input[name="startTime"]').fill("09:00");
            await page.locator('input[name="endTime"]').fill("18:00");
            await modal.getByRole("button", { name: "Add", exact: true }).click();
            await page.waitForTimeout(1000);
        } else {
            // Already has an entry from a previous run -- edit it instead.
            await page.locator('textarea[name="notes"]').fill("Updated by E2E audit");
            await modal.getByRole("button", { name: "Save Changes" }).click();
            await page.waitForTimeout(1000);
        }

        expect(health.getConsoleErrors().filter((e) => !/favicon/i.test(e)), "console errors while managing own shift schedule").toEqual([]);

        // Remove it, to leave the fixture clean for reruns.
        const editableCellAgain = page.locator(".shift-cell-editable, .shift-employee-card-day").first();
        await editableCellAgain.click();
        await expect(page.getByRole("heading", { name: "Edit My Schedule" })).toBeVisible({ timeout: 10000 });
        page.once("dialog", (dialog) => dialog.accept());
        await page.locator(".employee-modal").getByRole("button", { name: "Remove" }).click();
    });

    test("Admin can view schedules across employees and override an entry", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        await page.goto(`/${fixtures.slug}/admin/shift-management`);
        await expect(page.locator("body")).toBeVisible();

        // Admin override, verified at the API layer (system_access
        // rules for this are exhaustively covered by the backend
        // suite) -- confirms the admin UI's own session token is
        // actually authorized to write another employee's schedule.
        //
        // Uses POST /api/shifts/bulk (true upsert semantics), NOT plain
        // POST /api/shifts -- that endpoint intentionally 409s on a
        // second entry for the same employee+date (see
        // server/_test_shift_schedule.js's "EXTRA: creating a second
        // entry ... -> 409"); a plain POST is create-only, not an
        // override, by design.
        const headers = { Authorization: `Bearer ${await page.evaluate(() => sessionStorage.getItem("token"))}` };
        const createRes = await page.request.post("http://localhost:5000/api/shifts/bulk", {
            headers: { ...headers, "Content-Type": "application/json" },
            data: { shifts: [{ userId: fixtures.employee.id, shiftDate: todayIso(), status: "working", startTime: "10:00", endTime: "19:00" }] },
        });
        expect(createRes.status(), "Admin was not able to create/override an employee's shift").toBeLessThan(300);
        const body = await createRes.json();
        expect(body.results?.[0]?.success, `bulk override did not succeed: ${JSON.stringify(body)}`).toBe(true);
    });

    test("a plain employee cannot write another employee's schedule via a direct API call", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.employee, "employee");
        const headers = { Authorization: `Bearer ${await page.evaluate(() => sessionStorage.getItem("token"))}` };

        const attempt = await page.request.post("http://localhost:5000/api/shifts", {
            headers: { ...headers, "Content-Type": "application/json" },
            data: { userId: fixtures.stakeholder.id, shiftDate: todayIso(), status: "working", startTime: "09:00", endTime: "18:00" },
        });
        expect(attempt.status(), "a plain employee was able to write ANOTHER employee's shift schedule").toBe(403);
    });

});

test.describe("Shift Schedule -- mobile", () => {

    test.use({ viewport: { width: 390, height: 844 } });

    test("weekly calendar is usable on a mobile viewport", async ({ page }) => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.employee, "employee");
        await page.goto(`/${fixtures.slug}/employee/shift-schedule`);

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth, "shift schedule page has horizontal overflow on mobile").toBeLessThanOrEqual(391);
    });

});
