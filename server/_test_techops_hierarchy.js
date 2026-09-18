require("dotenv").config();
const bcrypt = require("bcrypt");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { buildTenantDbName } = require("./utils/tenantDbName");

// ==========================================
// TECHOPS HIERARCHY ENHANCEMENT -- SELF-TEST
//
// Real HTTP against the live backend on http://localhost:5000, using
// two throwaway tenants provisioned through the real platform APIs
// (same convention as _test_sop_library.js). Never touches
// reinsteins_workhub or any real tenant. Drops everything it creates
// at the end.
//
// Covers: work-item code generation (concurrency-safe, no
// duplicates), cross-project hierarchy validation (Task/Sprint/User
// Story parent chains), Project-level Task creation, Sprint-level
// User Story/Task creation, Sprint<->User Story/Task assignment and
// movement (no duplication, cross-project rejection), permissions
// (Basic can delete all 4 types, Stakeholder cannot, API cannot be
// bypassed by manipulating the frontend), Recycle Bin (soft delete,
// disappearance from active views, restore preserves hierarchy,
// permanent delete, tenant isolation).
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "techopstest_owner@groworgs.internal";
const OWNER_PASSWORD = "TechOpsTestOwner!2026Pwd";

const A_SLUG = "techopstest_a";
const B_SLUG = "techopstest_b";
const A_DB = buildTenantDbName(A_SLUG);
const B_DB = buildTenantDbName(B_SLUG);

