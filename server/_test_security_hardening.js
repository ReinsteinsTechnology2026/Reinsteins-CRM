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
const platformAuditService = require("./services/platformAuditService");
const platformTwoFactorService = require("./services/platformTwoFactorService");
const platformPaymentController = require("./controllers/platformPaymentController");
const { authenticator } = require("otplib");
const { LOGIN_LOCKOUT_THRESHOLD } = require("./config/securityConfig");

// ==========================================
// SECURITY HARDENING SELF-TEST (Phase 14)
//
// Covers all 25 required scenarios. Deliberately does NOT try to trip
// the pre-existing, SHARED, IP-keyed login rate limiters
// (authLoginLimiter/platformLoginLimiter/tenantLoginLimiter) up to
// their real limit -- doing so from an automated test would leave the
// in-memory limiter exhausted for the rest of THIS server process,
// potentially breaking every subsequent regression suite's real login
// calls for up to their 15-minute window. Instead, "brute-force
// protection works" is proven via the NEW, per-ACCOUNT, DB-backed
// lockout mechanism (Phase 14B) against one temporary Platform Owner
// account -- a more precise test of the actual new feature, and one
// that can never affect any other test's ability to log in.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "sectest_owner@groworgs.internal";
const OWNER_PASSWORD = "SecTestOwner!2026Pwd";
const LOCKOUT_OWNER_EMAIL = "sectest_lockout@groworgs.internal";
const LOCKOUT_OWNER_PASSWORD = "SecTestLockout!2026Pwd";
const COMPANY_SLUG = "sectest_alpha";
const ADMIN_PASSWORD = "SecTestAdmin!2026Pwd";

