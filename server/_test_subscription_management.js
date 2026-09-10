require("dotenv").config();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const platformCompanyService = require("./services/platformCompanyService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { buildTenantDbName } = require("./utils/tenantDbName");
const { PLATFORM_JWT_ISSUER, PLATFORM_JWT_AUDIENCE } = require("./controllers/platformAuthController");

// ==========================================
// SUBSCRIPTION & PLAN MANAGEMENT SELF-TEST (Phase 8)
//
// Exercises the new plan CRUD, company subscription management, and
// subscription-based access enforcement over real HTTP against a
// live backend. Creates exactly ONE temporary Platform Owner, TWO
// temporary companies + tenant databases, and TWO temporary
// subscription plans -- all deleted at the end. Never touches
// reinsteins_workhub or the Reinsteins company/subscription row.
// ==========================================

const BASE_URL = "http://localhost:5000";

const OWNER_EMAIL = "subtest_owner@groworgs.internal";
const OWNER_PASSWORD = "SubTestOwner!2026Pwd";
const INACTIVE_OWNER_EMAIL = "subtest_inactive_owner@groworgs.internal";

const COMPANY_A_SLUG = "subtest_alpha";
const COMPANY_A_NAME = "SubTest Alpha";
const COMPANY_B_SLUG = "subtest_beta";
const COMPANY_B_NAME = "SubTest Beta";

const ADMIN_PASSWORD = "SubTestAdmin!2026Pwd";

let failures = 0;
function check(label, condition, detail) {
    if (condition) console.log(`  [PASS] ${label}`);
    else { failures++; console.log(`  [FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

async function apiGet(pathname, token) {
    const res = await fetch(`${BASE_URL}${pathname}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
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

async function createCompanyWithAdmin(ownerToken, slug, name) {
    const createRes = await apiPost("/api/platform/companies", { companyName: name, companySlug: slug, accessType: "trial" }, ownerToken);
    if (createRes.status !== 201) throw new Error(`Failed to create company ${slug}: ${JSON.stringify(createRes.body)}`);
    const companyId = createRes.body.company.id;

    const adminEmail = `${slug}_admin@subtest.internal`;
    const adminRes = await apiPost(`/api/platform/companies/${companyId}/admin`, {
        name: `${name} Admin`, email: adminEmail, password: ADMIN_PASSWORD,
    }, ownerToken);
    if (adminRes.status !== 201) throw new Error(`Failed to create admin for ${slug}: ${JSON.stringify(adminRes.body)}`);

    const loginRes = await apiPost(`/api/tenant-auth/${slug}/login`, {
        employeeId: adminRes.body.admin.employeeId, password: ADMIN_PASSWORD,
    });
    if (loginRes.status !== 200) throw new Error(`Failed to log in as ${slug} admin: ${JSON.stringify(loginRes.body)}`);

    return { companyId, token: loginRes.body.token, employeeId: adminRes.body.admin.employeeId };
}

(async () => {

    // ========================================
    // SETUP
    // ========================================
    console.log("SETUP -- platform owner + two tenants + admins");

    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "SubTest Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });

    // ---------- 1. Platform authentication ----------
    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("1. Platform authentication succeeds", loginRes.status === 200 && !!ownerToken, JSON.stringify(loginRes.body));

    const companyA = await createCompanyWithAdmin(ownerToken, COMPANY_A_SLUG, COMPANY_A_NAME);
    const companyB = await createCompanyWithAdmin(ownerToken, COMPANY_B_SLUG, COMPANY_B_NAME);
    check("SETUP: both companies + admins + tenant logins succeed", !!companyA.token && !!companyB.token);

    // ---------- C. Only ACTIVE Platform Owners can manage plans/subscriptions ----------
    const inactiveOwner = await platformUserService.create({
        name: "SubTest Inactive Owner", email: INACTIVE_OWNER_EMAIL, passwordHash, role: "platform_owner",
    });
    await platformPool.query(`UPDATE platform_users SET status = 'inactive' WHERE id = ?`, [inactiveOwner.id]);
    const inactiveOwnerToken = jwt.sign(
        { id: inactiveOwner.id, email: INACTIVE_OWNER_EMAIL, role: "platform_owner" },
        process.env.PLATFORM_JWT_SECRET,
        { expiresIn: "1h", issuer: PLATFORM_JWT_ISSUER, audience: PLATFORM_JWT_AUDIENCE }
    );
    const inactiveOwnerRes = await apiGet("/api/platform/plans", inactiveOwnerToken);
    check("C. Inactive Platform Owner rejected from plan management APIs (401)", inactiveOwnerRes.status === 401, `got ${inactiveOwnerRes.status}`);

    // ========================================
    // 2/3/4. PLAN CREATE / LIST / UPDATE
    // ========================================
    console.log("\nSTEP 2/3/4 -- Plan create / list / update");

    const planSlug = `subtest-plan-${Date.now()}`;
    const createPlanRes = await apiPost("/api/platform/plans", {
        name: "SubTest Plan", slug: planSlug, description: "Temporary test plan",
        employeeLimit: 15, storageLimitMb: 2048, features: { customBranding: true },
    }, ownerToken);
    check("2. Plan creation succeeds", createPlanRes.status === 201 && createPlanRes.body?.plan?.slug === planSlug, JSON.stringify(createPlanRes.body));
    const planId = createPlanRes.body?.plan?.id;

    const dupPlanRes = await apiPost("/api/platform/plans", { name: "Dup", slug: planSlug, employeeLimit: 1 }, ownerToken);
    check("2b. Duplicate plan slug rejected (409)", dupPlanRes.status === 409, `got ${dupPlanRes.status}`);

    const invalidPlanRes = await apiPost("/api/platform/plans", { name: "X" }, ownerToken);
    check("2c. Plan creation missing slug rejected (400)", invalidPlanRes.status === 400, `got ${invalidPlanRes.status}`);

    const listPlansRes = await apiGet("/api/platform/plans", ownerToken);
    const seededSlugs = ["complimentary", "trial", "starter", "professional", "enterprise"];
    const listedSlugs = (listPlansRes.body?.plans || []).map((p) => p.slug);
    check("3. Plan listing succeeds and includes seeded default plans",
        listPlansRes.status === 200 && seededSlugs.every((s) => listedSlugs.includes(s)) && listedSlugs.includes(planSlug),
        JSON.stringify(listedSlugs));

    const updatePlanRes = await apiPatch(`/api/platform/plans/${planId}`, {
        name: "SubTest Plan Updated", employeeLimit: 20, storageLimitMb: 4096, features: {},
    }, ownerToken);
    check("4. Plan update succeeds", updatePlanRes.status === 200 && updatePlanRes.body?.plan?.name === "SubTest Plan Updated" && updatePlanRes.body?.plan?.employeeLimit === 20, JSON.stringify(updatePlanRes.body));

    // ========================================
    // 5/6. DISABLE PLAN + DISABLED-PLAN ASSIGNMENT REJECTION
    // ========================================
    console.log("\nSTEP 5/6 -- Disable plan + disabled-plan assignment rejection");

    const disableRes = await apiPatch(`/api/platform/plans/${planId}/status`, { action: "disable" }, ownerToken);
    check("5. Disable plan succeeds", disableRes.status === 200 && disableRes.body?.plan?.status === "inactive", JSON.stringify(disableRes.body));

    const assignDisabledToOtherCompanyRes = await apiPatch(`/api/platform/companies/${companyB.companyId}/subscription`, {
        planId, subscriptionStatus: "active",
    }, ownerToken);
    check("6. Disabled plan assignment to a company NOT already on it is rejected (400)",
        assignDisabledToOtherCompanyRes.status === 400, `got ${assignDisabledToOtherCompanyRes.status}, ${JSON.stringify(assignDisabledToOtherCompanyRes.body)}`);

    // ========================================
    // 7. COMPANY PLAN ASSIGNMENT
    // ========================================
    console.log("\nSTEP 7 -- Company plan assignment");

    // Re-enable the plan so this specific assignment test is clean;
    // the disabled-plan rejection above already proved (6).
    await apiPatch(`/api/platform/plans/${planId}/status`, { action: "enable" }, ownerToken);

    const assignRes = await apiPatch(`/api/platform/companies/${companyA.companyId}/subscription`, {
        planId, subscriptionStatus: "active",
    }, ownerToken);
    check("7. Company plan assignment succeeds", assignRes.status === 200 && assignRes.body?.company?.subscription?.planId === planId, JSON.stringify(assignRes.body));

    // Now the "already-assigned exception" (G): disable the plan
    // again, then confirm companyA (already on it) can still be
    // re-saved on the SAME plan without being rejected.
    await apiPatch(`/api/platform/plans/${planId}/status`, { action: "disable" }, ownerToken);
    const reassignSamePlanRes = await apiPatch(`/api/platform/companies/${companyA.companyId}/subscription`, {
        planId, subscriptionStatus: "active",
    }, ownerToken);
    check("7b (G exception). Company already on a since-disabled plan can still be re-saved on it", reassignSamePlanRes.status === 200, JSON.stringify(reassignSamePlanRes.body));
    // Re-enable for the rest of the test.
    await apiPatch(`/api/platform/plans/${planId}/status`, { action: "enable" }, ownerToken);

    const invalidPlanIdRes = await apiPatch(`/api/platform/companies/${companyA.companyId}/subscription`, {
        planId: 999999999, subscriptionStatus: "active",
    }, ownerToken);
    check("F. Invalid plan id rejected (400)", invalidPlanIdRes.status === 400, `got ${invalidPlanIdRes.status}`);

    // ========================================
    // 8. TRIAL COMPANY BEHAVIOR
    // ========================================
    console.log("\nSTEP 8 -- Trial company behavior");

    const [[trialPlanRow]] = await platformPool.query(`SELECT id FROM subscription_plans WHERE slug = 'trial'`);
    const futureTrialEnd = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now

    const trialSetupRes = await apiPatch(`/api/platform/companies/${companyB.companyId}/subscription`, {
        planId: trialPlanRow.id, subscriptionStatus: "trial", trialEndsAt: futureTrialEnd,
    }, ownerToken);
    check("8. Trial subscription (not yet expired) assigned", trialSetupRes.status === 200, JSON.stringify(trialSetupRes.body));

    const trialLoginRes = await apiPost(`/api/tenant-auth/${COMPANY_B_SLUG}/login`, {
        employeeId: companyB.employeeId, password: ADMIN_PASSWORD,
    });
    check("8b. Trial company (not yet expired) can still log in", trialLoginRes.status === 200 && !!trialLoginRes.body?.token, JSON.stringify(trialLoginRes.body));

    const trialApiRes = await apiGet("/api/departments", trialLoginRes.body?.token);
    check("8c. Trial company (not yet expired) can use protected APIs", trialApiRes.status === 200, `got ${trialApiRes.status}`);

    // ========================================
    // 9. EXPIRED COMPANY LOGIN REJECTION
    // ========================================
    console.log("\nSTEP 9 -- Expired company login rejection");

    const pastTrialEnd = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    const expireRes = await apiPatch(`/api/platform/companies/${companyB.companyId}/subscription`, {
        planId: trialPlanRow.id, subscriptionStatus: "trial", trialEndsAt: pastTrialEnd,
    }, ownerToken);
    check("SETUP: trial end date moved into the past", expireRes.status === 200);

    const expiredLoginRes = await apiPost(`/api/tenant-auth/${COMPANY_B_SLUG}/login`, {
        employeeId: companyB.employeeId, password: ADMIN_PASSWORD,
    });
    check("9 (H). Expired trial company login rejected (403) with a professional message",
        expiredLoginRes.status === 403 && /contact your administrator|platform owner/i.test(expiredLoginRes.body?.message || ""),
        JSON.stringify(expiredLoginRes.body));

    // ========================================
    // 10. EXISTING TOKEN REJECTION AFTER EXPIRY
    // ========================================
    console.log("\nSTEP 10 -- Existing token rejected after subscription expiry (I)");

    // trialLoginRes.body.token was issued BEFORE the expiry above,
    // while the subscription was still valid.
    const staleTokenRes = await apiGet("/api/departments", trialLoginRes.body?.token);
    check("10 (I). Pre-expiry token now rejected by tenantProtect (401)", staleTokenRes.status === 401, `got ${staleTokenRes.status}`);

    // Restore companyB to a valid state for the isolation checks below.
    await apiPatch(`/api/platform/companies/${companyB.companyId}/subscription`, {
        planId: trialPlanRow.id, subscriptionStatus: "active",
    }, ownerToken);

    // ========================================
    // 11. SUSPENDED COMPANY BEHAVIOR UNCHANGED
    // ========================================
    console.log("\nSTEP 11 -- Suspended company behavior remains unchanged");

    const suspendRes = await apiPatch(`/api/platform/companies/${companyA.companyId}/status`, { action: "suspend" }, ownerToken);
    check("SETUP: companyA suspended", suspendRes.status === 200);

    const suspendedLoginRealRes = await apiPost(`/api/tenant-auth/${COMPANY_A_SLUG}/login`, {
        employeeId: companyA.employeeId, password: ADMIN_PASSWORD,
    });
    check("11. Suspended company login rejected (403), same as before this phase", suspendedLoginRealRes.status === 403, JSON.stringify(suspendedLoginRealRes.body));

    const reactivateRes = await apiPatch(`/api/platform/companies/${companyA.companyId}/status`, { action: "reactivate" }, ownerToken);
    check("SETUP: companyA reactivated for remaining tests", reactivateRes.status === 200);

    // ========================================
    // 12/13. CROSS-BOUNDARY JWT REJECTION
    // ========================================
    console.log("\nSTEP 12/13 -- Tenant JWT vs Platform JWT boundary");

    const tenantOnPlatform = await apiGet("/api/platform/plans", companyB.token);
    check("12 (A/B). Tenant JWT rejected from platform plan APIs (401)", tenantOnPlatform.status === 401, `got ${tenantOnPlatform.status}`);

    const tenantOnPlatformCompanies = await apiPatch(`/api/platform/companies/${companyA.companyId}/subscription`, { planId, subscriptionStatus: "active" }, companyB.token);
    check("12b. Tenant JWT rejected from platform subscription-update API (401)", tenantOnPlatformCompanies.status === 401, `got ${tenantOnPlatformCompanies.status}`);

    const noTokenPlans = await apiGet("/api/platform/plans");
    check("B. Unauthenticated request rejected (401)", noTokenPlans.status === 401, `got ${noTokenPlans.status}`);

    const platformOnTenant = await apiGet("/api/departments", ownerToken);
    check("13. Platform JWT rejected from tenant-protected APIs (401)", platformOnTenant.status === 401, `got ${platformOnTenant.status}`);

    // ========================================
    // 14. CROSS-TENANT ISOLATION REMAINS INTACT
    // ========================================
    console.log("\nSTEP 14 -- Cross-tenant isolation remains intact");

    // A fresh companyB login (its subscription is valid again) must
    // still work and must never be affected by anything done to
    // companyA (suspend/reactivate/plan changes) above.
    const companyBFreshLogin = await apiPost(`/api/tenant-auth/${COMPANY_B_SLUG}/login`, {
        employeeId: companyB.employeeId, password: ADMIN_PASSWORD,
    });
    check("14. Company B login unaffected by Company A's subscription/status changes", companyBFreshLogin.status === 200 && !!companyBFreshLogin.body?.token, JSON.stringify(companyBFreshLogin.body));

    // ========================================
    // 15. TENANT DATABASE UNTOUCHED WHEN CHANGING PLANS
    // ========================================
    console.log("\nSTEP 15 -- Tenant database remains untouched when changing plans");

    const tenantDbNameA = buildTenantDbName(COMPANY_A_SLUG);
    const tenantPoolA = require("./config/tenantConnectionManager").getTenantPool(tenantDbNameA);
    const [[{ tblBefore }]] = await tenantPoolA.query(
        `SELECT COUNT(*) AS "tblBefore" FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const [[{ usersBefore }]] = await tenantPoolA.query(`SELECT COUNT(*) AS "usersBefore" FROM users`);

    await apiPatch(`/api/platform/companies/${companyA.companyId}/subscription`, {
        planId: trialPlanRow.id, subscriptionStatus: "trial", trialEndsAt: futureTrialEnd,
    }, ownerToken);
    await apiPatch(`/api/platform/companies/${companyA.companyId}/subscription`, {
        planId, subscriptionStatus: "active",
    }, ownerToken);

    const [[{ tblAfter }]] = await tenantPoolA.query(
        `SELECT COUNT(*) AS "tblAfter" FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const [[{ usersAfter }]] = await tenantPoolA.query(`SELECT COUNT(*) AS "usersAfter" FROM users`);

    check("15. Tenant database table/user counts unchanged after repeated plan changes",
        Number(tblBefore) === Number(tblAfter) && Number(usersBefore) === Number(usersAfter),
        `tables: ${tblBefore}->${tblAfter}, users: ${usersBefore}->${usersAfter}`);

    const [companyARow] = await platformPool.query(`SELECT tenant_db_name FROM companies WHERE id = ?`, [companyA.companyId]);
    check("E. Client cannot modify tenant database information (tenant_db_name unchanged)", companyARow[0].tenant_db_name === tenantDbNameA, JSON.stringify(companyARow[0]));

    // ========================================
    // D. Client cannot assign arbitrary database names
    // ========================================
    console.log("\nEXTRA -- D. Client cannot assign arbitrary database names via subscription API");
    const arbitraryDbFieldRes = await apiPatch(`/api/platform/companies/${companyA.companyId}/subscription`, {
        planId, subscriptionStatus: "active", tenantDbName: "tenant_reinsteins", tenant_db_name: "tenant_reinsteins",
    }, ownerToken);
    const [companyARowAfter] = await platformPool.query(`SELECT tenant_db_name FROM companies WHERE id = ?`, [companyA.companyId]);
    check("D. tenant_db_name field in request body has no effect", arbitraryDbFieldRes.status === 200 && companyARowAfter[0].tenant_db_name === tenantDbNameA, JSON.stringify(companyARowAfter[0]));

    // ========================================
    // K. No subscription API leaks secrets
    // ========================================
    console.log("\nEXTRA -- K. No subscription API leaks secrets");
    const fullResponseText = JSON.stringify([listPlansRes.body, assignRes.body]);
    check("K. No DB credentials/JWT secrets/password hashes leaked in plan or subscription responses",
        !/DB_PASSWORD|password_hash|JWT_SECRET|PLATFORM_DB_PASSWORD/i.test(fullResponseText));

    // ========================================
    // 16. REINSTEINS VERIFICATION
    // ========================================
    console.log("\nSTEP 16 -- Reinsteins unchanged");

    const dbPool = require("./config/db");
    const [[{ tbl }]] = await dbPool.query(`SELECT COUNT(*) AS tbl FROM information_schema.tables WHERE table_schema = 'public'`);
    const [[{ users }]] = await dbPool.query(`SELECT COUNT(*) AS users FROM users`);
    check("16. reinsteins_workhub unchanged (37 tables, 17 users)", Number(tbl) === 37 && Number(users) === 17, `tables=${tbl} users=${users}`);

    const legacyToken = jwt.sign({ id: 4, employeeId: "PHASE8-LEGACY-TEST", role: "employee" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const legacyDepts = await apiGet("/api/departments", legacyToken);
    check("16b. Legacy Reinsteins token still resolves real business data", legacyDepts.status === 200 && legacyDepts.body?.departments?.length === 3, JSON.stringify(legacyDepts.body));

    const [[reinsteinsRow]] = await platformPool.query(
        `SELECT plan_id, subscription_status, trial_ends_at, subscription_expires_at, sp.slug AS plan_slug
         FROM companies c LEFT JOIN subscription_plans sp ON sp.id = c.plan_id
         WHERE c.company_slug = 'reinsteins'`
    );
    check("16c. Reinsteins subscription untouched (Complimentary, active, no expiry)",
        reinsteinsRow.plan_slug === "complimentary" &&
        reinsteinsRow.subscription_status === "active" &&
        reinsteinsRow.trial_ends_at === null &&
        reinsteinsRow.subscription_expires_at === null,
        JSON.stringify(reinsteinsRow));

    // ========================================
    // No unwanted companies/tenant DBs beyond this test's own two
    // ========================================
    console.log("\nEXTRA -- No unexpected companies or tenant databases beyond this test's own");
    const [allCompanies] = await platformPool.query(`SELECT company_slug FROM companies`);
    const expectedSlugs = new Set(["reinsteins", COMPANY_A_SLUG, COMPANY_B_SLUG]);
    check("No unexpected company rows exist", allCompanies.every((c) => expectedSlugs.has(c.company_slug)) && allCompanies.length === 3, JSON.stringify(allCompanies));

    // ========================================
    // CLEANUP
    // ========================================
    console.log("\nCLEANUP");

    await tenantProvisioningService.dropProvisionedDatabase(buildTenantDbName(COMPANY_A_SLUG));
    await tenantProvisioningService.dropProvisionedDatabase(buildTenantDbName(COMPANY_B_SLUG));
    console.log("  Dropped both temporary tenant databases");

    await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?)`, [COMPANY_A_SLUG, COMPANY_B_SLUG]);
    console.log("  Deleted both temporary company rows");

    await platformPool.query(`DELETE FROM subscription_plans WHERE slug = ?`, [planSlug]);
    console.log("  Deleted temporary plan");

    await platformPool.query(`DELETE FROM platform_users WHERE email IN (?, ?)`, [OWNER_EMAIL, INACTIVE_OWNER_EMAIL]);
    console.log("  Deleted temporary platform owner accounts");

    const companyAGone = await platformCompanyService.getCompanyBySlug(COMPANY_A_SLUG);
    const companyBGone = await platformCompanyService.getCompanyBySlug(COMPANY_B_SLUG);
    check("CLEANUP: both temporary company rows confirmed gone", companyAGone === null && companyBGone === null);

    const dbAGone = await tenantProvisioningService.databaseExists(buildTenantDbName(COMPANY_A_SLUG));
    const dbBGone = await tenantProvisioningService.databaseExists(buildTenantDbName(COMPANY_B_SLUG));
    check("CLEANUP: both temporary tenant databases confirmed gone", dbAGone === false && dbBGone === false);

    const [remainingPlans] = await platformPool.query(`SELECT id FROM subscription_plans WHERE slug = ?`, [planSlug]);
    check("CLEANUP: temporary plan confirmed gone", remainingPlans.length === 0);

    const [remainingOwners] = await platformPool.query(`SELECT email FROM platform_users WHERE email IN (?, ?)`, [OWNER_EMAIL, INACTIVE_OWNER_EMAIL]);
    check("CLEANUP: temporary platform owner accounts confirmed gone", remainingOwners.length === 0);

    const [finalCompanies] = await platformPool.query(`SELECT company_slug FROM companies`);
    check("CLEANUP: only Reinsteins remains in companies", finalCompanies.length === 1 && finalCompanies[0].company_slug === "reinsteins", JSON.stringify(finalCompanies));

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