let failures = 0;
function check(label, condition, detail) {
    if (condition) console.log(`  [PASS] ${label}`);
    else { failures++; console.log(`  [FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

async function apiPost(pathname, body, token) {
    const res = await fetch(`${BASE_URL}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

async function apiGet(pathname, token) {
    const res = await fetch(`${BASE_URL}${pathname}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

async function apiPut(pathname, body, token) {
    const res = await fetch(`${BASE_URL}${pathname}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

async function apiPatch(pathname, body, token) {
    const res = await fetch(`${BASE_URL}${pathname}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body || {}),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

async function apiDelete(pathname, token) {
    const res = await fetch(`${BASE_URL}${pathname}`, { method: "DELETE", headers: token ? { Authorization: `Bearer ${token}` } : {} });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

(async () => {

    // ---------- Setup ----------
    console.log("SETUP -- platform owner + two tenants + project fixtures");

    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "TechOps Test Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });

    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: platform owner login succeeded", loginRes.status === 200 && !!ownerToken);

    const createA = await apiPost("/api/platform/companies", { companyName: "TechOps Test A", companySlug: A_SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: company A created", createA.status === 201);
    const companyAId = createA.body?.company?.id;

    const createB = await apiPost("/api/platform/companies", { companyName: "TechOps Test B", companySlug: B_SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: company B created", createB.status === 201);
    const companyBId = createB.body?.company?.id;

    const adminACreate = await apiPost(`/api/platform/companies/${companyAId}/admin`, { name: "Admin A", email: "admin@techopstest-a.test", password: "AdminPass123!TA_a" }, ownerToken);
    const adminAEmployeeId = adminACreate.body?.admin?.employeeId;
    const loginAdminA = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: adminAEmployeeId, password: "AdminPass123!TA_a" });
    const tokenAdminA = loginAdminA.body?.token;
    check("SETUP: admin A login succeeded", loginAdminA.status === 200 && !!tokenAdminA);

    const adminBCreate = await apiPost(`/api/platform/companies/${companyBId}/admin`, { name: "Admin B", email: "admin@techopstest-b.test", password: "AdminPass123!TA_b" }, ownerToken);
    const adminBEmployeeId = adminBCreate.body?.admin?.employeeId;
    const loginAdminB = await apiPost(`/api/tenant-auth/${B_SLUG}/login`, { employeeId: adminBEmployeeId, password: "AdminPass123!TA_b" });
    const tokenAdminB = loginAdminB.body?.token;
    check("SETUP: admin B login succeeded", loginAdminB.status === 200 && !!tokenAdminB);

    const poolA = getTenantPool(A_DB);
    const employeePasswordHash = await bcrypt.hash("Employee123!TechOps", 10);

    // designation="Manager" is in projectAccessService.js's
    // DEFAULT_PROJECT_ACCESS_DESIGNATIONS -- required for these fixture
    // users to pass the pre-existing, unrelated requireProjectAccess
    // MODULE gate (separate from per-project membership/permission,
    // which is what this test suite actually exercises).
    async function seedUser(pool, employeeId, fullName, emailDomain, projectAccessLevel) {
        const [result] = await pool.query(
            `INSERT INTO users (employee_id, full_name, email, password, role, system_access, employment_type, employment_status, status, designation, project_access_level)
             VALUES (?, ?, ?, ?, 'employee', 'employee', 'employee', 'active', 'active', ?, ?) RETURNING id`,
            [employeeId, fullName, `${employeeId.toLowerCase()}@${emailDomain}`, employeePasswordHash, "Manager", projectAccessLevel]
        );
        return result[0].id;
    }

    // Basic-tier and Stakeholder-tier employees for the permission tests below.
    const basicUserId = await seedUser(poolA, "TOB001", "Basic User", "techopstest-a.test", "basic");
    const stakeholderUserId = await seedUser(poolA, "TOB002", "Stakeholder User", "techopstest-a.test", "stakeholder");

    async function loginEmployee(slug, employeeId) {
        const res = await apiPost(`/api/tenant-auth/${slug}/login`, { employeeId, password: "Employee123!TechOps" });
        return res.body?.token;
    }

    const tokenBasic = await loginEmployee(A_SLUG, "TOB001");
    const tokenStakeholder = await loginEmployee(A_SLUG, "TOB002");
    check("SETUP: basic-tier employee login succeeded", !!tokenBasic);
    check("SETUP: stakeholder-tier employee login succeeded", !!tokenStakeholder);

    // ---------- Project + hierarchy fixtures (tenant A) ----------

    const createProjectA = await apiPost("/api/projects", { name: "TechOps Test Project A", description: "Fixture" }, tokenAdminA);
    const projectAId = createProjectA.body?.id;
    check("SETUP: project A created", createProjectA.status === 201 && !!projectAId);

    const createProjectA2 = await apiPost("/api/projects", { name: "TechOps Test Project A2", description: "Cross-project fixture" }, tokenAdminA);
    const projectA2Id = createProjectA2.body?.id;
    check("SETUP: second project (A2, same tenant) created", createProjectA2.status === 201 && !!projectA2Id);

    // Add Basic/Stakeholder as members of Project A -- Project Administrators
    // group is auto-seeded and would grant full permissions, so both are
    // added to a NEW custom security group instead, to control exactly what
    // each has (see PERMISSIONS section below).
    const groupsRes = await apiGet(`/api/projects/${projectAId}/groups`, tokenAdminA);
    const adminGroupId = groupsRes.body?.groups?.find((g) => g.name === "Project Administrators")?.id;
    check("SETUP: default Project Administrators group found", !!adminGroupId);

    await apiPost(`/api/projects/${projectAId}/members`, { userIds: [basicUserId, stakeholderUserId], securityGroupId: adminGroupId }, tokenAdminA);

    // ==========================================
    // 1. ID GENERATION -- EPIC/FEATURE/USER STORY codes
    // ==========================================
    console.log("\n1. ID GENERATION");

    const createEpic1 = await apiPost(`/api/epics/project/${projectAId}`, { title: "Epic One" }, tokenAdminA);
    const epic1Id = createEpic1.body?.id;
    check("epic 1 created", createEpic1.status === 201 && !!epic1Id);

    const createEpic2 = await apiPost(`/api/epics/project/${projectAId}`, { title: "Epic Two" }, tokenAdminA);
    const epic2Id = createEpic2.body?.id;
    check("epic 2 created", createEpic2.status === 201 && !!epic2Id);

    const epicsList = await apiGet(`/api/epics/project/${projectAId}`, tokenAdminA);
    const epic1 = epicsList.body?.epics?.find((e) => e.id === epic1Id);
    const epic2 = epicsList.body?.epics?.find((e) => e.id === epic2Id);

    check("epic 1 has a code matching EPIC-XXX", /^EPIC-\d{3,}$/.test(epic1?.epic_code || ""), epic1?.epic_code);
    check("epic 2 has a DIFFERENT code from epic 1", epic2?.epic_code && epic2.epic_code !== epic1?.epic_code);

    const createFeature1 = await apiPost(`/api/features/project/${projectAId}`, { title: "Feature One", epic_id: epic1Id }, tokenAdminA);
    const feature1Id = createFeature1.body?.id;
    check("feature 1 created under epic 1", createFeature1.status === 201 && !!feature1Id);

    const featuresList = await apiGet(`/api/features/project/${projectAId}`, tokenAdminA);
    const feature1 = featuresList.body?.features?.find((f) => f.id === feature1Id);
    check("feature 1 has a code matching FEAT-XXX", /^FEAT-\d{3,}$/.test(feature1?.feature_code || ""), feature1?.feature_code);

    const createStory1 = await apiPost(`/api/user-stories/project/${projectAId}`, { title: "Story One", feature_id: feature1Id }, tokenAdminA);
    const story1Id = createStory1.body?.id;
    check("story 1 created under feature 1", createStory1.status === 201 && !!story1Id);

    const storiesList = await apiGet(`/api/user-stories/project/${projectAId}`, tokenAdminA);
    const story1 = storiesList.body?.userStories?.find((s) => s.id === story1Id);
    check("story 1 has a code matching US-XXX", /^US-\d{3,}$/.test(story1?.story_code || ""), story1?.story_code);

    // Concurrency: fire 5 concurrent Epic creates and confirm 5 distinct codes.
    const concurrentCreates = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
            apiPost(`/api/epics/project/${projectAId}`, { title: `Concurrent Epic ${i}` }, tokenAdminA)
        )
    );
    const allSucceeded = concurrentCreates.every((r) => r.status === 201);
    check("5 concurrent epic creates all succeeded", allSucceeded, JSON.stringify(concurrentCreates.map((r) => r.status)));

    const epicsAfterConcurrent = await apiGet(`/api/epics/project/${projectAId}`, tokenAdminA);
    const allCodes = (epicsAfterConcurrent.body?.epics || []).map((e) => e.epic_code);
    const uniqueCodes = new Set(allCodes);
    check("no duplicate epic codes after concurrent creation", uniqueCodes.size === allCodes.length, `codes=${allCodes.length} unique=${uniqueCodes.size}`);

    // ==========================================
    // 2. CROSS-PROJECT HIERARCHY VALIDATION
    // ==========================================
    console.log("\n2. CROSS-PROJECT HIERARCHY VALIDATION");

    // Epic from Project A2 must be rejected as a parent for a Feature in Project A.
    const createEpicA2 = await apiPost(`/api/epics/project/${projectA2Id}`, { title: "Epic in A2" }, tokenAdminA);
    const epicA2Id = createEpicA2.body?.id;

    const crossProjectFeature = await apiPost(`/api/features/project/${projectAId}`, { title: "Bad Feature", epic_id: epicA2Id }, tokenAdminA);
    check("Feature creation rejects an Epic from a different project", crossProjectFeature.status === 400);

    // Task's user_story_id must be validated against the SAME project too
    // (the one gap identified during investigation -- now closed).
    const createStoryA2 = await apiPost(`/api/user-stories/project/${projectA2Id}`, { title: "Story in A2" }, tokenAdminA);
    const storyA2Id = createStoryA2.body?.id;

    const employeesA = await apiGet(`/api/task-management/employees?project_id=${projectAId}`, tokenAdminA);
    const assigneeA = employeesA.body?.employees?.[0]?.id;

    const crossProjectTask = await apiPost(`/api/projects/${projectAId}/tasks`, {
        title: "Bad Task", description: "Should be rejected", assigned_to: assigneeA, user_story_id: storyA2Id
    }, tokenAdminA);
    check("Project-level Task creation rejects a User Story from a different project", crossProjectTask.status === 400);

    // ==========================================
    // 3. PROJECT-LEVEL TASK CREATION (no User Story required)
    // ==========================================
    console.log("\n3. PROJECT-LEVEL TASK CREATION");

    const projectTaskNoStory = await apiPost(`/api/projects/${projectAId}/tasks`, {
        title: "Task directly under project", description: "No user story", assigned_to: assigneeA
    }, tokenAdminA);
    check("Task created directly under Project with no User Story", projectTaskNoStory.status === 201);

    const projectTaskWithStory = await apiPost(`/api/projects/${projectAId}/tasks`, {
        title: "Task directly under project, linked to a story", description: "Has user story", assigned_to: assigneeA, user_story_id: story1Id
    }, tokenAdminA);
    check("Task created directly under Project WITH a valid same-project User Story", projectTaskWithStory.status === 201);
    const linkedTaskId = projectTaskWithStory.body?.id;

    // ==========================================
    // 4. SPRINT-LEVEL USER STORY / TASK CREATION
    // ==========================================
    console.log("\n4. SPRINT-LEVEL CREATION");

    const createSprintA = await apiPost(`/api/sprints/project/${projectAId}`, { name: "Sprint 1" }, tokenAdminA);
    const sprintAId = createSprintA.body?.id;
    check("sprint created", createSprintA.status === 201 && !!sprintAId);

    const sprintStory = await apiPost(`/api/sprints/${sprintAId}/user-stories`, { title: "Story created directly in Sprint" }, tokenAdminA);
    const sprintStoryId = sprintStory.body?.id;
    check("User story created directly in a Sprint", sprintStory.status === 201 && !!sprintStoryId);

    const storiesAfterSprintCreate = await apiGet(`/api/user-stories/project/${projectAId}`, tokenAdminA);
    const sprintStoryRow = storiesAfterSprintCreate.body?.userStories?.find((s) => s.id === sprintStoryId);
    check("Story created in Sprint is auto-assigned to that Sprint", Number(sprintStoryRow?.sprint_id) === Number(sprintAId));

    const sprintTask = await apiPost(`/api/sprints/${sprintAId}/tasks`, { title: "Task created directly in Sprint", description: "x", assigned_to: assigneeA }, tokenAdminA);
    const sprintTaskId = sprintTask.body?.id;
    check("Task created directly in a Sprint", sprintTask.status === 201 && !!sprintTaskId);

    const sprintDetail = await apiGet(`/api/sprints/${sprintAId}`, tokenAdminA);
    const taskInSprint = sprintDetail.body?.sprint?.tasks?.find((t) => t.id === sprintTaskId);
    check("Task created in Sprint is auto-assigned to that Sprint", !!taskInSprint);

    // ==========================================
    // 5. SPRINT ASSIGNMENT / MOVEMENT (no duplication, cross-project rejection)
    // ==========================================
    console.log("\n5. SPRINT ASSIGNMENT / MOVEMENT");

    const createSprintA2nd = await apiPost(`/api/sprints/project/${projectAId}`, { name: "Sprint 2" }, tokenAdminA);
    const sprintA2ndId = createSprintA2nd.body?.id;

    // User Story: assign to sprint, move to another sprint, remove to backlog.
    const assignStoryToSprint = await apiPatch(`/api/user-stories/${story1Id}/sprint`, { sprint_id: sprintAId }, tokenAdminA);
    check("User Story assigned to Sprint 1", assignStoryToSprint.status === 200);

    const moveStoryToSprint2 = await apiPatch(`/api/user-stories/${story1Id}/sprint`, { sprint_id: sprintA2ndId }, tokenAdminA);
    check("User Story moved from Sprint 1 to Sprint 2", moveStoryToSprint2.status === 200);

    const storyAfterMove = await apiGet(`/api/user-stories/${story1Id}`, tokenAdminA);
    check("Moved User Story still has the SAME id/code (no duplication)", storyAfterMove.body?.userStory?.id === story1Id);
    check("Moved User Story's sprint_id reflects Sprint 2", Number(storyAfterMove.body?.userStory?.sprint_id) === Number(sprintA2ndId));

    const removeStoryFromSprint = await apiPatch(`/api/user-stories/${story1Id}/sprint`, { sprint_id: null }, tokenAdminA);
    check("User Story removed from Sprint back to Backlog", removeStoryFromSprint.status === 200);

    // Cross-project rejection: a Project A2 sprint cannot take a Project A story.
    const createSprintA2Proj = await apiPost(`/api/sprints/project/${projectA2Id}`, { name: "A2 Sprint" }, tokenAdminA);
    const sprintOnA2Id = createSprintA2Proj.body?.id;

    const crossProjectAssign = await apiPatch(`/api/user-stories/${story1Id}/sprint`, { sprint_id: sprintOnA2Id }, tokenAdminA);
    check("Assigning a User Story to a DIFFERENT project's Sprint is rejected", crossProjectAssign.status === 400);

    // Task: same coverage (pre-existing endpoint, verified still works under the new schema).
    const assignTaskToSprintRes = await apiPatch(`/api/task-management/${linkedTaskId}/sprint`, { sprint_id: sprintAId }, tokenAdminA);
    check("Task assigned to Sprint 1", assignTaskToSprintRes.status === 200);

    const crossProjectTaskAssign = await apiPatch(`/api/task-management/${linkedTaskId}/sprint`, { sprint_id: sprintOnA2Id }, tokenAdminA);
    check("Assigning a Task to a DIFFERENT project's Sprint is rejected", crossProjectTaskAssign.status === 400);

    // ==========================================
    // 6. PERMISSIONS -- Basic can delete all 4 types (when granted via
    // their security group), Stakeholder never can (ceiling-enforced),
    // and the API rejects a Stakeholder's delete attempt even with a
    // crafted direct request (not just a hidden frontend button).
    // ==========================================
    console.log("\n6. PERMISSIONS");

    const deleteEpicAsBasic = await apiDelete(`/api/epics/${epic2Id}`, tokenBasic);
    check("Basic-tier member (Project Administrators group) CAN delete an Epic", deleteEpicAsBasic.status === 200, JSON.stringify(deleteEpicAsBasic.body));

    const deleteFeatureAsStakeholder = await apiDelete(`/api/features/${feature1Id}`, tokenStakeholder);
    check("Stakeholder-tier member is REJECTED deleting a Feature, regardless of security group", deleteFeatureAsStakeholder.status === 403, JSON.stringify(deleteFeatureAsStakeholder.body));

    const deleteStoryAsStakeholder = await apiDelete(`/api/user-stories/${sprintStoryId}`, tokenStakeholder);
    check("Stakeholder-tier member is REJECTED deleting a User Story", deleteStoryAsStakeholder.status === 403);

    const deleteTaskAsStakeholder = await apiDelete(`/api/task-management/delete/${sprintTaskId}`, tokenStakeholder);
    check("Stakeholder-tier member is REJECTED deleting a Task", deleteTaskAsStakeholder.status === 403);

    const deleteStoryAsBasic = await apiDelete(`/api/user-stories/${sprintStoryId}`, tokenBasic);
    check("Basic-tier member CAN delete a User Story", deleteStoryAsBasic.status === 200);

    const deleteTaskAsBasic = await apiDelete(`/api/task-management/delete/${sprintTaskId}`, tokenBasic);
    check("Basic-tier member CAN delete a Task", deleteTaskAsBasic.status === 200);

    // ==========================================
    // 7. RECYCLE BIN -- soft delete, disappearance from active views,
    // restore (id/parent/sprint preserved), permanent delete, tenant
    // isolation.
    // ==========================================
    console.log("\n7. RECYCLE BIN");

    const epicsAfterDelete = await apiGet(`/api/epics/project/${projectAId}`, tokenAdminA);
    check("Deleted Epic no longer appears in the active Epics list", !epicsAfterDelete.body?.epics?.some((e) => e.id === epic2Id));

    const storiesAfterDelete = await apiGet(`/api/user-stories/project/${projectAId}`, tokenAdminA);
    check("Deleted User Story no longer appears in the active Backlog", !storiesAfterDelete.body?.userStories?.some((s) => s.id === sprintStoryId));

    const boardAfterDelete = await apiGet(`/api/projects/${projectAId}/tasks`, tokenAdminA);
    check("Deleted Task no longer appears on the Board", !boardAfterDelete.body?.tasks?.some((t) => t.id === sprintTaskId));

    const recycleBinA = await apiGet(`/api/projects/${projectAId}/recycle-bin`, tokenAdminA);
    check("Recycle Bin lists the deleted Epic", recycleBinA.body?.epics?.some((e) => e.id === epic2Id));
    check("Recycle Bin lists the deleted User Story", recycleBinA.body?.userStories?.some((s) => s.id === sprintStoryId));
    check("Recycle Bin lists the deleted Task", recycleBinA.body?.tasks?.some((t) => t.id === sprintTaskId));

    // Restore: id/code/parent must be preserved exactly.
    const restoreStory = await apiPatch(`/api/user-stories/${sprintStoryId}/restore`, null, tokenAdminA);
    check("User Story restore succeeded", restoreStory.status === 200);

    const storyAfterRestore = await apiGet(`/api/user-stories/${sprintStoryId}`, tokenAdminA);
    check("Restored User Story keeps its original id", storyAfterRestore.body?.userStory?.id === sprintStoryId);
    check("Restored User Story is back in the active Backlog", storyAfterRestore.status === 200);

    // Cascade: deleting Feature 1 (parent of story1) must cascade to story1
    // and any of its tasks, and restoring story1 must restore it back under
    // Feature 1.
    const deleteFeature1AsAdmin = await apiDelete(`/api/features/${feature1Id}`, tokenAdminA);
    check("Deleting Feature 1 succeeds (cascades to its User Story)", deleteFeature1AsAdmin.status === 200);

    const recycleBinAfterCascade = await apiGet(`/api/projects/${projectAId}/recycle-bin`, tokenAdminA);
    check("Cascading delete also moved Story 1 to the Recycle Bin", recycleBinAfterCascade.body?.userStories?.some((s) => s.id === story1Id));

    const restoreStory1 = await apiPatch(`/api/user-stories/${story1Id}/restore`, null, tokenAdminA);
    check("Story 1 restore succeeded", restoreStory1.status === 200);

    const story1AfterRestore = await apiGet(`/api/user-stories/${story1Id}`, tokenAdminA);
    check("Restored Story 1 still points at Feature 1 (parent relationship preserved)", Number(story1AfterRestore.body?.userStory?.feature_id) === Number(feature1Id));

    // Permanent delete.
    const restoreFeature1 = await apiPatch(`/api/features/${feature1Id}/restore`, null, tokenAdminA);
    check("Feature 1 restore succeeded (setup for permanent-delete check)", restoreFeature1.status === 200);

    const permanentDeleteEpic2NotInBin = await apiDelete(`/api/epics/${epic1Id}/permanent`, tokenAdminA);
    check("Permanently deleting an item that is NOT in the Recycle Bin is rejected", permanentDeleteEpic2NotInBin.status === 400);

    const permanentDeleteEpic2 = await apiDelete(`/api/epics/${epic2Id}/permanent`, tokenAdminA);
    check("Permanent delete of a Recycle-Binned Epic succeeded", permanentDeleteEpic2.status === 200);

    const recycleBinAfterPermanent = await apiGet(`/api/projects/${projectAId}/recycle-bin`, tokenAdminA);
    check("Permanently deleted Epic no longer appears in the Recycle Bin", !recycleBinAfterPermanent.body?.epics?.some((e) => e.id === epic2Id));

    // Tenant isolation: tenant B must never see tenant A's recycle bin data.
    const createProjectB = await apiPost("/api/projects", { name: "TechOps Test Project B" }, tokenAdminB);
    const projectBId = createProjectB.body?.id;

    const recycleBinB = await apiGet(`/api/projects/${projectBId}/recycle-bin`, tokenAdminB);
    check("Tenant B's Recycle Bin is empty (no cross-tenant leakage)", (recycleBinB.body?.epics || []).length === 0 && (recycleBinB.body?.tasks || []).length === 0);

    // A project id that happens to numerically coincide with a REAL
    // project B still only ever resolves within tenant B's OWN database
    // (tenant isolation here is a physically separate database per
    // tenant, selected by the authenticated tenant context -- never by
    // the numeric id in the URL) -- already proven by the empty-bin
    // check above. This check instead uses an id guaranteed not to
    // exist in tenant B's (small, freshly provisioned) database, to
    // directly confirm a nonexistent/foreign project id is rejected
    // rather than silently returning something.
    const crossTenantAccess = await apiGet(`/api/projects/999999/recycle-bin`, tokenAdminB);
    check("Tenant B's admin is rejected for a project id that doesn't exist in their own tenant", crossTenantAccess.status === 403 || crossTenantAccess.status === 404, `status=${crossTenantAccess.status}`);

    // ==========================================
    // 8. RESTORE ALL (cascade-deleted groups)
    //
    // Builds a fresh, self-contained Epic3 -> Feature3 -> Story3 ->
    // {Task3a, Task3b} chain (avoiding entanglement with objects
    // already restored/permanently-deleted above), with Story3 and
    // Task3b both assigned to a Sprint. Task3a is deleted
    // INDEPENDENTLY first (standalone delete, no cascade) -- the
    // critical scenario is confirming that when Epic3 is THEN
    // cascade-deleted, "Restore All" on that new cascade group never
    // touches Task3a, since it was never a member of it.
    // ==========================================
    console.log("\n8. RESTORE ALL (cascade-deleted groups)");

    const epic3 = (await apiPost(`/api/epics/project/${projectAId}`, { title: "Epic Three" }, tokenAdminA)).body;
    const feature3 = (await apiPost(`/api/features/project/${projectAId}`, { title: "Feature Three", epic_id: epic3.id }, tokenAdminA)).body;
    const story3 = (await apiPost(`/api/user-stories/project/${projectAId}`, { title: "Story Three", feature_id: feature3.id }, tokenAdminA)).body;
    const sprint3 = (await apiPost(`/api/sprints/project/${projectAId}`, { name: "Sprint Three" }, tokenAdminA)).body;

    await apiPatch(`/api/user-stories/${story3.id}/sprint`, { sprint_id: sprint3.id }, tokenAdminA);

    const task3a = (await apiPost(`/api/user-stories/${story3.id}/tasks`, { title: "Task 3a (deleted independently)", description: "x", assigned_to: assigneeA }, tokenAdminA)).body;
    const task3b = (await apiPost(`/api/user-stories/${story3.id}/tasks`, { title: "Task 3b (cascade member)", description: "x", assigned_to: assigneeA }, tokenAdminA)).body;

    await apiPatch(`/api/task-management/${task3b.id}/sprint`, { sprint_id: sprint3.id }, tokenAdminA);

    // Task3a deleted independently, BEFORE the Epic cascade -- gets no
    // batch id (a standalone delete is never part of a group).
    const deleteTask3aIndependently = await apiDelete(`/api/task-management/delete/${task3a.id}`, tokenAdminA);
    check("Task 3a (independent delete) succeeded", deleteTask3aIndependently.status === 200);

    // NOW cascade-delete Epic3 -- Feature3, Story3, Task3b all move
    // into a NEW group together; Task3a (already gone) is untouched.
    const deleteEpic3 = await apiDelete(`/api/epics/${epic3.id}`, tokenAdminA);
    check("Epic 3 cascade delete succeeded", deleteEpic3.status === 200);
    check("Epic 3 cascade reports exactly 1 Feature, 1 User Story, 1 Task (Task 3a excluded)", deleteEpic3.body?.featureCount === 1 && deleteEpic3.body?.userStoryCount === 1 && deleteEpic3.body?.taskCount === 1, JSON.stringify(deleteEpic3.body));

    const recycleBinBeforeRestoreAll = await apiGet(`/api/projects/${projectAId}/recycle-bin`, tokenAdminA);

    const epic3InBin = recycleBinBeforeRestoreAll.body?.epics?.find((e) => e.id === epic3.id);
    const feature3InBin = recycleBinBeforeRestoreAll.body?.features?.find((f) => f.id === feature3.id);
    const story3InBin = recycleBinBeforeRestoreAll.body?.userStories?.find((s) => s.id === story3.id);
    const task3aInBin = recycleBinBeforeRestoreAll.body?.tasks?.find((t) => t.id === task3a.id);
    const task3bInBin = recycleBinBeforeRestoreAll.body?.tasks?.find((t) => t.id === task3b.id);

    check("Epic 3, Feature 3, Story 3, Task 3b all share the SAME deleted_batch_id", epic3InBin?.deleted_batch_id && epic3InBin.deleted_batch_id === feature3InBin?.deleted_batch_id && epic3InBin.deleted_batch_id === story3InBin?.deleted_batch_id && epic3InBin.deleted_batch_id === task3bInBin?.deleted_batch_id);
    check("Task 3a (independently deleted) has a DIFFERENT (or no) batch id from the cascade group", task3aInBin?.deleted_batch_id !== epic3InBin?.deleted_batch_id);

    const batchId = epic3InBin.deleted_batch_id;

    // Stakeholder must be rejected from Restore All exactly like every
    // other delete/restore action -- direct API call, not a hidden button.
    const restoreBatchAsStakeholder = await fetch(`${BASE_URL}/api/projects/${projectAId}/recycle-bin/restore-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenStakeholder}` },
        body: JSON.stringify({ batchId }),
    });
    check("Stakeholder-tier member is REJECTED from Restore All", restoreBatchAsStakeholder.status === 403);

    const restoreBatchUnknown = await fetch(`${BASE_URL}/api/projects/${projectAId}/recycle-bin/restore-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenAdminA}` },
        body: JSON.stringify({ batchId: "00000000-0000-0000-0000-000000000000" }),
    });
    check("Restore All with an unknown/nonexistent batch id is rejected (404)", restoreBatchUnknown.status === 404);

    const restoreBatchRes = await fetch(`${BASE_URL}/api/projects/${projectAId}/recycle-bin/restore-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenAdminA}` },
        body: JSON.stringify({ batchId }),
    });
    let restoreBatchBody = null;
    try { restoreBatchBody = await restoreBatchRes.json(); } catch (_) { /* non-JSON */ }
    check("Restore All succeeded", restoreBatchRes.status === 200, JSON.stringify(restoreBatchBody));
    check("Restore All reports exactly 1 Epic, 1 Feature, 1 User Story, 1 Task restored", restoreBatchBody?.epicCount === 1 && restoreBatchBody?.featureCount === 1 && restoreBatchBody?.userStoryCount === 1 && restoreBatchBody?.taskCount === 1, JSON.stringify(restoreBatchBody));

    const epic3After = await apiGet(`/api/epics/${epic3.id}`, tokenAdminA);
    const feature3After = await apiGet(`/api/features/${feature3.id}`, tokenAdminA);
    const story3After = await apiGet(`/api/user-stories/${story3.id}`, tokenAdminA);
    const task3bAfter = await apiGet(`/api/task-management/task/${task3b.id}`, tokenAdminA);
    const task3aAfterRestoreAll = await apiGet(`/api/task-management/task/${task3a.id}`, tokenAdminA);

    check("Restore All: Epic 3 is active again with its ORIGINAL id", epic3After.status === 200 && epic3After.body?.epic?.id === epic3.id);
    check("Restore All: Feature 3 is active again, still pointing at Epic 3 (parent relationship preserved)", feature3After.status === 200 && Number(feature3After.body?.feature?.epic_id) === Number(epic3.id));
    check("Restore All: Story 3 is active again, still pointing at Feature 3", story3After.status === 200 && Number(story3After.body?.userStory?.feature_id) === Number(feature3.id));
    check("Restore All: Story 3's Sprint relationship was preserved through cascade delete + Restore All", Number(story3After.body?.userStory?.sprint_id) === Number(sprint3.id));
    check("Restore All: Task 3b is active again, still pointing at Story 3", task3bAfter.status === 200 && Number(task3bAfter.body?.task?.user_story_id) === Number(story3.id));
    check("Restore All: Task 3b's Sprint relationship was preserved through cascade delete + Restore All", Number(task3bAfter.body?.task?.sprint_id) === Number(sprint3.id));
    check("Restore All: Task 3a (independently deleted BEFORE the cascade) is STILL in the Recycle Bin, NOT incorrectly restored", task3aAfterRestoreAll.status === 404);

    const recycleBinAfterRestoreAll = await apiGet(`/api/projects/${projectAId}/recycle-bin`, tokenAdminA);
    check("Task 3a still appears in the Recycle Bin after Restore All", recycleBinAfterRestoreAll.body?.tasks?.some((t) => t.id === task3a.id));
    check("Epic 3 / Feature 3 / Story 3 / Task 3b no longer appear in the Recycle Bin after Restore All", ![epic3.id].some((eid) => recycleBinAfterRestoreAll.body?.epics?.some((e) => e.id === eid)) && !recycleBinAfterRestoreAll.body?.tasks?.some((t) => t.id === task3b.id));

    // Individual Restore must still work independently, unaffected by
    // Restore All's existence -- restore Task 3a on its own now.
    const restoreTask3aIndividually = await apiPatch(`/api/task-management/${task3a.id}/restore`, null, tokenAdminA);
    check("Individual Restore still works independently (Task 3a restored on its own)", restoreTask3aIndividually.status === 200);

    // Tenant isolation for Restore All: tenant B must never be able to
    // restore tenant A's batch via a forged/guessed batch id.
    const crossTenantRestoreBatch = await fetch(`${BASE_URL}/api/projects/${projectAId}/recycle-bin/restore-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenAdminB}` },
        body: JSON.stringify({ batchId }),
    });
    check("Tenant B cannot use Restore All against Tenant A's project/batch", crossTenantRestoreBatch.status === 403 || crossTenantRestoreBatch.status === 404, `status=${crossTenantRestoreBatch.status}`);

    // ==========================================
    // SUMMARY
    // ==========================================
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);

    // ---------- Cleanup ----------
    console.log("\nCLEANUP -- dropping test tenants and platform fixtures");

    try {
        await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?)`, [A_SLUG, B_SLUG]);
    } catch (error) {
        console.error("Cleanup (companies) error:", error.message);
    }

    try {
        await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    } catch (error) {
        console.error("Cleanup (platform user) error:", error.message);
    }

    try {
        // WITH (FORCE) (PostgreSQL 13+) disconnects any other session still
        // holding a pooled connection to this database -- e.g. a live
        // backend server process (a separate Node process from this test
        // script) that served the requests above and never closed its own
        // per-tenant pool. Without it, DROP DATABASE fails whenever this
        // suite is run against a live server, exactly as intended for a
        // real end-to-end test.
        await platformPool.query(`DROP DATABASE IF EXISTS "${A_DB}" WITH (FORCE)`);
        await platformPool.query(`DROP DATABASE IF EXISTS "${B_DB}" WITH (FORCE)`);
    } catch (error) {
        console.error("Cleanup (tenant databases) error:", error.message);
    }

    await closeAllTenantPools();
    await platformPool.end();

    process.exit(failures === 0 ? 0 : 1);

})().catch(async (error) => {
    console.error("TEST SCRIPT ERROR:", error);
    process.exit(1);
});
