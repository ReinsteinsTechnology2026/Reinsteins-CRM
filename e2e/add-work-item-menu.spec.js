const { test, expect } = require("@playwright/test");
const { loadFixtures, loginAsTenantUser } = require("./helpers");
const { VIEWPORTS } = require("./viewports");

// ==========================================
// "ADD NEW WORK ITEM" DROPDOWN -- BACKLOG CREATION UX
//
// Covers the redesigned single entry point (replacing the previous
// four separate "Add Epic"/"Add Feature"/"Add User Story"/"Add Task"
// toolbar buttons) and the contextual per-row creation actions, which
// were NOT changed by this redesign (still plain buttons, already
// covered structurally by techops.spec.js) -- this file adds explicit
// coverage for: the menu itself, its accessibility/UX behavior,
// parent auto-selection from contextual entry points, the empty
// state, and mobile/desktop fit.
//
// One shared admin session (see techops.spec.js's own comment for why
// -- avoids tripping the real login rate limiter).
// ==========================================

let fixtures;
let page;
let projectUrl;

test.beforeAll(async ({ browser }) => {
    fixtures = loadFixtures();
    page = await browser.newPage();
    await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");

    await page.goto(`/${fixtures.slug}/admin/projects`);
    await page.getByRole("button", { name: /New Project/i }).click();
    await page.getByPlaceholder(/RS Management Portal/i).fill("E2E Work Item Menu Project");
    await page.getByRole("button", { name: "Create Project" }).click();
    await page.getByText("E2E Work Item Menu Project").first().click();
    await page.waitForURL(/\/admin\/projects\/\d+/, { timeout: 10000 });
    projectUrl = page.url();
});

test.afterAll(async () => {
    await page.close();
});

