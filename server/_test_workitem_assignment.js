require("dotenv").config();
const bcrypt = require("bcrypt");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { buildTenantDbName } = require("./utils/tenantDbName");

// ==========================================
// EPIC/FEATURE/USER STORY ASSIGNMENT -- SELF-TEST
//
// Real HTTP against the live backend on http://localhost:5000, using
// two throwaway tenants provisioned through the real platform APIs
// (same convention as _test_techops_hierarchy.js). Never touches
// reinsteins_workhub or any real tenant. Drops everything it creates
// at the end.
//
// Covers (per the approved decision list): Assigned By is always the
// authenticated user, never client-spoofable; a Basic-tier project
// member is a valid assignee; an inactive or non-member user is
// rejected as assignee; a cross-project assignee is rejected; an
// authorized Epic/Feature/User Story edit can change Assigned To
// (and Assigned By becomes whoever made that change); an
// unauthorized reassignment (no EPIC_EDIT/FEATURE_EDIT, ceiling-
// capped) is rejected; existing optional-parent behavior (Feature
// with no Epic, User Story with no Feature, Task with no User
// Story) is unchanged; contextual creation still preserves the
// supplied parent.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "workitemassigntest_owner@groworgs.internal";
const OWNER_PASSWORD = "WorkItemAssignTestOwner!2026Pwd";

const A_SLUG = "wiassigntest_a";
const B_SLUG = "wiassigntest_b";
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

