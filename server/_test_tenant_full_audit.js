require("dotenv").config();
const bcrypt = require("bcrypt");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const platformCompanyService = require("./services/platformCompanyService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { buildTenantDbName } = require("./utils/tenantDbName");

// ==========================================
// FULL TENANT PRODUCTION SMOKE TEST (post-PostgreSQL-migration audit)
//
// Creates a temporary Platform Owner + TWO temporary companies (each
// with their own provisioned tenant database + admin user), exercises
// every major tenant feature area over real HTTP against the live
// backend, checks cross-tenant isolation between the two temp
// companies, and deletes everything it created at the end. Never
// reads, writes, or logs into the real "reinsteins" tenant.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "tenantaudit_owner@groworgs.internal";
const OWNER_PASSWORD = "TenantAudit!Owner2026Pwd";
const COMPANY_A_SLUG = "tenantaudit_alpha";
const COMPANY_B_SLUG = "tenantaudit_beta";
const ADMIN_PASSWORD = "TenantAudit!Admin2026Pwd";

const results = [];
let failures = 0;

function record(method, path, expected, actual, note) {
  const pass = Array.isArray(expected) ? expected.includes(actual) : expected === actual;
  if (!pass) failures++;
  results.push({ method, path, expected, actual, pass, note: note || "" });
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${method} ${path} -- expected ${JSON.stringify(expected)} got ${actual}${note ? " -- " + note : ""}`);
  return pass;
}

function check(label, cond, detail) {
  if (cond) console.log(`  [PASS] ${label}`);
  else { failures++; console.log(`  [FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

async function apiGet(p, token) {
  const res = await fetch(`${BASE_URL}${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}
async function apiPost(p, body, token) {
  const res = await fetch(`${BASE_URL}${p}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}
async function apiPut(p, body, token) {
  const res = await fetch(`${BASE_URL}${p}`, { method: "PUT", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}
async function apiPatch(p, body, token) {
  const res = await fetch(`${BASE_URL}${p}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}
async function apiDelete(p, token) {
  const res = await fetch(`${BASE_URL}${p}`, { method: "DELETE", headers: token ? { Authorization: `Bearer ${token}` } : {} });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}

async function createCompanyWithAdmin(ownerToken, slug, name) {
  const createRes = await apiPost("/api/platform/companies", { companyName: name, companySlug: slug, accessType: "trial" }, ownerToken);
  if (createRes.status !== 201) throw new Error(`Failed to create company ${slug}: ${JSON.stringify(createRes.body)}`);
  const companyId = createRes.body.company.id;
  const adminRes = await apiPost(`/api/platform/companies/${companyId}/admin`, {
    name: `${name} Admin`, email: `${slug}_admin@tenantaudit.internal`, password: ADMIN_PASSWORD,
  }, ownerToken);
  if (adminRes.status !== 201) throw new Error(`Failed to create admin for ${slug}: ${JSON.stringify(adminRes.body)}`);
  return { companyId, slug, adminEmployeeId: adminRes.body.admin.employeeId };
}

async function tenantLogin(slug, employeeId, password) {
  const res = await apiPost(`/api/tenant-auth/${slug}/login`, { employeeId, password });
  return res;
}

(async () => {

  console.log("SETUP -- platform owner + two temp companies (A, B)");
  const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
  await platformUserService.create({ name: "TenantAudit Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
  const ownerLoginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
  const ownerToken = ownerLoginRes.body?.token;
  check("SETUP: platform owner login succeeds", ownerLoginRes.status === 200 && !!ownerToken);

  const companyA = await createCompanyWithAdmin(ownerToken, COMPANY_A_SLUG, "TenantAudit Alpha");
  const companyB = await createCompanyWithAdmin(ownerToken, COMPANY_B_SLUG, "TenantAudit Beta");
  check("SETUP: both temp companies + admins created", !!companyA.companyId && !!companyB.companyId);

  let tokenA = null, tokenB = null;

  try {

    // ========================================
    // AUTHENTICATION
    // ========================================
    console.log("\n=== AUTHENTICATION ===");
    const loginAOk = await tenantLogin(COMPANY_A_SLUG, companyA.adminEmployeeId, ADMIN_PASSWORD);
    record("POST", "/api/tenant-auth/:slug/login (correct creds)", 200, loginAOk.status);
    tokenA = loginAOk.body?.token;
    check("AUTH: token A received", !!tokenA);

    const loginBOk = await tenantLogin(COMPANY_B_SLUG, companyB.adminEmployeeId, ADMIN_PASSWORD);
    record("POST", "/api/tenant-auth/:slug/login (correct creds, company B)", 200, loginBOk.status);
    tokenB = loginBOk.body?.token;
    check("AUTH: token B received", !!tokenB);

    const badPass = await tenantLogin(COMPANY_A_SLUG, companyA.adminEmployeeId, "WrongPassword!123");
    record("POST", "/api/tenant-auth/:slug/login (wrong password)", 401, badPass.status);

    const badSlug = await tenantLogin("no_such_company_slug_xyz", companyA.adminEmployeeId, ADMIN_PASSWORD);
    record("POST", "/api/tenant-auth/:slug/login (nonexistent slug)", [400, 401, 404], badSlug.status);

    const meA = await apiGet("/api/tenant-auth/me", tokenA);
    record("GET", "/api/tenant-auth/me", 200, meA.status);

    const noToken = await apiGet("/api/tenant-auth/me");
    record("GET", "/api/tenant-auth/me (no token)", 401, noToken.status);

    const wrongSecretToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwicm9sZSI6ImFkbWluIn0.invalidsignature";
    const badSig = await apiGet("/api/tenant-auth/me", wrongSecretToken);
    record("GET", "/api/tenant-auth/me (garbage token)", 401, badSig.status);

    const subStatus = await apiGet("/api/tenant-auth/subscription-status", tokenA);
    record("GET", "/api/tenant-auth/subscription-status", 200, subStatus.status);

    // ========================================
    // DASHBOARD
    // ========================================
    console.log("\n=== DASHBOARD ===");
    const dashStats = await apiGet("/api/dashboard/stats", tokenA);
    record("GET", "/api/dashboard/stats", 200, dashStats.status, JSON.stringify(dashStats.body)?.slice(0, 200));

    const liveWork = await apiGet("/api/dashboard/live-work", tokenA);
    record("GET", "/api/dashboard/live-work", 200, liveWork.status);

    // ========================================
    // DEPARTMENTS
    // ========================================
    console.log("\n=== DEPARTMENTS ===");
    const deptList = await apiGet("/api/departments", tokenA);
    record("GET", "/api/departments", 200, deptList.status);

    const deptCreate = await apiPost("/api/departments", { name: "Engineering", code: "ENG", description: "Eng dept" }, tokenA);
    record("POST", "/api/departments", 201, deptCreate.status, JSON.stringify(deptCreate.body)?.slice(0, 200));
    const deptId = deptCreate.body?.id ?? deptCreate.body?.department?.id;

    if (deptId) {
      const deptGet = await apiGet(`/api/departments/${deptId}`, tokenA);
      record("GET", "/api/departments/:id", 200, deptGet.status);

      const deptMembers = await apiGet(`/api/departments/${deptId}/members`, tokenA);
      record("GET", "/api/departments/:id/members", 200, deptMembers.status);

      const deptUpdate = await apiPut(`/api/departments/${deptId}`, { name: "Engineering Updated", code: "ENG", description: "Updated" }, tokenA);
      record("PUT", "/api/departments/:id", 200, deptUpdate.status, JSON.stringify(deptUpdate.body)?.slice(0, 200));

      const deptDeactivate = await apiPatch(`/api/departments/${deptId}/status`, { status: "inactive" }, tokenA);
      record("PATCH", "/api/departments/:id/status", 200, deptDeactivate.status, JSON.stringify(deptDeactivate.body)?.slice(0, 200));
    }

    // ========================================
    // EMPLOYEES
    // ========================================
    console.log("\n=== EMPLOYEES ===");
    const empList = await apiGet("/api/employees", tokenA);
    record("GET", "/api/employees", 200, empList.status, JSON.stringify(empList.body)?.slice(0, 200));

    const empCreate = await apiPost("/api/employees", {
      fullName: "Test Employee One", email: "test.employee.one@tenantaudit.internal",
      designation: "Software Engineer", password: "EmployeeOne!2026Pwd", employmentType: "employee",
    }, tokenA);
    record("POST", "/api/employees", 201, empCreate.status, JSON.stringify(empCreate.body)?.slice(0, 300));
    const empId = empCreate.body?.id;

    if (empId) {
      const empUpdate = await apiPut(`/api/employees/${empId}`, { fullName: "Test Employee One Updated", designation: "Senior Software Engineer" }, tokenA);
      record("PUT", "/api/employees/:id", 200, empUpdate.status, JSON.stringify(empUpdate.body)?.slice(0, 200));
    }

    const empSearch = await apiGet("/api/employees?search=Test", tokenA);
    record("GET", "/api/employees?search=", 200, empSearch.status);

    // NOTE: /api/employees/profile/me is scoped to role='employee' only
    // (see employeeController.js getMyProfile) -- an admin token
    // correctly gets 404 here by design (EmployeeProfile.jsx, the only
    // frontend caller, is never rendered for admins). Not tested with
    // the admin token for that reason.

    // ========================================
    // PROJECTS
    // ========================================
    console.log("\n=== PROJECTS ===");
    const projList = await apiGet("/api/projects", tokenA);
    record("GET", "/api/projects", 200, projList.status, JSON.stringify(projList.body)?.slice(0, 200));

    const projCreate = await apiPost("/api/projects", { name: "Test Project Alpha", description: "Audit test project" }, tokenA);
    record("POST", "/api/projects", 201, projCreate.status, JSON.stringify(projCreate.body)?.slice(0, 300));
    const projId = projCreate.body?.id ?? projCreate.body?.project?.id;

    if (projId) {
      const projGet = await apiGet(`/api/projects/${projId}`, tokenA);
      record("GET", "/api/projects/:id", 200, projGet.status, JSON.stringify(projGet.body)?.slice(0, 200));

      const projTasks = await apiGet(`/api/projects/${projId}/tasks`, tokenA);
      record("GET", "/api/projects/:id/tasks", 200, projTasks.status);

      const projUpdate = await apiPut(`/api/projects/${projId}`, { name: "Test Project Alpha Updated" }, tokenA);
      record("PUT", "/api/projects/:id", 200, projUpdate.status, JSON.stringify(projUpdate.body)?.slice(0, 200));

      const projMembers = await apiGet(`/api/projects/${projId}/members`, tokenA);
      record("GET", "/api/projects/:id/members", 200, projMembers.status);

      const projMyPerms = await apiGet(`/api/projects/${projId}/my-permissions`, tokenA);
      record("GET", "/api/projects/:id/my-permissions", 200, projMyPerms.status);
    }

    // ========================================
    // TASKS (task-management)
    // ========================================
    console.log("\n=== TASKS ===");
    const taskEmployees = await apiGet("/api/task-management/employees", tokenA);
    record("GET", "/api/task-management/employees", 200, taskEmployees.status);

    const taskList = await apiGet("/api/task-management/tasks", tokenA);
    record("GET", "/api/task-management/tasks", 200, taskList.status, JSON.stringify(taskList.body)?.slice(0, 200));

    let adminSelfId = null;
    const adminMe = await apiGet("/api/tenant-auth/me", tokenA);
    adminSelfId = adminMe.body?.user?.id;

    const taskCreate = await apiPost("/api/task-management/create", {
      title: "Audit Test Task", description: "Created by tenant audit", assigned_to: adminSelfId,
      priority: "Medium", status: "todo",
    }, tokenA);
    record("POST", "/api/task-management/create", [200, 201], taskCreate.status, JSON.stringify(taskCreate.body)?.slice(0, 300));

    const taskListAgain = await apiGet("/api/task-management/tasks", tokenA);
    const createdTask = taskListAgain.body?.tasks?.find((t) => t.title === "Audit Test Task");
    const taskId = createdTask?.id;

    if (taskId) {
      const taskGet = await apiGet(`/api/task-management/task/${taskId}`, tokenA);
      record("GET", "/api/task-management/task/:id", 200, taskGet.status);

      const taskStatusUpdate = await apiPut(`/api/task-management/${taskId}/status`, { status: "in_progress" }, tokenA);
      record("PUT", "/api/task-management/:id/status", 200, taskStatusUpdate.status, JSON.stringify(taskStatusUpdate.body)?.slice(0, 200));

      const taskUpdate = await apiPut(`/api/task-management/update/${taskId}`, { title: "Audit Test Task Updated" }, tokenA);
      record("PUT", "/api/task-management/update/:id", 200, taskUpdate.status, JSON.stringify(taskUpdate.body)?.slice(0, 200));

      const taskDelete = await apiDelete(`/api/task-management/delete/${taskId}`, tokenA);
      record("DELETE", "/api/task-management/delete/:id", 200, taskDelete.status, JSON.stringify(taskDelete.body)?.slice(0, 200));
    } else {
      console.log("  [SKIP] task detail/status/update/delete -- created task id not found via list");
    }

    // ========================================
    // MEETINGS
    // ========================================
    console.log("\n=== MEETINGS ===");
    const meetingList = await apiGet("/api/meetings", tokenA);
    record("GET", "/api/meetings", 200, meetingList.status, JSON.stringify(meetingList.body)?.slice(0, 200));

    const meetingCreate = await apiPost("/api/meetings", {
      title: "Audit Test Meeting", description: "Created by tenant audit", meetingType: "scheduled",
      scheduledDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      startTime: "10:00", endTime: "11:00",
    }, tokenA);
    record("POST", "/api/meetings", 201, meetingCreate.status, JSON.stringify(meetingCreate.body)?.slice(0, 300));
    const meetingId = meetingCreate.body?.meeting?.id;

    if (meetingId) {
      const meetingGet = await apiGet(`/api/meetings/${meetingId}`, tokenA);
      record("GET", "/api/meetings/:id", 200, meetingGet.status, JSON.stringify(meetingGet.body)?.slice(0, 200));

      const meetingParticipants = await apiGet(`/api/meetings/${meetingId}/participants`, tokenA);
      record("GET", "/api/meetings/:id/participants", 200, meetingParticipants.status);

      const meetingUpdate = await apiPut(`/api/meetings/${meetingId}`, { title: "Audit Test Meeting Updated" }, tokenA);
      record("PUT", "/api/meetings/:id", 200, meetingUpdate.status, JSON.stringify(meetingUpdate.body)?.slice(0, 200));

      const meetingCancel = await apiPost(`/api/meetings/${meetingId}/cancel`, {}, tokenA);
      record("POST", "/api/meetings/:id/cancel", 200, meetingCancel.status, JSON.stringify(meetingCancel.body)?.slice(0, 200));
    }

    // ========================================
    // CHAT
    // ========================================
    console.log("\n=== CHAT ===");
    const chatUsers = await apiGet("/api/chat/users", tokenA);
    record("GET", "/api/chat/users", 200, chatUsers.status);

    const conversations1 = await apiGet("/api/chat/conversations", tokenA);
    record("GET", "/api/chat/conversations", 200, conversations1.status, JSON.stringify(conversations1.body)?.slice(0, 300));

    let otherUserId = null;
    if (empId) otherUserId = empId;

    let privateConvId = null;
    if (otherUserId) {
      const privateConv = await apiPost("/api/chat/conversations/private", { userId: otherUserId }, tokenA);
      record("POST", "/api/chat/conversations/private", 201, privateConv.status, JSON.stringify(privateConv.body)?.slice(0, 300));
      privateConvId = privateConv.body?.conversation?.id;
    } else {
      console.log("  [SKIP] private conversation -- no second user available");
    }

    let groupConvId = null;
    if (otherUserId) {
      const groupConv = await apiPost("/api/chat/conversations/group", { name: "Audit Test Group", memberIds: [otherUserId] }, tokenA);
      record("POST", "/api/chat/conversations/group", 201, groupConv.status, JSON.stringify(groupConv.body)?.slice(0, 300));
      groupConvId = groupConv.body?.conversation?.id;
    }

    const convForMessages = privateConvId || groupConvId;
    if (convForMessages) {
      const sendMsg = await apiPost(`/api/chat/conversations/${convForMessages}/messages`, { message: "Audit test message" }, tokenA);
      record("POST", "/api/chat/conversations/:id/messages", [200, 201], sendMsg.status, JSON.stringify(sendMsg.body)?.slice(0, 300));

      const getMsgs = await apiGet(`/api/chat/conversations/${convForMessages}/messages`, tokenA);
      record("GET", "/api/chat/conversations/:id/messages", 200, getMsgs.status, JSON.stringify(getMsgs.body)?.slice(0, 300));

      const convMembers = await apiGet(`/api/chat/conversations/${convForMessages}/members`, tokenA);
      record("GET", "/api/chat/conversations/:id/members", 200, convMembers.status);

      const markRead = await apiPut(`/api/chat/conversations/${convForMessages}/read`, {}, tokenA);
      record("PUT", "/api/chat/conversations/:id/read", 200, markRead.status);
    } else {
      console.log("  [SKIP] chat messages -- no conversation available");
    }

    // Re-fetch conversation list after activity -- exercises the full
    // getMyConversations aggregate query (last_message/unread_count/etc).
    const conversations2 = await apiGet("/api/chat/conversations", tokenA);
    record("GET", "/api/chat/conversations (after activity)", 200, conversations2.status, JSON.stringify(conversations2.body)?.slice(0, 300));

    // Chat image upload (multipart) -- representative FILES test.
    let signedImageUrl = null;
    if (convForMessages) {
      const form = new FormData();
      const blob = new Blob([Buffer.from("fake-png-bytes-for-audit-test")], { type: "image/png" });
      form.append("image", blob, "audit-test.png");
      const uploadRes = await fetch(`${BASE_URL}/api/chat/conversations/${convForMessages}/upload-image`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenA}` },
        body: form,
      });
      let uploadBody = null; try { uploadBody = await uploadRes.json(); } catch (_) {}
      record("POST", "/api/chat/conversations/:id/upload-image", [200, 201], uploadRes.status, JSON.stringify(uploadBody)?.slice(0, 300));
      signedImageUrl = uploadBody?.message?.image || null;
    }

    // ========================================
    // FILES -- signed URL download + tenant isolation
    // ========================================
    console.log("\n=== FILES ===");
    if (signedImageUrl) {
      const signedRes = await fetch(`${BASE_URL}${signedImageUrl}`);
      record("GET", "/uploads/... (signed URL, no auth header needed)", 200, signedRes.status, `content-type=${signedRes.headers.get("content-type")}`);

      const unsignedPath = signedImageUrl.split("?")[0];
      const unsignedRes = await fetch(`${BASE_URL}${unsignedPath}`);
      record("GET", "/uploads/... (signature stripped)", [401, 403], unsignedRes.status);

      check("FILES: signed URL path is scoped under this tenant's own directory", signedImageUrl.includes(`tenant_${COMPANY_A_SLUG}`), signedImageUrl);
    } else {
      console.log("  [SKIP] file download tests -- no uploaded image URL available");
    }

    // ========================================
    // OTHER FEATURE AREAS -- lightweight read-only smoke checks
    // ========================================
    console.log("\n=== OTHER FEATURES ===");
    const myLeaves = await apiGet("/api/leaves/my", tokenA);
    record("GET", "/api/leaves/my", 200, myLeaves.status);

    const applyLeave = await apiPost("/api/leaves", {
      leaveType: "casual", fromDate: new Date(Date.now() + 172800000).toISOString().slice(0, 10),
      toDate: new Date(Date.now() + 172800000).toISOString().slice(0, 10), reason: "Audit test leave",
    }, tokenA);
    record("POST", "/api/leaves", [200, 201], applyLeave.status, JSON.stringify(applyLeave.body)?.slice(0, 200));

    const designationList = await apiGet("/api/designations", tokenA);
    record("GET", "/api/designations", 200, designationList.status);

    const orgMyTeam = await apiGet("/api/organization/my-team", tokenA);
    record("GET", "/api/organization/my-team", 200, orgMyTeam.status);

    const orgsList = await apiGet("/api/organizations", tokenA);
    record("GET", "/api/organizations", 200, orgsList.status);

    const attendanceStatus = await apiGet("/api/attendance/status", tokenA);
    record("GET", "/api/attendance/status", 200, attendanceStatus.status);

    const reportEmployees = await apiGet("/api/reports/employees", tokenA);
    record("GET", "/api/reports/employees", 200, reportEmployees.status);

    // ========================================
    // SOCKET.IO
    // ========================================
    console.log("\n=== SOCKET.IO ===");
    const { io: socketIoClient } = require("/var/www/reinsteins-crm/client/node_modules/socket.io-client");

    const goodSocket = socketIoClient(BASE_URL, { auth: { token: tokenA }, transports: ["websocket"], reconnection: false, timeout: 5000 });
    const goodConnect = await new Promise((resolve) => {
      goodSocket.on("connect", () => resolve(true));
      goodSocket.on("connect_error", () => resolve(false));
      setTimeout(() => resolve(false), 6000);
    });
    check("SOCKET.IO: valid tenant token connects", goodConnect);
    goodSocket.disconnect();

    const badSocket = socketIoClient(BASE_URL, { auth: { token: "not-a-real-token" }, transports: ["websocket"], reconnection: false, timeout: 5000 });
    const badConnect = await new Promise((resolve) => {
      badSocket.on("connect", () => resolve(true));
      badSocket.on("connect_error", () => resolve(false));
      setTimeout(() => resolve(false), 6000);
    });
    check("SOCKET.IO: invalid token rejected", !badConnect);
    badSocket.disconnect();

    // ========================================
    // NOTIFICATIONS
    // ========================================
    console.log("\n=== NOTIFICATIONS ===");
    const notifList = await apiGet("/api/notifications", tokenA);
    record("GET", "/api/notifications", 200, notifList.status, JSON.stringify(notifList.body)?.slice(0, 300));

    const notifUnread = await apiGet("/api/notifications/unread-count", tokenA);
    record("GET", "/api/notifications/unread-count", 200, notifUnread.status, JSON.stringify(notifUnread.body)?.slice(0, 200));

    const firstNotifId = notifList.body?.notifications?.[0]?.id;
    if (firstNotifId) {
      const notifRead = await apiPut(`/api/notifications/${firstNotifId}/read`, {}, tokenA);
      record("PUT", "/api/notifications/:id/read", 200, notifRead.status);
    } else {
      console.log("  [SKIP] mark single notification read -- none exist yet");
    }

    const notifReadAll = await apiPut("/api/notifications/read-all", {}, tokenA);
    record("PUT", "/api/notifications/read-all", 200, notifReadAll.status, JSON.stringify(notifReadAll.body)?.slice(0, 200));

    // ========================================
    // SETTINGS (profile + password change -- shared /api/auth route)
    // ========================================
    console.log("\n=== SETTINGS ===");
    const changePwWrongCurrent = await apiPut("/api/auth/change-password", {
      currentPassword: "TotallyWrongPassword!", newPassword: "NewAuditPassword!2026", confirmPassword: "NewAuditPassword!2026",
    }, tokenA);
    record("PUT", "/api/auth/change-password (wrong current)", 400, changePwWrongCurrent.status, JSON.stringify(changePwWrongCurrent.body)?.slice(0, 200));

    const changePwOk = await apiPut("/api/auth/change-password", {
      currentPassword: ADMIN_PASSWORD, newPassword: "NewAuditPassword!2026", confirmPassword: "NewAuditPassword!2026",
    }, tokenA);
    record("PUT", "/api/auth/change-password (correct)", 200, changePwOk.status, JSON.stringify(changePwOk.body)?.slice(0, 200));

    if (changePwOk.status === 200) {
      const reloginOldPw = await tenantLogin(COMPANY_A_SLUG, companyA.adminEmployeeId, ADMIN_PASSWORD);
      record("POST", "/api/tenant-auth/:slug/login (old password after change)", 401, reloginOldPw.status);

      const reloginNewPw = await tenantLogin(COMPANY_A_SLUG, companyA.adminEmployeeId, "NewAuditPassword!2026");
      record("POST", "/api/tenant-auth/:slug/login (new password after change)", 200, reloginNewPw.status);
      if (reloginNewPw.status === 200) tokenA = reloginNewPw.body?.token;
    }

    // ========================================
    // TENANT ISOLATION (Company A token vs Company B data, and vice versa)
    // ========================================
    console.log("\n=== TENANT ISOLATION ===");

    // A's token must never see B's employee list contents (different
    // tenant DB entirely -- prove via the admin identity, not IDs
    // which can coincidentally overlap across separate databases).
    const empListB = await apiGet("/api/employees", tokenB);
    const bAdminEmail = empListB.body?.employees?.find((e) => e.id)?.email;
    const empListA_forIsolation = await apiGet("/api/employees", tokenA);
    const aHasBAdmin = empListA_forIsolation.body?.employees?.some((e) => e.email === `${COMPANY_B_SLUG}_admin@tenantaudit.internal`);
    check("ISOLATION: Company A employee list does not include Company B's admin", !aHasBAdmin, JSON.stringify(empListA_forIsolation.body?.employees?.map((e) => e.email)));

    // A's token against a real object id that only exists in B's DB
    // (the freshly created department in B, if we made one) -- since
    // pool resolution is per-JWT/tenant, A's connection can't see B's
    // rows even if the numeric id coincides with something in A.
    if (deptId) {
      // Use B's token against A's department id -- must not return A's data.
      const crossDeptGet = await apiGet(`/api/departments/${deptId}`, tokenB);
      // Either 404 (B's DB has no row with this id) or a DIFFERENT department (B's own row with a coincidentally equal id) -- never A's "Engineering Updated" name.
      const leaked = crossDeptGet.status === 200 && crossDeptGet.body?.department?.name === "Engineering Updated";
      check("ISOLATION: Company B token cannot read Company A's department by id", !leaked, JSON.stringify(crossDeptGet.body));
    }

    // Wrong-company login: Company A's admin employeeId against Company B's slug.
    const crossLogin = await tenantLogin(COMPANY_B_SLUG, companyA.adminEmployeeId, "NewAuditPassword!2026");
    record("POST", "/api/tenant-auth/:slug/login (A's employeeId against B's slug)", 401, crossLogin.status);

    // Missing token entirely on a protected tenant route.
    const noTokenEmployees = await apiGet("/api/employees");
    record("GET", "/api/employees (no token)", 401, noTokenEmployees.status);

    // Platform JWT must not work as a tenant JWT (cross-auth-path boundary).
    const platformOnTenantRoute = await apiGet("/api/employees", ownerToken);
    record("GET", "/api/employees (platform owner token)", 401, platformOnTenantRoute.status);

  } catch (err) {
    console.error("\nUNEXPECTED ERROR DURING TESTS:", err);
    failures++;
  } finally {

    // ========================================
    // CLEANUP -- best effort, always runs
    // ========================================
    console.log("\nCLEANUP");
    try {
      await tenantProvisioningService.dropProvisionedDatabase(buildTenantDbName(COMPANY_A_SLUG));
      await tenantProvisioningService.dropProvisionedDatabase(buildTenantDbName(COMPANY_B_SLUG));
    } catch (e) { console.error("cleanup: drop tenant DBs failed:", e.message); }

    try {
      await platformPool.query(`DELETE FROM email_delivery_logs WHERE company_id IN (?, ?)`, [companyA.companyId, companyB.companyId]);
    } catch (e) { console.error("cleanup: delete email logs failed:", e.message); }

    try {
      const [[auditOwnerRow]] = await platformPool.query(`SELECT id FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
      if (auditOwnerRow) await platformPool.query(`DELETE FROM platform_audit_logs WHERE platform_user_id = ?`, [auditOwnerRow.id]);
    } catch (e) { console.error("cleanup: delete audit logs failed:", e.message); }

    try {
      await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?)`, [COMPANY_A_SLUG, COMPANY_B_SLUG]);
    } catch (e) { console.error("cleanup: delete companies failed:", e.message); }

    try {
      await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    } catch (e) { console.error("cleanup: delete owner failed:", e.message); }

    const companyAGone = (await platformCompanyService.getCompanyBySlug(COMPANY_A_SLUG)) === null;
    const companyBGone = (await platformCompanyService.getCompanyBySlug(COMPANY_B_SLUG)) === null;
    check("CLEANUP: both temporary companies confirmed gone", companyAGone && companyBGone);

    const dbAGone = !(await tenantProvisioningService.databaseExists(buildTenantDbName(COMPANY_A_SLUG)));
    const dbBGone = !(await tenantProvisioningService.databaseExists(buildTenantDbName(COMPANY_B_SLUG)));
    check("CLEANUP: both temporary tenant databases confirmed gone", dbAGone && dbBGone);

    const [finalCompanies] = await platformPool.query(`SELECT company_slug FROM companies`);
    check("CLEANUP: only Reinsteins remains in companies", finalCompanies.length === 1 && finalCompanies[0].company_slug === "reinsteins", JSON.stringify(finalCompanies));

    console.log(`\n${"=".repeat(60)}`);
    console.log(`RESULT SUMMARY: ${results.filter((r) => r.pass).length}/${results.length} endpoint checks passed, ${failures} total failure(s) (including non-endpoint checks)`);
    console.log("=".repeat(60));

    const fs = require("fs");
    fs.writeFileSync(
      "/tmp/claude-1000/-var-www-reinsteins-crm-server/d686b802-a167-4faf-b25c-1a5d6d8db930/scratchpad/tenant_audit_results.json",
      JSON.stringify(results, null, 2)
    );

    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);
  }

})();
