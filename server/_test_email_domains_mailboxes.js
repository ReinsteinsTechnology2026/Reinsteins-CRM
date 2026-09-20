require("dotenv").config();
const bcrypt = require("bcrypt");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const platformCompanyService = require("./services/platformCompanyService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { buildTenantDbName } = require("./utils/tenantDbName");

// ==========================================
// PHASE 16A -- EMAIL DOMAIN / MAILBOX FOUNDATION SELF-TEST
//
// Real HTTP against the live backend on http://localhost:5000, using
// two throwaway tenant companies provisioned through the real
// platform + tenant-auth APIs -- same pattern as every other
// _test_*.js script in this project. Never touches reinsteins_workhub
// or the real Reinsteins tenant.
//
// This is an APPLICATION-LAYER test suite: it proves the metadata
// model, the cross-tenant authorization boundary, and the domain-
// verification STATE MACHINE all work correctly. It does NOT send or
// receive a real external email -- no mail server is connected yet
// (see the Phase 16A report). The one real external system this
// script touches is actual public DNS, via the /verify endpoint,
// which is expected to correctly report "failed" for the fake .test
// domains used here (they have no real DNS records) -- that failure
// IS the passing behavior for this test, proving verification fails
// closed rather than trusting a client-supplied claim.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "email16a_owner@groworgs.internal";
const OWNER_PASSWORD = "Email16aOwner!2026Pwd";

const A_SLUG = "email16a_a";
const B_SLUG = "email16a_b";
const A_DB = buildTenantDbName(A_SLUG);
const B_DB = buildTenantDbName(B_SLUG);

const ADMIN_A_PASSWORD = "Email16aAdminA!2026";
const ADMIN_B_PASSWORD = "Email16aAdminB!2026";

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

async function apiDelete(pathname, token) {
    const res = await fetch(`${BASE_URL}${pathname}`, { method: "DELETE", headers: token ? { Authorization: `Bearer ${token}` } : {} });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

(async () => {

    // ---------- Setup ----------
    console.log("SETUP -- platform owner + two tenants + admins + one employee each");
    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "Email16A Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: platform owner login", loginRes.status === 200 && !!ownerToken);

    const createA = await apiPost("/api/platform/companies", { companyName: "EMAIL16A CO A", companySlug: A_SLUG, accessType: "trial" }, ownerToken);
    const companyAId = createA.body?.company?.id;
    const createB = await apiPost("/api/platform/companies", { companyName: "EMAIL16A CO B", companySlug: B_SLUG, accessType: "trial" }, ownerToken);
    const companyBId = createB.body?.company?.id;
    check("SETUP: both companies provisioned", createA.status === 201 && createB.status === 201);

    const adminA = await apiPost(`/api/platform/companies/${companyAId}/admin`, { name: "Admin A", email: "admin@email16a-a.test", password: ADMIN_A_PASSWORD }, ownerToken);
    const adminB = await apiPost(`/api/platform/companies/${companyBId}/admin`, { name: "Admin B", email: "admin@email16a-b.test", password: ADMIN_B_PASSWORD }, ownerToken);
    check("SETUP: both company admins created", adminA.status === 201 && adminB.status === 201);

    const loginA = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: adminA.body?.admin?.employeeId, password: ADMIN_A_PASSWORD });
    const loginB = await apiPost(`/api/tenant-auth/${B_SLUG}/login`, { employeeId: adminB.body?.admin?.employeeId, password: ADMIN_B_PASSWORD });
    const tokenA = loginA.body?.token;
    const tokenB = loginB.body?.token;
    check("SETUP: both admin logins succeed", loginA.status === 200 && loginB.status === 200);

    // A plain (non-admin) employee in Company A -- proves the
    // employee self-service path (GET /mailboxes/me) separately from
    // the admin management path.
    const empPasswordHash = await bcrypt.hash("Email16aEmployee!2026", 12);
    const poolA = getTenantPool(A_DB);
    const [[empA]] = await poolA.query(
        `INSERT INTO users (employee_id, full_name, email, password, role, system_access, status) VALUES ('EMP001', 'Employee A', 'emp@email16a-a.test', ?, 'employee', 'employee', 'active') RETURNING id`,
        [empPasswordHash]
    );
    const empLoginA = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: "EMP001", password: "Email16aEmployee!2026" });
    const empTokenA = empLoginA.body?.token;
    check("SETUP: plain employee login succeeds", empLoginA.status === 200 && !!empTokenA);

    // ---------- 1/2. Each company can create its own domain ----------
    console.log("\nTEST 1/2 -- Domain creation");
    const domainRegA = await apiPost("/api/email/domains", { domain: "email16a-a.test" }, tokenA);
    check("1. Company A can create its domain", domainRegA.status === 201 && domainRegA.body?.domain?.domain === "email16a-a.test", JSON.stringify(domainRegA.body));
    const domainAId = domainRegA.body?.domain?.id;

    const domainRegB = await apiPost("/api/email/domains", { domain: "email16a-b.test" }, tokenB);
    check("2. Company B can create its own (different) domain", domainRegB.status === 201, JSON.stringify(domainRegB.body));
    const domainBId = domainRegB.body?.domain?.id;

    // ---------- 3. Company A cannot access Company B's domain ----------
    console.log("\nTEST 3 -- Cross-tenant domain read blocked");
    const crossDnsRead = await apiGet(`/api/email/domains/${domainBId}/dns-instructions`, tokenA);
    check("3. Company A cannot read Company B's domain DNS instructions (404)", crossDnsRead.status === 404, `got ${crossDnsRead.status}`);

    const listA = await apiGet("/api/email/domains", tokenA);
    check("3b. Company A's domain list never includes Company B's domain", listA.status === 200 && !listA.body?.domains?.some((d) => d.id === domainBId), JSON.stringify(listA.body));

    // ---------- 4. Company A cannot modify Company B's domain ----------
    console.log("\nTEST 4 -- Cross-tenant domain modification blocked");
    const crossDelete = await apiDelete(`/api/email/domains/${domainBId}`, tokenA);
    check("4. Company A cannot delete Company B's domain (404)", crossDelete.status === 404, `got ${crossDelete.status}`);
    const crossVerify = await apiPost(`/api/email/domains/${domainBId}/verify`, {}, tokenA);
    check("4b. Company A cannot trigger verification on Company B's domain (404)", crossVerify.status === 404, `got ${crossVerify.status}`);

    // A non-admin employee cannot manage domains at all.
    const employeeDomainAttempt = await apiPost("/api/email/domains", { domain: "employee-should-not.test" }, empTokenA);
    check("EXTRA: a non-admin employee cannot create a domain (403)", employeeDomainAttempt.status === 403, `got ${employeeDomainAttempt.status}`);

    // ---------- 5. Unverified domain cannot create a mailbox ----------
    console.log("\nTEST 5 -- Unverified domain rejected for mailbox creation");
    const mailboxOnUnverified = await apiPost("/api/email/mailboxes", { domainId: domainAId, tenantUserId: empA.id, localPart: "shafiq" }, tokenA);
    check("5. Unverified domain cannot create a mailbox (409)", mailboxOnUnverified.status === 409 && mailboxOnUnverified.body?.code === "DOMAIN_NOT_VERIFIED", JSON.stringify(mailboxOnUnverified.body));

    // Real DNS verification attempt -- email16a-a.test has no real TXT
    // record, so this MUST report failed, never a fabricated success.
    const verifyAttempt = await apiPost(`/api/email/domains/${domainAId}/verify`, {}, tokenA);
    check("EXTRA: real DNS verification correctly reports failed for a domain with no TXT record", verifyAttempt.status === 200 && verifyAttempt.body?.domain?.verification_status === "failed", JSON.stringify(verifyAttempt.body));

    // Directly flip verification_status in the DB to simulate a real,
    // completed DNS verification -- the ONLY place this test bypasses
    // the real service logic, and only because this script cannot
    // control real public DNS for a .test domain. Every check AFTER
    // this point exercises real, unmodified application code again.
    await platformPool.query(`UPDATE email_domains SET verification_status = 'verified', verified_at = NOW() WHERE id = ?`, [domainAId]);
    await platformPool.query(`UPDATE email_domains SET verification_status = 'verified', verified_at = NOW() WHERE id = ?`, [domainBId]);

    // ---------- 6. Verified domain can create a mailbox ----------
    console.log("\nTEST 6/7 -- Mailbox creation");
    const mailboxRes = await apiPost("/api/email/mailboxes", { domainId: domainAId, tenantUserId: empA.id, localPart: "shafiq" }, tokenA);
    check("6. Verified domain can create a mailbox", mailboxRes.status === 201 && mailboxRes.body?.mailbox?.email_address === "shafiq@email16a-a.test", JSON.stringify(mailboxRes.body));
    const mailboxId = mailboxRes.body?.mailbox?.id;

    // ---------- 7. Mailbox belongs to the correct company ----------
    check("7. Mailbox belongs to the correct company", mailboxRes.body?.mailbox?.company_id === companyAId);

    // ---------- 8. Employee can only access their own mailbox ----------
    console.log("\nTEST 8 -- Employee self-service mailbox access");
    const myMailbox = await apiGet("/api/email/mailboxes/me", empTokenA);
    check("8. Employee can access their own mailbox via /me", myMailbox.status === 200 && myMailbox.body?.mailbox?.id === mailboxId, JSON.stringify(myMailbox.body));

    // ---------- 9. Suspended employee cannot get a mailbox created ----------
    console.log("\nTEST 9 -- Suspended employee blocked from mailbox creation");
    await poolA.query(`UPDATE users SET status = 'inactive' WHERE id = ?`, [empA.id]);
    const suspendedMailboxAttempt = await apiPost("/api/email/mailboxes", { domainId: domainAId, tenantUserId: empA.id, localPart: "shafiq2" }, tokenA);
    check("9. Suspended employee cannot have a new mailbox created (409)", suspendedMailboxAttempt.status === 409 && suspendedMailboxAttempt.body?.code === "EMPLOYEE_NOT_ACTIVE", JSON.stringify(suspendedMailboxAttempt.body));
    await poolA.query(`UPDATE users SET status = 'active' WHERE id = ?`, [empA.id]);

    // ---------- 10/11. Cross-tenant mailbox/API access fails ----------
    console.log("\nTEST 10/11 -- Cross-tenant mailbox access blocked");
    const crossMailboxRead = await apiGet(`/api/email/mailboxes/${mailboxId}`, tokenB);
    check("10. Cross-tenant mailbox lookup fails (404)", crossMailboxRead.status === 404, `got ${crossMailboxRead.status}`);

    const crossMailboxPatch = await fetch(`${BASE_URL}/api/email/mailboxes/${mailboxId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenB}` },
        body: JSON.stringify({ status: "suspended" }),
    });
    check("11. Company B cannot update Company A's mailbox status (404)", crossMailboxPatch.status === 404, `got ${crossMailboxPatch.status}`);

    const stillActive = await apiGet(`/api/email/mailboxes/${mailboxId}`, tokenA);
    check("11b. Mailbox A status unaffected by Company B's attempted update", stillActive.body?.mailbox?.status === "active", JSON.stringify(stillActive.body));

    // Mailbox-id guessing across companies -- Company B trying a
    // sequential id near its own mailbox range never resolves to
    // Company A's row (already proven by test 10, re-stated here as
    // an explicit "guessing" scenario per Phase 16A Step 20 item 10).
    const guessAttempt = await apiGet(`/api/email/mailboxes/${mailboxId}`, tokenB);
    check("EXTRA: guessing another company's mailbox id fails the same way (404, not 403 -- no existence signal leaked)", guessAttempt.status === 404);

    // ---------- Existing systems unaffected ----------
    console.log("\nEXTRA -- Existing systems unaffected");
    const noAuthDomains = await apiGet("/api/email/domains");
    check("EXTRA: domain routes require authentication (401)", noAuthDomains.status === 401, `got ${noAuthDomains.status}`);

    const platformOwnerOnTenantEmail = await apiGet("/api/email/domains", ownerToken);
    check("EXTRA: a Platform Owner token cannot use the tenant email routes (401)", platformOwnerOnTenantEmail.status === 401, `got ${platformOwnerOnTenantEmail.status}`);

    // Platform Owner's own email-summary visibility (Step 14) -- counts only.
    const companyDetails = await apiGet(`/api/platform/companies/${companyAId}`, ownerToken);
    check("EXTRA: Platform Owner company-details view includes an email summary (counts only)",
        companyDetails.status === 200 && companyDetails.body?.company?.email?.mailboxCount === 1 && companyDetails.body?.company?.email?.domainCount === 1,
        JSON.stringify(companyDetails.body?.company?.email));
    check("EXTRA: Platform Owner email summary never includes a domain name or mailbox address",
        !JSON.stringify(companyDetails.body?.company?.email || {}).includes("email16a-a.test") && !JSON.stringify(companyDetails.body?.company?.email || {}).includes("shafiq@"));

    // ---------- Reinsteins verification ----------
    console.log("\nEXTRA -- Reinsteins verification");
    const dbPool = require("./config/db");
    // Excludes the platform tables by name -- production's DB_NAME and
    // PLATFORM_DB_NAME are the same database (see schemas/
    // platformSchema.postgresql.sql), so a bare table_schema='public'
    // count would include them (and grow every time this phase adds
    // one, even though the Reinsteins TENANT schema itself hasn't
    // changed) without this exclusion.
    const PLATFORM_TABLE_NAMES = ["platform_users", "subscription_plans", "companies", "demo_requests", "payments", "subscription_history", "platform_audit_logs", "platform_notifications", "email_delivery_logs", "email_domains", "mailboxes", "email_aliases", "mailbox_settings"];
    const [[{ tbl }]] = await dbPool.query(`SELECT COUNT(*) AS tbl FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT IN (${PLATFORM_TABLE_NAMES.map(() => "?").join(",")})`, PLATFORM_TABLE_NAMES);
    const [[{ users }]] = await dbPool.query(`SELECT COUNT(*) AS users FROM users`);
    check("EXTRA: reinsteins tenant unchanged (37 tables, 17 users)", Number(tbl) === 37 && Number(users) === 17, `tables=${tbl} users=${users}`);

    // ---------- Cleanup ----------
    console.log("\nCLEANUP");
    await platformPool.query(`DELETE FROM email_delivery_logs WHERE company_id IN (?, ?)`, [companyAId, companyBId]);
    const [[email16aOwnerRow]] = await platformPool.query(`SELECT id FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    if (email16aOwnerRow) await platformPool.query(`DELETE FROM platform_audit_logs WHERE platform_user_id = ?`, [email16aOwnerRow.id]);

    // mailboxes/domains cascade-delete with their company row (ON
    // DELETE CASCADE, see schemas/platformSchema.postgresql.sql) --
    // no separate cleanup query needed for them.
    await closeAllTenantPools();
    await tenantProvisioningService.dropProvisionedDatabase(A_DB);
    await tenantProvisioningService.dropProvisionedDatabase(B_DB);
    await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?)`, [A_SLUG, B_SLUG]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);

    const [remainingDomains] = await platformPool.query(`SELECT id FROM email_domains WHERE domain IN ('email16a-a.test', 'email16a-b.test')`);
    check("CLEANUP: domains gone (cascade-deleted with their companies)", remainingDomains.length === 0);
    const [remainingCompanies] = await platformPool.query(`SELECT company_slug FROM companies`);
    check("CLEANUP: only Reinsteins remains in companies", remainingCompanies.length === 1 && remainingCompanies[0].company_slug === "reinsteins", JSON.stringify(remainingCompanies));

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
