require("dotenv").config();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const platformCompanyService = require("./services/platformCompanyService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { buildTenantDbName } = require("./utils/tenantDbName");
const razorpayProvider = require("./paymentProviders/razorpayProvider");

// ==========================================
// PAYMENT & BILLING FOUNDATION SELF-TEST (Phase 10)
//
// Exercises the new payments table/service/API + subscription trial
// auto-calc + expiring-soon attention signal, over real HTTP against
// a live backend. Creates ONE temporary Platform Owner, TWO temporary
// companies + tenant databases, and several temporary payment rows --
// all deleted at the end. Never touches reinsteins_workhub or
// Reinsteins' own company/subscription/payment data.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "paytest_owner@groworgs.internal";
const OWNER_PASSWORD = "PayTestOwner!2026Pwd";
const COMPANY_A_SLUG = "paytest_alpha";
const COMPANY_B_SLUG = "paytest_beta";
const ADMIN_PASSWORD = "PayTestAdmin!2026Pwd";

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
async function apiPostRaw(p, rawBody, headers) {
    const res = await fetch(`${BASE_URL}${p}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: rawBody });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, body: json };
}

async function createCompanyWithAdmin(ownerToken, slug, name) {
    const createRes = await apiPost("/api/platform/companies", { companyName: name, companySlug: slug, accessType: "trial" }, ownerToken);
    if (createRes.status !== 201) throw new Error(`Failed to create company ${slug}: ${JSON.stringify(createRes.body)}`);
    const companyId = createRes.body.company.id;
    const adminRes = await apiPost(`/api/platform/companies/${companyId}/admin`, {
        name: `${name} Admin`, email: `${slug}_admin@paytest.internal`, password: ADMIN_PASSWORD,
    }, ownerToken);
    if (adminRes.status !== 201) throw new Error(`Failed to create admin for ${slug}: ${JSON.stringify(adminRes.body)}`);
    return { companyId, adminEmployeeId: adminRes.body.admin.employeeId };
}

(async () => {

    console.log("SETUP -- platform owner + two temp companies");
    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "PayTest Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const token = loginRes.body?.token;
    check("SETUP: owner login succeeds", loginRes.status === 200 && !!token);

    const companyA = await createCompanyWithAdmin(token, COMPANY_A_SLUG, "PayTest Alpha");
    const companyB = await createCompanyWithAdmin(token, COMPANY_B_SLUG, "PayTest Beta");
    check("SETUP: both temp companies + admins created", !!companyA.companyId && !!companyB.companyId);

    const [[trialPlan]] = await platformPool.query(`SELECT id, trial_duration_days FROM subscription_plans WHERE slug = 'trial'`);
    const [[starterPlan]] = await platformPool.query(`SELECT id FROM subscription_plans WHERE slug = 'starter'`);

    // ========================================
    // 1. Unauthenticated payment APIs are rejected
    // ========================================
    console.log("\nTEST 1 -- Unauthenticated rejection");
    const noAuthList = await apiGet("/api/platform/payments");
    check("1. GET /payments with no token -> 401", noAuthList.status === 401, `got ${noAuthList.status}`);
    const noAuthCreate = await apiPost("/api/platform/payments", { companyId: companyA.companyId, planId: starterPlan.id, amount: 999, billingCycle: "monthly" });
    check("1b. POST /payments with no token -> 401", noAuthCreate.status === 401, `got ${noAuthCreate.status}`);
    const noAuthStats = await apiGet("/api/platform/payments/stats");
    check("1c. GET /payments/stats with no token -> 401", noAuthStats.status === 401, `got ${noAuthStats.status}`);

    // ========================================
    // 2. Tenant JWT cannot access Platform payment APIs
    // ========================================
    console.log("\nTEST 2 -- Tenant JWT boundary");
    const tenantShapedToken = jwt.sign({ id: 999999, employeeId: "PAYTEST-BOUNDARY", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const tenantOnList = await apiGet("/api/platform/payments", tenantShapedToken);
    check("2. Tenant-shaped JWT rejected from GET /payments (401)", tenantOnList.status === 401, `got ${tenantOnList.status}`);
    const tenantOnCreate = await apiPost("/api/platform/payments", { companyId: companyA.companyId, planId: starterPlan.id, amount: 999, billingCycle: "monthly" }, tenantShapedToken);
    check("2b. Tenant-shaped JWT rejected from POST /payments (401)", tenantOnCreate.status === 401, `got ${tenantOnCreate.status}`);

    // Reverse direction: Platform JWT must not work as a tenant JWT.
    const platformOnTenantRoute = await apiGet("/api/departments", token);
    check("2c. Platform JWT rejected from tenant-protected API (401)", platformOnTenantRoute.status === 401, `got ${platformOnTenantRoute.status}`);

    // ========================================
    // 3. Invalid company IDs are rejected
    // ========================================
    console.log("\nTEST 3 -- Invalid company id rejection");
    const badCompanyId = await apiPost("/api/platform/payments", { companyId: 999999999, planId: starterPlan.id, amount: 999, billingCycle: "monthly" }, token);
    check("3. Nonexistent companyId rejected (400)", badCompanyId.status === 400, `got ${badCompanyId.status}, ${JSON.stringify(badCompanyId.body)}`);
    const nonNumericCompanyId = await apiPost("/api/platform/payments", { companyId: "abc", planId: starterPlan.id, amount: 999, billingCycle: "monthly" }, token);
    check("3b. Non-numeric companyId rejected (400)", nonNumericCompanyId.status === 400, `got ${nonNumericCompanyId.status}`);

    // ========================================
    // 4. Invalid plan IDs are rejected
    // ========================================
    console.log("\nTEST 4 -- Invalid plan id rejection");
    const badPlanId = await apiPost("/api/platform/payments", { companyId: companyA.companyId, planId: 999999999, amount: 999, billingCycle: "monthly" }, token);
    check("4. Nonexistent planId rejected (400)", badPlanId.status === 400, `got ${badPlanId.status}`);

    // ========================================
    // 5. Invalid amounts are rejected
    // ========================================
    console.log("\nTEST 5 -- Invalid amount rejection");
    const zeroAmount = await apiPost("/api/platform/payments", { companyId: companyA.companyId, planId: starterPlan.id, amount: 0, billingCycle: "monthly" }, token);
    check("5. Zero amount rejected (400)", zeroAmount.status === 400, `got ${zeroAmount.status}`);
    const negativeAmount = await apiPost("/api/platform/payments", { companyId: companyA.companyId, planId: starterPlan.id, amount: -50, billingCycle: "monthly" }, token);
    check("5b. Negative amount rejected (400)", negativeAmount.status === 400, `got ${negativeAmount.status}`);
    const hugeAmount = await apiPost("/api/platform/payments", { companyId: companyA.companyId, planId: starterPlan.id, amount: 99999999999, billingCycle: "monthly" }, token);
    check("5c. Absurdly large amount rejected (400)", hugeAmount.status === 400, `got ${hugeAmount.status}`);
    const badCycle = await apiPost("/api/platform/payments", { companyId: companyA.companyId, planId: starterPlan.id, amount: 999, billingCycle: "weekly" }, token);
    check("5d. Invalid billingCycle rejected (400)", badCycle.status === 400, `got ${badCycle.status}`);

    // ========================================
    // 6. Payment status validation works
    // ========================================
    console.log("\nTEST 6 -- Payment status validation");
    const createPending = await apiPost("/api/platform/payments", { companyId: companyA.companyId, planId: starterPlan.id, amount: 999, billingCycle: "monthly" }, token);
    check("6. Create with no status defaults to pending", createPending.status === 201 && createPending.body?.payment?.paymentStatus === "pending", JSON.stringify(createPending.body));
    const pendingPaymentId = createPending.body?.payment?.id;

    const badStatusTransition = await apiPatch(`/api/platform/payments/${pendingPaymentId}/status`, { status: "not_a_real_status" }, token);
    check("6b. Invalid status value rejected (400)", badStatusTransition.status === 400, `got ${badStatusTransition.status}`);

    const validTransition = await apiPatch(`/api/platform/payments/${pendingPaymentId}/status`, { status: "paid" }, token);
    check("6c. Valid status transition (pending -> paid) succeeds", validTransition.status === 200 && validTransition.body?.payment?.paymentStatus === "paid", JSON.stringify(validTransition.body));
    check("6d. Invoice number auto-assigned on becoming paid", /^INV-\d{4}-\d{6}$/.test(validTransition.body?.payment?.invoiceNumber || ""), JSON.stringify(validTransition.body?.payment));
    check("6e. paidAt timestamp set", !!validTransition.body?.payment?.paidAt);

    // Manual creation never accepts a client-supplied provider/providerPaymentId
    const forgedProvider = await apiPost("/api/platform/payments", {
        companyId: companyA.companyId, planId: starterPlan.id, amount: 500, billingCycle: "one_time",
        paymentProvider: "razorpay", providerPaymentId: "pay_FAKE123", paymentStatus: "paid",
    }, token);
    check("6f. Forged paymentProvider/providerPaymentId ignored (still recorded as manual, no fake provider id)",
        forgedProvider.status === 201 && forgedProvider.body?.payment?.paymentProvider === "manual" && forgedProvider.body?.payment?.providerPaymentId === null,
        JSON.stringify(forgedProvider.body?.payment));

    // ========================================
    // 7. Duplicate provider payment IDs safely handled
    // ========================================
    console.log("\nTEST 7 -- Duplicate provider payment id handling");
    // Manual creation can never produce a real duplicate (provider
    // id is always forced null), so this proves the DB-level
    // uniqueness constraint itself directly -- the real safety net
    // a future webhook handler relies on.
    const dupId = `paytest_dup_${Date.now()}`;
    const [insertA] = await platformPool.query(
        `INSERT INTO payments (company_id, plan_id, amount, currency, billing_cycle, payment_status, payment_provider, provider_payment_id)
         VALUES (?, ?, 100, 'INR', 'one_time', 'paid', 'razorpay', ?)
         RETURNING id`,
        [companyA.companyId, starterPlan.id, dupId]
    );
    check("7. First insert with a given provider_payment_id succeeds", !!insertA.insertId);
    let duplicateRejected = false;
    try {
        await platformPool.query(
            `INSERT INTO payments (company_id, plan_id, amount, currency, billing_cycle, payment_status, payment_provider, provider_payment_id)
             VALUES (?, ?, 100, 'INR', 'one_time', 'paid', 'razorpay', ?)
             RETURNING id`,
            [companyA.companyId, starterPlan.id, dupId]
        );
    } catch (dupError) {
        duplicateRejected = dupError.code === "23505";
    }
    check("7b. Second insert with the SAME provider_payment_id is rejected at the DB level (idempotency guarantee)", duplicateRejected);

    // ========================================
    // 8/9. Revenue only counts 'paid' payments
    // ========================================
    console.log("\nTEST 8/9 -- Revenue calculation correctness");
    const failedPayment = await apiPost("/api/platform/payments", { companyId: companyB.companyId, planId: starterPlan.id, amount: 777, billingCycle: "monthly" }, token);
    await apiPatch(`/api/platform/payments/${failedPayment.body.payment.id}/status`, { status: "failed" }, token);

    const pendingOnlyPayment = await apiPost("/api/platform/payments", { companyId: companyB.companyId, planId: starterPlan.id, amount: 888, billingCycle: "monthly" }, token);

    const statsRes = await apiGet("/api/platform/payments/stats", token);
    // Known paid total from this test so far: 999 (6c) + 500 (6f) + 100 (7, direct insert) = 1599
    check("8. Revenue equals the sum of ONLY 'paid' payments (999 + 500 + 100 = 1599)", statsRes.body?.stats?.totalRevenue === 1599, JSON.stringify(statsRes.body?.stats));
    check("9. Failed payment does not count toward revenue", statsRes.body?.stats?.failed >= 1);
    check("9b. Pending payment does not count toward revenue", statsRes.body?.stats?.pending >= 1);

    // ========================================
    // 10. Payment records remain isolated by company
    // ========================================
    console.log("\nTEST 10 -- Company isolation of payment records");
    const companyAPayments = await apiGet(`/api/platform/payments?companyId=${companyA.companyId}`, token);
    const companyBPayments = await apiGet(`/api/platform/payments?companyId=${companyB.companyId}`, token);
    check("10. Company A's payment list contains no Company B payments", companyAPayments.body?.payments?.every((p) => p.companyId === companyA.companyId), JSON.stringify(companyAPayments.body?.payments?.map((p) => p.companyId)));
    check("10b. Company B's payment list contains no Company A payments", companyBPayments.body?.payments?.every((p) => p.companyId === companyB.companyId), JSON.stringify(companyBPayments.body?.payments?.map((p) => p.companyId)));

    // ========================================
    // Webhook signature verification (Phase 10H, real crypto logic)
    //
    // Setting RAZORPAY_WEBHOOK_SECRET in THIS script's process would
    // have no effect on the live backend (a separate already-running
    // process holds its own env) -- and restarting the server with a
    // webhook secret configured just to test this would mean running
    // the backend in a materially different configuration than its
    // real deployment state, which is exactly what "do not activate a
    // real payment gateway yet" rules out. So: the *live HTTP route*
    // is verified in its actual, current, real deployment state (not
    // configured -> 503, can never be tricked into writing a payment
    // no matter what body/signature is sent); the *cryptographic
    // correctness* of signature verification (accepts a valid HMAC,
    // rejects an invalid one) is verified directly against the
    // provider module below, in-process, with a temporary secret that
    // never touches the running server or any .env file.
    // ========================================
    console.log("\nEXTRA -- Webhook signature verification");
    const rawBody = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_test123" } } } });
    const validSig = crypto.createHmac("sha256", "unconfigured_probe_secret").update(rawBody).digest("hex");
    const webhookNotConfigured = await apiPostRaw("/api/platform/payments/webhook/razorpay", rawBody, { "x-razorpay-signature": validSig });
    check("Webhook returns 503 when RAZORPAY_WEBHOOK_SECRET is not configured (real deployment state -- cannot be tricked into processing)", webhookNotConfigured.status === 503, `got ${webhookNotConfigured.status}`);

    process.env.RAZORPAY_WEBHOOK_SECRET = "test_webhook_secret_for_this_run_only";
    const inProcessValidSig = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest("hex");
    check("razorpayProvider.verifyWebhookSignature accepts a correctly-computed signature (in-process, real deployment untouched)",
        razorpayProvider.verifyWebhookSignature({ rawBody, signature: inProcessValidSig }) === true);
    check("razorpayProvider.verifyWebhookSignature rejects an incorrect signature",
        razorpayProvider.verifyWebhookSignature({ rawBody, signature: "0".repeat(64) }) === false);
    delete process.env.RAZORPAY_WEBHOOK_SECRET;

    // Direct provider unit check -- proves the HMAC math itself is
    // Razorpay's documented algorithm, independent of the HTTP route.
    process.env.RAZORPAY_KEY_SECRET = "test_key_secret";
    const paymentSigValid = crypto.createHmac("sha256", "test_key_secret").update("order_abc|pay_xyz").digest("hex");
    process.env.RAZORPAY_KEY_ID = "test_key_id";
    check("razorpayProvider.verifyPaymentSignature accepts a correctly-computed signature",
        razorpayProvider.verifyPaymentSignature({ orderId: "order_abc", paymentId: "pay_xyz", signature: paymentSigValid }) === true);
    check("razorpayProvider.verifyPaymentSignature rejects a wrong signature",
        razorpayProvider.verifyPaymentSignature({ orderId: "order_abc", paymentId: "pay_xyz", signature: "f".repeat(64) }) === false);
    delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_KEY_ID;

    // ========================================
    // Trial auto-calculation (Phase 10E)
    //
    // In real current data no plan has trial_duration_days set (every
    // plan shows NULL -- confirmed by direct inspection), so this
    // sets a temporary value on the 'trial' plan to actually exercise
    // the auto-calc branch, and restores the plan's original value
    // immediately after, regardless of outcome.
    // ========================================
    console.log("\nEXTRA -- Trial auto-calculation from plan.trial_duration_days");
    const TEMP_TRIAL_DAYS = 14;
    const [[originalTrialPlanRow]] = await platformPool.query(`SELECT trial_duration_days FROM subscription_plans WHERE id = ?`, [trialPlan.id]);
    await platformPool.query(`UPDATE subscription_plans SET trial_duration_days = ? WHERE id = ?`, [TEMP_TRIAL_DAYS, trialPlan.id]);
    try {
        const trialAssign = await apiPatch(`/api/platform/companies/${companyB.companyId}/subscription`, {
            planId: trialPlan.id, subscriptionStatus: "trial",
            // trialEndsAt deliberately OMITTED entirely -- this is what
            // should trigger auto-calculation from the plan's own
            // trial_duration_days.
        }, token);
        const expectedTrialEnd = Date.now() + TEMP_TRIAL_DAYS * 24 * 60 * 60 * 1000;
        const actualTrialEnd = new Date(trialAssign.body?.company?.subscription?.trialEndsAt).getTime();
        check("Trial end date auto-calculated from plan.trial_duration_days when omitted",
            trialAssign.status === 200 && Math.abs(actualTrialEnd - expectedTrialEnd) < 60000,
            `expected ~${new Date(expectedTrialEnd).toISOString()}, got ${trialAssign.body?.company?.subscription?.trialEndsAt}`);
    } finally {
        await platformPool.query(`UPDATE subscription_plans SET trial_duration_days = ? WHERE id = ?`, [originalTrialPlanRow.trial_duration_days, trialPlan.id]);
    }

    // ========================================
    // 11. Existing tenant isolation still works
    // ========================================
    console.log("\nTEST 11 -- Existing tenant isolation still works");
    const companyAInfo = await apiGet(`/api/tenant-auth/${COMPANY_A_SLUG}/info`);
    check("11. Company A tenant-auth info endpoint still resolves correctly", companyAInfo.status === 200 && companyAInfo.body?.company?.name === "PayTest Alpha", JSON.stringify(companyAInfo.body));

    // Real end-to-end proof the tenant-JWT path (added in a prior
    // phase, untouched by Phase 10) still works after these changes:
    // log in as Company A's real admin, and confirm the resulting
    // tenant JWT can reach a tenant-protected business API and gets
    // routed to Company A's own tenant database (not some other
    // tenant's, not the platform DB).
    const tenantALogin = await apiPost(`/api/tenant-auth/${COMPANY_A_SLUG}/login`, {
        employeeId: companyA.adminEmployeeId, password: ADMIN_PASSWORD,
    });
    check("11b. Company A admin can log in via tenant-auth and receive a tenant JWT", tenantALogin.status === 200 && !!tenantALogin.body?.token, JSON.stringify(tenantALogin.body));
    const tenantAToken = tenantALogin.body?.token;
    const tenantADepts = await apiGet("/api/departments", tenantAToken);
    check("11c. Company A's tenant JWT can reach a tenant-protected business API (200)", tenantADepts.status === 200, `got ${tenantADepts.status}, ${JSON.stringify(tenantADepts.body)}`);

    // A garbage/forged token (not signed with either real secret)
    // must still fail exactly as before -- unrelated to Phase 10, but
    // confirms the auth chain wasn't accidentally loosened.
    const garbageToken = "not.a.real.jwt.token";
    const garbageOnDept = await apiGet("/api/departments", garbageToken);
    check("11d. A garbage/forged token is still rejected from a tenant-protected API (401)", garbageOnDept.status === 401, `got ${garbageOnDept.status}`);

    // ========================================
    // 12. Existing subscription enforcement still works
    // ========================================
    console.log("\nTEST 12 -- Subscription enforcement unchanged");
    await apiPatch(`/api/platform/companies/${companyA.companyId}/subscription`, {
        planId: trialPlan.id, subscriptionStatus: "trial", trialEndsAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }, token);
    const expiredLoginAttempt = await apiPost(`/api/tenant-auth/${COMPANY_A_SLUG}/login`, { employeeId: "NOSUCHID", password: ADMIN_PASSWORD });
    check("12. Expired-trial company login still rejected (403), enforcement unchanged", expiredLoginAttempt.status === 403, `got ${expiredLoginAttempt.status}`);

    // ========================================
    // 13. Reinsteins remains unchanged
    // ========================================
    console.log("\nTEST 13 -- Reinsteins unchanged");
    const dbPool = require("./config/db");
    // Phase 16A discovery -- see _test_security_hardening.js's comment
    // at this same check for the full explanation.
    const PLATFORM_TABLE_NAMES = ["platform_users", "subscription_plans", "companies", "demo_requests", "payments", "subscription_history", "platform_audit_logs", "platform_notifications", "email_delivery_logs", "email_domains", "mailboxes", "email_aliases", "mailbox_settings"];
    const [[{ tbl }]] = await dbPool.query(`SELECT COUNT(*) AS tbl FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT IN (${PLATFORM_TABLE_NAMES.map(() => "?").join(",")})`, PLATFORM_TABLE_NAMES);
    const [[{ users }]] = await dbPool.query(`SELECT COUNT(*) AS users FROM users`);
    check("13. reinsteins_workhub unchanged (37 tables, 17 users)", Number(tbl) === 37 && Number(users) === 17, `tables=${tbl} users=${users}`);
    const legacyToken = jwt.sign({ id: 4, employeeId: "PAYTEST-LEGACY", role: "employee" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const legacyDepts = await apiGet("/api/departments", legacyToken);
    check("13b. Legacy Reinsteins token still resolves real business data", legacyDepts.status === 200 && legacyDepts.body?.departments?.length === 3, JSON.stringify(legacyDepts.body));
    const [[reinsteinsRow]] = await platformPool.query(
        `SELECT subscription_status, trial_ends_at, subscription_expires_at FROM companies WHERE company_slug = 'reinsteins'`
    );
    check("13c. Reinsteins subscription remains Complimentary/active with no expiry", reinsteinsRow.subscription_status === "active" && reinsteinsRow.trial_ends_at === null && reinsteinsRow.subscription_expires_at === null, JSON.stringify(reinsteinsRow));
    const [reinsteinsPayments] = await platformPool.query(
        `SELECT p.id FROM payments p JOIN companies c ON c.id = p.company_id WHERE c.company_slug = 'reinsteins'`
    );
    check("13d. No payment records were created against Reinsteins", reinsteinsPayments.length === 0, JSON.stringify(reinsteinsPayments));

    // ========================================
    // CLEANUP
    // ========================================
    console.log("\nCLEANUP");
    await platformPool.query(`DELETE FROM payments WHERE company_id IN (?, ?)`, [companyA.companyId, companyB.companyId]);
    // Phase 13/14 -- this script predates email_delivery_logs/
    // platform_audit_logs, but real lifecycle/audit events now fire as
    // a side effect of the actions above; clean them up too so no
    // orphaned rows (company_id/platform_user_id both nulled by their
    // FKs' ON DELETE SET NULL) linger after the owner/company rows below
    // are gone.
    await platformPool.query(`DELETE FROM email_delivery_logs WHERE company_id IN (?, ?)`, [companyA.companyId, companyB.companyId]);
    const [[paytestOwnerRow]] = await platformPool.query(`SELECT id FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    if (paytestOwnerRow) await platformPool.query(`DELETE FROM platform_audit_logs WHERE platform_user_id = ?`, [paytestOwnerRow.id]);
    await tenantProvisioningService.dropProvisionedDatabase(buildTenantDbName(COMPANY_A_SLUG));
    await tenantProvisioningService.dropProvisionedDatabase(buildTenantDbName(COMPANY_B_SLUG));
    await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?)`, [COMPANY_A_SLUG, COMPANY_B_SLUG]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);

    const [remainingPayments] = await platformPool.query(`SELECT id FROM payments WHERE company_id IN (?, ?)`, [companyA.companyId, companyB.companyId]);
    check("CLEANUP: all temporary payment records deleted", remainingPayments.length === 0);
    const companyAGone = (await platformCompanyService.getCompanyBySlug(COMPANY_A_SLUG)) === null;
    const companyBGone = (await platformCompanyService.getCompanyBySlug(COMPANY_B_SLUG)) === null;
    check("CLEANUP: both temporary companies confirmed gone", companyAGone && companyBGone);
    const dbAGone = !(await tenantProvisioningService.databaseExists(buildTenantDbName(COMPANY_A_SLUG)));
    const dbBGone = !(await tenantProvisioningService.databaseExists(buildTenantDbName(COMPANY_B_SLUG)));
    check("CLEANUP: both temporary tenant databases confirmed gone", dbAGone && dbBGone);
    const [remainingOwner] = await platformPool.query(`SELECT id FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    check("CLEANUP: temporary platform owner confirmed gone", remainingOwner.length === 0);
    const [finalCompanies] = await platformPool.query(`SELECT company_slug FROM companies`);
    check("CLEANUP: only Reinsteins remains in companies", finalCompanies.length === 1 && finalCompanies[0].company_slug === "reinsteins", JSON.stringify(finalCompanies));

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch((e) => { console.error(e); process.exit(1); });
