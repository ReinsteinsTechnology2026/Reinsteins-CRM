require("dotenv").config();
const bcrypt = require("bcrypt");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const platformCompanyService = require("./services/platformCompanyService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { buildTenantDbName } = require("./utils/tenantDbName");

// ==========================================
// EMPLOYEE-ROLE BLANK PAGE INVESTIGATION
// Prior E2E audits this session all used the tenant ADMIN token.
// This one specifically logs in as a genuine role='employee' account
// and hits exactly the APIs EmployeeProfile.jsx / MeetingLobby.jsx /
// MeetingRoom.jsx call, to see the real response shape an employee
// actually receives. One temp company, fully cleaned up.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "blankpage_owner@groworgs.internal";
const OWNER_PASSWORD = "BlankPage!Owner2026Pwd";
const COMPANY_SLUG = "blankpage_co";
const ADMIN_PASSWORD = "BlankPage!Admin2026Pwd";
const EMPLOYEE_PASSWORD = "BlankPage!Employee2026Pwd";

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

(async () => {

  console.log("SETUP -- platform owner + temp company + admin + employee");
  const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
  await platformUserService.create({ name: "BlankPage Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
  const ownerLogin = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
  const ownerToken = ownerLogin.body?.token;

  const createRes = await apiPost("/api/platform/companies", { companyName: "BlankPage Co", companySlug: COMPANY_SLUG, accessType: "trial" }, ownerToken);
  const companyId = createRes.body.company.id;

  const adminRes = await apiPost(`/api/platform/companies/${companyId}/admin`, { name: "BlankPage Admin", email: "blankpage_admin@blankpage.internal", password: ADMIN_PASSWORD }, ownerToken);
  const adminEmployeeId = adminRes.body.admin.employeeId;

  const adminLogin = await apiPost(`/api/tenant-auth/${COMPANY_SLUG}/login`, { employeeId: adminEmployeeId, password: ADMIN_PASSWORD });
  const adminToken = adminLogin.body?.token;
  console.log("  admin login:", adminLogin.status);

  const empCreate = await apiPost("/api/employees", {
    fullName: "Real Employee One", email: "real.employee.one@blankpage.internal",
    designation: "QA Engineer", password: EMPLOYEE_PASSWORD, employmentType: "employee",
  }, adminToken);
  console.log("  employee create:", empCreate.status, JSON.stringify(empCreate.body));
  const employeeId = empCreate.body?.employeeId;
  const employeeUserId = empCreate.body?.id;

  const empLogin = await apiPost(`/api/tenant-auth/${COMPANY_SLUG}/login`, { employeeId, password: EMPLOYEE_PASSWORD });
  console.log("  employee login:", empLogin.status);
  const empToken = empLogin.body?.token;
  console.log("  logged-in employee role/user:", JSON.stringify(empLogin.body?.user));

  try {

    console.log("\n=== EMPLOYEE PROFILE ===");
    const profileRes = await apiGet("/api/employees/profile/me", empToken);
    console.log("  GET /api/employees/profile/me ->", profileRes.status);
    console.log("  body:", JSON.stringify(profileRes.body, null, 2));

    console.log("\n=== MEETINGS (as employee) ===");
    const meetingCreateByAdmin = await apiPost("/api/meetings", {
      title: "Blank Page Test Meeting", meetingType: "instant", participantUserIds: [employeeUserId],
    }, adminToken);
    console.log("  admin creates meeting ->", meetingCreateByAdmin.status, JSON.stringify(meetingCreateByAdmin.body)?.slice(0, 300));
    const meetingId = meetingCreateByAdmin.body?.meeting?.id;

    if (meetingId) {
      const meetingGetAsEmp = await apiGet(`/api/meetings/${meetingId}`, empToken);
      console.log("  GET /api/meetings/:id (as employee) ->", meetingGetAsEmp.status);
      console.log("  body:", JSON.stringify(meetingGetAsEmp.body, null, 2));

      const participantsAsEmp = await apiGet(`/api/meetings/${meetingId}/participants`, empToken);
      console.log("  GET /api/meetings/:id/participants (as employee) ->", participantsAsEmp.status);
      console.log("  body:", JSON.stringify(participantsAsEmp.body, null, 2));

      const joinAsEmp = await apiPost("/api/meetings/join", { meetingCode: meetingCreateByAdmin.body?.meeting?.meeting_code }, empToken);
      console.log("  POST /api/meetings/join (as employee) ->", joinAsEmp.status);
      console.log("  body:", JSON.stringify(joinAsEmp.body, null, 2));
    } else {
      console.log("  [SKIP] meeting detail checks -- no meeting id");
    }

  } catch (err) {
    console.error("UNEXPECTED ERROR:", err);
  } finally {

    console.log("\nCLEANUP");
    try { await tenantProvisioningService.dropProvisionedDatabase(buildTenantDbName(COMPANY_SLUG)); } catch (e) { console.error(e.message); }
    try { await platformPool.query(`DELETE FROM email_delivery_logs WHERE company_id = ?`, [companyId]); } catch (e) { console.error(e.message); }
    try {
      const [[o]] = await platformPool.query(`SELECT id FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
      if (o) await platformPool.query(`DELETE FROM platform_audit_logs WHERE platform_user_id = ?`, [o.id]);
    } catch (e) { console.error(e.message); }
    try { await platformPool.query(`DELETE FROM companies WHERE company_slug = ?`, [COMPANY_SLUG]); } catch (e) { console.error(e.message); }
    try { await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]); } catch (e) { console.error(e.message); }

    const gone = (await platformCompanyService.getCompanyBySlug(COMPANY_SLUG)) === null;
    console.log("  company cleaned up:", gone);

    await platformPool.end();
  }

})();
