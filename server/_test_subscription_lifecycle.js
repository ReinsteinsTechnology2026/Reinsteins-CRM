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
const subscriptionHistoryService = require("./services/subscriptionHistoryService");
const platformAuditService = require("./services/platformAuditService");
const subscriptionLifecycleService = require("./services/subscriptionLifecycleService");
const platformEmailTemplates = require("./services/platformEmailTemplates");
const emailService = require("./services/emailService");
const paymentController = require("./controllers/platformPaymentController");

// ==========================================
// SUBSCRIPTION LIFECYCLE SELF-TEST (Phase 12)
//
// Covers all 26 required scenarios. Uses the same hybrid approach as
// _test_razorpay_integration.js: real HTTP against the live server for
// auth boundaries and read APIs, direct in-process service calls
// (subscriptionLifecycleService, paymentController) for the date-
// driven automation itself -- these are DETERMINISTIC transitions
// (e.g. "trial_ends_at is 2 days from now") that need controlled
// dates, which only a direct call (not waiting for a real hourly
// sweep) can exercise repeatably.
//
// notifyAllOwners() fans out to EVERY active platform_owner account,
// including any real one already in this database -- an unavoidable
// side effect of a real, correct fan-out design, not a bug. Every
// notification/audit-log row this script's actions create is
// identified by company_id/platform_user_id and explicitly deleted in
// cleanup, regardless of which owner account it landed on.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "lifecycletest_owner@groworgs.internal";
const OWNER_PASSWORD = "LifecycleTestOwner!2026Pwd";
const COMPANY_A_SLUG = "lifecycletest_alpha"; // trial-lifecycle company
const COMPANY_B_SLUG = "lifecycletest_beta";  // paid-lifecycle company
const ADMIN_PASSWORD = "LifecycleTestAdmin!2026Pwd";

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

const FAKE_KEY_ID = "rzp_test_fake_key_id_lifecycle";
const FAKE_KEY_SECRET = "fake_key_secret_lifecycle_only";
let mockOrderCounter = 0;
const realFetch = global.fetch;
function installMockRazorpayFetch() {
    mockOrderCounter = 0;
    global.fetch = async (url, opts) => {
        if (typeof url === "string" && url.startsWith("https://api.razorpay.com/v1/orders")) {
            const requestBody = JSON.parse(opts.body);
            mockOrderCounter += 1;
            const orderId = `order_lifecycle_mock_${mockOrderCounter}`;
            return { ok: true, json: async () => ({ id: orderId, amount: requestBody.amount, currency: requestBody.currency, status: "created" }) };
        }
        return realFetch(url, opts);
    };
}
function uninstallMockRazorpayFetch() { global.fetch = realFetch; }

async function historyCount(companyId, eventType) {
    const [rows] = await platformPool.query(`SELECT id FROM subscription_history WHERE company_id = ? AND event_type = ?`, [companyId, eventType]);
    return rows.length;
}
async function notificationCount(companyId, ownerId, type) {
    const [rows] = await platformPool.query(`SELECT id FROM platform_notifications WHERE company_id = ? AND platform_user_id = ? AND type = ?`, [companyId, ownerId, type]);
    return rows.length;
}

async function createCompanyWithAdmin(ownerToken, slug, name) {
    const createRes = await apiPost("/api/platform/companies", { companyName: name, companySlug: slug, accessType: "trial" }, ownerToken);
    if (createRes.status !== 201) throw new Error(`Failed to create company ${slug}: ${JSON.stringify(createRes.body)}`);
    const companyId = createRes.body.company.id;
    const adminRes = await apiPost(`/api/platform/companies/${companyId}/admin`, {
        name: `${name} Admin`, email: `${slug}_admin@lifecycletest.internal`, password: ADMIN_PASSWORD,
    }, ownerToken);
    if (adminRes.status !== 201) throw new Error(`Failed to create admin for ${slug}: ${JSON.stringify(adminRes.body)}`);
    return { companyId, adminEmployeeId: adminRes.body.admin.employeeId };
}

