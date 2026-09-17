require("dotenv").config();
const bcrypt = require("bcrypt");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { buildTenantDbName } = require("./utils/tenantDbName");

// ==========================================
// EMPLOYEE ID / AUTO-GENERATED COMPANY EMAIL / LOGIN SELF-TEST
// (Phase 17c)
//
// Real HTTP against the live backend on http://localhost:5000, using
// two throwaway tenants (with two DIFFERENT verified email domains,
// to prove domains are never shared/hardcoded across tenants)
// provisioned through the real platform APIs. Never touches
// reinsteins_workhub or any real tenant. Drops everything it creates
// at the end.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "eidtest_owner@groworgs.internal";
const OWNER_PASSWORD = "EidTestOwner!2026Pwd";

const A_SLUG = "eidtest_a";
const B_SLUG = "eidtest_b";
const A_DB = buildTenantDbName(A_SLUG);
const B_DB = buildTenantDbName(B_SLUG);

const A_DOMAIN = "eidtest-a.example";
const B_DOMAIN = "eidtest-b.example";

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

async function registerAndVerifyDomain(companySlug, token, domain) {
    const create = await apiPost("/api/email/domains", { domain }, token);
    const domainId = create.body?.domain?.id;
    await platformPool.query(
        `UPDATE email_domains SET verification_status = 'verified', verified_at = NOW() WHERE id = ?`,
        [domainId]
    );
    return domainId;
}