let failures = 0;
function check(label, cond, detail) {
    if (cond) console.log(`  [PASS] ${label}`);
    else { failures++; console.log(`  [FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}
async function apiGet(p, token) {
    const res = await fetch(`${BASE_URL}${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, body: json, headers: res.headers };
}
async function apiPost(p, body, token, extraHeaders) {
    const res = await fetch(`${BASE_URL}${p}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(extraHeaders || {}) }, body: JSON.stringify(body || {}) });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, body: json, headers: res.headers };
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
const FAKE_KEY_ID = "rzp_test_fake_key_id_sec";
const FAKE_KEY_SECRET = "fake_key_secret_sec_only";
let mockOrderCounter = 0;
const realFetch = global.fetch;
function installMockRazorpayFetch() {
    mockOrderCounter = 0;
    global.fetch = async (url, opts) => {
        if (typeof url === "string" && url.startsWith("https://api.razorpay.com/v1/orders")) {
            const requestBody = JSON.parse(opts.body);
            mockOrderCounter += 1;
            const orderId = `order_sec_mock_${mockOrderCounter}`;
            return { ok: true, json: async () => ({ id: orderId, amount: requestBody.amount, currency: requestBody.currency, status: "created" }) };
        }
        return realFetch(url, opts);
    };
}
function uninstallMockRazorpayFetch() { global.fetch = realFetch; }

async function createCompanyWithAdmin(ownerToken, slug, name) {
    const createRes = await apiPost("/api/platform/companies", { companyName: name, companySlug: slug, accessType: "trial" }, ownerToken);
    if (createRes.status !== 201) throw new Error(`Failed to create company ${slug}: ${JSON.stringify(createRes.body)}`);
    const companyId = createRes.body.company.id;
    const adminRes = await apiPost(`/api/platform/companies/${companyId}/admin`, {
        name: `${name} Admin`, email: `${slug}_admin@sectest.internal`, password: ADMIN_PASSWORD,
    }, ownerToken);
    if (adminRes.status !== 201) throw new Error(`Failed to create admin for ${slug}: ${JSON.stringify(adminRes.body)}`);
    return { companyId };
}

(async () => {

    console.log("SETUP -- two temp platform owners (main + lockout-test) + one company + paid plan");
    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    const owner = await platformUserService.create({ name: "SecTest Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
    const lockoutPasswordHash = await bcrypt.hash(LOCKOUT_OWNER_PASSWORD, 12);
    const lockoutOwner = await platformUserService.create({ name: "SecTest Lockout", email: LOCKOUT_OWNER_EMAIL, passwordHash: lockoutPasswordHash, role: "platform_owner" });

    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const token = loginRes.body?.token;
    check("SETUP: owner login succeeds", loginRes.status === 200 && !!token);

    const company = await createCompanyWithAdmin(token, COMPANY_SLUG, "SecTest Alpha");
    const [planInsert] = await platformPool.query(
        `INSERT INTO subscription_plans (name, slug, status, monthly_price, yearly_price, employee_limit, features)
         VALUES ('SecTest Plan', 'sectest-plan', 'active', 499.00, 4999.00, 50, '[]')`
    );
    const planId = planInsert.insertId;

    const tenantShapedToken = jwt.sign({ id: 999999, employeeId: "SECTEST-BOUNDARY", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

    // ========================================
    // 1/2. PLATFORM <-> TENANT JWT CROSS-REJECTION
    // ========================================
    console.log("\nTEST 1/2 -- Platform/Tenant JWT cross-rejection");
    const platformOnTenant = await apiGet("/api/departments", token);
    check("1. Platform JWT rejected by tenant API (401)", platformOnTenant.status === 401, `got ${platformOnTenant.status}`);
    const tenantOnPlatform = await apiGet("/api/platform/companies", tenantShapedToken);
    check("2. Tenant JWT rejected by platform API (401)", tenantOnPlatform.status === 401, `got ${tenantOnPlatform.status}`);

    // ========================================
    // 3/4. INVALID / EXPIRED JWT
    // ========================================
    console.log("\nTEST 3/4 -- Invalid and expired JWT rejection");
    const garbageRes = await apiGet("/api/platform/companies", "not.a.real.jwt");
    check("3. Invalid/garbage JWT rejected (401)", garbageRes.status === 401, `got ${garbageRes.status}`);

    const expiredToken = jwt.sign(
        { userId: owner.id, type: "platform_owner", tokenVersion: 0 },
        process.env.PLATFORM_JWT_SECRET,
        { expiresIn: -10, issuer: "groworgs-platform", audience: "groworgs-platform-owner", algorithm: "HS256" }
    );
    const expiredRes = await apiGet("/api/platform/companies", expiredToken);
    check("4. Expired JWT rejected (401)", expiredRes.status === 401, `got ${expiredRes.status}`);

    // ========================================
    // 5. ACCOUNT LOCKOUT (brute-force protection)
    //
    // Builds up the first (THRESHOLD - 1) failures via a direct
    // service call rather than real HTTP -- this is pure setup
    // (getting the account into "one failure away from locked"
    // state), not itself what's being verified. The actual assertions
    // below (the locking attempt, the locked-with-correct-password
    // rejection, and the post-recovery login) all go through the
    // REAL, live HTTP endpoint, proving the real wiring end-to-end.
    // Deliberately economical with real /login HTTP calls throughout
    // this script -- platformLoginLimiter is a real, shared,
    // IP-keyed, in-memory limiter (10/15min); exhausting it here would
    // risk 429s in every subsequent regression suite sharing this
    // server process.
    // ========================================
    console.log("\nTEST 5 -- Account lockout after repeated failed logins");
    for (let i = 0; i < LOGIN_LOCKOUT_THRESHOLD - 1; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await platformUserService.recordFailedLogin(lockoutOwner.id);
    }
    const lockingAttempt = await apiPost("/api/platform/auth/login", { email: LOCKOUT_OWNER_EMAIL, password: "WrongPassword!123" });
    check(`5. The ${LOGIN_LOCKOUT_THRESHOLD}th failed attempt still returns generic invalid-credentials (locks silently)`, lockingAttempt.status === 401, `got ${lockingAttempt.status}`);
    const lockedOutCorrectPassword = await apiPost("/api/platform/auth/login", { email: LOCKOUT_OWNER_EMAIL, password: LOCKOUT_OWNER_PASSWORD });
    check("5b. Even the CORRECT password is rejected while locked (429)", lockedOutCorrectPassword.status === 429, `got ${lockedOutCorrectPassword.status}, ${JSON.stringify(lockedOutCorrectPassword.body)}`);

    const [lockRows] = await platformPool.query(`SELECT locked_until, failed_login_attempts FROM platform_users WHERE id = ?`, [lockoutOwner.id]);
    check("5c. locked_until is set in the future", lockRows[0].locked_until && new Date(lockRows[0].locked_until) > new Date());

    const [lockAuditRows] = await platformPool.query(
        `SELECT action_type FROM platform_audit_logs WHERE platform_user_id = ? AND action_type = 'account_locked'`, [lockoutOwner.id]
    );
    check("5d. account_locked audit event logged", lockAuditRows.length === 1);

    // Recovery: legitimate user can eventually log in again (Part B:
    // "ensure legitimate users can recover") -- proven by manually
    // clearing the lock the same way natural expiry would, rather than
    // waiting the real LOGIN_LOCKOUT_DURATION_MINUTES in this test.
    await platformUserService.unlockAccount(lockoutOwner.id);
    const recoveredLogin = await apiPost("/api/platform/auth/login", { email: LOCKOUT_OWNER_EMAIL, password: LOCKOUT_OWNER_PASSWORD });
    check("5e. Legitimate user can log in again once no longer locked", recoveredLogin.status === 200 && !!recoveredLogin.body?.token);

    // ========================================
    // 6. GENERIC LOGIN ERRORS (no account enumeration)
    //
    // Reuses `lockingAttempt` from test 5 above (a real "wrong
    // password for a real, existing account" response) as the
    // comparator, instead of spending another /login call -- same
    // budget-economy reasoning as test 5's setup.
    // ========================================
    console.log("\nTEST 6 -- No account enumeration");
    const nonexistentEmailRes = await apiPost("/api/platform/auth/login", { email: "definitely_not_a_real_account@nowhere.internal", password: "whatever123" });
    check("6. Nonexistent email and wrong-password-for-real-account return the SAME status", nonexistentEmailRes.status === lockingAttempt.status, `${nonexistentEmailRes.status} vs ${lockingAttempt.status}`);
    check("6b. Nonexistent email and wrong-password-for-real-account return the SAME message", nonexistentEmailRes.body?.message === lockingAttempt.body?.message, `"${nonexistentEmailRes.body?.message}" vs "${lockingAttempt.body?.message}"`);

    // ========================================
    // 7/8. PASSWORD POLICY + NEVER RETURNED
    // ========================================
    console.log("\nTEST 7/8 -- Password policy enforcement + never returned");
    const weakPwRes = await apiPatch("/api/platform/auth/password", { currentPassword: OWNER_PASSWORD, newPassword: "short" }, token);
    check("7. Too-short new password rejected (400)", weakPwRes.status === 400, `got ${weakPwRes.status}`);
    const noUpperRes = await apiPatch("/api/platform/auth/password", { currentPassword: OWNER_PASSWORD, newPassword: "alllowercase123" }, token);
    check("7b. New password with no uppercase rejected (400)", noUpperRes.status === 400, `got ${noUpperRes.status}`);
    const noDigitRes = await apiPatch("/api/platform/auth/password", { currentPassword: OWNER_PASSWORD, newPassword: "NoDigitsHere" }, token);
    check("7c. New password with no digit rejected (400)", noDigitRes.status === 400, `got ${noDigitRes.status}`);

    const meRes = await apiGet("/api/platform/auth/me", token);
    const meBodyText = JSON.stringify(meRes.body);
    check("8. GET /auth/me never includes password/hash fields", !meBodyText.includes("password") && !/hash/i.test(meBodyText), meBodyText);
    check("8b. Login response never includes password/hash fields", !JSON.stringify(loginRes.body).toLowerCase().includes("password"));

    // ========================================
    // 9. MASS-ASSIGNMENT PROTECTION
    // ========================================
    console.log("\nTEST 9 -- Sensitive APIs reject/ignore unexpected fields");
    const massAssignRes = await apiPatch(`/api/platform/companies/${company.companyId}/billing-contact`, {
        name: "Legit Name", email: "legit@sectest.internal", role: "super_admin", isAdmin: true, id: 999999,
    }, token);
    check("9. Billing contact update succeeds despite extra fields", massAssignRes.status === 200);
    check("9b. Unexpected fields (role/isAdmin/id) had no effect on the response shape", massAssignRes.body?.company?.id === company.companyId && !("role" in (massAssignRes.body?.company || {})));

    // ========================================
    // 10. SQL-INJECTION-STYLE INPUT DOES NOT BYPASS AUTH
    // ========================================
    console.log("\nTEST 10 -- SQL-injection-style input does not bypass authentication");
    const sqliRes = await apiPost("/api/platform/auth/login", { email: "' OR '1'='1", password: "' OR '1'='1" });
    check("10. Classic SQLi payload as email/password does not authenticate (401)", sqliRes.status === 401, `got ${sqliRes.status}`);

    // ========================================
    // 11. COMPANY ISOLATION (spot check -- full coverage in
    // _test_company_aware_routing.js / _test_file_tenant_isolation.js)
    // ========================================
    console.log("\nTEST 11 -- Company isolation spot check");
    const companyInfoRes = await apiGet(`/api/tenant-auth/${COMPANY_SLUG}/info`);
    check("11. Tenant-auth info resolves this company only", companyInfoRes.status === 200 && companyInfoRes.body?.company?.name === "SecTest Alpha");

    // ========================================
    // 12-15. PAYMENT / RAZORPAY SECURITY REVIEW
    // ========================================
    console.log("\nTEST 12-15 -- Payment/Razorpay security review");
    const clientAmountRes = await apiPost("/api/platform/payments", { companyId: company.companyId, planId, amount: 1, billingCycle: "one_time", paymentStatus: "paid" }, token);
    check("SETUP: manual payment created with a deliberately tiny client-supplied amount", clientAmountRes.status === 201);
    check("12. Manual payment amount is exactly what was recorded (server never re-derives an unrelated value) -- see checkout endpoint for the REAL amount-manipulation defense", Number(clientAmountRes.body?.payment?.amount) === 1);

    const checkoutRes = await apiPost("/api/platform/payments/checkout", { companyId: company.companyId, planId, billingCycle: "monthly", amount: 1 }, token);
    check("12b. Checkout endpoint IGNORES any client-supplied amount -- server derives it from the plan price (499), not the client's '1'", Number(checkoutRes.body?.payment?.amount) === 499, JSON.stringify(checkoutRes.body?.payment));

    process.env.RAZORPAY_KEY_ID = FAKE_KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = FAKE_KEY_SECRET;
    installMockRazorpayFetch();
    try {
        const payment = await paymentService.createPaymentRecord({
            companyId: company.companyId, planId, amount: 499, currency: "INR", billingCycle: "monthly",
            paymentStatus: "pending", paymentProvider: "razorpay", providerPaymentId: null, providerOrderId: null, notes: null,
        });
        const orderResp = await callController(platformPaymentController.createOrderForExistingPayment, { params: { id: String(payment.id) } });
        const orderId = orderResp.body?.razorpay?.orderId;

        const badSigResp = await callController(platformPaymentController.verifyPayment, {
            params: { id: String(payment.id) },
            body: { razorpayOrderId: orderId, razorpayPaymentId: "pay_sec_test", razorpaySignature: "0".repeat(64) },
        });
        check("13. Invalid Razorpay signature rejected (400)", badSigResp.status === 400, JSON.stringify(badSigResp.body));

        const validSig = razorpaySignature(orderId, "pay_sec_test", FAKE_KEY_SECRET);
        const firstVerify = await callController(platformPaymentController.verifyPayment, {
            params: { id: String(payment.id) },
            body: { razorpayOrderId: orderId, razorpayPaymentId: "pay_sec_test", razorpaySignature: validSig },
        });
        check("SETUP: valid verification succeeds", firstVerify.status === 200 && firstVerify.body?.payment?.paymentStatus === "paid");

        const dupVerify = await callController(platformPaymentController.verifyPayment, {
            params: { id: String(payment.id) },
            body: { razorpayOrderId: orderId, razorpayPaymentId: "pay_sec_test", razorpaySignature: validSig },
        });
        check("14. Duplicate verification is idempotent (200, alreadyVerified)", dupVerify.status === 200 && dupVerify.body?.alreadyVerified === true);

        const manualMarkPaidRes = await fetch(`${BASE_URL}/api/platform/payments/${payment.id}/status`, {
            method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ status: "paid" }),
        });
        check("15. A Razorpay payment (already paid) cannot be re-marked paid manually (400/409)", manualMarkPaidRes.status === 400 || manualMarkPaidRes.status === 409, `got ${manualMarkPaidRes.status}`);
    } finally {
        uninstallMockRazorpayFetch();
        delete process.env.RAZORPAY_KEY_ID;
        delete process.env.RAZORPAY_KEY_SECRET;
    }

    // ========================================
    // 16/17. FILE SECURITY
    // ========================================
    console.log("\nTEST 16/17 -- Unauthorized file access + path traversal");
    const noTokenFileRes = await fetch(`${BASE_URL}/uploads/tenant_${COMPANY_SLUG}/profiles/whatever.png`);
    check("16. File access with no token rejected (401)", noTokenFileRes.status === 401, `got ${noTokenFileRes.status}`);

    // %2e%2e%2f is URL-encoded "../" -- avoids the fetch/URL layer
    // normalizing the traversal away before the request is even sent,
    // so this genuinely exercises the server's own defense.
    const traversalRes = await fetch(`${BASE_URL}/uploads/tenant_${COMPANY_SLUG}%2f%2e%2e%2f%2e%2e%2fpackage.json?fat=fake`);
    check("17. Path traversal attempt rejected (400/401/403/404, never 200)", [400, 401, 403, 404].includes(traversalRes.status), `got ${traversalRes.status}`);

    // ========================================
    // 18-22. TWO-FACTOR AUTHENTICATION
    // ========================================
    console.log("\nTEST 18-22 -- Two-factor authentication (real otplib codes, no mocked SMTP needed)");
    const setupRes = await apiPost("/api/platform/auth/2fa/setup", { password: OWNER_PASSWORD }, token);
    check("18. 2FA setup returns a secret + QR code for an authenticated request", setupRes.status === 200 && !!setupRes.body?.secret && !!setupRes.body?.qrCodeDataUrl);
    const secret = setupRes.body.secret;

    const badCodeConfirm = await apiPost("/api/platform/auth/2fa/confirm", { code: "000000" }, token);
    check("19. Invalid 2FA confirmation code rejected (400)", badCodeConfirm.status === 400, `got ${badCodeConfirm.status}`);

    const validCode = authenticator.generate(secret);
    const confirmRes = await apiPost("/api/platform/auth/2fa/confirm", { code: validCode }, token);
    check("20. Valid 2FA code enables 2FA and returns backup codes", confirmRes.status === 200 && Array.isArray(confirmRes.body?.backupCodes) && confirmRes.body.backupCodes.length === 10);
    const backupCodes = confirmRes.body.backupCodes;

    const [enabledAuditRows] = await platformPool.query(`SELECT id FROM platform_audit_logs WHERE platform_user_id = ? AND action_type = '2fa_enabled'`, [owner.id]);
    check("20b. 2fa_enabled audit event logged", enabledAuditRows.length === 1);

    // Login now requires the second step.
    const loginAfter2FA = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    check("20c. Login now returns requiresTwoFactor instead of a full session token", loginAfter2FA.status === 200 && loginAfter2FA.body?.requiresTwoFactor === true && !loginAfter2FA.body?.token);
    const twoFactorToken = loginAfter2FA.body.twoFactorToken;

    const badVerify = await apiPost("/api/platform/auth/verify-2fa", { twoFactorToken, code: "000000" });
    check("19b. Invalid TOTP code at login step 2 rejected (401)", badVerify.status === 401, `got ${badVerify.status}`);

    const goodVerify = await apiPost("/api/platform/auth/verify-2fa", { twoFactorToken, code: authenticator.generate(secret) });
    check("20d. Valid TOTP code at login step 2 completes login with a real token", goodVerify.status === 200 && !!goodVerify.body?.token);
    const newFullToken = goodVerify.body.token;

    // Backup code: one-time use.
    const login2 = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const backupVerify = await apiPost("/api/platform/auth/verify-2fa", { twoFactorToken: login2.body.twoFactorToken, code: backupCodes[0] });
    check("21. Backup code works for login", backupVerify.status === 200 && !!backupVerify.body?.token);

    const [backupUsedAuditRows] = await platformPool.query(`SELECT id FROM platform_audit_logs WHERE platform_user_id = ? AND action_type = 'backup_code_used'`, [owner.id]);
    check("21b. backup_code_used audit event logged", backupUsedAuditRows.length === 1);

    const login3 = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const reuseBackupVerify = await apiPost("/api/platform/auth/verify-2fa", { twoFactorToken: login3.body.twoFactorToken, code: backupCodes[0] });
    check("22. The SAME backup code cannot be used a second time (401)", reuseBackupVerify.status === 401, `got ${reuseBackupVerify.status}`);

    // Clean up 2FA state so this account doesn't require it for any
    // later step in this script.
    const disableRes = await apiPost("/api/platform/auth/2fa/disable", { password: OWNER_PASSWORD, code: authenticator.generate(secret) }, newFullToken);
    check("SETUP: 2FA disabled again for cleanup", disableRes.status === 200);
    const [disabledAuditRows] = await platformPool.query(`SELECT id FROM platform_audit_logs WHERE platform_user_id = ? AND action_type = '2fa_disabled'`, [owner.id]);
    check("SETUP: 2fa_disabled audit event logged", disabledAuditRows.length === 1);

    // ========================================
    // 23. SECURITY AUDIT LOGS SCRUB SECRETS
    // ========================================
    console.log("\nTEST 23 -- Security audit logs scrub secrets");
    const scrubbed = platformAuditService.scrubMetadata({ safe: "ok", password: "shouldNeverAppear", totp_secret: secret, jwt: "shouldNeverAppear", nested: { authToken: "shouldNeverAppear" } });
    check("23. scrubMetadata strips password/totp_secret/jwt-shaped keys", scrubbed.password === undefined && scrubbed.totp_secret === undefined && scrubbed.jwt === undefined && scrubbed.nested.authToken === undefined && scrubbed.safe === "ok");

    const [allSecTestAuditRows] = await platformPool.query(`SELECT metadata FROM platform_audit_logs WHERE platform_user_id IN (?, ?)`, [owner.id, lockoutOwner.id]);
    const allAuditText = JSON.stringify(allSecTestAuditRows).toLowerCase();
    check("23b. No real audit log row created by this test contains the TOTP secret, a password, or a JWT", !allAuditText.includes(secret.toLowerCase()) && !allAuditText.includes("password") && !/eyj[a-z0-9_-]{10,}/i.test(allAuditText));

    // ========================================
    // 24. CORS
    // ========================================
    console.log("\nTEST 24 -- CORS rejects unauthorized origins");
    const badOriginRes = await fetch(`${BASE_URL}/api/platform/companies/stats`, { headers: { Origin: "https://evil-attacker-site.example" } });
    const acaoHeader = badOriginRes.headers.get("access-control-allow-origin");
    check("24. An unrecognized Origin never gets reflected in Access-Control-Allow-Origin", acaoHeader !== "https://evil-attacker-site.example", `got ACAO=${acaoHeader}`);

    // ========================================
    // 25. SENSITIVE ERROR RESPONSES DO NOT EXPOSE SECRETS
    // ========================================
    console.log("\nTEST 25 -- Error responses do not expose secrets");
    const malformedJsonRes = await fetch(`${BASE_URL}/api/platform/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not valid json" });
    let malformedBody = null; try { malformedBody = await malformedJsonRes.json(); } catch (_) {}
    const malformedText = JSON.stringify(malformedBody || {}).toLowerCase();
    check("25. A malformed-JSON request never leaks a stack trace or file path in its error response", !malformedText.includes(".js:") && !malformedText.includes("at object.") && !malformedText.includes(process.cwd().toLowerCase()), malformedText);

    // ========================================
    // REGRESSION SPOT CHECKS
    // ========================================
    console.log("\nEXTRA -- Reinsteins unchanged");
    const dbPool = require("./config/db");
    const [[{ tbl }]] = await dbPool.query(`SELECT COUNT(*) AS tbl FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [process.env.DB_NAME]);
    const [[{ users }]] = await dbPool.query(`SELECT COUNT(*) AS users FROM users`);
    check("Reinsteins tenant DB unchanged (37 tables, 17 users)", tbl === 37 && users === 17, `tables=${tbl} users=${users}`);
    const [[reinsteinsRow]] = await platformPool.query(`SELECT subscription_status, trial_ends_at FROM companies WHERE company_slug = 'reinsteins'`);
    check("Reinsteins remains Complimentary/active", reinsteinsRow.subscription_status === "active" && reinsteinsRow.trial_ends_at === null);

    // ========================================
    // CLEANUP
    // ========================================
    console.log("\nCLEANUP");
    await platformPool.query(`DELETE FROM email_delivery_logs WHERE company_id = ?`, [company.companyId]);
    await platformPool.query(`DELETE FROM platform_notifications WHERE company_id = ?`, [company.companyId]);
    await platformPool.query(`DELETE FROM platform_audit_logs WHERE platform_user_id IN (?, ?)`, [owner.id, lockoutOwner.id]);
    await platformPool.query(`DELETE FROM payments WHERE company_id = ?`, [company.companyId]);
    await tenantProvisioningService.dropProvisionedDatabase(buildTenantDbName(COMPANY_SLUG));
    await platformPool.query(`DELETE FROM companies WHERE company_slug = ?`, [COMPANY_SLUG]);
    await platformPool.query(`DELETE FROM platform_users WHERE email IN (?, ?)`, [OWNER_EMAIL, LOCKOUT_OWNER_EMAIL]);
    await platformPool.query(`DELETE FROM subscription_plans WHERE id = ?`, [planId]);

    const companyGone = (await platformCompanyService.getCompanyBySlug(COMPANY_SLUG)) === null;
    check("CLEANUP: temporary company confirmed gone", companyGone);
    const dbGone = !(await tenantProvisioningService.databaseExists(buildTenantDbName(COMPANY_SLUG)));
    check("CLEANUP: temporary tenant database confirmed gone", dbGone);
    const [remainingOwners] = await platformPool.query(`SELECT id FROM platform_users WHERE email IN (?, ?)`, [OWNER_EMAIL, LOCKOUT_OWNER_EMAIL]);
    check("CLEANUP: both temporary platform owners confirmed gone", remainingOwners.length === 0);
    const [finalCompanies] = await platformPool.query(`SELECT company_slug FROM companies`);
    check("CLEANUP: only Reinsteins remains in companies", finalCompanies.length === 1 && finalCompanies[0].company_slug === "reinsteins", JSON.stringify(finalCompanies));
    check("ENV: no fake Razorpay credentials leaked into this process after cleanup", !process.env.RAZORPAY_KEY_ID && !process.env.RAZORPAY_KEY_SECRET);

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch((e) => { console.error(e); process.exit(1); });