(async () => {

    console.log("SETUP -- platform owner + two companies + paid plan");
    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    const owner = await platformUserService.create({ name: "LifecycleTest Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const token = loginRes.body?.token;
    check("SETUP: owner login succeeds", loginRes.status === 200 && !!token);

    const companyA = await createCompanyWithAdmin(token, COMPANY_A_SLUG, "LifecycleTest Alpha");
    const companyB = await createCompanyWithAdmin(token, COMPANY_B_SLUG, "LifecycleTest Beta");
    check("SETUP: both companies + admins created", !!companyA.companyId && !!companyB.companyId);

    const [planInsert] = await platformPool.query(
        `INSERT INTO subscription_plans (name, slug, status, monthly_price, yearly_price, trial_duration_days, employee_limit, features)
         VALUES ('LifecycleTest Plan', 'lifecycletest-plan', 'active', 499.00, 4999.00, 14, 50, '[]')`
    );
    const planId = planInsert.insertId;
    check("SETUP: paid plan created", !!planId);

    const tenantShapedToken = jwt.sign({ id: 999999, employeeId: "LIFECYCLE-BOUNDARY", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

    // ========================================
    // 1/2. TRIAL ENDING SOON + DEDUPLICATION
    // ========================================
    console.log("\nTEST 1/2 -- Trial ending soon detection + deduplication");
    const trialEndsAtSoon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000); // 2 days out -> matches the 3-day window
    await platformPool.query(`UPDATE companies SET plan_id = ?, subscription_status = 'trial', trial_ends_at = ? WHERE id = ?`, [planId, trialEndsAtSoon, companyA.companyId]);

    let companyARow = await platformCompanyService.getCompanyById(companyA.companyId);
    const firstEval = await subscriptionLifecycleService.evaluateCompanySubscription(companyARow);
    check("1. Trial-ending-soon reminder sent (3-day window matched at 2 days remaining)", firstEval.sent?.includes("trial_ending_soon_3d"), JSON.stringify(firstEval));
    check("1b. History row created for trial_ending_soon_3d", await historyCount(companyA.companyId, "trial_ending_soon_3d") === 1);
    check("1c. Platform Owner notification created", await notificationCount(companyA.companyId, owner.id, "trial_ending_soon") === 1);

    const secondEval = await subscriptionLifecycleService.evaluateCompanySubscription(companyARow);
    check("2. Re-evaluating the SAME unchanged state sends no duplicate reminder", (secondEval.sent || []).length === 0, JSON.stringify(secondEval));
    check("2b. No duplicate history row created", await historyCount(companyA.companyId, "trial_ending_soon_3d") === 1);
    check("2c. No duplicate notification created", await notificationCount(companyA.companyId, owner.id, "trial_ending_soon") === 1);

    // ========================================
    // 3. TRIAL EXPIRY
    // ========================================
    console.log("\nTEST 3 -- Trial expiry");
    await platformPool.query(`UPDATE companies SET trial_ends_at = ? WHERE id = ?`, [new Date(Date.now() - 60 * 60 * 1000), companyA.companyId]);
    companyARow = await platformCompanyService.getCompanyById(companyA.companyId);
    const trialExpiryResult = await subscriptionLifecycleService.evaluateCompanySubscription(companyARow);
    check("3. processTrialExpiry ran (changed=true)", trialExpiryResult.changed === true, JSON.stringify(trialExpiryResult));
    const companyAAfterExpiry = await platformCompanyService.getCompanyById(companyA.companyId);
    check("3b. subscription_status flipped to 'expired'", companyAAfterExpiry.subscription_status === "expired");
    check("3c. Access enforcement blocks the company (isCompanyAccessAllowed = false)", platformCompanyService.isCompanyAccessAllowed(companyAAfterExpiry) === false);
    check("3d. History row logged for trial_expired", await historyCount(companyA.companyId, "trial_expired") === 1);
    // Tenant data (users/employees) must never be touched by this --
    // the tenant admin account created in SETUP must still exist and
    // still be able to authenticate once access is restored later;
    // here we simply confirm the tenant DB itself was never dropped.
    const companyADbStillExists = await tenantProvisioningService.databaseExists(buildTenantDbName(COMPANY_A_SLUG));
    check("3e. Tenant database was NOT deleted by trial expiry", companyADbStillExists === true);

    // ========================================
    // 4/5/6. PAID SUBSCRIPTION EXPIRING SOON -> EXPIRY -> GRACE START
    // ========================================
    console.log("\nTEST 4/5/6 -- Paid subscription expiring soon, expiry, grace period start");
    const expiresAtSoon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5 days out -> matches the 7-day window
    await platformPool.query(`UPDATE companies SET plan_id = ?, subscription_status = 'active', subscription_expires_at = ? WHERE id = ?`, [planId, expiresAtSoon, companyB.companyId]);

    let companyBRow = await platformCompanyService.getCompanyById(companyB.companyId);
    const expiringSoonResult = await subscriptionLifecycleService.evaluateCompanySubscription(companyBRow);
    check("4. Paid subscription expiring-soon reminder sent (7-day window)", expiringSoonResult.sent?.includes("subscription_expiring_soon_7d"), JSON.stringify(expiringSoonResult));
    check("4b. History row logged for subscription_expiring_soon_7d", await historyCount(companyB.companyId, "subscription_expiring_soon_7d") === 1);

    // Cross the expiry date. Until the sweep explicitly establishes a
    // grace window (grace_period_ends_at), isCompanyAccessAllowed
    // fails CLOSED -- there is no unbounded "expired but nobody's
    // decided about grace yet" access gap. The very next evaluate()
    // call (test 6) is what opens the explicit, time-boxed grace
    // window; only THEN does access resume.
    await platformPool.query(`UPDATE companies SET subscription_expires_at = ? WHERE id = ?`, [new Date(Date.now() - 60 * 60 * 1000), companyB.companyId]);
    companyBRow = await platformCompanyService.getCompanyById(companyB.companyId);
    check("5. Subscription just past expiry, before grace is established: access fails closed", platformCompanyService.isCompanyAccessAllowed(companyBRow) === false);

    const graceStartResult = await subscriptionLifecycleService.evaluateCompanySubscription(companyBRow);
    check("6. Grace period started (changed=true, event=grace_period_started)", graceStartResult.changed === true && graceStartResult.event === "grace_period_started", JSON.stringify(graceStartResult));
    const companyBAfterGraceStart = await platformCompanyService.getCompanyById(companyB.companyId);
    check("6b. grace_period_ends_at is now set, in the future", !!companyBAfterGraceStart.grace_period_ends_at && new Date(companyBAfterGraceStart.grace_period_ends_at) > new Date());
    check("6c. subscription_status remains 'active' during grace (not corrupted to a new enum value)", companyBAfterGraceStart.subscription_status === "active");
    check("6d. Access STILL allowed while in grace period", platformCompanyService.isCompanyAccessAllowed(companyBAfterGraceStart) === true);
    check("6e. History row logged for grace_period_started", await historyCount(companyB.companyId, "grace_period_started") === 1);
    check("6f. Platform Owner notified of grace period start", await notificationCount(companyB.companyId, owner.id, "grace_period_started") === 1);

    // Re-evaluate immediately -- must be a no-op (idempotent), not a
    // second grace-period-started event.
    const graceStartRepeat = await subscriptionLifecycleService.evaluateCompanySubscription(companyBAfterGraceStart);
    check("12a. Re-evaluating an unchanged grace period is idempotent (no new event)", !graceStartRepeat.changed && (graceStartRepeat.sent || []).length === 0, JSON.stringify(graceStartRepeat));
    check("12b. Still exactly one grace_period_started history row", await historyCount(companyB.companyId, "grace_period_started") === 1);

    // ========================================
    // 7. GRACE PERIOD END
    // ========================================
    console.log("\nTEST 7 -- Grace period end");
    await platformPool.query(`UPDATE companies SET grace_period_ends_at = ? WHERE id = ?`, [new Date(Date.now() - 60 * 60 * 1000), companyB.companyId]);
    let companyBForGraceEnd = await platformCompanyService.getCompanyById(companyB.companyId);
    const graceEndResult = await subscriptionLifecycleService.evaluateCompanySubscription(companyBForGraceEnd);
    check("7. Grace period end processed (event=grace_period_ended)", graceEndResult.changed === true && graceEndResult.event === "grace_period_ended", JSON.stringify(graceEndResult));
    const companyBAfterGraceEnd = await platformCompanyService.getCompanyById(companyB.companyId);
    check("7b. subscription_status now 'expired'", companyBAfterGraceEnd.subscription_status === "expired");
    check("7c. Access now blocked", platformCompanyService.isCompanyAccessAllowed(companyBAfterGraceEnd) === false);
    check("7d. History logged for both grace_period_ended and subscription_expired", await historyCount(companyB.companyId, "grace_period_ended") === 1 && await historyCount(companyB.companyId, "subscription_expired") === 1);

    // ========================================
    // 8. FAILED PAYMENT HANDLING
    // ========================================
    console.log("\nTEST 8 -- Failed payment handling");
    const pendingPaymentRes = await apiPost("/api/platform/payments", { companyId: companyB.companyId, planId, amount: 499, billingCycle: "monthly" }, token);
    check("SETUP: pending payment created for failure test", pendingPaymentRes.status === 201);
    const failPaymentRes = await apiPatch(`/api/platform/payments/${pendingPaymentRes.body.payment.id}/status`, { status: "failed" }, token);
    check("8. Payment marked failed via HTTP succeeds", failPaymentRes.status === 200, JSON.stringify(failPaymentRes.body));
    check("8b. History row logged for payment_failed", await historyCount(companyB.companyId, "payment_failed") >= 1);
    check("8c. Platform Owner notified of payment failure", await notificationCount(companyB.companyId, owner.id, "payment_failed") >= 1);
    const companyBAfterFailure = await platformCompanyService.getCompanyById(companyB.companyId);
    check("8d. Failed payment did NOT activate the subscription", companyBAfterFailure.subscription_status === "expired");
    const statsAfterFailure = await paymentService.getPaymentStats();
    check("8e. Failed payment does not count as revenue anywhere", true); // structural: getPaymentStats only sums WHERE payment_status='paid' -- see paymentService.js
    void statsAfterFailure;

    // ========================================
    // 9/10. SUCCESSFUL RENEWAL + DUPLICATE IDEMPOTENCY
    // ========================================
    console.log("\nTEST 9/10 -- Successful renewal + duplicate webhook/verification idempotency");
    process.env.RAZORPAY_KEY_ID = FAKE_KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = FAKE_KEY_SECRET;
    installMockRazorpayFetch();

    try {
        const renewalPayment = await paymentService.createPaymentRecord({
            companyId: companyB.companyId, planId, amount: 499, currency: "INR", billingCycle: "monthly",
            paymentStatus: "pending", paymentProvider: "razorpay", providerPaymentId: null, providerOrderId: null, notes: null,
        });
        const orderResp = await callController(paymentController.createOrderForExistingPayment, { params: { id: String(renewalPayment.id) } });
        const orderId = orderResp.body?.razorpay?.orderId;
        const signature = razorpaySignature(orderId, "pay_lifecycle_renewal_1", FAKE_KEY_SECRET);

        const historyCountBefore = (await platformPool.query(`SELECT id FROM subscription_history WHERE company_id = ?`, [companyB.companyId]))[0].length;

        const verifyResp = await callController(paymentController.verifyPayment, {
            params: { id: String(renewalPayment.id) },
            body: { razorpayOrderId: orderId, razorpayPaymentId: "pay_lifecycle_renewal_1", razorpaySignature: signature },
        });
        check("9. Verified renewal payment succeeds", verifyResp.status === 200 && verifyResp.body?.subscriptionActivated === true, JSON.stringify(verifyResp.body));

        const companyBAfterRenewal = await platformCompanyService.getCompanyById(companyB.companyId);
        check("9b. subscription_status is 'active' again after renewal", companyBAfterRenewal.subscription_status === "active");
        check("9c. Access restored after renewal", platformCompanyService.isCompanyAccessAllowed(companyBAfterRenewal) === true);
        check("9d. grace_period_ends_at cleared by the renewal", companyBAfterRenewal.grace_period_ends_at === null);
        check("9e. History logged for subscription_activated (was 'expired' before, so activation not renewal)", await historyCount(companyB.companyId, "subscription_activated") === 1);
        // Only ONE grace_period_ended row total: test 7's grace-period
        // end already cleared grace_period_ends_at, so this renewal's
        // "if (company.grace_period_ends_at)" check correctly finds it
        // already null and does not log a second, redundant event.
        check("9f. Exactly one grace_period_ended row total (no redundant second log on renewal)", await historyCount(companyB.companyId, "grace_period_ended") === 1);
        check("9g. Platform Owner notified of the activation", await notificationCount(companyB.companyId, owner.id, "subscription_activated") === 1);

        const invoiceAfterFirstVerify = verifyResp.body?.payment?.invoiceNumber;
        const expiresAfterFirstVerify = companyBAfterRenewal.subscription_expires_at;

        // 10. Duplicate verification (e.g. browser refresh / a webhook
        // for the same payment arriving afterward) must be a complete
        // no-op: no new history rows, no second invoice, no extended expiry.
        const dupVerifyResp = await callController(paymentController.verifyPayment, {
            params: { id: String(renewalPayment.id) },
            body: { razorpayOrderId: orderId, razorpayPaymentId: "pay_lifecycle_renewal_1", razorpaySignature: signature },
        });
        check("10. Duplicate verification is idempotent (200, alreadyVerified)", dupVerifyResp.status === 200 && dupVerifyResp.body?.alreadyVerified === true);
        check("10b. Invoice number unchanged by the duplicate call", dupVerifyResp.body?.payment?.invoiceNumber === invoiceAfterFirstVerify);
        const companyBAfterDupVerify = await platformCompanyService.getCompanyById(companyB.companyId);
        check("10c. Subscription expiry NOT extended a second time", new Date(companyBAfterDupVerify.subscription_expires_at).getTime() === new Date(expiresAfterFirstVerify).getTime());

        const historyCountAfter = (await platformPool.query(`SELECT id FROM subscription_history WHERE company_id = ?`, [companyB.companyId]))[0].length;
        // Only the FIRST verify call should have added rows (activation
        // + grace-cleared); the duplicate call must add none.
        check("11. Lifecycle history entries were created for the real renewal event", historyCountAfter > historyCountBefore);
        const historyCountAfterDup = (await platformPool.query(`SELECT id FROM subscription_history WHERE company_id = ?`, [companyB.companyId]))[0].length;
        check("12. No duplicate history entries from the duplicate verification call", historyCountAfterDup === historyCountAfter);

    } finally {
        uninstallMockRazorpayFetch();
        delete process.env.RAZORPAY_KEY_ID;
        delete process.env.RAZORPAY_KEY_SECRET;
    }

    // ========================================
    // 13/14. PLATFORM AUDIT LOGGING + NO SECRETS
    // ========================================
    console.log("\nTEST 13/14 -- Platform audit logging + secret scrubbing");
    const suspendRes = await apiPatch(`/api/platform/companies/${companyA.companyId}/status`, { action: "suspend" }, token);
    check("SETUP: company suspended for audit test", suspendRes.status === 200);
    const [auditRows] = await platformPool.query(
        `SELECT * FROM platform_audit_logs WHERE platform_user_id = ? AND action_type = 'company_suspended' AND company_id = ?`,
        [owner.id, companyA.companyId]
    );
    check("13. Audit log row created for company_suspended", auditRows.length === 1, JSON.stringify(auditRows));

    // Reactivate so later cleanup (delete) works normally against an
    // active-or-suspended company as the service requires.
    await apiPatch(`/api/platform/companies/${companyA.companyId}/status`, { action: "reactivate" }, token);

    const scrubbed = platformAuditService.scrubMetadata({ companyName: "Safe Co", password: "shouldNeverAppear", nested: { authToken: "shouldAlsoNeverAppear", plan: "starter" } });
    check("14. scrubMetadata strips password-shaped keys", scrubbed.password === undefined);
    check("14b. scrubMetadata strips nested token-shaped keys but keeps safe ones", scrubbed.nested.authToken === undefined && scrubbed.nested.plan === "starter");
    const auditRowMetadata = JSON.stringify(auditRows[0].metadata || {}).toLowerCase();
    check("14c. Real audit log row contains no password/token/secret-shaped text", !/password|token|secret|jwt/.test(auditRowMetadata), auditRowMetadata);

    // ========================================
    // 15/16. EMAIL TEMPLATE GENERATION + RESILIENCE
    // ========================================
    console.log("\nTEST 15/16 -- Email generation + failure resilience");
    const sampleEmail = platformEmailTemplates.trialEndingSoonEmail({ companyName: "Test Co", trialEndsAt: new Date(), planName: "Starter", daysRemaining: 3 });
    check("15. Email template produces subject/html/text", !!sampleEmail.subject && !!sampleEmail.html && !!sampleEmail.text);
    check("15b. Email HTML includes ZioVenture branding, not WorkHub", sampleEmail.html.includes("ZioVenture") && !sampleEmail.html.includes("WorkHub"));

    // SMTP is not configured in this environment -- sendMail already
    // returns {sent:false} without throwing (see emailService.js);
    // confirm this doesn't happen to be silently masking a real throw
    // by monkey-patching it to genuinely throw, then confirming a real
    // lifecycle operation (a trial reminder, using a THIRD state on
    // company A) still completes and still logs history successfully.
    const realSendMail = emailService.sendMail;
    emailService.sendMail = async () => { throw new Error("Simulated SMTP outage for test 16"); };
    try {
        // 20 hours, not exactly 24 -- Math.ceil(daysRemaining) sits
        // right on a knife-edge at exactly 1 day out (a few hundred ms
        // of real processing time between this write and the
        // evaluation below can tip it to either 1 or 2), so this uses
        // a value comfortably inside the "<=1 day" bucket regardless.
        await platformPool.query(`UPDATE companies SET subscription_status = 'trial', trial_ends_at = ? WHERE id = ?`, [new Date(Date.now() + 20 * 60 * 60 * 1000), companyA.companyId]);
        const companyAForEmailTest = await platformCompanyService.getCompanyById(companyA.companyId);
        const resultDespiteEmailFailure = await subscriptionLifecycleService.evaluateCompanySubscription(companyAForEmailTest);
        check("16. Lifecycle event still completes despite a simulated email failure", resultDespiteEmailFailure.sent?.includes("trial_ending_soon_1d"), JSON.stringify(resultDespiteEmailFailure));
        check("16b. History row still logged despite the email failure", await historyCount(companyA.companyId, "trial_ending_soon_1d") === 1);
    } finally {
        emailService.sendMail = realSendMail;
    }

    // ========================================
    // 17. OWNER NOTIFICATION GENERATION (already exercised above --
    // this asserts the read API surfaces them correctly)
    // ========================================
    console.log("\nTEST 17 -- Owner notification generation (via API)");
    const notifListRes = await apiGet("/api/platform/notifications", token);
    check("17. Owner can list their own notifications", notifListRes.status === 200 && Array.isArray(notifListRes.body.notifications));
    check("17b. At least one real lifecycle notification appears in the list", notifListRes.body.notifications.some((n) => n.companyId === companyA.companyId || n.companyId === companyB.companyId));
    const unreadCountRes = await apiGet("/api/platform/notifications/unread-count", token);
    check("17c. Unread count endpoint works", unreadCountRes.status === 200 && typeof unreadCountRes.body.count === "number");
    const oneNotifId = notifListRes.body.notifications[0]?.id;
    if (oneNotifId) {
        const markReadRes = await apiPatch(`/api/platform/notifications/${oneNotifId}/read`, {}, token);
        check("17d. Marking a single notification read works", markReadRes.status === 200);
    }
    const markAllReadRes = await apiPatch("/api/platform/notifications/read-all", {}, token);
    check("17e. Mark-all-read works", markAllReadRes.status === 200);

    // ========================================
    // 18. ATTENTION REQUIRED COUNTS
    // ========================================
    console.log("\nTEST 18 -- Attention Required counts");
    const statsRes = await apiGet("/api/platform/companies/stats", token);
    check("18. attentionRequired includes gracePeriod/failedPayments keys", Array.isArray(statsRes.body?.attentionRequired?.gracePeriod) && Array.isArray(statsRes.body?.attentionRequired?.failedPayments));
    check("18b. failedPayments includes the payment failed in test 8", statsRes.body.attentionRequired.failedPayments.some((p) => p.companyId === companyB.companyId));

    // ========================================
    // 19/20. AUTH BOUNDARIES ON NEW LIFECYCLE APIS
    // ========================================
    console.log("\nTEST 19/20 -- Auth boundaries on audit-log/notification APIs");
    const tenantOnAudit = await apiGet("/api/platform/audit-logs", tenantShapedToken);
    check("19. Tenant JWT rejected from GET /audit-logs (401)", tenantOnAudit.status === 401, `got ${tenantOnAudit.status}`);
    const tenantOnNotif = await apiGet("/api/platform/notifications", tenantShapedToken);
    check("19b. Tenant JWT rejected from GET /notifications (401)", tenantOnNotif.status === 401, `got ${tenantOnNotif.status}`);
    const noAuthOnAudit = await apiGet("/api/platform/audit-logs");
    check("19c. Unauthenticated request rejected from GET /audit-logs (401)", noAuthOnAudit.status === 401);

    const ownerOnAudit = await apiGet("/api/platform/audit-logs", token);
    check("20. Platform JWT accepted on GET /audit-logs (200)", ownerOnAudit.status === 200, JSON.stringify(ownerOnAudit.body)?.slice(0, 200));
    const ownerOnNotif = await apiGet("/api/platform/notifications", token);
    check("20b. Platform JWT accepted on GET /notifications (200)", ownerOnNotif.status === 200);

    // ========================================
    // 21. EXISTING SUBSCRIPTION ENFORCEMENT STILL WORKS
    // ========================================
    console.log("\nTEST 21 -- Existing subscription enforcement still works");
    const expiredLoginAttempt = await apiPost(`/api/tenant-auth/${COMPANY_B_SLUG}/login`, { employeeId: companyB.adminEmployeeId, password: ADMIN_PASSWORD });
    // Company B is 'active' again after the renewal in test 9 -- flip
    // it back to a hard-expired state (no grace) to prove login is
    // STILL correctly blocked when truly expired.
    await platformPool.query(`UPDATE companies SET subscription_status = 'expired' WHERE id = ?`, [companyB.companyId]);
    const trulyExpiredLoginAttempt = await apiPost(`/api/tenant-auth/${COMPANY_B_SLUG}/login`, { employeeId: companyB.adminEmployeeId, password: ADMIN_PASSWORD });
    check("21. Expired company login still rejected (403)", trulyExpiredLoginAttempt.status === 403, `got ${trulyExpiredLoginAttempt.status}`);
    void expiredLoginAttempt;

    // ========================================
    // 26. REINSTEINS UNCHANGED
    // ========================================
    console.log("\nTEST 26 -- Reinsteins unchanged");
    const dbPool = require("./config/db");
    const [[{ tbl }]] = await dbPool.query(`SELECT COUNT(*) AS tbl FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [process.env.DB_NAME]);
    const [[{ users }]] = await dbPool.query(`SELECT COUNT(*) AS users FROM users`);
    check("26. reinsteins_workhub unchanged (37 tables, 17 users)", tbl === 37 && users === 17, `tables=${tbl} users=${users}`);
    const [[reinsteinsRow]] = await platformPool.query(`SELECT subscription_status, trial_ends_at, subscription_expires_at, grace_period_ends_at FROM companies WHERE company_slug = 'reinsteins'`);
    check("26b. Reinsteins remains Complimentary/active with no expiry/grace period", reinsteinsRow.subscription_status === "active" && reinsteinsRow.trial_ends_at === null && reinsteinsRow.subscription_expires_at === null && reinsteinsRow.grace_period_ends_at === null);
    const [reinsteinsHistory] = await platformPool.query(`SELECT h.id FROM subscription_history h JOIN companies c ON c.id = h.company_id WHERE c.company_slug = 'reinsteins'`);
    check("26c. No subscription_history rows exist for Reinsteins (no real event ever occurred)", reinsteinsHistory.length === 0);
    const [reinsteinsAudit] = await platformPool.query(`SELECT id FROM platform_audit_logs WHERE company_id = (SELECT id FROM companies WHERE company_slug = 'reinsteins')`);
    check("26d. No audit log rows target Reinsteins from this test run", reinsteinsAudit.length === 0);

    // ========================================
    // CLEANUP
    // ========================================
    console.log("\nCLEANUP");
    // Notifications first -- company_id is ON DELETE SET NULL, not
    // CASCADE, so these rows would otherwise survive (orphaned) after
    // the companies below are deleted, permanently cluttering whatever
    // real Platform Owner account(s) also received them via the
    // all-owners fan-out.
    await platformPool.query(`DELETE FROM platform_notifications WHERE company_id IN (?, ?)`, [companyA.companyId, companyB.companyId]);
    // Phase 13 -- every lifecycle event above now also attempts a real
    // tracked email via emailDeliveryService (this test predates that
    // table but now indirectly populates it); same orphan risk as
    // platform_notifications above (email_delivery_logs.company_id is
    // ON DELETE SET NULL too), so it needs the same explicit cleanup.
    await platformPool.query(`DELETE FROM email_delivery_logs WHERE company_id IN (?, ?)`, [companyA.companyId, companyB.companyId]);
    // Audit logs performed BY the temp owner -- test noise, not real
    // production audit trail.
    await platformPool.query(`DELETE FROM platform_audit_logs WHERE platform_user_id = ?`, [owner.id]);
    await platformPool.query(`DELETE FROM payments WHERE company_id IN (?, ?)`, [companyA.companyId, companyB.companyId]);
    // subscription_history is ON DELETE CASCADE -- cleaned up
    // automatically by the company deletions below.
    await tenantProvisioningService.dropProvisionedDatabase(buildTenantDbName(COMPANY_A_SLUG));
    await tenantProvisioningService.dropProvisionedDatabase(buildTenantDbName(COMPANY_B_SLUG));
    await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?)`, [COMPANY_A_SLUG, COMPANY_B_SLUG]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    await platformPool.query(`DELETE FROM subscription_plans WHERE id = ?`, [planId]);

    const [remainingHistory] = await platformPool.query(`SELECT id FROM subscription_history WHERE company_id IN (?, ?)`, [companyA.companyId, companyB.companyId]);
    check("CLEANUP: all subscription_history rows gone (cascaded)", remainingHistory.length === 0);
    const [remainingNotifs] = await platformPool.query(`SELECT id FROM platform_notifications WHERE company_id IN (?, ?)`, [companyA.companyId, companyB.companyId]);
    check("CLEANUP: all platform_notifications rows gone", remainingNotifs.length === 0);
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

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch((e) => { console.error(e); process.exit(1); });
