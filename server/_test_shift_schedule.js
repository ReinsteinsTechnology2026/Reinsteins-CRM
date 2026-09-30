require("dotenv").config();
const bcrypt = require("bcrypt");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const platformCompanyService = require("./services/platformCompanyService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { buildTenantDbName } = require("./utils/tenantDbName");

// ==========================================
// SHIFT SCHEDULE SELF-TEST (Phase 17b)
//
// Real HTTP against the live backend on http://localhost:5000, using
// two throwaway tenants provisioned through the real platform APIs.
// Never touches reinsteins_workhub or any real tenant. Drops
// everything it creates at the end.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "shifttest_owner@groworgs.internal";
const OWNER_PASSWORD = "ShiftTestOwner!2026Pwd";

const A_SLUG = "shifttest_a";
const B_SLUG = "shifttest_b";
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

async function apiPatch(pathname, body, token) {
    const res = await fetch(`${BASE_URL}${pathname}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

async function apiDelete(pathname, token) {
    const res = await fetch(`${BASE_URL}${pathname}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
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

(async () => {

    // ---------- Setup ----------
    console.log("SETUP -- platform owner + two tenants + employee fixtures");

    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "Shift Test Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });

    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: platform owner login succeeded", loginRes.status === 200 && !!ownerToken);

    const createA = await apiPost("/api/platform/companies", { companyName: "Shift Test A", companySlug: A_SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: company A created", createA.status === 201);
    const companyAId = createA.body?.company?.id;

    const createB = await apiPost("/api/platform/companies", { companyName: "Shift Test B", companySlug: B_SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: company B created", createB.status === 201);
    const companyBId = createB.body?.company?.id;

    const adminACreate = await apiPost(`/api/platform/companies/${companyAId}/admin`, { name: "Admin A", email: "admin@shifttest-a.test", password: "AdminPass123!Shift_A" }, ownerToken);
    check("SETUP: admin A created", adminACreate.status === 201);
    const adminAEmployeeId = adminACreate.body?.admin?.employeeId;

    const adminBCreate = await apiPost(`/api/platform/companies/${companyBId}/admin`, { name: "Admin B", email: "admin@shifttest-b.test", password: "AdminPass123!Shift_B" }, ownerToken);
    check("SETUP: admin B created", adminBCreate.status === 201);
    const adminBEmployeeId = adminBCreate.body?.admin?.employeeId;

    const loginAdminA = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: adminAEmployeeId, password: "AdminPass123!Shift_A" });
    const tokenAdminA = loginAdminA.body?.token;
    check("SETUP: admin A login succeeded", loginAdminA.status === 200 && !!tokenAdminA);

    const loginAdminB = await apiPost(`/api/tenant-auth/${B_SLUG}/login`, { employeeId: adminBEmployeeId, password: "AdminPass123!Shift_B" });
    const tokenAdminB = loginAdminB.body?.token;
    check("SETUP: admin B login succeeded", loginAdminB.status === 200 && !!tokenAdminB);

    // Directly seed a handful of employee fixtures at different
    // system_access tiers into tenant A -- covers Part 15 items 1/2/13/14
    // without needing a separate "set system access" round-trip per
    // fixture.
    const poolA = getTenantPool(A_DB);
    const employeePasswordHash = await bcrypt.hash("Employee123!Shift", 10);

    async function seedEmployee(employeeId, fullName, systemAccess, designation) {
        const [result] = await poolA.query(
            `INSERT INTO users (employee_id, full_name, email, password, role, system_access, employment_status, status, designation)
             VALUES (?, ?, ?, ?, 'employee', ?, 'active', 'active', ?) RETURNING id`,
            [employeeId, fullName, `${employeeId.toLowerCase()}@shifttest-a.test`, employeePasswordHash, systemAccess, designation]
        );
        return result[0].id;
    }

    const empUserId = await seedEmployee("SE001", "Plain Employee", "employee", "Software Engineer");
    const hrUserId = await seedEmployee("SE002", "HR Person", "hr", "HR Manager");
    const execUserId = await seedEmployee("SE003", "Exec Person", "executive", "VP Engineering");
    const teamLeadUserId = await seedEmployee("SE004", "Team Lead Person", "team_lead", "Team Lead");
    const sysAdminUserId = await seedEmployee("SE005", "System Admin Person", "admin", "Ops Lead");
    const superAdminUserId = await seedEmployee("SE006", "Super Admin Person", "super_admin", "CTO (Chief Technology Officer)");

    check("SETUP: employee fixtures created", !!(empUserId && hrUserId && execUserId && teamLeadUserId && sysAdminUserId && superAdminUserId));

    async function loginAs(employeeId) {
        const res = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId, password: "Employee123!Shift" });
        return res.body?.token;
    }

    const tokenEmp = await loginAs("SE001");
    const tokenHr = await loginAs("SE002");
    const tokenExec = await loginAs("SE003");
    const tokenTeamLead = await loginAs("SE004");
    const tokenSysAdmin = await loginAs("SE005");
    const tokenSuperAdmin = await loginAs("SE006");

    check("SETUP: all fixture logins succeeded", !!(tokenEmp && tokenHr && tokenExec && tokenTeamLead && tokenSysAdmin && tokenSuperAdmin));

    // A near-future Monday so the date range is stable regardless of
    // when this test runs, and never collides with "today".
    const baseMonday = new Date();
    baseMonday.setDate(baseMonday.getDate() + ((8 - baseMonday.getDay()) % 7) + 7);
    const iso = (d) => d.toISOString().slice(0, 10);
    const mon = iso(baseMonday);
    const tue = iso(new Date(baseMonday.getTime() + 86400000));
    const wed = iso(new Date(baseMonday.getTime() + 2 * 86400000));

    // ---------- 1. Employee can view schedule ----------
    console.log("\nTEST 1 -- Employee can view schedule");
    const viewAsEmployee = await apiGet(`/api/shifts?startDate=${mon}&endDate=${wed}`, tokenEmp);
    check("1. Employee GET /api/shifts -> 200", viewAsEmployee.status === 200, JSON.stringify(viewAsEmployee.body));

    // ---------- A/B/C. Employee A (empUserId/tokenEmp) manages OWN schedule ----------
    console.log("\nTEST A/B/C -- Employee A can create, update, delete their OWN schedule (self-service, no userId needed)");
    const selfCreate = await apiPost("/api/shifts", { shiftDate: mon, status: "working", startTime: "10:00", endTime: "19:00" }, tokenEmp);
    check("A. Employee A creates own schedule (no userId in body) -> 201", selfCreate.status === 201, JSON.stringify(selfCreate.body));
    const selfShiftId = selfCreate.body?.id;

    const selfUpdate = await apiPatch(`/api/shifts/${selfShiftId}`, { startTime: "11:00", endTime: "20:00" }, tokenEmp);
    check("B. Employee A updates own schedule -> 200", selfUpdate.status === 200, JSON.stringify(selfUpdate.body));

    const selfDelete = await apiDelete(`/api/shifts/${selfShiftId}`, tokenEmp);
    check("C. Employee A deletes own schedule -> 200", selfDelete.status === 200, JSON.stringify(selfDelete.body));

    const afterSelfDelete = await apiPatch(`/api/shifts/${selfShiftId}`, { notes: "should 404" }, tokenEmp);
    check("C2. Deleted shift no longer found -> 404", afterSelfDelete.status === 404, JSON.stringify(afterSelfDelete.body));

    // Recreate it -- later tests (date range, designation, etc.) expect
    // empUserId to have a Monday entry again.
    const createRes = await apiPost("/api/shifts", { userId: empUserId, shiftDate: mon, status: "working", startTime: "10:00", endTime: "19:00" }, tokenAdminA);
    check("SETUP: re-seed Employee A's Monday entry (via role=admin override) -> 201", createRes.status === 201, JSON.stringify(createRes.body));
    const createdShiftId = createRes.body?.id;

    // ---------- D/E/F/G. Employee A vs Employee B's schedule ----------
    console.log("\nTEST D/E/F/G -- Employee A can VIEW but never modify Employee B's (hrUserId) schedule");
    const employeeBOwnShift = await apiPost("/api/shifts", { shiftDate: tue, status: "working", startTime: "09:00", endTime: "17:00" }, tokenHr);
    check("SETUP: Employee B (hrUserId) creates their own Tuesday shift -> 201", employeeBOwnShift.status === 201, JSON.stringify(employeeBOwnShift.body));
    const employeeBShiftId = employeeBOwnShift.body?.id;

    // Corrected visibility model: Employee A's DEFAULT list view (no
    // ?userId=) is now self-only -- Employee B's entry must NOT appear
    // there. Viewing a SPECIFIC other person is still allowed, but only
    // via the explicit ?userId= parameter (or /search below) -- never
    // the default board. This replaces the old "everyone sees
    // everyone's schedule by default" assertion.
    const employeeAViewsDefault = await apiGet(`/api/shifts?startDate=${tue}&endDate=${tue}`, tokenEmp);
    const seesEmployeeBByDefault = (employeeAViewsDefault.body?.shifts || []).some((s) => s.user_id === hrUserId);
    check("D. Employee A's DEFAULT list view does NOT include Employee B (self-only by default)", employeeAViewsDefault.status === 200 && !seesEmployeeBByDefault, JSON.stringify(employeeAViewsDefault.body?.shifts));

    const employeeAViewsBExplicitly = await apiGet(`/api/shifts?startDate=${tue}&endDate=${tue}&userId=${hrUserId}`, tokenEmp);
    const seesEmployeeBExplicitly = (employeeAViewsBExplicitly.body?.shifts || []).some((s) => s.user_id === hrUserId);
    check("D2. Employee A CAN still view Employee B's schedule via explicit ?userId= (organization-wide 'view a particular person')", employeeAViewsBExplicitly.status === 200 && seesEmployeeBExplicitly, JSON.stringify(employeeAViewsBExplicitly.body?.shifts));

    const employeeATriesCreateForB = await apiPost("/api/shifts", { userId: hrUserId, shiftDate: wed, status: "working", startTime: "09:00", endTime: "18:00" }, tokenEmp);
    check("E. Employee A CANNOT create a schedule for Employee B -> 403", employeeATriesCreateForB.status === 403, JSON.stringify(employeeATriesCreateForB.body));

    const employeeATriesUpdateB = await apiPatch(`/api/shifts/${employeeBShiftId}`, { notes: "hijacked" }, tokenEmp);
    check("F. Employee A CANNOT update Employee B's schedule -> 403", employeeATriesUpdateB.status === 403, JSON.stringify(employeeATriesUpdateB.body));

    const employeeATriesDeleteB = await apiDelete(`/api/shifts/${employeeBShiftId}`, tokenEmp);
    check("G. Employee A CANNOT delete Employee B's schedule -> 403", employeeATriesDeleteB.status === 403, JSON.stringify(employeeATriesDeleteB.body));

    // ---------- I. Employee B can manage only Employee B's schedule ----------
    console.log("\nTEST I -- Employee B can manage their OWN schedule but not Employee A's");
    const employeeBUpdatesOwn = await apiPatch(`/api/shifts/${employeeBShiftId}`, { notes: "my own note" }, tokenHr);
    check("I. Employee B can update their OWN schedule -> 200", employeeBUpdatesOwn.status === 200, JSON.stringify(employeeBUpdatesOwn.body));

    const employeeBTriesUpdateA = await apiPatch(`/api/shifts/${createdShiftId}`, { notes: "hijacked" }, tokenHr);
    check("I2. Employee B CANNOT update Employee A's schedule -> 403", employeeBTriesUpdateA.status === 403, JSON.stringify(employeeBTriesUpdateA.body));

    const employeeBDeletesOwn = await apiDelete(`/api/shifts/${employeeBShiftId}`, tokenHr);
    check("I3. Employee B can delete their OWN schedule -> 200", employeeBDeletesOwn.status === 200, JSON.stringify(employeeBDeletesOwn.body));

    // ---------- role='admin' retains an explicit override ----------
    console.log("\nTEST -- role='admin' retains an explicit administrative override (create/update/delete for ANOTHER user)");
    const updateRes = await apiPatch(`/api/shifts/${createdShiftId}`, { startTime: "11:00", endTime: "20:00" }, tokenAdminA);
    check("Admin override: update Employee A's schedule -> 200", updateRes.status === 200, JSON.stringify(updateRes.body));

    const deleteRes = await apiDelete(`/api/shifts/${createdShiftId}`, tokenAdminA);
    check("Admin override: delete Employee A's schedule -> 200", deleteRes.status === 200, JSON.stringify(deleteRes.body));

    const afterDelete = await apiPatch(`/api/shifts/${createdShiftId}`, { notes: "should 404" }, tokenAdminA);
    check("Deleted shift no longer found -> 404", afterDelete.status === 404, JSON.stringify(afterDelete.body));

    // ---------- 6. Invalid employee ID rejected ----------
    console.log("\nTEST 6 -- Invalid employee id rejected");
    const invalidEmployee = await apiPost("/api/shifts", { userId: 9999999, shiftDate: mon, status: "working", startTime: "09:00", endTime: "18:00" }, tokenAdminA);
    check("6. Nonexistent user id -> 400", invalidEmployee.status === 400, JSON.stringify(invalidEmployee.body));

    // ---------- 7. Cross-tenant employee ID rejected ----------
    console.log("\nTEST 7 -- Cross-tenant employee id rejected");
    // adminBCreate's own user id, from tenant B, used against tenant A's
    // route. Tenant ids are small per-tenant IDENTITY sequences (not
    // globally unique), so it is possible for tenant B's admin id to
    // numerically coincide with a real, different user already seeded
    // in tenant A -- guard against that false negative explicitly
    // rather than assuming no collision.
    const crossTenantUserIdRaw = adminBCreate.body?.admin?.id;
    const [collisionCheck] = await poolA.query(`SELECT id FROM users WHERE id = ?`, [crossTenantUserIdRaw]);
    const crossTenantUserId = collisionCheck.length > 0 ? crossTenantUserIdRaw + 100000 : crossTenantUserIdRaw;
    const crossTenantAttempt = await apiPost("/api/shifts", { userId: crossTenantUserId, shiftDate: mon, status: "working", startTime: "09:00", endTime: "18:00" }, tokenAdminA);
    check("7. Cross-tenant user id rejected -> 400", crossTenantAttempt.status === 400, JSON.stringify(crossTenantAttempt.body));

    // ---------- 8. Cross-tenant schedule access rejected ----------
    console.log("\nTEST 8 -- Tenant B cannot see Tenant A's schedule");
    await apiPost("/api/shifts", { userId: empUserId, shiftDate: mon, status: "working", startTime: "09:00", endTime: "18:00" }, tokenAdminA);
    const viewAsTenantB = await apiGet(`/api/shifts?startDate=${mon}&endDate=${wed}`, tokenAdminB);
    check("H. Cross-tenant schedule access remains impossible -- Tenant B's own schedule view has zero Tenant A entries", viewAsTenantB.status === 200 && (viewAsTenantB.body?.shifts || []).length === 0, JSON.stringify(viewAsTenantB.body));

    // ---------- 9. Date range filtering ----------
    console.log("\nTEST 9 -- Date range filtering");
    await apiPost("/api/shifts", { userId: hrUserId, shiftDate: tue, status: "working", startTime: "09:00", endTime: "18:00" }, tokenAdminA);
    await apiPost("/api/shifts", { userId: execUserId, shiftDate: wed, status: "working", startTime: "09:00", endTime: "18:00" }, tokenAdminA);

    const mondayOnly = await apiGet(`/api/shifts?startDate=${mon}&endDate=${mon}`, tokenAdminA);
    const mondayDates = (mondayOnly.body?.shifts || []).map((s) => s.shift_date);
    check("9. startDate=endDate=Monday returns only Monday entries", mondayOnly.status === 200 && mondayDates.every((d) => String(d).startsWith(mon)), JSON.stringify(mondayDates));

    const fullRange = await apiGet(`/api/shifts?startDate=${mon}&endDate=${wed}`, tokenAdminA);
    check("9b. Full Mon-Wed range returns all 3 entries", (fullRange.body?.shifts || []).length === 3, JSON.stringify(fullRange.body?.shifts?.map((s) => s.shift_date)));

    // ---------- 10. WORKING/OFF/LEAVE statuses ----------
    console.log("\nTEST 10 -- WORKING/OFF/LEAVE statuses");
    const offRes = await apiPost("/api/shifts", { userId: teamLeadUserId, shiftDate: mon, status: "off" }, tokenAdminA);
    check("10a. OFF shift created -> 201", offRes.status === 201, JSON.stringify(offRes.body));

    const leaveRes = await apiPost("/api/shifts", { userId: teamLeadUserId, shiftDate: tue, status: "leave" }, tokenAdminA);
    check("10b. LEAVE shift created -> 201", leaveRes.status === 201, JSON.stringify(leaveRes.body));

    const rangeAfterOffLeave = await apiGet(`/api/shifts?startDate=${mon}&endDate=${tue}`, tokenAdminA);
    const teamLeadEntries = (rangeAfterOffLeave.body?.shifts || []).filter((s) => s.user_id === teamLeadUserId);
    check(
        "10c. OFF/LEAVE entries have null start/end time",
        teamLeadEntries.length === 2 && teamLeadEntries.every((s) => s.start_time === null && s.end_time === null),
        JSON.stringify(teamLeadEntries)
    );

    // ---------- 11. Start/end validation ----------
    console.log("\nTEST 11 -- Start/end time validation");
    const noTimes = await apiPost("/api/shifts", { userId: sysAdminUserId, shiftDate: mon, status: "working" }, tokenAdminA);
    check("11a. WORKING with no times -> 400", noTimes.status === 400, JSON.stringify(noTimes.body));

    const reversedTimes = await apiPost("/api/shifts", { userId: sysAdminUserId, shiftDate: mon, status: "working", startTime: "18:00", endTime: "09:00" }, tokenAdminA);
    check("11b. start >= end -> 400", reversedTimes.status === 400, JSON.stringify(reversedTimes.body));

    // ---------- 12. Designation returned correctly ----------
    console.log("\nTEST 12 -- Designation is returned in the schedule response");
    const withDesignation = await apiGet(`/api/shifts?startDate=${mon}&endDate=${mon}`, tokenAdminA);
    const empEntry = (withDesignation.body?.shifts || []).find((s) => s.user_id === empUserId);
    check("J. Designation is correctly returned/displayed", empEntry?.designation === "Software Engineer", JSON.stringify(empEntry));

    // ---------- 13. Admin/Super Admin RETAIN the explicit override (system_access tier, not role) ----------
    console.log("\nTEST 13 -- system_access='admin'/'super_admin' (role still 'employee') retain the administrative override");
    const sysAdminCreates = await apiPost("/api/shifts", { userId: hrUserId, shiftDate: wed, status: "working", startTime: "09:00", endTime: "17:00" }, tokenSysAdmin);
    check("13a. system_access='admin' CAN create for another employee (override) -> 201", sysAdminCreates.status === 201, JSON.stringify(sysAdminCreates.body));

    const superAdminCreates = await apiPost("/api/shifts", { userId: execUserId, shiftDate: mon, status: "working", startTime: "09:00", endTime: "17:00" }, tokenSuperAdmin);
    check("13b. system_access='super_admin' CAN create for another employee (override) -> 201", superAdminCreates.status === 201, JSON.stringify(superAdminCreates.body));

    // ---------- 14. Corrected model: HR/Executive/Team Lead/Manager/Department Head are SELF-SERVICE ONLY ----------
    // This is the key behavior change from the original Phase 17b
    // permission model: HR and Executive no longer get a company-wide
    // override just because of their tier label -- only role='admin'
    // or system_access in ('admin','super_admin') do (see TEST 13 and
    // the role='admin' override block above). Every other tier,
    // including HR and Executive, is identical to a plain Employee for
    // shift-schedule purposes: view everyone, edit only your own.
    console.log("\nTEST 14 -- HR/Executive/Team Lead are self-service ONLY -- none may create for another employee");
    const hrTriesCreateForOther = await apiPost("/api/shifts", { userId: teamLeadUserId, shiftDate: wed, status: "working", startTime: "09:00", endTime: "17:00" }, tokenHr);
    check("14a. system_access='hr' CANNOT create for another employee -> 403", hrTriesCreateForOther.status === 403, JSON.stringify(hrTriesCreateForOther.body));

    const execTriesCreateForOther = await apiPost("/api/shifts", { userId: sysAdminUserId, shiftDate: tue, status: "off" }, tokenExec);
    check("14b. system_access='executive' CANNOT create for another employee -> 403", execTriesCreateForOther.status === 403, JSON.stringify(execTriesCreateForOther.body));

    const teamLeadTriesCreate = await apiPost("/api/shifts", { userId: empUserId, shiftDate: wed, status: "off" }, tokenTeamLead);
    check("14c. system_access='team_lead' cannot create for another employee -> 403", teamLeadTriesCreate.status === 403, JSON.stringify(teamLeadTriesCreate.body));

    // But every one of these tiers CAN manage their OWN schedule.
    const hrCreatesOwn = await apiPost("/api/shifts", { shiftDate: mon, status: "working", startTime: "09:00", endTime: "17:00" }, tokenHr);
    check("14d. system_access='hr' CAN create their OWN schedule -> 201", hrCreatesOwn.status === 201, JSON.stringify(hrCreatesOwn.body));

    const execCreatesOwn = await apiPost("/api/shifts", { shiftDate: tue, status: "leave" }, tokenExec);
    check("14e. system_access='executive' CAN create their OWN schedule -> 201", execCreatesOwn.status === 201, JSON.stringify(execCreatesOwn.body));

    const teamLeadCreatesOwn = await apiPost("/api/shifts", { shiftDate: wed, status: "off" }, tokenTeamLead);
    check("14f. system_access='team_lead' CAN create their OWN schedule -> 201", teamLeadCreatesOwn.status === 201, JSON.stringify(teamLeadCreatesOwn.body));

    const teamLeadCanView = await apiGet(`/api/shifts?startDate=${mon}&endDate=${wed}`, tokenTeamLead);
    check("14d. system_access='team_lead' can still VIEW -> 200", teamLeadCanView.status === 200, JSON.stringify(teamLeadCanView.body));

    // ---------- 15. MANAGER TIER -- self + direct reports only ----------
    console.log("\nTEST 15 -- Manager sees self + direct reports only, never another team, and cannot bypass via ?userId=");

    const managerUserId = await seedEmployee("SE007", "Manager Person", "manager", "Engineering Manager");
    const reportOneUserId = await seedEmployee("SE008", "Report One", "employee", "Engineer I");
    const reportTwoUserId = await seedEmployee("SE009", "Report Two", "employee", "Engineer II");
    const outsiderUserId = await seedEmployee("SE010", "Outsider Person", "employee", "Designer");

    await poolA.query(`UPDATE users SET reporting_manager_id = ? WHERE id IN (?, ?)`, [managerUserId, reportOneUserId, reportTwoUserId]);

    const tokenManager = await loginAs("SE007");
    const tokenReportOne = await loginAs("SE008");
    const tokenOutsider = await loginAs("SE010");
    check("15 SETUP: manager + team fixtures created and logged in", !!(tokenManager && tokenReportOne && tokenOutsider));

    // Give each fixture a shift on `mon` so the visibility checks below
    // have something concrete to look for.
    await apiPost("/api/shifts", { shiftDate: mon, status: "working", startTime: "09:00", endTime: "17:00" }, tokenManager);
    await apiPost("/api/shifts", { shiftDate: mon, status: "working", startTime: "09:00", endTime: "17:00" }, tokenReportOne);
    await apiPost("/api/shifts", { userId: reportTwoUserId, shiftDate: mon, status: "working", startTime: "09:00", endTime: "17:00" }, tokenAdminA);
    await apiPost("/api/shifts", { shiftDate: mon, status: "working", startTime: "09:00", endTime: "17:00" }, tokenOutsider);

    const managerDefaultView = await apiGet(`/api/shifts?startDate=${mon}&endDate=${mon}`, tokenManager);
    const managerVisibleIds = (managerDefaultView.body?.shifts || []).map((s) => s.user_id);
    check(
        "15a. Manager's default view includes self + BOTH direct reports",
        managerDefaultView.status === 200 &&
            managerVisibleIds.includes(managerUserId) &&
            managerVisibleIds.includes(reportOneUserId) &&
            managerVisibleIds.includes(reportTwoUserId),
        JSON.stringify(managerVisibleIds)
    );
    check(
        "15b. Manager's default view does NOT include the outsider (different team)",
        !managerVisibleIds.includes(outsiderUserId),
        JSON.stringify(managerVisibleIds)
    );

    const managerViewsReportExplicitly = await apiGet(`/api/shifts?startDate=${mon}&endDate=${mon}&userId=${reportOneUserId}`, tokenManager);
    check(
        "15c. Manager CAN explicitly view a direct report's schedule via ?userId= -> 200",
        managerViewsReportExplicitly.status === 200 && (managerViewsReportExplicitly.body?.shifts || []).some((s) => s.user_id === reportOneUserId),
        JSON.stringify(managerViewsReportExplicitly.body)
    );

    const managerTriesOutsiderViaParam = await apiGet(`/api/shifts?startDate=${mon}&endDate=${mon}&userId=${outsiderUserId}`, tokenManager);
    check("15d. Manager CANNOT view the outsider's schedule via ?userId= -> 403 (cannot bypass team scoping via API parameter manipulation)", managerTriesOutsiderViaParam.status === 403, JSON.stringify(managerTriesOutsiderViaParam.body));

    const managerTriesNonexistentUserId = await apiGet(`/api/shifts?startDate=${mon}&endDate=${mon}&userId=9999999`, tokenManager);
    check("15e. Manager requesting a nonexistent user id -> also 403 (same generic message, does not leak existence)", managerTriesNonexistentUserId.status === 403, JSON.stringify(managerTriesNonexistentUserId.body));

    // Manager tier gets no NEW write capability from this visibility
    // change -- still cannot edit a direct report's schedule (unchanged
    // write-side ownership boundary, isAdminTier only).
    const reportOneShiftLookup = await apiGet(`/api/shifts?startDate=${mon}&endDate=${mon}&userId=${reportOneUserId}`, tokenManager);
    const reportOneShiftId = reportOneShiftLookup.body?.shifts?.[0]?.id;
    const managerTriesEditReport = await apiPatch(`/api/shifts/${reportOneShiftId}`, { notes: "manager edit attempt" }, tokenManager);
    check("15f. Manager still CANNOT edit a direct report's schedule (visibility != write access) -> 403", managerTriesEditReport.status === 403, JSON.stringify(managerTriesEditReport.body));

    // Department filter is Admin/Super Admin only.
    const managerTriesDepartmentFilter = await apiGet(`/api/shifts?startDate=${mon}&endDate=${mon}&departmentId=1`, tokenManager);
    check("15g. Non-admin-tier caller using ?departmentId= -> 403", managerTriesDepartmentFilter.status === 403, JSON.stringify(managerTriesDepartmentFilter.body));

    // ---------- 16. SEARCH ENDPOINT ----------
    console.log("\nTEST 16 -- /api/shifts/search respects the same visibility model, is case-insensitive, supports partial match");

    const employeeSearchesOutsider = await apiGet(`/api/shifts/search?q=outsider&date=${mon}`, tokenEmp);
    check(
        "16a. Plain Employee CAN search organization-wide and find someone outside any team relationship",
        employeeSearchesOutsider.status === 200 && (employeeSearchesOutsider.body?.results || []).some((r) => r.userId === outsiderUserId),
        JSON.stringify(employeeSearchesOutsider.body)
    );

    const caseInsensitiveSearch = await apiGet(`/api/shifts/search?q=OUTSIDER&date=${mon}`, tokenEmp);
    check("16b. Search is case-insensitive", caseInsensitiveSearch.status === 200 && (caseInsensitiveSearch.body?.results || []).some((r) => r.userId === outsiderUserId), JSON.stringify(caseInsensitiveSearch.body));

    const partialSearch = await apiGet(`/api/shifts/search?q=Report&date=${mon}`, tokenEmp);
    const partialMatchIds = (partialSearch.body?.results || []).map((r) => r.userId);
    check("16c. Partial name match finds BOTH 'Report One' and 'Report Two'", partialMatchIds.includes(reportOneUserId) && partialMatchIds.includes(reportTwoUserId), JSON.stringify(partialMatchIds));

    const managerSearchesTeamMember = await apiGet(`/api/shifts/search?q=${encodeURIComponent("Report One")}&date=${mon}`, tokenManager);
    check("16d. Manager searching finds their OWN team member", managerSearchesTeamMember.status === 200 && (managerSearchesTeamMember.body?.results || []).some((r) => r.userId === reportOneUserId), JSON.stringify(managerSearchesTeamMember.body));

    const managerSearchesOutsider = await apiGet(`/api/shifts/search?q=Outsider&date=${mon}`, tokenManager);
    check("16e. Manager searching does NOT find someone outside their team (search is scoped, not just the list view)", managerSearchesOutsider.status === 200 && (managerSearchesOutsider.body?.results || []).length === 0, JSON.stringify(managerSearchesOutsider.body));

    const searchMissingQuery = await apiGet(`/api/shifts/search?date=${mon}`, tokenEmp);
    check("16f. Search with no q param -> 400", searchMissingQuery.status === 400, JSON.stringify(searchMissingQuery.body));

    const searchIncludesShiftTime = (employeeSearchesOutsider.body?.results || []).find((r) => r.userId === outsiderUserId);
    check(
        "16g. Search result includes that day's shift status/start time for a matched employee",
        searchIncludesShiftTime?.status === "working" && String(searchIncludesShiftTime?.startTime).startsWith("09:00"),
        JSON.stringify(searchIncludesShiftTime)
    );

    // ---------- Bulk save ----------
    console.log("\nEXTRA -- bulk save endpoint");
    const bulkRes = await apiPost("/api/shifts/bulk", {
        shifts: [
            { userId: empUserId, shiftDate: tue, status: "working", startTime: "09:00", endTime: "17:00" },
            { userId: hrUserId, shiftDate: mon, status: "off" },
        ],
    }, tokenAdminA);
    check("EXTRA: bulk save -> 200 all succeeded", bulkRes.status === 200 && bulkRes.body?.success === true, JSON.stringify(bulkRes.body));

    const bulkWithBadEntry = await apiPost("/api/shifts/bulk", {
        shifts: [
            { userId: 9999999, shiftDate: mon, status: "working", startTime: "09:00", endTime: "17:00" },
        ],
    }, tokenAdminA);
    check("EXTRA: bulk save with only a bad entry -> 400, success:false", bulkWithBadEntry.status === 400 && bulkWithBadEntry.body?.success === false, JSON.stringify(bulkWithBadEntry.body));

    // Ownership is enforced per-entry in bulk too -- a plain employee
    // cannot use /shifts/bulk to write another employee's schedule.
    const bulkOwnershipViolation = await apiPost("/api/shifts/bulk", {
        shifts: [{ userId: hrUserId, shiftDate: wed, status: "off" }],
    }, tokenEmp);
    check(
        "EXTRA: bulk save entry for another employee, by a non-admin-tier caller -> reported as failed, not silently written",
        bulkOwnershipViolation.body?.results?.[0]?.success === false,
        JSON.stringify(bulkOwnershipViolation.body)
    );

    // ---------- Duplicate conflict handling ----------
    console.log("\nEXTRA -- duplicate entry conflict handling");
    const duplicateAttempt = await apiPost("/api/shifts", { userId: empUserId, shiftDate: tue, status: "working", startTime: "09:00", endTime: "17:00" }, tokenAdminA);
    check("EXTRA: creating a second entry for the same employee+date -> 409", duplicateAttempt.status === 409, JSON.stringify(duplicateAttempt.body));

    // ---------- History table populated ----------
    console.log("\nEXTRA -- shift_schedule_history recorded");
    const [historyRows] = await poolA.query(`SELECT action FROM shift_schedule_history ORDER BY id ASC`);
    check("EXTRA: history has created/updated/deleted entries", historyRows.some((r) => r.action === "created") && historyRows.some((r) => r.action === "updated") && historyRows.some((r) => r.action === "deleted"), JSON.stringify(historyRows));

    // ---------- Cleanup ----------
    console.log("\nCLEANUP");
    await closeAllTenantPools();
    await tenantProvisioningService.dropProvisionedDatabase(A_DB);
    await tenantProvisioningService.dropProvisionedDatabase(B_DB);
    console.log(`  Dropped "${A_DB}" and "${B_DB}"`);

    await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?)`, [A_SLUG, B_SLUG]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    console.log(`  Deleted company rows and temp platform owner`);

    const aGone = await tenantProvisioningService.databaseExists(A_DB);
    const bGone = await tenantProvisioningService.databaseExists(B_DB);
    check("CLEANUP: tenant A DB gone", aGone === false);
    check("CLEANUP: tenant B DB gone", bGone === false);

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