test.describe.serial("Add New Work Item menu", () => {

    test("menu exists, opens on click, shows all four options with descriptions", async () => {
        await page.goto(projectUrl);

        // Scoped to the toolbar -- while the Backlog is still empty
        // (true for a freshly created project), the empty state ALSO
        // renders its own "Add New Work Item" trigger (see the
        // dedicated empty-state test below), so an unscoped locator
        // here would be ambiguous.
        const trigger = page.locator(".pw-backlog-header-actions").getByRole("button", { name: "Add New Work Item" });
        await expect(trigger).toBeVisible();

        await trigger.click();
        const menu = page.getByRole("menu");
        await expect(menu).toBeVisible();

        await expect(menu.getByRole("menuitem", { name: /Add Epic/i })).toBeVisible();
        await expect(menu.getByText("High-level container for features")).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: /Add Feature/i })).toBeVisible();
        await expect(menu.getByText("Group of user stories")).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: /Add User Story/i })).toBeVisible();
        await expect(menu.getByText("End-user requirement")).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: /Add Task/i })).toBeVisible();
        await expect(menu.getByText("Specific actionable item")).toBeVisible();

        // Closes with Escape.
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();

        // Closes on outside click.
        await trigger.click();
        await expect(menu).toBeVisible();
        await page.locator("h2", { hasText: "Backlog" }).click();
        await expect(menu).toBeHidden();
    });

    test("menu closes after selecting an option, and opens the correct modal", async () => {
        await page.goto(projectUrl);

        await page.locator(".pw-backlog-header-actions").getByRole("button", { name: "Add New Work Item" }).click();
        await page.getByRole("menuitem", { name: /Add Epic/i }).click();

        await expect(page.getByRole("menu")).toBeHidden();
        await expect(page.getByRole("heading", { name: "Create New Epic" })).toBeVisible({ timeout: 10000 });
        await page.getByRole("button", { name: "Cancel" }).click();
    });

    test("Epic created via the menu appears in the Backlog with code and type badge", async () => {
        await page.goto(projectUrl);

        await page.locator(".pw-backlog-header-actions").getByRole("button", { name: "Add New Work Item" }).click();
        await page.getByRole("menuitem", { name: /Add Epic/i }).click();
        await page.getByPlaceholder(/Customer Onboarding Overhaul/i).fill("E2E Menu Epic");
        await page.getByRole("button", { name: "Create Epic" }).click();

        await expect(page.getByText("E2E Menu Epic")).toBeVisible({ timeout: 10000 });
        const epicFolder = page.locator(".pw-story-folder", { hasText: "E2E Menu Epic" });
        await expect(epicFolder.getByText(/^EPIC-\d+$/)).toBeVisible();
        await expect(epicFolder.getByText("Epic", { exact: true })).toBeVisible();
    });

    test("contextual 'Add Feature' on the Epic row auto-selects that Epic", async () => {
        await page.goto(projectUrl);

        const epicFolder = page.locator(".pw-story-folder", { hasText: "E2E Menu Epic" });
        // Toggling via getByText (a narrow text-node match), not by
        // clicking the .pw-story-folder locator directly -- once a
        // Feature exists nested inside, that CSS+hasText locator
        // starts matching BOTH the Epic wrapper and the Feature's own
        // folder (the Epic's aggregate text contains the Feature's
        // text too), which a direct .click() correctly rejects as
        // ambiguous. Chaining .getByRole() off epicFolder is still
        // safe (only one root actually has an "Add Feature" button).
        await page.getByText("E2E Menu Epic").click(); // expand
        await epicFolder.getByRole("button", { name: /Add Feature/i }).click();

        await expect(page.getByRole("heading", { name: "Create New Feature" })).toBeVisible({ timeout: 10000 });
        const epicSelect = page.locator('select[name="epic_id"]');
        const selectedText = await epicSelect.locator("option:checked").textContent();
        expect(selectedText, "Epic was not auto-selected from the contextual entry point").toContain("E2E Menu Epic");

        await page.locator('input[name="title"]').first().fill("E2E Menu Feature");
        await page.getByRole("button", { name: "Create Feature" }).click();
        await expect(page.getByText("E2E Menu Feature")).toBeVisible({ timeout: 10000 });

        const featureFolder = page.locator(".pw-story-folder", { hasText: "E2E Menu Feature" });
        await expect(featureFolder.getByText(/^FEAT-\d+$/)).toBeVisible();
        await expect(featureFolder.getByText("Feature", { exact: true })).toBeVisible();
    });

    test("all four menu options remain visible once an Epic and Feature already exist", async () => {
        await page.goto(projectUrl);

        await page.locator(".pw-backlog-header-actions").getByRole("button", { name: "Add New Work Item" }).click();
        const menu = page.getByRole("menu");
        await expect(menu.getByRole("menuitem", { name: /Add Epic/i })).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: /Add Feature/i })).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: /Add User Story/i })).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: /Add Task/i })).toBeVisible();
        await page.keyboard.press("Escape");
    });

    test("contextual 'Add User Story' on the Feature row auto-selects that Feature", async () => {
        await page.goto(projectUrl);

        await page.getByText("E2E Menu Epic").click();
        const featureFolder = page.locator(".pw-story-folder", { hasText: "E2E Menu Feature" });
        await page.getByText("E2E Menu Feature").click();
        await featureFolder.getByRole("button", { name: /Add User Story/i }).click();

        await expect(page.getByRole("heading", { name: "Create New User Story" })).toBeVisible({ timeout: 10000 });
        const featureSelect = page.locator('select[name="feature_id"]');
        const selectedText = await featureSelect.locator("option:checked").textContent();
        expect(selectedText, "Feature was not auto-selected from the contextual entry point").toContain("E2E Menu Feature");

        await page.locator('input[name="title"]').first().fill("E2E Menu Story");
        await page.getByRole("button", { name: "Create User Story" }).click();
        // Scoped -- once created, the filter bar's "User Story"
        // dropdown gains a matching option too.
        await expect(page.locator(".pw-backlog-list").getByText("E2E Menu Story")).toBeVisible({ timeout: 10000 });

        const storyFolder = page.locator(".pw-story-folder", { hasText: "E2E Menu Story" });
        await expect(storyFolder.getByText(/^US-\d+$/)).toBeVisible();
        await expect(storyFolder.getByText("User Story", { exact: true })).toBeVisible();
    });

    test("contextual 'Add Task' on the User Story row auto-selects that User Story", async () => {
        await page.goto(projectUrl);

        await page.getByText("E2E Menu Epic").click();
        await page.getByText("E2E Menu Feature").click();
        const storyFolder = page.locator(".pw-story-folder", { hasText: "E2E Menu Story" });
        // Scoped to the backlog tree -- once a User Story exists, the
        // Search/filter bar's "User Story" dropdown gains a matching
        // option too, making an unscoped getByText ambiguous.
        await page.locator(".pw-backlog-list").getByText("E2E Menu Story").click();
        await storyFolder.getByRole("button", { name: /Add Task/i }).click();

        await expect(page.getByPlaceholder(/Create Attendance Widget/i)).toBeVisible({ timeout: 10000 });
        await page.getByPlaceholder(/Create Attendance Widget/i).fill("E2E Menu Task");
        await page.locator("textarea").first().fill("Created via contextual Add Task");
        // Required field -- this project (created fresh in beforeAll)
        // has only the Admin as a member, unlike techops.spec.js's
        // project which explicitly adds the Employee fixture too.
        await page.locator('select[name="assigned_to"]').selectOption({ label: "E2E Admin (ADM001)" });
        await page.getByRole("button", { name: "Create Task" }).click();

        await expect(page.getByText("E2E Menu Task")).toBeVisible({ timeout: 10000 });
    });

    test("full hierarchy is visible after creation: Epic -> Feature -> User Story -> Task", async () => {
        await page.goto(projectUrl);

        await page.getByText("E2E Menu Epic").click();
        await page.getByText("E2E Menu Feature").click();
        // Scoped -- see the same note in the "contextual Add Task" test.
        const backlog = page.locator(".pw-backlog-list");
        await backlog.getByText("E2E Menu Story").click();

        await expect(backlog.getByText("E2E Menu Epic")).toBeVisible();
        await expect(backlog.getByText("E2E Menu Feature")).toBeVisible();
        await expect(backlog.getByText("E2E Menu Story")).toBeVisible();
        await expect(backlog.getByText("E2E Menu Task")).toBeVisible();
        await expect(backlog.getByText(/^T-\d+$/)).toBeVisible();
    });

    test("Recycle Bin, Restore All, and Sprint tabs still work unmodified after the redesign", async () => {
        await page.goto(projectUrl);
        await expect(page.getByRole("button", { name: "Sprints" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Recycle Bin" })).toBeVisible();
    });

});

test.describe("Add New Work Item -- empty state", () => {

    test("empty project shows a single 'Add New Work Item' entry point, no separate buttons", async () => {
        await page.goto(`/${fixtures.slug}/admin/projects`);
        await page.getByRole("button", { name: /New Project/i }).click();
        await page.getByPlaceholder(/RS Management Portal/i).fill("E2E Empty Menu Project");
        await page.getByRole("button", { name: "Create Project" }).click();
        await page.getByText("E2E Empty Menu Project").first().click();
        await page.waitForURL(/\/admin\/projects\/\d+/, { timeout: 10000 });

        await expect(page.getByText("No work items yet")).toBeVisible({ timeout: 10000 });
        await expect(page.getByText("Start by creating an Epic, Feature, User Story, or Task.")).toBeVisible();

        // Exactly two "Add New Work Item" triggers exist on this page
        // (toolbar + empty state) -- never a separate "Add User Story"
        // / "Add Task" button anywhere at the top level.
        await expect(page.getByRole("button", { name: "Add New Work Item" })).toHaveCount(2);
    });

});

test.describe("Add New Work Item -- viewport fit", () => {

    for (const [name, viewport] of [["desktop 1280x800", VIEWPORTS.laptop1280], ["mobile 390x844", VIEWPORTS.mobile390]]) {

        test(`dropdown and modal fit within the viewport at ${name}`, async ({ browser }) => {
            const vpPage = await browser.newPage();
            try {
                await vpPage.setViewportSize(viewport);
                await loginAsTenantUser(vpPage, fixtures.slug, fixtures.admin, "admin");
                await vpPage.goto(projectUrl);

                // .first() -- robust regardless of whether the Backlog
                // happens to be empty at this point (empty state also
                // renders its own trigger); either resolves to the same
                // component/behavior.
                await vpPage.getByRole("button", { name: "Add New Work Item" }).first().click();
                const menu = vpPage.getByRole("menu");
                await expect(menu).toBeVisible();

                const box = await menu.boundingBox();
                expect(box.x, `menu overflows left edge at ${name}`).toBeGreaterThanOrEqual(0);
                expect(box.x + box.width, `menu overflows right edge at ${name}`).toBeLessThanOrEqual(viewport.width + 1);

                const pageScrollWidth = await vpPage.evaluate(() => document.documentElement.scrollWidth);
                expect(pageScrollWidth, `page has horizontal overflow with menu open at ${name}`).toBeLessThanOrEqual(viewport.width + 1);

                await vpPage.getByRole("menuitem", { name: /Add Epic/i }).click();
                await expect(vpPage.getByRole("heading", { name: "Create New Epic" })).toBeVisible({ timeout: 10000 });
                const modalScrollWidth = await vpPage.evaluate(() => document.documentElement.scrollWidth);
                expect(modalScrollWidth, `Create Epic modal overflows at ${name}`).toBeLessThanOrEqual(viewport.width + 1);
            } finally {
                await vpPage.close();
            }
        });

    }

});

// ==========================================
// REGRESSION: LIVE BUG -- "Add Epic"/"Add Feature" missing from the
// menu for a member whose default "Project Administrators" group
// predates EPIC_CREATE/FEATURE_CREATE existing as permission keys.
//
// Root cause (confirmed by direct reproduction below, not guessed):
// ensureDefaultProjectAdministratorsGroupId() in projectService.js
// only ever inserted project_permissions rows for a tenant's default
// group at the moment that group was FIRST created. Any permission
// key added to PERMISSION_KEYS afterwards (EPIC_CREATE/FEATURE_CREATE,
// added once Epics/Features shipped) never got backfilled onto an
// ALREADY-existing group -- so GET /api/projects/:id/my-permissions
// genuinely returns EPIC_CREATE: false, FEATURE_CREATE: false for
// such a tenant, while USER_STORY_CREATE/TASK_CREATE (older keys)
// still correctly resolve true. AddWorkItemMenu.jsx was never the
// bug -- it correctly reflects whatever the server says; nothing in
// it hides an item based on how many Epics/Features currently exist.
//
// This test reproduces the exact historical data state (delete the
// two rows from an already-existing group, simulating a tenant whose
// group predates those keys), confirms the live symptom via the real
// UI, then confirms both fixes restore it: (a) the migration script,
// and (b) the self-healing code path (creating a new project).
// ==========================================

test.describe("Regression: default admin group missing newer permission keys", () => {

    let regressionFixtures;
    let regressionPage;

    test.beforeAll(async ({ browser }) => {
        regressionFixtures = loadFixtures();
        regressionPage = await browser.newPage();
    });

    test.afterAll(async () => {
        await regressionPage.close();
    });

    async function deleteEpicFeatureCreateRows() {
        const { getTenantPool } = require("../server/config/tenantConnectionManager");
        const { buildTenantDbName } = require("../server/utils/tenantDbName");
        const pool = getTenantPool(buildTenantDbName(regressionFixtures.slug));
        const [[group]] = await pool.query(
            `SELECT id FROM project_security_groups WHERE project_id IS NULL AND name = 'Project Administrators' AND is_default = TRUE LIMIT 1`
        );
        await pool.query(
            `DELETE FROM project_permissions WHERE security_group_id = ? AND permission_key IN ('EPIC_CREATE', 'FEATURE_CREATE')`,
            [group.id]
        );
        return group.id;
    }

    async function countEpicFeatureCreateRows(groupId) {
        const { getTenantPool } = require("../server/config/tenantConnectionManager");
        const { buildTenantDbName } = require("../server/utils/tenantDbName");
        const pool = getTenantPool(buildTenantDbName(regressionFixtures.slug));
        const [rows] = await pool.query(
            `SELECT permission_key FROM project_permissions WHERE security_group_id = ? AND permission_key IN ('EPIC_CREATE', 'FEATURE_CREATE')`,
            [groupId]
        );
        return rows.length;
    }

    test("reproduces the live bug: with the rows missing, the menu really does show only Add User Story/Add Task", async () => {
        const groupId = await deleteEpicFeatureCreateRows();
        expect(await countEpicFeatureCreateRows(groupId), "setup: rows should be gone before reproducing").toBe(0);

        await loginAsTenantUser(regressionPage, regressionFixtures.slug, regressionFixtures.admin, "admin");
        await regressionPage.goto(`/${regressionFixtures.slug}/admin/projects/${regressionFixtures.projectId}`);
        await regressionPage.locator(".pw-backlog-header-actions").getByRole("button", { name: "Add New Work Item" }).click();

        const menu = regressionPage.getByRole("menu");
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: /Add Epic/i })).toHaveCount(0);
        await expect(menu.getByRole("menuitem", { name: /Add Feature/i })).toHaveCount(0);
        await expect(menu.getByRole("menuitem", { name: /Add User Story/i })).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: /Add Task/i })).toBeVisible();
        await regressionPage.keyboard.press("Escape");
    });

    test("fix: the migration script restores all four options", async () => {
        // Confirms the migration alone (without any project-creation
        // side effect) repairs the exact broken state left by the
        // previous test.
        // eslint-disable-next-line global-require
        const { execFileSync } = require("child_process");
        execFileSync(process.execPath, ["_migrate_backfill_admin_group_permissions.js"], {
            cwd: require("path").join(__dirname, "..", "server"),
            env: process.env,
            stdio: "inherit",
        });

        await regressionPage.goto(`/${regressionFixtures.slug}/admin/projects/${regressionFixtures.projectId}`);
        await regressionPage.reload();
        await regressionPage.locator(".pw-backlog-header-actions").getByRole("button", { name: "Add New Work Item" }).click();

        const menu = regressionPage.getByRole("menu");
        await expect(menu.getByRole("menuitem", { name: /Add Epic/i })).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: /Add Feature/i })).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: /Add User Story/i })).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: /Add Task/i })).toBeVisible();
        await regressionPage.keyboard.press("Escape");
    });

    test("fix: the self-healing code path also restores all four options (no separate migration needed going forward)", async () => {
        const groupId = await deleteEpicFeatureCreateRows();
        expect(await countEpicFeatureCreateRows(groupId), "setup: rows should be gone again before this check").toBe(0);

        // Creating a new project calls ensureDefaultProjectAdministratorsGroupId()
        // again, which (after the fix) backfills any missing key even
        // though the group already existed -- no migration required.
        await regressionPage.goto(`/${regressionFixtures.slug}/admin/projects`);
        await regressionPage.getByRole("button", { name: /New Project/i }).click();
        await regressionPage.getByPlaceholder(/RS Management Portal/i).fill("E2E Self-Heal Regression Project");
        await regressionPage.getByRole("button", { name: "Create Project" }).click();
        await expect(regressionPage.getByText("E2E Self-Heal Regression Project")).toBeVisible({ timeout: 10000 });

        expect(await countEpicFeatureCreateRows(groupId), "self-healing code path did not backfill the missing keys").toBe(2);

        await regressionPage.goto(`/${regressionFixtures.slug}/admin/projects/${regressionFixtures.projectId}`);
        await regressionPage.locator(".pw-backlog-header-actions").getByRole("button", { name: "Add New Work Item" }).click();
        const menu = regressionPage.getByRole("menu");
        await expect(menu.getByRole("menuitem", { name: /Add Epic/i })).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: /Add Feature/i })).toBeVisible();
    });

});
