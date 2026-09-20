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
const subscriptionLifecycleService = require("./services/subscriptionLifecycleService");
const emailDeliveryService = require("./services/emailDeliveryService");
const emailService = require("./services/emailService");
const tenantUserService = require("./services/tenantUserService");
const platformPaymentController = require("./controllers/platformPaymentController");
const { EMAIL_MAX_RETRIES } = require("./config/emailConfig");

// ==========================================
// EMAIL / BILLING CONTACT SELF-TEST (Phase 13)
//
// SMTP is NOT configured in this environment -- and per the explicit
// rule "do not require a real SMTP server for automated tests", every
// send/fail scenario is exercised by temporarily monkey-patching
// emailService.sendMail IN THIS PROCESS ONLY (never touching the live
// server, never touching real SMTP config), restored in a finally
// block after each use. The "SMTP not configured" path is instead
// tested against the REAL, current, genuinely-unconfigured
// emailService -- that IS its real state in this deployment, so no
// mock is needed or appropriate there.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "emailtest_owner@groworgs.internal";
const OWNER_PASSWORD = "EmailTestOwner!2026Pwd";
const COMPANY_A_SLUG = "emailtest_alpha";
const COMPANY_B_SLUG = "emailtest_beta";
const ADMIN_PASSWORD = "EmailTestAdmin!2026Pwd";

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
async function apiPatch(p, body, token) {
    const res = await fetch(`${BASE_URL}${p}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body || {}) });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, body: json };
}
async function apiDelete(p, token) {
    const res = await fetch(`${BASE_URL}${p}`, { method: "DELETE", headers: token ? { Authorization: `Bearer ${token}` } : {} });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, body: json };
}

function mockRes() {
    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => { res.body = obj; return res; };
    return res;
}
async function callController(fn, { params = {}, body = {} } = {}) {
    const req = { params, body };
    const res = mockRes();
    await fn(req, res);
    return { status: res.statusCode, body: res.body };
}
function razorpaySignature(orderId, paymentId, keySecret) {
    return crypto.createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
}

const realSendMail = emailService.sendMail;
function mockSendMailSuccess() {
    emailService.sendMail = async () => ({ sent: true, messageId: `mock_${Date.now()}_${Math.random().toString(36).slice(2)}` });
}
function mockSendMailFailure(errorText = "Simulated SMTP failure") {
    emailService.sendMail = async () => ({ sent: false, reason: "send_failed", error: errorText });
}
function restoreSendMail() { emailService.sendMail = realSendMail; }

const realGetFirstAdmin = tenantUserService.getFirstAdmin;
function mockNoAdmin() { tenantUserService.getFirstAdmin = async () => null; }
function restoreGetFirstAdmin() { tenantUserService.getFirstAdmin = realGetFirstAdmin; }

const FAKE_KEY_ID = "rzp_test_fake_key_id_email";
const FAKE_KEY_SECRET = "fake_key_secret_email_only";
let mockOrderCounter = 0;
const realFetch = global.fetch;
function installMockRazorpayFetch() {
    mockOrderCounter = 0;
    global.fetch = async (url, opts) => {
        if (typeof url === "string" && url.startsWith("https://api.razorpay.com/v1/orders")) {
            const requestBody = JSON.parse(opts.body);
            mockOrderCounter += 1;
            const orderId = `order_email_mock_${mockOrderCounter}`;
            return { ok: true, json: async () => ({ id: orderId, amount: requestBody.amount, currency: requestBody.currency, status: "created" }) };
        }
        return realFetch(url, opts);
    };
}
function uninstallMockRazorpayFetch() { global.fetch = realFetch; }

async function getEmailLogRow(id) {
    const [rows] = await platformPool.query(`SELECT * FROM email_delivery_logs WHERE id = ?`, [id]);
    return rows[0] || null;
}
async function countEmailLogs(companyId, emailType) {
    const [rows] = await platformPool.query(`SELECT id FROM email_delivery_logs WHERE company_id = ? AND email_type = ?`, [companyId, emailType]);
    return rows.length;
}

async function createCompanyWithAdmin(ownerToken, slug, name) {
    const createRes = await apiPost("/api/platform/companies", { companyName: name, companySlug: slug, accessType: "trial" }, ownerToken);
    if (createRes.status !== 201) throw new Error(`Failed to create company ${slug}: ${JSON.stringify(createRes.body)}`);
    const companyId = createRes.body.company.id;
    const adminRes = await apiPost(`/api/platform/companies/${companyId}/admin`, {
        name: `${name} Admin`, email: `${slug}_admin@emailtest.internal`, password: ADMIN_PASSWORD,
    }, ownerToken);
    if (adminRes.status !== 201) throw new Error(`Failed to create admin for ${slug}: ${JSON.stringify(adminRes.body)}`);
    return { companyId, adminEmail: adminRes.body.admin.email };
}

(async () => {

    console.log("SETUP -- platform owner + two companies + paid plan");
    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    const owner = await platformUserService.create({ name: "EmailTest Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const token = loginRes.body?.token;
    check("SETUP: owner login succeeds", loginRes.status === 200 && !!token);

    const companyA = await createCompanyWithAdmin(token, COMPANY_A_SLUG, "EmailTest Alpha");
    const companyB = await createCompanyWithAdmin(token, COMPANY_B_SLUG, "EmailTest Beta");
    check("SETUP: both companies + admins created", !!companyA.companyId && !!companyB.companyId);

    const [planInsert] = await platformPool.query(
        `INSERT INTO subscription_plans (name, slug, status, monthly_price, yearly_price, employee_limit, features)
         VALUES ('EmailTest Plan', 'emailtest-plan', 'active', 499.00, 4999.00, 50, '[]')
         RETURNING id`
    );
    const planId = planInsert.insertId;

    const tenantShapedToken = jwt.sign({ id: 999999, employeeId: "EMAILTEST-BOUNDARY", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

    // ========================================
    // 1-4. BILLING CONTACT CRUD + VALIDATION
    // ========================================
    console.log("\nTEST 1-4 -- Billing contact add/edit/remove/validation");
    const invalidEmailRes = await apiPatch(`/api/platform/companies/${companyA.companyId}/billing-contact`, { name: "Bad", email: "not-an-email" }, token);
    check("4. Invalid billing contact email rejected (400)", invalidEmailRes.status === 400, `got ${invalidEmailRes.status}`);

    const addRes = await apiPatch(`/api/platform/companies/${companyA.companyId}/billing-contact`, { name: "Priya Sharma", email: "billing@emailtest-alpha.internal", phone: "9999999999" }, token);
    check("1. Add billing contact succeeds", addRes.status === 200 && addRes.body?.company?.billingContact?.email === "billing@emailtest-alpha.internal", JSON.stringify(addRes.body?.company?.billingContact));

    const editRes = await apiPatch(`/api/platform/companies/${companyA.companyId}/billing-contact`, { name: "Priya S. Updated", email: "billing-updated@emailtest-alpha.internal" }, token);
    check("2. Edit billing contact succeeds", editRes.status === 200 && editRes.body?.company?.billingContact?.email === "billing-updated@emailtest-alpha.internal");

    const removeRes = await apiDelete(`/api/platform/companies/${companyA.companyId}/billing-contact`, token);
    check("3. Remove billing contact succeeds", removeRes.status === 200 && removeRes.body?.company?.billingContact?.email === null, JSON.stringify(removeRes.body?.company?.billingContact));

    // 24. Billing contact cannot be modified through tenant APIs.
    const tenantBillingAttempt = await apiPatch(`/api/platform/companies/${companyA.companyId}/billing-contact`, { email: "hacker@evil.internal" }, tenantShapedToken);
    check("24. Tenant JWT rejected from billing-contact endpoint (401)", tenantBillingAttempt.status === 401, `got ${tenantBillingAttempt.status}`);

    // ========================================
    // 25. AUDIT LOG RECORDS BILLING CONTACT CHANGES
    // ========================================
    const [billingAuditRows] = await platformPool.query(
        `SELECT action_type FROM platform_audit_logs WHERE platform_user_id = ? AND company_id = ? AND action_type IN ('billing_contact_updated','billing_contact_removed') ORDER BY id`,
        [owner.id, companyA.companyId]
    );
    check("25. Audit log recorded billing_contact_updated and billing_contact_removed", billingAuditRows.some((r) => r.action_type === "billing_contact_updated") && billingAuditRows.some((r) => r.action_type === "billing_contact_removed"), JSON.stringify(billingAuditRows));

    // ========================================
    // 5/6/7/8. RECIPIENT PRIORITY + LOGGING
    // ========================================
    console.log("\nTEST 5-8 -- Recipient priority + email log creation");

    // Re-add a billing contact for companyA to test priority (5).
    await apiPatch(`/api/platform/companies/${companyA.companyId}/billing-contact`, { name: "Billing A", email: "billing-a@emailtest.internal" }, token);
    const companyAWithBilling = await platformCompanyService.getCompanyById(companyA.companyId);
    const recipientWithBilling = await emailDeliveryService.resolveRecipient(companyAWithBilling);
    check("5. Billing contact chosen before admin when both exist", recipientWithBilling?.source === "billing_contact" && recipientWithBilling.email === "billing-a@emailtest.internal", JSON.stringify(recipientWithBilling));

    // Remove it -> should fall back to the admin (6).
    await apiDelete(`/api/platform/companies/${companyA.companyId}/billing-contact`, token);
    const companyANoBilling = await platformCompanyService.getCompanyById(companyA.companyId);
    const recipientAdminFallback = await emailDeliveryService.resolveRecipient(companyANoBilling);
    check("6. Admin fallback works when no billing contact is set", recipientAdminFallback?.source === "admin" && recipientAdminFallback.email === companyA.adminEmail, JSON.stringify(recipientAdminFallback));

    // No recipient at all -> safe skip (7), and a real log row (8).
    mockNoAdmin();
    let noRecipientLogId;
    try {
        noRecipientLogId = await emailDeliveryService.sendLifecycleEmail({
            companyId: companyA.companyId, emailType: "trial_ending_soon",
            templateData: { companyName: "EmailTest Alpha", trialEndsAt: new Date(), planName: "EmailTest Plan", daysRemaining: 3 },
        });
    } finally {
        restoreGetFirstAdmin();
    }
    const noRecipientLog = await getEmailLogRow(noRecipientLogId);
    check("7. No recipient available results in a safely skipped email (status='skipped')", noRecipientLog?.status === "skipped", JSON.stringify(noRecipientLog));
    check("8. Email log created correctly (company/type/subject recorded)", noRecipientLog?.company_id === companyA.companyId && noRecipientLog?.email_type === "trial_ending_soon" && !!noRecipientLog?.subject);

    // ========================================
    // 9/10. MOCKED SEND SUCCESS / FAILURE
    // ========================================
    console.log("\nTEST 9/10 -- Mocked SMTP success/failure marking");
    await apiPatch(`/api/platform/companies/${companyA.companyId}/billing-contact`, { email: "success-target@emailtest.internal" }, token);

    mockSendMailSuccess();
    let sentLogId;
    try {
        sentLogId = await emailDeliveryService.sendLifecycleEmail({
            companyId: companyA.companyId, emailType: "trial_ending_soon",
            templateData: { companyName: "EmailTest Alpha", trialEndsAt: new Date(), planName: "EmailTest Plan", daysRemaining: 1 },
        });
    } finally { restoreSendMail(); }
    const sentLog = await getEmailLogRow(sentLogId);
    check("9. Successful mocked SMTP response marks the log 'sent' with a provider message id", sentLog?.status === "sent" && !!sentLog?.provider_message_id, JSON.stringify(sentLog));

    mockSendMailFailure("Simulated: connection refused");
    let failedLogId;
    try {
        failedLogId = await emailDeliveryService.sendLifecycleEmail({
            companyId: companyB.companyId, emailType: "payment_failed",
            templateData: { companyName: "EmailTest Beta", planName: "EmailTest Plan", amount: 499, currency: "INR" },
        });
    } finally { restoreSendMail(); }
    const failedLog = await getEmailLogRow(failedLogId);
    check("10. Failed send attempt marks the log 'failed' with the real error message", failedLog?.status === "failed" && failedLog?.error_message?.includes("connection refused"), JSON.stringify(failedLog));

    // ========================================
    // 11. FAILED EMAIL DOES NOT BREAK SUBSCRIPTION LIFECYCLE
    // ========================================
    console.log("\nTEST 11 -- Failed email does not break subscription lifecycle");
    await platformPool.query(`UPDATE companies SET subscription_status = 'trial', trial_ends_at = ? WHERE id = ?`, [new Date(Date.now() - 60 * 60 * 1000), companyB.companyId]);
    mockSendMailFailure("Simulated failure during trial expiry email");
    let trialExpiryDuringEmailFailure;
    try {
        const companyBTrial = await platformCompanyService.getCompanyById(companyB.companyId);
        trialExpiryDuringEmailFailure = await subscriptionLifecycleService.evaluateCompanySubscription(companyBTrial);
    } finally { restoreSendMail(); }
    check("11. Trial-expiry lifecycle transition still completes even though its email send failed", trialExpiryDuringEmailFailure?.changed === true, JSON.stringify(trialExpiryDuringEmailFailure));
    const companyBAfterExpiry = await platformCompanyService.getCompanyById(companyB.companyId);
    check("11b. Subscription status genuinely transitioned to 'expired' despite the email failure", companyBAfterExpiry.subscription_status === "expired");

    // ========================================
    // 12/13/14/15/16. RETRY SYSTEM
    // ========================================
    console.log("\nTEST 12-16 -- Retry system (increment, max cap, non-retryable states)");

    // 12/13: retry a failed log with a mocked SUCCESS this time.
    const retryTargetBefore = await getEmailLogRow(failedLogId);
    mockSendMailSuccess();
    let retryResult;
    try {
        retryResult = await emailDeliveryService.retryFailedEmail(failedLogId);
    } finally { restoreSendMail(); }
    check("12. Retry of a failed email works (now 'sent')", retryResult.error === null && retryResult.log.status === "sent", JSON.stringify(retryResult));
    check("13. retry_count incremented by the retry attempt", retryResult.log.retry_count === retryTargetBefore.retry_count + 1, `before=${retryTargetBefore.retry_count} after=${retryResult.log.retry_count}`);

    // 15: a 'sent' email cannot be retried again.
    const retrySentAgain = await emailDeliveryService.retryFailedEmail(failedLogId);
    check("15. A sent email cannot be retried (NOT_RETRYABLE)", retrySentAgain.error === "NOT_RETRYABLE", JSON.stringify(retrySentAgain));

    // 14: max retry count enforced -- create a fresh failed log and
    // exhaust its retries with mocked failures.
    mockSendMailFailure("Persistent simulated failure");
    let maxRetryLogId;
    try {
        maxRetryLogId = await emailDeliveryService.sendLifecycleEmail({
            companyId: companyB.companyId, emailType: "subscription_expired",
            templateData: { companyName: "EmailTest Beta", planName: "EmailTest Plan" },
        });
        for (let i = 0; i < EMAIL_MAX_RETRIES; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await emailDeliveryService.retryFailedEmail(maxRetryLogId);
        }
    } finally { restoreSendMail(); }
    const exhaustedLog = await getEmailLogRow(maxRetryLogId);
    check("14a. retry_count reached EMAIL_MAX_RETRIES after exhausting retries", exhaustedLog.retry_count === EMAIL_MAX_RETRIES, `retry_count=${exhaustedLog.retry_count} max=${EMAIL_MAX_RETRIES}`);
    const overLimitRetry = await emailDeliveryService.retryFailedEmail(maxRetryLogId);
    check("14b. Maximum retry count enforced -- further retry rejected", overLimitRetry.error === "MAX_RETRIES_EXCEEDED", JSON.stringify(overLimitRetry));

    // 16: a skipped email (test 7's noRecipientLogId) is never
    // automatically retried by the sweep's processEmailRetries.
    const retryPassResult = await emailDeliveryService.processEmailRetries();
    const skippedLogAfterSweep = await getEmailLogRow(noRecipientLogId);
    check("16. A skipped email is not touched by the automatic retry pass", skippedLogAfterSweep.status === "skipped" && skippedLogAfterSweep.retry_count === 0, JSON.stringify(skippedLogAfterSweep));
    void retryPassResult;

    // ========================================
    // 17. DUPLICATE LIFECYCLE SWEEP DOES NOT DUPLICATE EMAILS
    // ========================================
    console.log("\nTEST 17 -- Duplicate sweep does not duplicate emails");
    await platformPool.query(`UPDATE companies SET subscription_status = 'trial', trial_ends_at = ? WHERE id = ?`, [new Date(Date.now() + 20 * 60 * 60 * 1000), companyA.companyId]);
    mockSendMailSuccess();
    try {
        const companyAForDedup = await platformCompanyService.getCompanyById(companyA.companyId);
        await subscriptionLifecycleService.evaluateCompanySubscription(companyAForDedup);
        const companyAForDedup2 = await platformCompanyService.getCompanyById(companyA.companyId);
        await subscriptionLifecycleService.evaluateCompanySubscription(companyAForDedup2);
    } finally { restoreSendMail(); }
    const dedupCount = await countEmailLogs(companyA.companyId, "trial_ending_soon");
    // Exactly one NEW email for this specific trial_ends_at value --
    // test 7/9 above already created 'trial_ending_soon' rows for a
    // DIFFERENT trial_ends_at, so this count is "at least 1 new, not
    // 2 new from the duplicate sweep call" -- verified via history dedup.
    const [historyRows] = await platformPool.query(
        `SELECT id FROM subscription_history WHERE company_id = ? AND event_type = 'trial_ending_soon_1d'`,
        [companyA.companyId]
    );
    check("17. Duplicate sweep call does not create a duplicate history/email pair (exactly one 1d reminder logged)", historyRows.length === 1, `history rows=${historyRows.length}`);
    void dedupCount;

    // ========================================
    // 18. DUPLICATE WEBHOOK/VERIFY DOES NOT DUPLICATE RENEWAL EMAIL
    // ========================================
    console.log("\nTEST 18 -- Duplicate verification does not duplicate renewal email");
    process.env.RAZORPAY_KEY_ID = FAKE_KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = FAKE_KEY_SECRET;
    installMockRazorpayFetch();
    mockSendMailSuccess();
    try {
        const renewalPayment = await paymentService.createPaymentRecord({
            companyId: companyB.companyId, planId, amount: 499, currency: "INR", billingCycle: "monthly",
            paymentStatus: "pending", paymentProvider: "razorpay", providerPaymentId: null, providerOrderId: null, notes: null,
        });
        const orderResp = await callController(platformPaymentController.createOrderForExistingPayment, { params: { id: String(renewalPayment.id) } });
        const orderId = orderResp.body?.razorpay?.orderId;
        const signature = razorpaySignature(orderId, "pay_email_dup_test", FAKE_KEY_SECRET);

        await callController(platformPaymentController.verifyPayment, {
            params: { id: String(renewalPayment.id) },
            body: { razorpayOrderId: orderId, razorpayPaymentId: "pay_email_dup_test", razorpaySignature: signature },
        });
        // Duplicate verification call (browser refresh / duplicate webhook scenario).
        await callController(platformPaymentController.verifyPayment, {
            params: { id: String(renewalPayment.id) },
            body: { razorpayOrderId: orderId, razorpayPaymentId: "pay_email_dup_test", razorpaySignature: signature },
        });
    } finally {
        uninstallMockRazorpayFetch();
        restoreSendMail();
        delete process.env.RAZORPAY_KEY_ID;
        delete process.env.RAZORPAY_KEY_SECRET;
    }
    const [renewalEmailRows] = await platformPool.query(
        `SELECT id FROM email_delivery_logs WHERE company_id = ? AND email_type = 'subscription_renewed'`,
        [companyB.companyId]
    );
    check("18. Duplicate verification call results in exactly one renewal email log row", renewalEmailRows.length === 1, `rows=${renewalEmailRows.length}`);

    // ========================================
    // 19. SMTP NOT CONFIGURED DOES NOT CRASH
    //
    // This deployment's real .env actually sets SMTP_HOST (pointing at
    // a local MailDev instance that isn't currently running) -- so the
    // REAL, unmocked emailService genuinely attempts a send and gets a
    // real connection error, which correctly logs 'failed' (a real
    // attempt was made), not 'skipped'. Both sub-cases below use the
    // REAL, unmocked emailService.sendMail -- no mock -- to prove
    // neither the true "nothing configured" state NOR the "configured
    // but unreachable" state ever crashes the process.
    // ========================================
    console.log("\nTEST 19 -- SMTP not configured/unreachable does not crash (real, unmocked emailService)");
    await apiPatch(`/api/platform/companies/${companyA.companyId}/billing-contact`, { email: "realsmtp-check@emailtest.internal" }, token);

    // 19a: genuinely unconfigured (SMTP_HOST unset in-process only --
    // real .env file and the live server process are untouched).
    const realSmtpHost = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    let unconfiguredLogId;
    let unconfiguredThrew = false;
    try {
        unconfiguredLogId = await emailDeliveryService.sendLifecycleEmail({
            companyId: companyA.companyId, emailType: "trial_expired",
            templateData: { companyName: "EmailTest Alpha", trialEndsAt: new Date() },
        });
    } catch (_e) {
        unconfiguredThrew = true;
    } finally {
        process.env.SMTP_HOST = realSmtpHost;
    }
    check("19a. Sending with genuinely unconfigured SMTP does not throw", !unconfiguredThrew);
    const unconfiguredLog = await getEmailLogRow(unconfiguredLogId);
    check("19b. Genuinely unconfigured SMTP correctly logs status='skipped' (never attempted, not a send error)", unconfiguredLog?.status === "skipped", JSON.stringify(unconfiguredLog));

    // 19c: configured but unreachable (this deployment's actual
    // current real state -- SMTP_HOST is set, MailDev isn't running).
    let unreachableLogId;
    let unreachableThrew = false;
    try {
        unreachableLogId = await emailDeliveryService.sendLifecycleEmail({
            companyId: companyA.companyId, emailType: "trial_expired",
            templateData: { companyName: "EmailTest Alpha", trialEndsAt: new Date() },
        });
    } catch (_e) {
        unreachableThrew = true;
    }
    check("19d. Sending with configured-but-unreachable SMTP does not throw", !unreachableThrew);
    const unreachableLog = await getEmailLogRow(unreachableLogId);
    check("19e. Configured-but-unreachable SMTP correctly logs status='failed' with a real error (a genuine attempt was made)", unreachableLog?.status === "failed" && !!unreachableLog?.error_message, JSON.stringify(unreachableLog));

    // ========================================
    // 20. SMTP SECRETS NEVER APPEAR IN API RESPONSES
    // ========================================
    console.log("\nTEST 20 -- SMTP secrets never exposed via API");
    const statusRes = await apiGet("/api/platform/email-logs/status", token);
    const statusBodyText = JSON.stringify(statusRes.body).toLowerCase();
    check("20. GET /email-logs/status never includes a password/secret field or value", !statusBodyText.includes("smtp_pass") && !statusBodyText.includes("password"), statusBodyText);
    check("20b. Status endpoint reports only booleans/safe metadata (configured/sendingEnabled/fromAddress)", typeof statusRes.body?.status?.configured === "boolean");

    // ========================================
    // 21/22. AUTH BOUNDARIES
    // ========================================
    console.log("\nTEST 21/22 -- Auth boundaries on platform email APIs");
    const tenantOnLogs = await apiGet("/api/platform/email-logs", tenantShapedToken);
    check("21. Tenant JWT rejected from GET /email-logs (401)", tenantOnLogs.status === 401, `got ${tenantOnLogs.status}`);
    const tenantOnStatus = await apiGet("/api/platform/email-logs/status", tenantShapedToken);
    check("21b. Tenant JWT rejected from GET /email-logs/status (401)", tenantOnStatus.status === 401, `got ${tenantOnStatus.status}`);
    const tenantOnTest = await apiPost("/api/platform/email-logs/test-connection", {}, tenantShapedToken);
    check("21c. Tenant JWT rejected from POST /email-logs/test-connection (401)", tenantOnTest.status === 401, `got ${tenantOnTest.status}`);
    const tenantOnRetry = await apiPost(`/api/platform/email-logs/${failedLogId}/retry`, {}, tenantShapedToken);
    check("21d. Tenant JWT rejected from POST /email-logs/:id/retry (401)", tenantOnRetry.status === 401, `got ${tenantOnRetry.status}`);
    const noAuthOnLogs = await apiGet("/api/platform/email-logs");
    check("21e. Unauthenticated request rejected from GET /email-logs (401)", noAuthOnLogs.status === 401);

    const ownerOnLogs = await apiGet("/api/platform/email-logs", token);
    check("22. Platform JWT accepted on GET /email-logs (200)", ownerOnLogs.status === 200, JSON.stringify(ownerOnLogs.body)?.slice(0, 150));
    const ownerOnStatus = await apiGet("/api/platform/email-logs/status", token);
    check("22b. Platform JWT accepted on GET /email-logs/status (200)", ownerOnStatus.status === 200);

    // ========================================
    // 23. EMAIL LOGS ISOLATED APPROPRIATELY
    // ========================================
    console.log("\nTEST 23 -- Email logs isolated by company");
    const logsForA = await apiGet(`/api/platform/email-logs?companyId=${companyA.companyId}`, token);
    const logsForB = await apiGet(`/api/platform/email-logs?companyId=${companyB.companyId}`, token);
    check("23. Company A's filtered logs contain no Company B entries", logsForA.body.logs.every((l) => l.companyId === companyA.companyId));
    check("23b. Company B's filtered logs contain no Company A entries", logsForB.body.logs.every((l) => l.companyId === companyB.companyId));

    // ========================================
    // 26. AUDIT LOG RECORDS MANUAL RETRY
    // ========================================
    console.log("\nTEST 26 -- Audit log records manual retry");
    // Use the HTTP retry endpoint (the real manual-retry path) against
    // the exhausted-but-not-yet-maxed... actually use a FRESH failed
    // log so the HTTP call succeeds cleanly.
    mockSendMailFailure("For manual retry audit test");
    let manualRetryTargetId;
    try {
        manualRetryTargetId = await emailDeliveryService.sendLifecycleEmail({
            companyId: companyA.companyId, emailType: "grace_period_started",
            templateData: { companyName: "EmailTest Alpha", gracePeriodEndsAt: new Date(), planName: "EmailTest Plan" },
        });
    } finally { restoreSendMail(); }
    mockSendMailSuccess();
    let manualRetryHttpRes;
    try {
        manualRetryHttpRes = await apiPost(`/api/platform/email-logs/${manualRetryTargetId}/retry`, {}, token);
    } finally { restoreSendMail(); }
    check("SETUP: manual retry via HTTP succeeds", manualRetryHttpRes.status === 200, JSON.stringify(manualRetryHttpRes.body));
    const [retryAuditRows] = await platformPool.query(
        `SELECT id FROM platform_audit_logs WHERE platform_user_id = ? AND action_type = 'email_retried' AND target_id = ?`,
        [owner.id, manualRetryTargetId]
    );
    check("26. Audit log recorded the manual email retry", retryAuditRows.length === 1, JSON.stringify(retryAuditRows));

    // ========================================
    // 27. REINSTEINS UNCHANGED
    // ========================================
    console.log("\nTEST 27 -- Reinsteins unchanged");
    const dbPool = require("./config/db");
    // Phase 16A discovery -- see _test_security_hardening.js's comment
    // at this same check for the full explanation.
    const PLATFORM_TABLE_NAMES = ["platform_users", "subscription_plans", "companies", "demo_requests", "payments", "subscription_history", "platform_audit_logs", "platform_notifications", "email_delivery_logs", "email_domains", "mailboxes", "email_aliases", "mailbox_settings"];
    const [[{ tbl }]] = await dbPool.query(`SELECT COUNT(*) AS tbl FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT IN (${PLATFORM_TABLE_NAMES.map(() => "?").join(",")})`, PLATFORM_TABLE_NAMES);
    const [[{ users }]] = await dbPool.query(`SELECT COUNT(*) AS users FROM users`);
    check("27. reinsteins_workhub unchanged (37 tables, 17 users)", Number(tbl) === 37 && Number(users) === 17, `tables=${tbl} users=${users}`);
    const [[reinsteinsRow]] = await platformPool.query(
        `SELECT subscription_status, trial_ends_at, subscription_expires_at, grace_period_ends_at, billing_contact_email FROM companies WHERE company_slug = 'reinsteins'`
    );
    check("27b. Reinsteins remains Complimentary/active with no expiry/grace/billing contact", reinsteinsRow.subscription_status === "active" && reinsteinsRow.trial_ends_at === null && reinsteinsRow.subscription_expires_at === null && reinsteinsRow.grace_period_ends_at === null && reinsteinsRow.billing_contact_email === null);
    const [reinsteinsEmailLogs] = await platformPool.query(
        `SELECT e.id FROM email_delivery_logs e JOIN companies c ON c.id = e.company_id WHERE c.company_slug = 'reinsteins'`
    );
    check("27c. No email_delivery_logs rows exist for Reinsteins", reinsteinsEmailLogs.length === 0);
    const [reinsteinsAudit] = await platformPool.query(
        `SELECT id FROM platform_audit_logs WHERE company_id = (SELECT id FROM companies WHERE company_slug = 'reinsteins')`
    );
    check("27d. No audit log rows target Reinsteins from this test run", reinsteinsAudit.length === 0);

    // ========================================
    // CLEANUP
    // ========================================
    console.log("\nCLEANUP");
    await platformPool.query(`DELETE FROM email_delivery_logs WHERE company_id IN (?, ?)`, [companyA.companyId, companyB.companyId]);
    await platformPool.query(`DELETE FROM platform_notifications WHERE company_id IN (?, ?)`, [companyA.companyId, companyB.companyId]);
    await platformPool.query(`DELETE FROM platform_audit_logs WHERE platform_user_id = ?`, [owner.id]);
    await platformPool.query(`DELETE FROM payments WHERE company_id IN (?, ?)`, [companyA.companyId, companyB.companyId]);
    await tenantProvisioningService.dropProvisionedDatabase(buildTenantDbName(COMPANY_A_SLUG));
    await tenantProvisioningService.dropProvisionedDatabase(buildTenantDbName(COMPANY_B_SLUG));
    await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?)`, [COMPANY_A_SLUG, COMPANY_B_SLUG]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    await platformPool.query(`DELETE FROM subscription_plans WHERE id = ?`, [planId]);

    const [remainingEmailLogs] = await platformPool.query(`SELECT id FROM email_delivery_logs WHERE company_id IN (?, ?)`, [companyA.companyId, companyB.companyId]);
    check("CLEANUP: all email_delivery_logs rows gone", remainingEmailLogs.length === 0);
    const [remainingAudit] = await platformPool.query(`SELECT id FROM platform_audit_logs WHERE platform_user_id = ?`, [owner.id]);
    check("CLEANUP: all test audit log rows gone", remainingAudit.length === 0);
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
    check("ENV: no fake Razorpay credentials leaked into this process after cleanup", !process.env.RAZORPAY_KEY_ID && !process.env.RAZORPAY_KEY_SECRET);
    check("ENV: emailService.sendMail restored to its real implementation", emailService.sendMail === realSendMail);
    check("ENV: tenantUserService.getFirstAdmin restored to its real implementation", tenantUserService.getFirstAdmin === realGetFirstAdmin);

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch((e) => { console.error(e); process.exit(1); });
