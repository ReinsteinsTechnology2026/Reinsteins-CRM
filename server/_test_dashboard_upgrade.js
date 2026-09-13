require("dotenv").config();
const bcrypt = require("bcrypt");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const platformCompanyService = require("./services/platformCompanyService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { buildTenantDbName } = require("./utils/tenantDbName");

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "dash2check_owner@groworgs.internal";
const OWNER_PASSWORD = "Dash2CheckOwner!2026Pwd";
const SLUG = "dash2check_co";

let failures = 0;
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
async function apiPatch(p, body, token) {
    const res = await fetch(`${BASE_URL}${p}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, body: json };
}

(async () => {

    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "Dash2Check Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const token = loginRes.body?.token;
    check("owner login", loginRes.status === 200 && !!token);

    // ---------- Password change ----------
    const wrongCurrent = await apiPatch("/api/platform/auth/password", { currentPassword: "wrong", newPassword: "NewPassword12345" }, token);
    check("password change rejects wrong current password (401)", wrongCurrent.status === 401, `got ${wrongCurrent.status}`);

    const tooShort = await apiPatch("/api/platform/auth/password", { currentPassword: OWNER_PASSWORD, newPassword: "short" }, token);
    check("password change rejects too-short new password (400)", tooShort.status === 400, `got ${tooShort.status}`);

    const changeOk = await apiPatch("/api/platform/auth/password", { currentPassword: OWNER_PASSWORD, newPassword: "NewPassword12345" }, token);
    check("password change succeeds", changeOk.status === 200, JSON.stringify(changeOk.body));

    const oldPwLoginFails = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    check("old password no longer works", oldPwLoginFails.status === 401, `got ${oldPwLoginFails.status}`);

    const newPwLoginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: "NewPassword12345" });
    check("new password works", newPwLoginRes.status === 200 && !!newPwLoginRes.body?.token);
    const freshToken = newPwLoginRes.body.token;

    const noAuthChange = await apiPatch("/api/platform/auth/password", { currentPassword: "x", newPassword: "NewPassword99999" });
    check("password change rejected with no token (401)", noAuthChange.status === 401, `got ${noAuthChange.status}`);

    // ---------- Plan pricing fields ----------
    const planSlug = `dash2check-plan-${Date.now()}`;
    const createPlanRes = await apiPost("/api/platform/plans", {
        name: "Dash2Check Plan", slug: planSlug, employeeLimit: 5,
        monthlyPrice: 49.99, yearlyPrice: 499.99, trialDurationDays: 14,
    }, freshToken);
    check("plan creation with pricing succeeds", createPlanRes.status === 201
        && createPlanRes.body?.plan?.monthlyPrice === 49.99
        && createPlanRes.body?.plan?.yearlyPrice === 499.99
        && createPlanRes.body?.plan?.trialDurationDays === 14,
        JSON.stringify(createPlanRes.body));
    const planId = createPlanRes.body?.plan?.id;

    const badPrice = await apiPost("/api/platform/plans", { name: "Bad", slug: `${planSlug}-bad`, monthlyPrice: -5 }, freshToken);
    check("negative price rejected (400)", badPrice.status === 400, `got ${badPrice.status}`);

    const updatePlanRes = await apiPatch(`/api/platform/plans/${planId}`, {
        name: "Dash2Check Plan Updated", employeeLimit: 10, monthlyPrice: 59.99, yearlyPrice: null, trialDurationDays: 30,
    }, freshToken);
    check("plan update with pricing succeeds", updatePlanRes.status === 200
        && updatePlanRes.body?.plan?.monthlyPrice === 59.99
        && updatePlanRes.body?.plan?.yearlyPrice === null,
        JSON.stringify(updatePlanRes.body));

    // ---------- Company creation + list/details with new fields ----------
    const companyRes = await apiPost("/api/platform/companies", { companyName: "Dash2Check Co", companySlug: SLUG, accessType: "trial" }, freshToken);
    check("temp company created", companyRes.status === 201, JSON.stringify(companyRes.body));
    const companyId = companyRes.body?.company?.id;

    const adminRes = await apiPost(`/api/platform/companies/${companyId}/admin`, {
        name: "Dash2Check Admin", email: "admin@dash2check.internal", password: "AdminPass12345",
    }, freshToken);
    check("temp admin created", adminRes.status === 201, JSON.stringify(adminRes.body));

    await apiPatch(`/api/platform/companies/${companyId}/subscription`, { planId, subscriptionStatus: "active" }, freshToken);

    const listRes = await apiGet("/api/platform/companies?includeAdmin=1", freshToken);
    const listed = listRes.body?.companies?.find((c) => c.id === companyId);
    check("list includes planName", listed?.subscription?.planName === "Dash2Check Plan Updated", JSON.stringify(listed));
    check("list includes adminEmail when requested", listed?.adminEmail === "admin@dash2check.internal", JSON.stringify(listed));
    check("list includes employeeCount", listed?.employeeCount === 1, JSON.stringify(listed));

    const listNoFlag = await apiGet("/api/platform/companies", freshToken);
    const listedNoFlag = listNoFlag.body?.companies?.find((c) => c.id === companyId);
    check("list omits adminEmail without the flag", listedNoFlag?.adminEmail === null, JSON.stringify(listedNoFlag));

    const detailsRes = await apiGet(`/api/platform/companies/${companyId}`, freshToken);
    check("details includes adminName/adminEmail", detailsRes.body?.company?.adminName === "Dash2Check Admin"
        && detailsRes.body?.company?.adminEmail === "admin@dash2check.internal",
        JSON.stringify(detailsRes.body?.company));
    check("details includes plan pricing", detailsRes.body?.company?.subscription?.planMonthlyPrice === 59.99, JSON.stringify(detailsRes.body?.company?.subscription));
    check("details includes newUsersThisMonth (number)", typeof detailsRes.body?.company?.newUsersThisMonth === "number", JSON.stringify(detailsRes.body?.company?.newUsersThisMonth));

    // ---------- Dashboard stats: attentionRequired + recentActivity ----------
    const statsRes = await apiGet("/api/platform/companies/stats", freshToken);
    check("stats includes platformStats.newUsersThisMonth", typeof statsRes.body?.platformStats?.newUsersThisMonth === "number", JSON.stringify(statsRes.body?.platformStats));
    check("stats includes attentionRequired shape", Array.isArray(statsRes.body?.attentionRequired?.expiredSubscriptions)
        && Array.isArray(statsRes.body?.attentionRequired?.stalePendingProvisioning)
        && Array.isArray(statsRes.body?.attentionRequired?.approachingEmployeeLimit)
        && typeof statsRes.body?.attentionRequired?.newDemoRequests === "number",
        JSON.stringify(statsRes.body?.attentionRequired));
    check("stats includes recentActivity array with company_created entry", Array.isArray(statsRes.body?.recentActivity)
        && statsRes.body.recentActivity.some((e) => e.type === "company_created" && e.companySlug === SLUG),
        JSON.stringify(statsRes.body?.recentActivity));
    check("recentCompanies include planName", statsRes.body?.recentCompanies?.some((c) => c.subscription?.planName), JSON.stringify(statsRes.body?.recentCompanies));

    // Approaching-employee-limit: plan limit is 10, company has 1
    // employee -- should NOT appear (below 80% threshold).
    const approaching = statsRes.body?.attentionRequired?.approachingEmployeeLimit || [];
    check("company with 1/10 employees does not trigger approaching-limit alert", !approaching.some((c) => c.id === companyId), JSON.stringify(approaching));

    // ---------- Security: tenant JWT / no-token rejections on new endpoints ----------
    const jwt = require("jsonwebtoken");
    const tenantShapedToken = jwt.sign({ id: 999999, employeeId: "DASH2-TEST", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const tenantOnPassword = await apiPatch("/api/platform/auth/password", { currentPassword: "x", newPassword: "y".repeat(12) }, tenantShapedToken);
    check("tenant JWT rejected from password-change endpoint (401)", tenantOnPassword.status === 401, `got ${tenantOnPassword.status}`);

    const tenantOnListIncludeAdmin = await apiGet("/api/platform/companies?includeAdmin=1", tenantShapedToken);
    check("tenant JWT rejected from companies list even with includeAdmin (401)", tenantOnListIncludeAdmin.status === 401, `got ${tenantOnListIncludeAdmin.status}`);

    // ---------- Cleanup ----------
    // Phase 13/14 -- see _test_payments.js's cleanup comment for why.
    await platformPool.query(`DELETE FROM email_delivery_logs WHERE company_id = ?`, [companyId]);
    const [[dashupgradeOwnerRow]] = await platformPool.query(`SELECT id FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    if (dashupgradeOwnerRow) await platformPool.query(`DELETE FROM platform_audit_logs WHERE platform_user_id = ?`, [dashupgradeOwnerRow.id]);

    await tenantProvisioningService.dropProvisionedDatabase(buildTenantDbName(SLUG));
    await platformPool.query(`DELETE FROM companies WHERE company_slug = ?`, [SLUG]);
    await platformPool.query(`DELETE FROM subscription_plans WHERE slug LIKE ?`, [`${planSlug}%`]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);

    const companyGone = (await platformCompanyService.getCompanyBySlug(SLUG)) === null;
    check("CLEANUP: temp company gone", companyGone);
    const [remainingPlans] = await platformPool.query(`SELECT id FROM subscription_plans WHERE slug LIKE ?`, [`${planSlug}%`]);
    check("CLEANUP: temp plans gone", remainingPlans.length === 0);
    const [remainingOwner] = await platformPool.query(`SELECT id FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    check("CLEANUP: temp owner gone", remainingOwner.length === 0);

    const [[{ tbl }]] = await require("./config/db").query(`SELECT COUNT(*) AS tbl FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [process.env.DB_NAME]);
    check("reinsteins_workhub unchanged (37 tables)", tbl === 37, `tables=${tbl}`);

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch((e) => { console.error(e); process.exit(1); });
