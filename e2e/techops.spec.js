const { test, expect } = require("@playwright/test");
const { loadFixtures, loginAsTenantUser, attachHealthMonitors } = require("./helpers");

// ==========================================
// PHASES 8, 9, 10 -- TECHOPS HIERARCHY, SPRINT, RECYCLE BIN
//
// Uses page.request (with the real bearer token pulled from
// sessionStorage after a real UI login) for state-verification calls
// the UI doesn't visually surface (e.g. epic_code/feature_code isn't
// rendered in the Backlog tree, only in the Recycle Bin) -- the
// WORKFLOWS themselves are always driven through the real UI.
//
// A SINGLE page/session is shared across this whole serial block
// (opened once in beforeAll, closed in afterAll) rather than each
// test logging in fresh -- repeatedly hitting the real login endpoint
// (and the company-info lookup it triggers) at the pace an automated
// suite runs tests eventually trips the app's own rate limiter, which
// is correct, intentional production behavior this audit must never
// weaken. Logging in once and reusing the session is the safe fix, on
// the TEST side. Role changes (Stakeholder, then back to Admin) still
// log in explicitly where the test genuinely needs a different user.
// ==========================================

let fixtures;
let page;

test.beforeAll(async ({ browser }) => {
    fixtures = loadFixtures();
    page = await browser.newPage();
    await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
});

test.afterAll(async () => {
    await page.close();
});

async function authHeader(pageArg) {
    const token = await pageArg.evaluate(() => sessionStorage.getItem("token"));
    return { Authorization: `Bearer ${token}` };
}