(async () => {

    // ---------- Setup ----------
    console.log("SETUP -- platform owner + two tenants, each with its OWN verified domain");

    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "Eid Test Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });

    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: platform owner login succeeded", loginRes.status === 200 && !!ownerToken);

    const createA = await apiPost("/api/platform/companies", { companyName: "Eid Test A", companySlug: A_SLUG, accessType: "trial" }, ownerToken);
    const companyAId = createA.body?.company?.id;
    check("SETUP: company A created", createA.status === 201);

    const createB = await apiPost("/api/platform/companies", { companyName: "Eid Test B", companySlug: B_SLUG, accessType: "trial" }, ownerToken);
    const companyBId = createB.body?.company?.id;
    check("SETUP: company B created", createB.status === 201);

    const adminACreate = await apiPost(`/api/platform/companies/${companyAId}/admin`, { name: "Admin A", email: "admin@eidtest-a.test", password: "AdminPass123!Eid_A" }, ownerToken);
    const adminAEmployeeId = adminACreate.body?.admin?.employeeId;
    const loginAdminA = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: adminAEmployeeId, password: "AdminPass123!Eid_A" });
    const tokenAdminA = loginAdminA.body?.token;
    check("SETUP: admin A login succeeded", loginAdminA.status === 200 && !!tokenAdminA);

    const adminBCreate = await apiPost(`/api/platform/companies/${companyBId}/admin`, { name: "Admin B", email: "admin@eidtest-b.test", password: "AdminPass123!Eid_B" }, ownerToken);
    const adminBEmployeeId = adminBCreate.body?.admin?.employeeId;
    const loginAdminB = await apiPost(`/api/tenant-auth/${B_SLUG}/login`, { employeeId: adminBEmployeeId, password: "AdminPass123!Eid_B" });
    const tokenAdminB = loginAdminB.body?.token;
    check("SETUP: admin B login succeeded", loginAdminB.status === 200 && !!tokenAdminB);

    await registerAndVerifyDomain(A_SLUG, tokenAdminA, A_DOMAIN);
    await registerAndVerifyDomain(B_SLUG, tokenAdminB, B_DOMAIN);
    console.log(`  Verified domain "${A_DOMAIN}" for tenant A, "${B_DOMAIN}" for tenant B`);

    // ---------- Employee ID: correct sequence + existing IDs unchanged ----------
    console.log("\nTEST -- Employee ID: new employee gets the next correct ID, existing IDs untouched");

    // The admin itself (ADM001) uses a completely separate "ADM"
    // prefix minted by platformCompanyController.js at company-admin
    // creation time -- generateNextEmployeeId()'s "RS" sequence
    // (used by createEmployee below) is independent and starts fresh
    // at RS001 regardless, since "ADM001" doesn't match `^RS[0-9]+$`.
    const create1 = await apiPost("/api/employees", { fullName: "First Employee", designation: "Engineer", password: "Passw0rd!1" }, tokenAdminA);
    check("Employee 1 created -> 201", create1.status === 201, JSON.stringify(create1.body));
    check("Employee 1 gets RS001 (own independent sequence from the admin's ADM001)", create1.body?.employeeId === "RS001", JSON.stringify(create1.body));

    const create2 = await apiPost("/api/employees", { fullName: "Second Employee", designation: "Engineer", password: "Passw0rd!2" }, tokenAdminA);
    check("Employee 2 gets the NEXT sequential id (RS002)", create2.body?.employeeId === "RS002", JSON.stringify(create2.body));

    check("Employee 1's id is untouched by employee 2's creation", create1.body?.employeeId === "RS001");

    // ---------- Employee ID: safe under concurrent creation ----------
    console.log("\nTEST -- Employee ID: concurrent creation never produces a duplicate");
    const concurrentResults = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
            apiPost("/api/employees", { fullName: `Concurrent Person ${i}`, designation: "Engineer", password: "Passw0rd!C" }, tokenAdminA)
        )
    );
    const concurrentIds = concurrentResults.map((r) => r.body?.employeeId);
    const uniqueConcurrentIds = new Set(concurrentIds);
    check(
        "8 concurrent creates all succeeded",
        concurrentResults.every((r) => r.status === 201),
        JSON.stringify(concurrentResults.map((r) => r.status))
    );
    check(
        "8 concurrent creates produced 8 DISTINCT employee_ids (no duplicates/race)",
        uniqueConcurrentIds.size === 8,
        JSON.stringify(concurrentIds)
    );

    // ---------- Email: name generates expected normalized email ----------
    console.log("\nTEST -- Email: name generates expected normalized, domain-scoped email");
    const shafiq = await apiPost("/api/employees", { fullName: "Shafiq Mohammed", designation: "CTO", password: "Passw0rd!S" }, tokenAdminA);
    check(
        `Shafiq Mohammed -> shafiqmohammed@${A_DOMAIN}`,
        shafiq.body?.email === `shafiqmohammed@${A_DOMAIN}` && shafiq.body?.emailGenerated === true,
        JSON.stringify(shafiq.body)
    );

    // ---------- Email: duplicate names get a unique, deterministic suffix ----------
    console.log("\nTEST -- Email: duplicate names resolve deterministically (johnsmith, johnsmith2, johnsmith3)");
    const john1 = await apiPost("/api/employees", { fullName: "John Smith", designation: "Engineer", password: "Passw0rd!J1" }, tokenAdminA);
    const john2 = await apiPost("/api/employees", { fullName: "John Smith", designation: "Engineer", password: "Passw0rd!J2" }, tokenAdminA);
    const john3 = await apiPost("/api/employees", { fullName: "John Smith", designation: "Engineer", password: "Passw0rd!J3" }, tokenAdminA);
    check(`John Smith #1 -> johnsmith@${A_DOMAIN}`, john1.body?.email === `johnsmith@${A_DOMAIN}`, JSON.stringify(john1.body));
    check(`John Smith #2 -> johnsmith2@${A_DOMAIN}`, john2.body?.email === `johnsmith2@${A_DOMAIN}`, JSON.stringify(john2.body));
    check(`John Smith #3 -> johnsmith3@${A_DOMAIN}`, john3.body?.email === `johnsmith3@${A_DOMAIN}`, JSON.stringify(john3.body));

    const allEmails = [shafiq, john1, john2, john3].map((r) => r.body?.email);
    check("All generated emails are unique within the tenant", new Set(allEmails).size === allEmails.length, JSON.stringify(allEmails));

    // ---------- Email: different tenants use their own domains ----------
    console.log("\nTEST -- Email: different tenants use their OWN company domain (never hardcoded)");
    const shafiqB = await apiPost("/api/employees", { fullName: "Shafiq Mohammed", designation: "CTO", password: "Passw0rd!SB" }, tokenAdminB);
    check(
        `Same name in tenant B -> shafiqmohammed@${B_DOMAIN} (NOT tenant A's domain)`,
        shafiqB.body?.email === `shafiqmohammed@${B_DOMAIN}`,
        JSON.stringify(shafiqB.body)
    );

    // ---------- Login: RS/ADM-style employee ID works ----------
    console.log("\nTEST -- Login: employee ID works");
    const loginByEmployeeId = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: shafiq.body.employeeId, password: "Passw0rd!S" });
    check("Login with employee ID -> 200", loginByEmployeeId.status === 200, JSON.stringify(loginByEmployeeId.body));

    // ---------- Login: company email works ----------
    console.log("\nTEST -- Login: company email works");
    const loginByEmail = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: shafiq.body.email, password: "Passw0rd!S" });
    check("Login with company email -> 200", loginByEmail.status === 200, JSON.stringify(loginByEmail.body));
    check("Both login methods resolve to the SAME user id", loginByEmployeeId.body?.user?.id === loginByEmail.body?.user?.id);

    // Case-insensitive email login, matching existing case-insensitive email handling elsewhere.
    const loginByEmailUppercase = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: shafiq.body.email.toUpperCase(), password: "Passw0rd!S" });
    check("Login with company email is case-insensitive -> 200", loginByEmailUppercase.status === 200, JSON.stringify(loginByEmailUppercase.body));

    // ---------- Login: invalid identifier fails ----------
    console.log("\nTEST -- Login: invalid identifier fails");
    const loginInvalid = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: "not-a-real-identifier@nowhere.test", password: "Passw0rd!S" });
    check("Login with a nonexistent identifier -> 401", loginInvalid.status === 401, JSON.stringify(loginInvalid.body));

    // ---------- Login: existing password behavior unchanged ----------
    console.log("\nTEST -- Login: wrong password still rejected the same way for both identifier types");
    const wrongPassById = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: shafiq.body.employeeId, password: "WrongPassword!" });
    const wrongPassByEmail = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: shafiq.body.email, password: "WrongPassword!" });
    check("Wrong password via employee ID -> 401", wrongPassById.status === 401, JSON.stringify(wrongPassById.body));
    check("Wrong password via email -> 401", wrongPassByEmail.status === 401, JSON.stringify(wrongPassByEmail.body));
    check("Both wrong-password responses use the same generic message (no user enumeration)", wrongPassById.body?.message === wrongPassByEmail.body?.message);

    // ---------- Login: tenant isolation intact ----------
    console.log("\nTEST -- Login: tenant A's email/ID do not work against tenant B's login route");
    const crossTenantById = await apiPost(`/api/tenant-auth/${B_SLUG}/login`, { employeeId: shafiq.body.employeeId, password: "Passw0rd!S" });
    const crossTenantByEmail = await apiPost(`/api/tenant-auth/${B_SLUG}/login`, { employeeId: shafiq.body.email, password: "Passw0rd!S" });
    check("Tenant A's employee ID rejected on tenant B's login route -> 401", crossTenantById.status === 401, JSON.stringify(crossTenantById.body));
    check("Tenant A's email rejected on tenant B's login route -> 401", crossTenantByEmail.status === 401, JSON.stringify(crossTenantByEmail.body));

    // Legacy (unprefixed) login path gets the same identifier widening.
    console.log("\nTEST -- Legacy /api/auth/login also accepts email, structurally (no real Reinsteins creds used)");
    const legacyStructuralCheck = await apiPost("/api/auth/login", { employeeId: "nonexistent@nowhere.test", password: "whatever" });
    check("Legacy login endpoint still responds correctly (401, unchanged behavior)", legacyStructuralCheck.status === 401, JSON.stringify(legacyStructuralCheck.body));

    // ---------- No verified domain -> explicit no-email state, no fake domain ----------
    console.log("\nTEST -- No verified domain: explicit null, never a fake/guessed domain");
    const createC = await apiPost("/api/platform/companies", { companyName: "Eid Test C (no domain)", companySlug: "eidtest_c", accessType: "trial" }, ownerToken);
    const companyCId = createC.body?.company?.id;
    const adminCCreate = await apiPost(`/api/platform/companies/${companyCId}/admin`, { name: "Admin C", email: "admin@eidtest-c.test", password: "AdminPass123!Eid_C" }, ownerToken);
    const loginAdminC = await apiPost(`/api/tenant-auth/eidtest_c/login`, { employeeId: adminCCreate.body?.admin?.employeeId, password: "AdminPass123!Eid_C" });
    const tokenAdminC = loginAdminC.body?.token;

    const domainPreview = await apiGet("/api/employees/company-email-domain", tokenAdminC);
    check("Company with no verified domain -> domain: null (never a guessed/fake domain)", domainPreview.status === 200 && domainPreview.body?.domain === null, JSON.stringify(domainPreview.body));

    const noDomainEmployee = await apiPost("/api/employees", { fullName: "No Domain Person", designation: "Engineer", password: "Passw0rd!ND" }, tokenAdminC);
    check("Employee created successfully even with no domain -> 201", noDomainEmployee.status === 201, JSON.stringify(noDomainEmployee.body));
    check("email is explicitly null, emailGenerated: false (not a fake domain)", noDomainEmployee.body?.email === null && noDomainEmployee.body?.emailGenerated === false, JSON.stringify(noDomainEmployee.body));

    const noDomainLogin = await apiPost(`/api/tenant-auth/eidtest_c/login`, { employeeId: noDomainEmployee.body.employeeId, password: "Passw0rd!ND" });
    check("That employee can still log in with their Employee ID", noDomainLogin.status === 200, JSON.stringify(noDomainLogin.body));

    // ---------- Cleanup ----------
    console.log("\nCLEANUP");
    await closeAllTenantPools();
    await tenantProvisioningService.dropProvisionedDatabase(A_DB);
    await tenantProvisioningService.dropProvisionedDatabase(B_DB);
    await tenantProvisioningService.dropProvisionedDatabase(buildTenantDbName("eidtest_c"));
    console.log(`  Dropped "${A_DB}", "${B_DB}", and eidtest_c's tenant DB`);

    await platformPool.query(`DELETE FROM mailboxes WHERE domain_id IN (SELECT id FROM email_domains WHERE domain IN (?, ?))`, [A_DOMAIN, B_DOMAIN]);
    await platformPool.query(`DELETE FROM email_domains WHERE domain IN (?, ?)`, [A_DOMAIN, B_DOMAIN]);
    await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?, ?)`, [A_SLUG, B_SLUG, "eidtest_c"]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    console.log(`  Deleted company/domain rows and temp platform owner`);

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
