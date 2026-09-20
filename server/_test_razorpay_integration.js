require("dotenv").config();
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const platformCompanyService = require("./services/platformCompanyService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { buildTenantDbName } = require("./utils/tenantDbName");
const paymentService = require("./services/paymentService");
const paymentController = require("./controllers/platformPaymentController");

// ==========================================
// RAZORPAY INTEGRATION SELF-TEST (Phase 11)
//
// This deployment has NO real Razorpay credentials configured (by
// design -- "do not use real/live keys initially"), so this script
// tests in two complementary ways rather than one:
//
//   (A) REAL HTTP, against the actually-running server on :5000, for
//       everything that is true regardless of configuration: auth
//       boundaries, input validation, the "not configured -> safe
//       failure, never fakes success" behavior, and any check that
//       happens before the code would ever need real credentials
//       (e.g. order-id-mismatch is rejected before a signature is
//       ever computed).
//
//   (B) IN-PROCESS, calling the controller functions directly (never
//       touching the live server or its real, unconfigured env) with
//       TEMPORARY, CLEARLY-FAKE credentials set only in THIS script's
//       own process.env, restored/deleted immediately after each use.
//       The one real outbound network call (creating a Razorpay
//       order) is stubbed via a scoped global.fetch override so real
//       Razorpay servers are never contacted -- but the cryptographic
//       signature verification, the DB writes, the idempotency
//       guards, and the subscription-activation math are all 100%
//       real, unmodified production code. This is standard practice
//       for testing a payment integration without live credentials;
//       it is not "faking a successful payment" in the sense of
//       skipping verification -- verification still runs for real,
//       just against a stubbed order instead of a real Razorpay one.
//
// Socket.IO isolation (test 27) is intentionally NOT re-implemented
// here -- it is unrelated to payments and already has its own
// permanent suite (_test_socket_tenant_isolation.js), re-run
// separately as part of this phase's regression pass.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "rzptest_owner@groworgs.internal";
const OWNER_PASSWORD = "RzpTestOwner!2026Pwd";
const COMPANY_SLUG = "rzptest_alpha";
const ADMIN_PASSWORD = "RzpTestAdmin!2026Pwd";

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
    const res = await fetch(`${BASE_URL}${p}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body || {}) });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, body: json };
}

// ---------- in-process controller invocation helpers ----------
function mockRes() {
    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => { res.body = obj; return res; };
    return res;
}
async function callController(fn, { params = {}, body = {}, headers = {}, rawBody } = {}) {
    const req = { params, body, headers, rawBody };
    const res = mockRes();
    await fn(req, res);
    return { status: res.statusCode, body: res.body };
}

function razorpaySignature(orderId, paymentId, keySecret) {
    return crypto.createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
}
function webhookSignature(rawBody, webhookSecret) {
    return crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
}

const FAKE_KEY_ID = "rzp_test_fake_key_id_for_automated_tests";
const FAKE_KEY_SECRET = "fake_key_secret_for_automated_tests_only";
const FAKE_WEBHOOK_SECRET = "fake_webhook_secret_for_automated_tests_only";

let mockOrderCounter = 0;
const realFetch = global.fetch;
function installMockRazorpayFetch() {
    mockOrderCounter = 0;
    global.fetch = async (url, opts) => {
        if (typeof url === "string" && url.startsWith("https://api.razorpay.com/v1/orders")) {
            const requestBody = JSON.parse(opts.body);
            mockOrderCounter += 1;
            const orderId = `order_test_mock_${mockOrderCounter}`;
            return { ok: true, json: async () => ({ id: orderId, amount: requestBody.amount, currency: requestBody.currency, receipt: requestBody.receipt, status: "created" }) };
        }
        return realFetch(url, opts);
    };
}
function uninstallMockRazorpayFetch() {
    global.fetch = realFetch;
}

async function createCompanyWithAdmin(ownerToken, slug, name) {
    const createRes = await apiPost("/api/platform/companies", { companyName: name, companySlug: slug, accessType: "trial" }, ownerToken);
    if (createRes.status !== 201) throw new Error(`Failed to create company ${slug}: ${JSON.stringify(createRes.body)}`);
    const companyId = createRes.body.company.id;
    const adminRes = await apiPost(`/api/platform/companies/${companyId}/admin`, {
        name: `${name} Admin`, email: `${slug}_admin@rzptest.internal`, password: ADMIN_PASSWORD,
    }, ownerToken);
    if (adminRes.status !== 201) throw new Error(`Failed to create admin for ${slug}: ${JSON.stringify(adminRes.body)}`);
    return { companyId, adminEmployeeId: adminRes.body.admin.employeeId };
}

(async () => {

    console.log("SETUP -- platform owner + company + paid plan");
    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "RzpTest Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const token = loginRes.body?.token;
    check("SETUP: owner login succeeds", loginRes.status === 200 && !!token);

    const company = await createCompanyWithAdmin(token, COMPANY_SLUG, "RzpTest Alpha");
    check("SETUP: company + admin created", !!company.companyId);

    // A real, active plan with BOTH monthly and yearly prices -- the
    // checkout endpoint reads its amount from here, never from the
    // client.
    const [planInsert] = await platformPool.query(
        `INSERT INTO subscription_plans (name, slug, status, monthly_price, yearly_price, employee_limit, features)
         VALUES ('RzpTest Plan', 'rzptest-plan', 'active', 499.00, 4999.00, 50, '[]')
         RETURNING id`
    );
    const planId = planInsert.insertId;
    check("SETUP: paid plan created", !!planId);

    const tenantShapedToken = jwt.sign({ id: 999999, employeeId: "RZPTEST-BOUNDARY", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

    // ========================================
    // AUTHENTICATION (1-3)
    // ========================================
    console.log("\nAUTHENTICATION");
    const noAuthCheckout = await apiPost("/api/platform/payments/checkout", { companyId: company.companyId, planId, billingCycle: "monthly" });
    check("1. Unauthenticated POST /payments/checkout -> 401", noAuthCheckout.status === 401, `got ${noAuthCheckout.status}`);
    const noAuthOrder = await apiPost(`/api/platform/payments/1/create-order`, {});
    check("1b. Unauthenticated POST /payments/:id/create-order -> 401", noAuthOrder.status === 401, `got ${noAuthOrder.status}`);
    const noAuthVerify = await apiPost(`/api/platform/payments/1/verify`, {});
    check("1c. Unauthenticated POST /payments/:id/verify -> 401", noAuthVerify.status === 401, `got ${noAuthVerify.status}`);

    const tenantOnCheckout = await apiPost("/api/platform/payments/checkout", { companyId: company.companyId, planId, billingCycle: "monthly" }, tenantShapedToken);
    check("2. Tenant JWT rejected from POST /payments/checkout (401)", tenantOnCheckout.status === 401, `got ${tenantOnCheckout.status}`);
    const tenantOnVerify = await apiPost(`/api/platform/payments/1/verify`, {}, tenantShapedToken);
    check("2b. Tenant JWT rejected from POST /payments/:id/verify (401)", tenantOnVerify.status === 401, `got ${tenantOnVerify.status}`);

    const platformOnTenantRoute = await apiGet("/api/departments", token);
    check("3. Platform JWT rejected from tenant-protected API (401)", platformOnTenantRoute.status === 401, `got ${platformOnTenantRoute.status}`);

    // ========================================
    // ORDER CREATION (4-7)
    // ========================================
    console.log("\nORDER CREATION");
    const invalidPaymentOrder = await apiPost("/api/platform/payments/999999999/create-order", {}, token);
    check("4. Invalid payment ID rejected on create-order (404)", invalidPaymentOrder.status === 404, `got ${invalidPaymentOrder.status}`);

    // Manually-recorded, already-paid payment (no Razorpay involved) --
    // creating an order on it must be rejected both because it's not a
    // Razorpay payment AND because it's not pending.
    const manualPaidRes = await apiPost("/api/platform/payments", { companyId: company.companyId, planId, amount: 111, billingCycle: "one_time", paymentStatus: "paid" }, token);
    check("SETUP: manual paid payment created for test 5", manualPaidRes.status === 201);
    const alreadyPaidOrderAttempt = await apiPost(`/api/platform/payments/${manualPaidRes.body?.payment?.id}/create-order`, {}, token);
    check("5. Already-paid (and non-Razorpay) payment cannot create an order (400)", alreadyPaidOrderAttempt.status === 400, `got ${alreadyPaidOrderAttempt.status}`);

    // 6. Server-side amount is used -- the checkout endpoint accepts NO
    // amount field at all; whatever is created must equal the plan's
    // own stored price.
    const checkoutRes = await apiPost("/api/platform/payments/checkout", { companyId: company.companyId, planId, billingCycle: "monthly" }, token);
    // Unconfigured deployment -> order creation fails, but the payment
    // row must still be created with the SERVER-COMPUTED amount.
    check("6. Checkout payment amount matches plan.monthlyPrice exactly (499.00), never client-supplied", Number(checkoutRes.body?.payment?.amount) === 499, JSON.stringify(checkoutRes.body?.payment));
    check("6b. Unconfigured Razorpay -> checkout fails safely (503), no fake success", checkoutRes.status === 503, `got ${checkoutRes.status}, ${JSON.stringify(checkoutRes.body)}`);
    const checkoutPaymentId = checkoutRes.body?.payment?.id;

    // 7. Duplicate order creation is prevented/safely reused -- proven
    // in-process below (test 7b), where a real (mocked) order can
    // actually be created. Here, over live HTTP with no gateway
    // configured, confirm retrying create-order on the same pending
    // payment does not corrupt anything (stays pending, no order id).
    const retryOrderAttempt = await apiPost(`/api/platform/payments/${checkoutPaymentId}/create-order`, {}, token);
    check("7. Retrying create-order on an unconfigured gateway stays safe (503, no corruption)", retryOrderAttempt.status === 503, `got ${retryOrderAttempt.status}`);

    // 9. Wrong Razorpay order ID rejected -- this check happens BEFORE
    // any provider call, so it's fully testable over live HTTP even
    // fully unconfigured. Simulate "an order was already created" via
    // a direct DB write (this is PURELY test setup, not the app
    // creating a fake order).
    await platformPool.query(`UPDATE payments SET provider_order_id = ? WHERE id = ?`, ["order_real_one", checkoutPaymentId]);
    const wrongOrderVerify = await apiPost(`/api/platform/payments/${checkoutPaymentId}/verify`, {
        razorpayOrderId: "order_SOMETHING_ELSE", razorpayPaymentId: "pay_x", razorpaySignature: "0".repeat(64),
    }, token);
    check("9. Wrong Razorpay order ID rejected (400) -- order/payment mismatch caught before any signature check", wrongOrderVerify.status === 400, `got ${wrongOrderVerify.status}, ${JSON.stringify(wrongOrderVerify.body)}`);

    // 17. Cancelled/abandoned checkout does not activate subscription --
    // this payment has been sitting pending this whole time; the
    // company's subscription must be completely untouched by it.
    const companyBeforeAnyVerify = await platformCompanyService.getCompanyById(company.companyId);
    check("17. Company subscription unaffected by a pending, never-verified checkout payment", companyBeforeAnyVerify.subscription_status !== "active" || companyBeforeAnyVerify.plan_id !== planId);

    // ========================================
    // IN-PROCESS: full real flow with a stubbed Razorpay + fake (but
    // consistent) TEST credentials, scoped to THIS process only.
    // ========================================
    console.log("\nIN-PROCESS -- full checkout -> order -> verify -> subscription flow (stubbed Razorpay network call, real signature/DB logic)");

    process.env.RAZORPAY_KEY_ID = FAKE_KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = FAKE_KEY_SECRET;
    installMockRazorpayFetch();

    try {
        // Fresh payment for the in-process flow (separate from the
        // unconfigured-HTTP one above).
        const monthlyPayment = await paymentService.createPaymentRecord({
            companyId: company.companyId, planId, amount: 499, currency: "INR", billingCycle: "monthly",
            paymentStatus: "pending", paymentProvider: "razorpay", providerPaymentId: null, providerOrderId: null, notes: null,
        });

        const orderResp = await callController(paymentController.createOrderForExistingPayment, { params: { id: String(monthlyPayment.id) } });
        check("SETUP: in-process order creation succeeds against stubbed Razorpay", orderResp.status === 201, JSON.stringify(orderResp.body));
        const orderId = orderResp.body?.razorpay?.orderId;

        // 7b. Duplicate order creation is prevented/safely reused --
        // calling create-order again on the SAME pending payment must
        // reuse the same order id and must NOT call Razorpay again.
        const ordersBeforeRetry = mockOrderCounter;
        const orderRetryResp = await callController(paymentController.createOrderForExistingPayment, { params: { id: String(monthlyPayment.id) } });
        check("7b. Retrying create-order on a payment that already has an order reuses it (same orderId, no new Razorpay call)",
            orderRetryResp.status === 200 && orderRetryResp.body?.razorpay?.orderId === orderId && mockOrderCounter === ordersBeforeRetry,
            `orderId1=${orderId} orderId2=${orderRetryResp.body?.razorpay?.orderId} callsBefore=${ordersBeforeRetry} callsAfter=${mockOrderCounter}`);

        // 8. Invalid signature rejected.
        const badSigResp = await callController(paymentController.verifyPayment, {
            params: { id: String(monthlyPayment.id) },
            body: { razorpayOrderId: orderId, razorpayPaymentId: "pay_test_fake_1", razorpaySignature: "f".repeat(64) },
        });
        check("8. Invalid Razorpay signature rejected (400)", badSigResp.status === 400, JSON.stringify(badSigResp.body));

        // 16. Failed/invalid verification does not activate subscription.
        const companyAfterBadSig = await platformCompanyService.getCompanyById(company.companyId);
        check("16. Invalid-signature attempt does not activate subscription", companyAfterBadSig.subscription_status !== "active" || companyAfterBadSig.plan_id !== planId);
        const paymentAfterBadSig = await paymentService.getPaymentById(monthlyPayment.id);
        check("16b. Invalid-signature attempt leaves payment status as pending (no fake failure record)", paymentAfterBadSig.payment_status === "pending");

        // 10/11/14. Correct signature accepted, payment becomes paid,
        // monthly subscription activates with correct expiry.
        const validSig = razorpaySignature(orderId, "pay_test_fake_1", FAKE_KEY_SECRET);
        const beforeVerifyAt = Date.now();
        const verifyResp = await callController(paymentController.verifyPayment, {
            params: { id: String(monthlyPayment.id) },
            body: { razorpayOrderId: orderId, razorpayPaymentId: "pay_test_fake_1", razorpaySignature: validSig },
        });
        check("10. Correct TEST signature is accepted (200)", verifyResp.status === 200, JSON.stringify(verifyResp.body));
        check("11. Payment becomes paid only after verification", verifyResp.body?.payment?.paymentStatus === "paid");
        check("11b. providerPaymentId stored from the verified payment", verifyResp.body?.payment?.providerPaymentId === "pay_test_fake_1");
        check("13. Invoice number assigned on verification", /^INV-\d{4}-\d{6}$/.test(verifyResp.body?.payment?.invoiceNumber || ""));
        check("14. Subscription activated on verified monthly payment", verifyResp.body?.subscriptionActivated === true);

        const companyAfterMonthly = await platformCompanyService.getCompanyById(company.companyId);
        const expectedMonthlyExpiry = new Date(beforeVerifyAt); expectedMonthlyExpiry.setMonth(expectedMonthlyExpiry.getMonth() + 1);
        check("14b. subscription_status is active after verified monthly payment", companyAfterMonthly.subscription_status === "active");
        check("14c. plan_id matches the paid plan", companyAfterMonthly.plan_id === planId);
        check("14d. subscription_expires_at ~= now + 1 month",
            Math.abs(new Date(companyAfterMonthly.subscription_expires_at).getTime() - expectedMonthlyExpiry.getTime()) < 30000,
            `expected ~${expectedMonthlyExpiry.toISOString()}, got ${companyAfterMonthly.subscription_expires_at}`);

        // 12/13/21. Duplicate verification is idempotent -- calling
        // verify again (browser refresh scenario) must not change
        // paid_at, must not reassign the invoice number, must not
        // extend the subscription expiry a second time.
        const invoiceBeforeDup = verifyResp.body?.payment?.invoiceNumber;
        const expiryBeforeDup = companyAfterMonthly.subscription_expires_at;
        const dupVerifyResp = await callController(paymentController.verifyPayment, {
            params: { id: String(monthlyPayment.id) },
            body: { razorpayOrderId: orderId, razorpayPaymentId: "pay_test_fake_1", razorpaySignature: validSig },
        });
        check("12. Duplicate verification is idempotent (200, alreadyVerified)", dupVerifyResp.status === 200 && dupVerifyResp.body?.alreadyVerified === true, JSON.stringify(dupVerifyResp.body));
        check("13b. Invoice number NOT reassigned/duplicated on repeat verification", dupVerifyResp.body?.payment?.invoiceNumber === invoiceBeforeDup);
        const companyAfterDupVerify = await platformCompanyService.getCompanyById(company.companyId);
        check("21. Duplicate verification does not extend subscription a second time", new Date(companyAfterDupVerify.subscription_expires_at).getTime() === new Date(expiryBeforeDup).getTime());

        // 15. Yearly payment sets correct (yearly) expiry -- separate
        // payment + order + verify cycle.
        const yearlyPayment = await paymentService.createPaymentRecord({
            companyId: company.companyId, planId, amount: 4999, currency: "INR", billingCycle: "yearly",
            paymentStatus: "pending", paymentProvider: "razorpay", providerPaymentId: null, providerOrderId: null, notes: null,
        });
        const yearlyOrderResp = await callController(paymentController.createOrderForExistingPayment, { params: { id: String(yearlyPayment.id) } });
        const yearlyOrderId = yearlyOrderResp.body?.razorpay?.orderId;
        const yearlySig = razorpaySignature(yearlyOrderId, "pay_test_fake_yearly", FAKE_KEY_SECRET);
        const beforeYearlyVerifyAt = Date.now();
        const yearlyVerifyResp = await callController(paymentController.verifyPayment, {
            params: { id: String(yearlyPayment.id) },
            body: { razorpayOrderId: yearlyOrderId, razorpayPaymentId: "pay_test_fake_yearly", razorpaySignature: yearlySig },
        });
        check("15. Verified yearly payment activates subscription", yearlyVerifyResp.status === 200 && yearlyVerifyResp.body?.subscriptionActivated === true);
        const companyAfterYearly = await platformCompanyService.getCompanyById(company.companyId);
        const expectedYearlyExpiry = new Date(beforeYearlyVerifyAt); expectedYearlyExpiry.setFullYear(expectedYearlyExpiry.getFullYear() + 1);
        check("15b. subscription_expires_at ~= now + 1 year",
            Math.abs(new Date(companyAfterYearly.subscription_expires_at).getTime() - expectedYearlyExpiry.getTime()) < 30000,
            `expected ~${expectedYearlyExpiry.toISOString()}, got ${companyAfterYearly.subscription_expires_at}`);

        // A Razorpay payment can NEVER be manually marked paid, even by
        // the Platform Owner, even via the generic manual-status
        // endpoint -- this is the security gap Phase 11 explicitly closes.
        const freshRzpPayment = await paymentService.createPaymentRecord({
            companyId: company.companyId, planId, amount: 499, currency: "INR", billingCycle: "monthly",
            paymentStatus: "pending", paymentProvider: "razorpay", providerPaymentId: null, providerOrderId: null, notes: null,
        });
        const patchRes = await fetch(`${BASE_URL}/api/platform/payments/${freshRzpPayment.id}/status`, {
            method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ status: "paid" }),
        });
        const patchBody = await patchRes.json().catch(() => null);
        check("SECURITY: Razorpay payment cannot be manually marked 'paid' via PATCH /status (400)", patchRes.status === 400, `got ${patchRes.status}, ${JSON.stringify(patchBody)}`);
        const stillPending = await paymentService.getPaymentById(freshRzpPayment.id);
        check("SECURITY: payment status genuinely unchanged after the rejected manual attempt", stillPending.payment_status === "pending");

        // ========================================
        // WEBHOOK (18-21) -- also in-process, needs its own fake secret.
        // ========================================
        console.log("\nWEBHOOK (in-process)");
        process.env.RAZORPAY_WEBHOOK_SECRET = FAKE_WEBHOOK_SECRET;

        const webhookPayment = await paymentService.createPaymentRecord({
            companyId: company.companyId, planId, amount: 499, currency: "INR", billingCycle: "monthly",
            paymentStatus: "pending", paymentProvider: "razorpay", providerPaymentId: null, providerOrderId: null, notes: null,
        });
        const webhookOrderResp = await callController(paymentController.createOrderForExistingPayment, { params: { id: String(webhookPayment.id) } });
        const webhookOrderId = webhookOrderResp.body?.razorpay?.orderId;

        const capturedEventBody = {
            event: "payment.captured",
            payload: { payment: { entity: { id: "pay_test_webhook_1", order_id: webhookOrderId, status: "captured" } } },
        };
        const rawBodyStr = JSON.stringify(capturedEventBody);

        const invalidWebhookSig = await callController(paymentController.handleRazorpayWebhook, {
            headers: { "x-razorpay-signature": "0".repeat(64) }, body: capturedEventBody, rawBody: rawBodyStr,
        });
        check("18. Invalid webhook signature rejected (401)", invalidWebhookSig.status === 401, JSON.stringify(invalidWebhookSig.body));
        const paymentAfterInvalidWebhook = await paymentService.getPaymentById(webhookPayment.id);
        check("18b. Payment unaffected by a rejected/invalid webhook", paymentAfterInvalidWebhook.payment_status === "pending");

        const validWebhookSig = webhookSignature(rawBodyStr, FAKE_WEBHOOK_SECRET);
        const validWebhookResp = await callController(paymentController.handleRazorpayWebhook, {
            headers: { "x-razorpay-signature": validWebhookSig }, body: capturedEventBody, rawBody: rawBodyStr,
        });
        check("19. Valid webhook signature accepted (200) and payment.captured processed", validWebhookResp.status === 200, JSON.stringify(validWebhookResp.body));
        const paymentAfterWebhook = await paymentService.getPaymentById(webhookPayment.id);
        check("19b. Webhook marked the payment paid", paymentAfterWebhook.payment_status === "paid");
        check("19c. Webhook stored the Razorpay payment id", paymentAfterWebhook.provider_payment_id === "pay_test_webhook_1");
        const invoiceAfterFirstWebhook = paymentAfterWebhook.invoice_number;
        const companyAfterWebhook = await platformCompanyService.getCompanyById(company.companyId);
        const expiryAfterFirstWebhook = companyAfterWebhook.subscription_expires_at;
        check("19d. Webhook activated the subscription too (same shared logic as verify)", companyAfterWebhook.subscription_status === "active");

        // 20/21. Duplicate webhook delivery (Razorpay's documented
        // at-least-once retries) must be a complete no-op the second
        // time -- same invoice, same expiry, no error.
        const duplicateWebhookResp = await callController(paymentController.handleRazorpayWebhook, {
            headers: { "x-razorpay-signature": validWebhookSig }, body: capturedEventBody, rawBody: rawBodyStr,
        });
        check("20. Duplicate webhook delivery is idempotent (200, no error)", duplicateWebhookResp.status === 200, JSON.stringify(duplicateWebhookResp.body));
        const paymentAfterDupWebhook = await paymentService.getPaymentById(webhookPayment.id);
        const companyAfterDupWebhook = await platformCompanyService.getCompanyById(company.companyId);
        check("21. Duplicate webhook did not reassign the invoice number", paymentAfterDupWebhook.invoice_number === invoiceAfterFirstWebhook);
        check("21b. Duplicate webhook did not extend the subscription expiry a second time", new Date(companyAfterDupWebhook.subscription_expires_at).getTime() === new Date(expiryAfterFirstWebhook).getTime());

        // Webhook arriving for an order already verified via the
        // frontend path (the other ordering in Phase 11I's scenario
        // list) -- reuse the very first monthlyPayment/orderId pair,
        // already verified above, and confirm a (simulated) webhook
        // for the SAME order is equally a no-op.
        const crossPathEventBody = {
            event: "payment.captured",
            payload: { payment: { entity: { id: "pay_test_fake_1", order_id: orderId, status: "captured" } } },
        };
        const crossPathRawBody = JSON.stringify(crossPathEventBody);
        const crossPathSig = webhookSignature(crossPathRawBody, FAKE_WEBHOOK_SECRET);
        const crossPathResp = await callController(paymentController.handleRazorpayWebhook, {
            headers: { "x-razorpay-signature": crossPathSig }, body: crossPathEventBody, rawBody: crossPathRawBody,
        });
        check("21c. Webhook for a payment already verified via the frontend path is a safe no-op", crossPathResp.status === 200);
        const companyAfterCrossPath = await platformCompanyService.getCompanyById(company.companyId);
        check("21d. No duplicate subscription activation across the two confirmation paths", new Date(companyAfterCrossPath.subscription_expires_at).getTime() === new Date(companyAfterDupWebhook.subscription_expires_at).getTime());

    } finally {
        uninstallMockRazorpayFetch();
        delete process.env.RAZORPAY_KEY_ID;
        delete process.env.RAZORPAY_KEY_SECRET;
        delete process.env.RAZORPAY_WEBHOOK_SECRET;
    }

    // ========================================
    // REGRESSION (22-26) -- 27 (Socket.IO) covered by re-running
    // _test_socket_tenant_isolation.js separately.
    // ========================================
    console.log("\nREGRESSION");

    const manualWorkflowRes = await apiPost("/api/platform/payments", { companyId: company.companyId, planId, amount: 250, billingCycle: "one_time", paymentStatus: "paid" }, token);
    check("22. Existing manual payment workflow still works (still forces provider='manual')",
        manualWorkflowRes.status === 201 && manualWorkflowRes.body?.payment?.paymentProvider === "manual" && manualWorkflowRes.body?.payment?.providerPaymentId === null,
        JSON.stringify(manualWorkflowRes.body?.payment));

    const trialExpireRes = await fetch(`${BASE_URL}/api/platform/companies/${company.companyId}/subscription`, {
        method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ planId, subscriptionStatus: "trial", trialEndsAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
    });
    check("SETUP: company subscription set to expired trial for regression checks", trialExpireRes.status === 200);
    const expiredLoginAttempt = await apiPost(`/api/tenant-auth/${COMPANY_SLUG}/login`, { employeeId: company.adminEmployeeId, password: ADMIN_PASSWORD });
    check("23. Existing subscription enforcement still works (expired trial login rejected, 403)", expiredLoginAttempt.status === 403, `got ${expiredLoginAttempt.status}`);
    check("24. Expired company remains blocked (same check as 23 -- access enforcement unchanged)", expiredLoginAttempt.status === 403);

    const dbPool = require("./config/db");
    // Phase 16A discovery -- see _test_security_hardening.js's comment
    // at this same check for the full explanation.
    const PLATFORM_TABLE_NAMES = ["platform_users", "subscription_plans", "companies", "demo_requests", "payments", "subscription_history", "platform_audit_logs", "platform_notifications", "email_delivery_logs", "email_domains", "mailboxes", "email_aliases", "mailbox_settings"];
    const [[{ tbl }]] = await dbPool.query(`SELECT COUNT(*) AS tbl FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT IN (${PLATFORM_TABLE_NAMES.map(() => "?").join(",")})`, PLATFORM_TABLE_NAMES);
    const [[{ users }]] = await dbPool.query(`SELECT COUNT(*) AS users FROM users`);
    check("25. reinsteins_workhub unchanged (37 tables, 17 users)", Number(tbl) === 37 && Number(users) === 17, `tables=${tbl} users=${users}`);
    const [[reinsteinsRow]] = await platformPool.query(`SELECT subscription_status, trial_ends_at, subscription_expires_at FROM companies WHERE company_slug = 'reinsteins'`);
    check("25b. Reinsteins subscription remains Complimentary/active with no expiry", reinsteinsRow.subscription_status === "active" && reinsteinsRow.trial_ends_at === null && reinsteinsRow.subscription_expires_at === null);
    const [reinsteinsPayments] = await platformPool.query(`SELECT p.id FROM payments p JOIN companies c ON c.id = p.company_id WHERE c.company_slug = 'reinsteins'`);
    check("25c. No payment records exist against Reinsteins", reinsteinsPayments.length === 0);

    const companyAInfo = await apiGet(`/api/tenant-auth/${COMPANY_SLUG}/info`);
    check("26. Tenant-auth info endpoint still resolves correctly", companyAInfo.status === 200 && companyAInfo.body?.company?.name === "RzpTest Alpha");
    const garbageOnDept = await apiGet("/api/departments", "not.a.real.jwt.token");
    check("26b. Tenant isolation: garbage token still rejected from tenant business API (401)", garbageOnDept.status === 401, `got ${garbageOnDept.status}`);

    console.log("\n27. Socket.IO isolation is covered by re-running _test_socket_tenant_isolation.js separately (see final report).");

    // ========================================
    // CLEANUP
    // ========================================
    console.log("\nCLEANUP");
    await platformPool.query(`DELETE FROM payments WHERE company_id = ?`, [company.companyId]);
    // Phase 13/14 -- see _test_payments.js's cleanup comment for why.
    await platformPool.query(`DELETE FROM email_delivery_logs WHERE company_id = ?`, [company.companyId]);
    const [[rzptestOwnerRow]] = await platformPool.query(`SELECT id FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    if (rzptestOwnerRow) await platformPool.query(`DELETE FROM platform_audit_logs WHERE platform_user_id = ?`, [rzptestOwnerRow.id]);
    await tenantProvisioningService.dropProvisionedDatabase(buildTenantDbName(COMPANY_SLUG));
    await platformPool.query(`DELETE FROM companies WHERE company_slug = ?`, [COMPANY_SLUG]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    await platformPool.query(`DELETE FROM subscription_plans WHERE id = ?`, [planId]);

    const [remainingPayments] = await platformPool.query(`SELECT id FROM payments WHERE company_id = ?`, [company.companyId]);
    check("CLEANUP: all temporary payment records deleted", remainingPayments.length === 0);
    const companyGone = (await platformCompanyService.getCompanyBySlug(COMPANY_SLUG)) === null;
    check("CLEANUP: temporary company confirmed gone", companyGone);
    const dbGone = !(await tenantProvisioningService.databaseExists(buildTenantDbName(COMPANY_SLUG)));
    check("CLEANUP: temporary tenant database confirmed gone", dbGone);
    const [remainingOwner] = await platformPool.query(`SELECT id FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    check("CLEANUP: temporary platform owner confirmed gone", remainingOwner.length === 0);
    const [remainingPlan] = await platformPool.query(`SELECT id FROM subscription_plans WHERE id = ?`, [planId]);
    check("CLEANUP: temporary plan confirmed gone", remainingPlan.length === 0);
    const [finalCompanies] = await platformPool.query(`SELECT company_slug FROM companies`);
    check("CLEANUP: only Reinsteins remains in companies", finalCompanies.length === 1 && finalCompanies[0].company_slug === "reinsteins", JSON.stringify(finalCompanies));
    check("ENV: no fake Razorpay credentials leaked into this process after cleanup", !process.env.RAZORPAY_KEY_ID && !process.env.RAZORPAY_KEY_SECRET && !process.env.RAZORPAY_WEBHOOK_SECRET);

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch((e) => { console.error(e); process.exit(1); });