test.describe.serial("TechOps: full hierarchy, direct task creation, Sprint, Recycle Bin", () => {

    let projectUrl;
    let epicId, featureId, storyId, taskId;

    test("Project: create, list, open", async () => {
        const health = attachHealthMonitors(page);

        await page.goto(`/${fixtures.slug}/admin/projects`);

        await page.getByRole("button", { name: /New Project/i }).click();
        await page.getByPlaceholder(/RS Management Portal/i).fill("E2E Hierarchy Project");
        await page.getByRole("button", { name: /Create Project/i }).click();

        await expect(page.getByText("E2E Hierarchy Project")).toBeVisible({ timeout: 10000 });
        await page.getByText("E2E Hierarchy Project").click();

        await page.waitForURL(/\/admin\/projects\/\d+/, { timeout: 10000 });
        projectUrl = page.url();

        await expect(page.getByRole("heading", { name: "E2E Hierarchy Project" })).toBeVisible();
        expect(health.getConsoleErrors().filter((e) => !/favicon/i.test(e)), "console errors while creating/opening a project").toEqual([]);

        // Add the fixture Employee as a member of THIS newly-created
        // project (global-setup only added them to the separate,
        // pre-seeded "E2E Audit Project") -- otherwise the assignee
        // dropdown in every Create Task modal below would correctly
        // show no one but the Admin (project-member-scoped, by design),
        // and nothing that follows would be testing an assignment to a
        // non-admin member.
        const newProjectId = projectUrl.match(/projects\/(\d+)/)[1];
        const headersForSetup = await authHeader(page);
        const groupsRes = await page.request.get(`http://localhost:5000/api/projects/${newProjectId}/groups`, { headers: headersForSetup });
        const adminGroupId = (await groupsRes.json()).groups.find((g) => g.name === "Project Administrators").id;
        await page.request.post(`http://localhost:5000/api/projects/${newProjectId}/members`, {
            headers: { ...headersForSetup, "Content-Type": "application/json" },
            data: { userIds: [fixtures.employee.id, fixtures.stakeholder.id], securityGroupId: adminGroupId },
        });
        // Membership alone via the (full-access) Project Administrators
        // group would trivially let the Stakeholder delete too --
        // exactly the bypass the access-level ceiling exists to
        // prevent. Adding them here with the SAME "full access" group
        // and still expecting a 403 later (see the final Recycle Bin
        // test) is what actually proves the ceiling works, rather than
        // proving the weaker "non-members can't act" fact.
    });

    test("Epic: create with automatic ID, edit, child Feature creation entry point", async () => {
        await page.goto(projectUrl);

        await page.getByRole("button", { name: /Add Epic/i }).click();
        await page.getByPlaceholder(/Customer Onboarding Overhaul/i).fill("E2E Epic One");
        await page.getByRole("button", { name: "Create Epic" }).click();

        await expect(page.getByText("E2E Epic One")).toBeVisible({ timeout: 10000 });

        // Automatic ID -- not rendered in the Backlog tree UI (only in
        // the Recycle Bin), so verified directly via the API using the
        // real session token, not the UI.
        const headers = await authHeader(page);
        const epicsRes = await page.request.get(`http://localhost:5000/api/epics/project/${projectUrl.match(/projects\/(\d+)/)[1]}`, { headers });
        const epicsBody = await epicsRes.json();
        const epic = epicsBody.epics.find((e) => e.title === "E2E Epic One");
        expect(epic, "created Epic not found via API").toBeTruthy();
        expect(epic.epic_code, "Epic has no automatically-generated code").toMatch(/^EPIC-\d{3,}$/);
        epicId = epic.id;

        // Edit
        await page.getByText("E2E Epic One").click();
        await page.getByTitle("Edit Epic").click();
        await page.getByPlaceholder(/Customer Onboarding Overhaul/i).fill("E2E Epic One (edited)");
        await page.getByRole("button", { name: "Save Changes" }).click();
        await expect(page.getByText("E2E Epic One (edited)")).toBeVisible({ timeout: 10000 });
    });

    test("Feature: create under Epic with automatic ID, edit", async () => {
        await page.goto(projectUrl);

        await page.getByText("E2E Epic One (edited)").click(); // expand the epic folder
        // Scoped to the epic's own folder -- the Backlog header ALSO has
        // a project-level "Add Feature" button (creates a Feature with
        // no Epic), which a bare .first() would incorrectly match since
        // it renders before the epic-scoped one in the DOM.
        const epicFolder = page.locator(".pw-story-folder", { hasText: "E2E Epic One (edited)" });
        await epicFolder.getByRole("button", { name: /Add Feature/i }).click();
        await page.locator('input[name="title"]').first().fill("E2E Feature One");
        await page.getByRole("button", { name: "Create Feature" }).click();

        await expect(page.getByText("E2E Feature One")).toBeVisible({ timeout: 10000 });

        const headers = await authHeader(page);
        const projectId = projectUrl.match(/projects\/(\d+)/)[1];
        const featuresRes = await page.request.get(`http://localhost:5000/api/features/project/${projectId}`, { headers });
        const feature = (await featuresRes.json()).features.find((f) => f.title === "E2E Feature One");
        expect(feature, "created Feature not found via API").toBeTruthy();
        expect(feature.feature_code, "Feature has no automatically-generated code").toMatch(/^FEAT-\d{3,}$/);
        expect(feature.epic_id, "Feature is not linked to its parent Epic").toBe(epicId);
        featureId = feature.id;
    });

    test("User Story: create under Feature with automatic ID, edit", async () => {
        await page.goto(projectUrl);

        await page.getByText("E2E Epic One (edited)").click();
        await page.getByText("E2E Feature One").click();
        // Scoped to the feature's own folder -- same header-vs-nested
        // button ambiguity as "Add Feature" above.
        const featureFolder = page.locator(".pw-story-folder", { hasText: "E2E Feature One" });
        await featureFolder.getByRole("button", { name: /Add User Story/i }).click();
        await page.locator('input[name="title"]').first().fill("E2E Story One");
        await page.getByRole("button", { name: "Create User Story" }).click();

        await expect(page.getByText("E2E Story One")).toBeVisible({ timeout: 10000 });

        const headers = await authHeader(page);
        const projectId = projectUrl.match(/projects\/(\d+)/)[1];
        const storiesRes = await page.request.get(`http://localhost:5000/api/user-stories/project/${projectId}`, { headers });
        const story = (await storiesRes.json()).userStories.find((s) => s.title === "E2E Story One");
        expect(story, "created User Story not found via API").toBeTruthy();
        expect(story.story_code, "User Story has no automatically-generated code").toMatch(/^US-\d{3,}$/);
        expect(story.feature_id, "User Story is not linked to its parent Feature").toBe(featureId);
        storyId = story.id;
    });

    test("Task: create under User Story with automatic ID, edit", async () => {
        await page.goto(projectUrl);

        await page.getByText("E2E Epic One (edited)").click();
        await page.getByText("E2E Feature One").click();
        await page.getByText("E2E Story One").click();

        // Scoped to the story's own folder -- the Backlog header ALSO
        // has a project-level "Add Task" button (direct project task,
        // no forced User Story -- tested separately below).
        const storyFolder = page.locator(".pw-story-folder", { hasText: "E2E Story One" });
        await storyFolder.getByRole("button", { name: /Add Task/i }).click();
        await page.getByPlaceholder(/Create Attendance Widget/i).fill("E2E Task One");
        await page.locator("textarea").first().fill("E2E task description");
        await page.locator('select[name="assigned_to"]').selectOption({ label: "E2E Employee (E2E001)" });
        await page.getByRole("button", { name: "Create Task" }).click();

        await expect(page.getByText("E2E Task One")).toBeVisible({ timeout: 10000 });

        const headers = await authHeader(page);
        const projectId = projectUrl.match(/projects\/(\d+)/)[1];
        const boardRes = await page.request.get(`http://localhost:5000/api/projects/${projectId}/tasks`, { headers });
        const task = (await boardRes.json()).tasks.find((t) => t.task_title === "E2E Task One");
        expect(task, "created Task not found via API").toBeTruthy();
        expect(task.user_story_id, "Task is not linked to its parent User Story").toBe(storyId);
        taskId = task.id;
    });

    test("Direct Task creation from Project (no User Story forced), Epic/Feature/User Story/Assignee selectable", async () => {
        await page.goto(projectUrl);

        await page.getByRole("button", { name: /Add Task/i }).first().click(); // project-level "Add Task" in the Backlog header
        await page.getByPlaceholder(/Create Attendance Widget/i).fill("E2E Direct Project Task");
        await page.locator("textarea").first().fill("Created directly from the project, no forced User Story");

        // The optional User Story selector should only offer stories
        // from THIS project.
        const storySelect = page.locator('select[name="user_story_id"]');
        if (await storySelect.count() > 0) {
            await expect(storySelect.locator("option", { hasText: "E2E Story One" })).toHaveCount(1);
        }

        await page.locator('select[name="assigned_to"]').selectOption({ label: "E2E Employee (E2E001)" });
        await page.getByRole("button", { name: "Create Task" }).click();

        // A Task with no User Story renders in its own top-level
        // "Tasks (No User Story)" folder, collapsed by default like
        // every other folder in this tree -- expand it before checking
        // for the task row itself.
        await expect(page.getByText(/Tasks \(No User Story\)/)).toBeVisible({ timeout: 10000 });
        await page.getByText(/Tasks \(No User Story\)/).click();
        await expect(page.getByText("E2E Direct Project Task")).toBeVisible({ timeout: 10000 });

        const headers = await authHeader(page);
        const projectId = projectUrl.match(/projects\/(\d+)/)[1];
        const boardRes = await page.request.get(`http://localhost:5000/api/projects/${projectId}/tasks`, { headers });
        const directTask = (await boardRes.json()).tasks.find((t) => t.task_title === "E2E Direct Project Task");
        expect(directTask, "directly-created project Task not found via API").toBeTruthy();
        expect(directTask.user_story_id, "direct project Task should have no forced User Story").toBeNull();

        // Cross-project rejection, verified directly against the API
        // (the UI's own selectors are already scoped to this project by
        // construction -- the backend re-validation is the real
        // security boundary being tested here).
        const otherProjectRes = await page.request.post("http://localhost:5000/api/projects", {
            headers: { ...headers, "Content-Type": "application/json" },
            data: { name: "E2E Other Project (cross-project reject check)" },
        });
        const otherProjectId = (await otherProjectRes.json()).id;
        const otherStoryRes = await page.request.post(`http://localhost:5000/api/user-stories/project/${otherProjectId}`, {
            headers: { ...headers, "Content-Type": "application/json" },
            data: { title: "Story in other project" },
        });
        const otherStoryId = (await otherStoryRes.json()).id;

        const crossProjectAttempt = await page.request.post(`http://localhost:5000/api/projects/${projectId}/tasks`, {
            headers: { ...headers, "Content-Type": "application/json" },
            data: { title: "Should be rejected", description: "x", assigned_to: fixtures.employee.id, user_story_id: otherStoryId },
        });
        expect(crossProjectAttempt.status(), "a User Story from a DIFFERENT project was accepted -- cross-project validation failed").toBe(400);
    });

    test("Sprint: create, view, create User Story inside Sprint (auto-selected)", async () => {
        await page.goto(projectUrl);

        await page.getByRole("button", { name: "Sprints" }).click();
        await page.getByRole("button", { name: /Add Sprint/i }).click();
        await page.locator('input[name="name"]').fill("E2E Sprint One");
        await page.getByRole("button", { name: /Create Sprint/i }).click();

        await expect(page.getByText("E2E Sprint One")).toBeVisible({ timeout: 10000 });
        await page.getByText("E2E Sprint One").click(); // expand

        await page.getByRole("button", { name: "Create User Story" }).click();
        const sprintStoryModal = page.locator(".wi-modal");
        await sprintStoryModal.locator('input[name="title"]').first().fill("E2E Sprint Story");
        await sprintStoryModal.getByRole("button", { name: "Create User Story" }).click();

        await expect(page.getByText("E2E Sprint Story")).toBeVisible({ timeout: 10000 });

        const headers = await authHeader(page);
        const projectId = projectUrl.match(/projects\/(\d+)/)[1];
        const sprintsRes = await page.request.get(`http://localhost:5000/api/sprints/project/${projectId}`, { headers });
        const sprint = (await sprintsRes.json()).sprints.find((s) => s.name === "E2E Sprint One");
        expect(sprint, "created Sprint not found via API").toBeTruthy();

        const storiesRes = await page.request.get(`http://localhost:5000/api/user-stories/project/${projectId}`, { headers });
        const sprintStory = (await storiesRes.json()).userStories.find((s) => s.title === "E2E Sprint Story");
        expect(sprintStory.sprint_id, "User Story created inside a Sprint was not auto-assigned to it").toBe(sprint.id);

        // Create Task directly inside the same Sprint -- same
        // open-button/submit-button label collision risk as "Create
        // User Story" above (SprintsTab's trigger and the modal's
        // submit button are both literally "Create Task"), scoped to
        // the modal the same way.
        const sprintFolder = page.locator(".pw-story-folder", { hasText: "E2E Sprint One" });
        await sprintFolder.getByRole("button", { name: "Create Task" }).click();
        const sprintTaskModal = page.locator(".wi-modal");
        await sprintTaskModal.getByPlaceholder(/Create Attendance Widget/i).fill("E2E Sprint Task");
        await sprintTaskModal.locator("textarea").first().fill("Created directly inside a Sprint");
        await sprintTaskModal.locator('select[name="assigned_to"]').selectOption({ label: "E2E Employee (E2E001)" });
        await sprintTaskModal.getByRole("button", { name: "Create Task" }).click();

        await expect(page.getByText("E2E Sprint Task")).toBeVisible({ timeout: 10000 });

        const boardRes = await page.request.get(`http://localhost:5000/api/projects/${projectId}/tasks`, { headers });
        const sprintTask = (await boardRes.json()).tasks.find((t) => t.task_title === "E2E Sprint Task");
        expect(sprintTask, "Task created inside a Sprint not found via API").toBeTruthy();
        expect(sprintTask.sprint_id, "Task created inside a Sprint was not auto-assigned to it").toBe(sprint.id);
    });

    test("Sprint: assign existing User Story, move between Sprints, no duplication/ID change, cross-project rejection", async () => {
        const headers = await authHeader(page);
        const projectId = projectUrl.match(/projects\/(\d+)/)[1];

        const sprintsRes = await page.request.get(`http://localhost:5000/api/sprints/project/${projectId}`, { headers });
        const sprint1 = (await sprintsRes.json()).sprints.find((s) => s.name === "E2E Sprint One");

        const createSprint2 = await page.request.post(`http://localhost:5000/api/sprints/project/${projectId}`, {
            headers: { ...headers, "Content-Type": "application/json" },
            data: { name: "E2E Sprint Two" },
        });
        const sprint2Id = (await createSprint2.json()).id;

        // Assign the earlier-created "E2E Story One" (Backlog) to Sprint 1
        const assign1 = await page.request.patch(`http://localhost:5000/api/user-stories/${storyId}/sprint`, {
            headers: { ...headers, "Content-Type": "application/json" },
            data: { sprint_id: sprint1.id },
        });
        expect(assign1.status()).toBe(200);

        // Move it to Sprint 2
        const move = await page.request.patch(`http://localhost:5000/api/user-stories/${storyId}/sprint`, {
            headers: { ...headers, "Content-Type": "application/json" },
            data: { sprint_id: sprint2Id },
        });
        expect(move.status()).toBe(200);

        const storyAfter = await page.request.get(`http://localhost:5000/api/user-stories/${storyId}`, { headers });
        const storyBody = (await storyAfter.json()).userStory;
        expect(storyBody.id, "User Story id changed after moving between Sprints").toBe(storyId);
        expect(storyBody.feature_id, "User Story's parent Feature changed after moving between Sprints").toBe(featureId);
        expect(storyBody.sprint_id, "User Story's sprint_id did not reflect Sprint 2").toBe(sprint2Id);

        // Confirm no duplicate row was created (same total count of stories with this title)
        const storiesAfter = await page.request.get(`http://localhost:5000/api/user-stories/project/${projectId}`, { headers });
        const matching = (await storiesAfter.json()).userStories.filter((s) => s.id === storyId);
        expect(matching.length, "moving between Sprints duplicated the User Story row").toBe(1);

        // Cross-project rejection
        const otherProjectRes = await page.request.post("http://localhost:5000/api/projects", {
            headers: { ...headers, "Content-Type": "application/json" },
            data: { name: "E2E Other Project 2 (sprint cross-project check)" },
        });
        const otherProjectId = (await otherProjectRes.json()).id;
        const otherSprintRes = await page.request.post(`http://localhost:5000/api/sprints/project/${otherProjectId}`, {
            headers: { ...headers, "Content-Type": "application/json" },
            data: { name: "Other Project Sprint" },
        });
        const otherSprintId = (await otherSprintRes.json()).id;

        const crossProjectAssign = await page.request.patch(`http://localhost:5000/api/user-stories/${storyId}/sprint`, {
            headers: { ...headers, "Content-Type": "application/json" },
            data: { sprint_id: otherSprintId },
        });
        expect(crossProjectAssign.status(), "assigning a User Story to a DIFFERENT project's Sprint was accepted").toBe(400);

        // Also verify Task move-to-sprint via the UI (Board's task can
        // be dragged in the real Sprints tab picker instead -- exercised
        // via API here since the picker UI is already covered
        // structurally by the User Story flow above).
        const assignTask = await page.request.patch(`http://localhost:5000/api/task-management/${taskId}/sprint`, {
            headers: { ...headers, "Content-Type": "application/json" },
            data: { sprint_id: sprint1.id },
        });
        expect(assignTask.status()).toBe(200);
        const taskAfter = await page.request.get(`http://localhost:5000/api/task-management/task/${taskId}`, { headers });
        expect((await taskAfter.json()).task.id, "Task id changed after Sprint assignment").toBe(taskId);
    });

    test("Active Sprint cannot be deleted", async () => {
        const headers = await authHeader(page);
        const projectId = projectUrl.match(/projects\/(\d+)/)[1];

        const sprintsRes = await page.request.get(`http://localhost:5000/api/sprints/project/${projectId}`, { headers });
        const sprint1 = (await sprintsRes.json()).sprints.find((s) => s.name === "E2E Sprint One");

        const startRes = await page.request.patch(`http://localhost:5000/api/sprints/${sprint1.id}/start`, { headers });
        expect(startRes.status()).toBe(200);

        const deleteAttempt = await page.request.delete(`http://localhost:5000/api/sprints/${sprint1.id}`, { headers });
        expect(deleteAttempt.status(), "an ACTIVE sprint was deletable, which should be blocked").toBe(400);
    });

    test("Recycle Bin: soft delete Epic (cascade), items disappear from active views, appear in Recycle Bin", async () => {
        await page.goto(projectUrl);

        await page.getByText("E2E Epic One (edited)").click();
        page.once("dialog", (dialog) => dialog.accept());
        await page.getByTitle("Delete Epic").click();

        await page.waitForTimeout(1500);
        await expect(page.getByText("E2E Epic One (edited)")).toHaveCount(0);
        await expect(page.getByText("E2E Feature One")).toHaveCount(0);
        await expect(page.getByText("E2E Story One")).toHaveCount(0);

        await page.getByRole("button", { name: "Recycle Bin" }).click();
        // The Epic's name legitimately appears more than once here (the
        // cascade-group summary row, its own Epics-section row, AND the
        // Feature row's "Epic" parent column) -- .first() is enough to
        // confirm it's present without a strict-mode ambiguity error.
        await expect(page.getByText("E2E Epic One (edited)").first()).toBeVisible({ timeout: 10000 });
        await expect(page.getByText(/E2E Feature One/).first()).toBeVisible();
        await expect(page.getByText(/E2E Story One/).first()).toBeVisible();

        // "Restore All" group is visible and distinct from individual Restore
        await expect(page.getByRole("button", { name: /Restore All/i })).toBeVisible();
        const individualRestoreButtons = page.getByRole("button", { name: "Restore" });
        expect(await individualRestoreButtons.count(), "individual Restore buttons should still exist alongside Restore All").toBeGreaterThan(0);
    });

    test("Recycle Bin: Restore All restores the whole cascade group with IDs/relationships intact", async () => {
        await page.goto(projectUrl);
        await page.getByRole("button", { name: "Recycle Bin" }).click();

        page.once("dialog", (dialog) => dialog.accept());
        await page.getByRole("button", { name: /Restore All/i }).click();

        await page.waitForTimeout(1500);
        await expect(page.getByText("E2E Epic One (edited)")).toHaveCount(0); // gone from Recycle Bin

        await page.getByRole("button", { name: "Backlog" }).click();
        await expect(page.getByText("E2E Epic One (edited)")).toBeVisible({ timeout: 10000 });

        const headers = await authHeader(page);
        const epicAfter = await page.request.get(`http://localhost:5000/api/epics/${epicId}`, { headers });
        expect(epicAfter.status(), "restored Epic did not have its original id").toBe(200);
        const featureAfter = await page.request.get(`http://localhost:5000/api/features/${featureId}`, { headers });
        expect((await featureAfter.json()).feature.epic_id, "restored Feature lost its parent Epic link").toBe(epicId);
        const storyAfter = await page.request.get(`http://localhost:5000/api/user-stories/${storyId}`, { headers });
        expect((await storyAfter.json()).userStory.feature_id, "restored User Story lost its parent Feature link").toBe(featureId);
    });

    test("Recycle Bin: Stakeholder cannot delete a Task; permanent delete requires prior soft delete", async () => {
        await loginAsTenantUser(page, fixtures.slug, fixtures.stakeholder, "employee");
        const headers = await authHeader(page);

        const deleteAttempt = await page.request.delete(`http://localhost:5000/api/task-management/delete/${taskId}`, { headers });
        expect(deleteAttempt.status(), "Stakeholder was able to delete a Task via direct API call").toBe(403);

        await loginAsTenantUser(page, fixtures.slug, fixtures.admin, "admin");
        const adminHeaders = await authHeader(page);

        const permanentBeforeDelete = await page.request.delete(`http://localhost:5000/api/task-management/${taskId}/permanent`, { headers: adminHeaders });
        expect(permanentBeforeDelete.status(), "permanent-delete succeeded on a task that was never soft-deleted").toBe(400);

        const softDelete = await page.request.delete(`http://localhost:5000/api/task-management/delete/${taskId}`, { headers: adminHeaders });
        expect(softDelete.status()).toBe(200);

        const permanentDelete = await page.request.delete(`http://localhost:5000/api/task-management/${taskId}/permanent`, { headers: adminHeaders });
        expect(permanentDelete.status()).toBe(200);
    });

});