(async () => {

    // ---------- Setup ----------
    console.log("SETUP -- platform owner + two tenants + project fixtures");

    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "WorkItem Assign Test Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });

    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: platform owner login succeeded", loginRes.status === 200 && !!ownerToken);

    const createA = await apiPost("/api/platform/companies", { companyName: "WI Assign Test A", companySlug: A_SLUG, accessType: "trial" }, ownerToken);
    const companyAId = createA.body?.company?.id;
    check("SETUP: company A created", createA.status === 201);

    const createB = await apiPost("/api/platform/companies", { companyName: "WI Assign Test B", companySlug: B_SLUG, accessType: "trial" }, ownerToken);
    const companyBId = createB.body?.company?.id;
    check("SETUP: company B created", createB.status === 201);

    const adminACreate = await apiPost(`/api/platform/companies/${companyAId}/admin`, { name: "Admin A", email: "admin@wiassigntest-a.test", password: "AdminPass123!WA_a" }, ownerToken);
    const adminAEmployeeId = adminACreate.body?.admin?.employeeId;
    const loginAdminA = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: adminAEmployeeId, password: "AdminPass123!WA_a" });
    const tokenAdminA = loginAdminA.body?.token;
    const adminAId = loginAdminA.body?.user?.id;
    check("SETUP: admin A login succeeded", loginAdminA.status === 200 && !!tokenAdminA);

    const adminBCreate = await apiPost(`/api/platform/companies/${companyBId}/admin`, { name: "Admin B", email: "admin@wiassigntest-b.test", password: "AdminPass123!WA_b" }, ownerToken);
    const adminBEmployeeId = adminBCreate.body?.admin?.employeeId;
    const loginAdminB = await apiPost(`/api/tenant-auth/${B_SLUG}/login`, { employeeId: adminBEmployeeId, password: "AdminPass123!WA_b" });
    const tokenAdminB = loginAdminB.body?.token;
    check("SETUP: admin B login succeeded", loginAdminB.status === 200 && !!tokenAdminB);

    const poolA = getTenantPool(A_DB);
    const employeePasswordHash = await bcrypt.hash("Employee123!WIAssign", 10);

    // designation="Manager" is in projectAccessService.js's
    // DEFAULT_PROJECT_ACCESS_DESIGNATIONS -- required to pass the
    // pre-existing, unrelated requireProjectAccess MODULE gate.
    async function seedUser(pool, employeeId, fullName, emailDomain, projectAccessLevel, employmentStatus) {
        const [result] = await pool.query(
            `INSERT INTO users (employee_id, full_name, email, password, role, system_access, employment_type, employment_status, status, designation, project_access_level)
             VALUES (?, ?, ?, ?, 'employee', 'employee', 'employee', ?, 'active', 'Manager', ?) RETURNING id`,
            [employeeId, fullName, `${employeeId.toLowerCase()}@${emailDomain}`, employeePasswordHash, employmentStatus || "active", projectAccessLevel]
        );
        return result[0].id;
    }

    const basicUserId = await seedUser(poolA, "WIA001", "Basic Assignee", "wiassigntest-a.test", "basic");
    const stakeholderUserId = await seedUser(poolA, "WIA002", "Stakeholder Editor", "wiassigntest-a.test", "stakeholder");
    const inactiveUserId = await seedUser(poolA, "WIA003", "Inactive Employee", "wiassigntest-a.test", "basic", "resigned");
    const nonMemberUserId = await seedUser(poolA, "WIA004", "Non Member Employee", "wiassigntest-a.test", "basic");
    const crossProjectUserId = await seedUser(poolA, "WIA005", "Cross Project Employee", "wiassigntest-a.test", "basic");

    async function loginEmployee(slug, employeeId) {
        const res = await apiPost(`/api/tenant-auth/${slug}/login`, { employeeId, password: "Employee123!WIAssign" });
        return res.body?.token;
    }

    const tokenStakeholder = await loginEmployee(A_SLUG, "WIA002");
    check("SETUP: stakeholder-tier employee login succeeded", !!tokenStakeholder);

    // ---------- Project fixtures (tenant A) ----------

    const createProjectA = await apiPost("/api/projects", { name: "WI Assign Test Project A", description: "Fixture" }, tokenAdminA);
    const projectAId = createProjectA.body?.id;
    check("SETUP: project A created", createProjectA.status === 201 && !!projectAId);

    const createProjectA2 = await apiPost("/api/projects", { name: "WI Assign Test Project A2", description: "Cross-project fixture" }, tokenAdminA);
    const projectA2Id = createProjectA2.body?.id;
    check("SETUP: second project (A2, same tenant) created", createProjectA2.status === 201 && !!projectA2Id);

    const groupsRes = await apiGet(`/api/projects/${projectAId}/groups`, tokenAdminA);
    const adminGroupId = groupsRes.body?.groups?.find((g) => g.name === "Project Administrators")?.id;
    check("SETUP: default Project Administrators group found", !!adminGroupId);

    // Basic + Stakeholder both added to the SAME full-permission group --
    // their actual effective permissions still diverge purely via
    // ACCESS_LEVEL_CEILINGS (stakeholder excludes EPIC_EDIT/FEATURE_EDIT
    // but includes USER_STORY_EDIT), same pattern _test_techops_hierarchy.js
    // already relies on.
    await apiPost(`/api/projects/${projectAId}/members`, { userIds: [basicUserId, stakeholderUserId], securityGroupId: adminGroupId }, tokenAdminA);

    const groupsA2Res = await apiGet(`/api/projects/${projectA2Id}/groups`, tokenAdminA);
    const adminGroupA2Id = groupsA2Res.body?.groups?.find((g) => g.name === "Project Administrators")?.id;
    await apiPost(`/api/projects/${projectA2Id}/members`, { userIds: [crossProjectUserId], securityGroupId: adminGroupA2Id }, tokenAdminA);

    // ==========================================
    // 1. ASSIGNED BY -- always the authenticated creator, never
    // client-spoofable
    // ==========================================
    console.log("\n1. ASSIGNED BY -- server-derived, never client-trusted");

    const createEpicSpoof = await apiPost(`/api/epics/project/${projectAId}`, {
        title: "Epic with spoofed Assigned By",
        assigned_to: basicUserId,
        assigned_by: 999999,
    }, tokenAdminA);
    const epicSpoofId = createEpicSpoof.body?.id;
    check("Epic created with assigned_to + a spoofed assigned_by in the body", createEpicSpoof.status === 201 && !!epicSpoofId);

    const epicSpoofAfter = await apiGet(`/api/epics/${epicSpoofId}`, tokenAdminA);
    check("Assigned By is the REAL authenticated creator (Admin A), not the spoofed id", Number(epicSpoofAfter.body?.epic?.assigned_by) === Number(adminAId), JSON.stringify(epicSpoofAfter.body?.epic?.assigned_by));
    check("Assigned To was still honored from the request", Number(epicSpoofAfter.body?.epic?.assigned_to) === Number(basicUserId));

    // ==========================================
    // 2. ELIGIBLE ASSIGNEE -- Basic project member is valid;
    // inactive / non-member / cross-project are all rejected
    // ==========================================
    console.log("\n2. ASSIGNEE ELIGIBILITY");

    const createFeatureBasic = await apiPost(`/api/features/project/${projectAId}`, {
        title: "Feature assigned to Basic member", assigned_to: basicUserId,
    }, tokenAdminA);
    check("Feature CAN be assigned to a Basic-tier project member", createFeatureBasic.status === 201, JSON.stringify(createFeatureBasic.body));

    const createFeatureInactive = await apiPost(`/api/features/project/${projectAId}`, {
        title: "Feature assigned to inactive employee", assigned_to: inactiveUserId,
    }, tokenAdminA);
    check("Feature assignment to an INACTIVE employee is rejected", createFeatureInactive.status === 400, JSON.stringify(createFeatureInactive.body));

    const createFeatureNonMember = await apiPost(`/api/features/project/${projectAId}`, {
        title: "Feature assigned to non-member", assigned_to: nonMemberUserId,
    }, tokenAdminA);
    check("Feature assignment to a NON-MEMBER (active, but not on this project) is rejected", createFeatureNonMember.status === 400, JSON.stringify(createFeatureNonMember.body));

    const createFeatureCrossProject = await apiPost(`/api/features/project/${projectAId}`, {
        title: "Feature assigned to cross-project user", assigned_to: crossProjectUserId,
    }, tokenAdminA);
    check("Feature assignment to a user who is a member of a DIFFERENT project only is rejected", createFeatureCrossProject.status === 400, JSON.stringify(createFeatureCrossProject.body));

    const createStoryBasic = await apiPost(`/api/user-stories/project/${projectAId}`, {
        title: "Story assigned to Basic member", assigned_to: basicUserId,
    }, tokenAdminA);
    const storyBasicId = createStoryBasic.body?.id;
    check("User Story CAN be assigned to a Basic-tier project member", createStoryBasic.status === 201);

    // ==========================================
    // 3. REASSIGNMENT -- authorized edit changes Assigned To AND
    // Assigned By becomes whoever performed the change
    // ==========================================
    console.log("\n3. REASSIGNMENT (authorized)");

    const updateStoryReassign = await apiPut(`/api/user-stories/${storyBasicId}`, {
        title: "Story assigned to Basic member",
        assigned_to: stakeholderUserId,
    }, tokenStakeholder);
    check("Stakeholder (has USER_STORY_EDIT via ceiling) can reassign a User Story to THEMSELVES", updateStoryReassign.status === 200, JSON.stringify(updateStoryReassign.body));

    const storyAfterReassign = await apiGet(`/api/user-stories/${storyBasicId}`, tokenAdminA);
    check("Assigned To reflects the new assignee", Number(storyAfterReassign.body?.userStory?.assigned_to) === Number(stakeholderUserId));
    check("Assigned By is now the Stakeholder who performed the reassignment (not preserved as original creator Admin A)", Number(storyAfterReassign.body?.userStory?.assigned_by) !== Number(adminAId) && !!storyAfterReassign.body?.userStory?.assigned_by);

    // ==========================================
    // 4. REASSIGNMENT -- unauthorized (ceiling-capped) is rejected
    // ==========================================
    console.log("\n4. REASSIGNMENT (unauthorized)");

    const createEpicForCeilingTest = await apiPost(`/api/epics/project/${projectAId}`, { title: "Epic for ceiling test" }, tokenAdminA);
    const epicCeilingId = createEpicForCeilingTest.body?.id;

    const stakeholderEditEpic = await apiPut(`/api/epics/${epicCeilingId}`, {
        title: "Epic for ceiling test", assigned_to: stakeholderUserId,
    }, tokenStakeholder);
    check("Stakeholder is REJECTED editing/reassigning an Epic (EPIC_EDIT excluded by the stakeholder ceiling)", stakeholderEditEpic.status === 403, JSON.stringify(stakeholderEditEpic.body));

    const createFeatureForCeilingTest = await apiPost(`/api/features/project/${projectAId}`, { title: "Feature for ceiling test" }, tokenAdminA);
    const featureCeilingId = createFeatureForCeilingTest.body?.id;

    const stakeholderEditFeature = await apiPut(`/api/features/${featureCeilingId}`, {
        title: "Feature for ceiling test", assigned_to: stakeholderUserId,
    }, tokenStakeholder);
    check("Stakeholder is REJECTED editing/reassigning a Feature (FEATURE_EDIT excluded by the stakeholder ceiling)", stakeholderEditFeature.status === 403, JSON.stringify(stakeholderEditFeature.body));

    // Being a VALID assignee (Basic/Stakeholder eligibility) does not
    // by itself grant reassignment rights -- confirmed above: the
    // stakeholder IS a valid assignee (used as assigned_to
    // successfully elsewhere) but is still rejected from performing
    // the Epic/Feature edit itself.

    // ==========================================
    // 5. OPTIONAL PARENTS -- unchanged (Feature with no Epic, User
    // Story with no Feature, Task with no User Story)
    // ==========================================
    console.log("\n5. OPTIONAL PARENTS (no regression)");

    const featureNoEpic = await apiPost(`/api/features/project/${projectAId}`, { title: "Feature directly under project" }, tokenAdminA);
    check("Feature can still be created with NO Epic (opt-in hierarchy preserved)", featureNoEpic.status === 201);

    const storyNoFeature = await apiPost(`/api/user-stories/project/${projectAId}`, { title: "Story directly under project" }, tokenAdminA);
    check("User Story can still be created with NO Feature (opt-in hierarchy preserved)", storyNoFeature.status === 201);

    const employeesA = await apiGet(`/api/task-management/employees?project_id=${projectAId}`, tokenAdminA);
    const taskAssignee = employeesA.body?.employees?.[0]?.id;

    const taskNoStory = await apiPost(`/api/projects/${projectAId}/tasks`, {
        title: "Task with no User Story", description: "Standalone", assigned_to: taskAssignee,
    }, tokenAdminA);
    check("Task can still be created with NO User Story (Task's own optionality unchanged)", taskNoStory.status === 201);

    // ==========================================
    // 6. CONTEXTUAL CREATION -- parent is preserved exactly as
    // supplied (Epic -> Add Feature / Feature -> Add User Story)
    // ==========================================
    console.log("\n6. CONTEXTUAL CREATION preserves supplied parent");

    const contextEpic = await apiPost(`/api/epics/project/${projectAId}`, { title: "Context Epic" }, tokenAdminA);
    const contextEpicId = contextEpic.body?.id;

    const contextFeature = await apiPost(`/api/features/project/${projectAId}`, { title: "Context Feature", epic_id: contextEpicId, assigned_to: basicUserId }, tokenAdminA);
    const contextFeatureId = contextFeature.body?.id;
    check("Feature created via 'Epic -> Add Feature' keeps the supplied Epic parent", contextFeature.status === 201);

    const contextFeatureAfter = await apiGet(`/api/features/${contextFeatureId}`, tokenAdminA);
    check("Feature's epic_id matches the Epic it was created under", Number(contextFeatureAfter.body?.feature?.epic_id) === Number(contextEpicId));
    check("Feature's assigned_to was honored alongside the parent", Number(contextFeatureAfter.body?.feature?.assigned_to) === Number(basicUserId));

    const contextStory = await apiPost(`/api/user-stories/project/${projectAId}`, { title: "Context Story", feature_id: contextFeatureId }, tokenAdminA);
    const contextStoryId = contextStory.body?.id;
    check("User Story created via 'Feature -> Add User Story' keeps the supplied Feature parent", contextStory.status === 201);

    const contextStoryAfter = await apiGet(`/api/user-stories/${contextStoryId}`, tokenAdminA);
    check("Story's feature_id matches the Feature it was created under", Number(contextStoryAfter.body?.userStory?.feature_id) === Number(contextFeatureId));

    // ==========================================
    // 7. TASK ASSIGNMENT -- TASK_ASSIGN behavior unchanged (schema
    // untouched for tasks; light regression check only)
    // ==========================================
    console.log("\n7. TASK ASSIGNMENT (unchanged regression check)");

    const taskForAssignCheck = await apiPost(`/api/projects/${projectAId}/tasks`, {
        title: "Task for assign regression check", description: "x", assigned_to: taskAssignee,
    }, tokenAdminA);
    const taskForAssignId = taskForAssignCheck.body?.id;
    check("Task creation with assigned_to still works exactly as before (Task schema untouched)", taskForAssignCheck.status === 201 && !!taskForAssignId);

    const taskAfterCreate = await apiGet(`/api/task-management/task/${taskForAssignId}`, tokenAdminA);
    check("Task's assigned_by is the authenticated creator, exactly as before", Number(taskAfterCreate.body?.task?.assigned_by) === Number(adminAId));

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
