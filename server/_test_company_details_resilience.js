require("dotenv").config();
const bcrypt = require("bcrypt");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const emailDomainService = require("./services/emailDomainService");
const { getCompanyDetails } = require("./controllers/platformCompanyController");
const { tableExists, run: runEmailTablesMigration, EXPECTED_TABLES } = require("./_migrate_add_email_platform_tables");

// ==========================================
// COMPANY DETAILS RESILIENCE -- SELF-TEST
//
// Covers the "Failed to load company details" production bug: an
// unguarded emailDomainService.getEmailSummaryForCompany() call inside
// getCompanyDetails aborted the ENTIRE Company Details page with a
// generic 500 whenever the email platform tables weren't provisioned
// on this environment yet.
//
// Two techniques, deliberately different:
//   - Cases 1, 3, 5-7: real HTTP + a real throwaway platform company,
//     exactly like _test_company_branding.js -- proves the ordinary,
//     tables-present path is completely unaffected.
//   - Cases 2, 4: getCompanyDetails() called DIRECTLY (bypassing
//     HTTP/Express), with emailDomainService.getEmailSummaryForCompany
//     monkey-patched to throw and restored immediately after --
//     platform tables (email_domains/mailboxes/etc.) are SHARED,
//     non-tenant-isolated infrastructure with exactly one physical
//     copy, so a test can never safely drop/rename them (even
//     temporarily) without risking every other concurrent request
//     against this environment. Monkey-patching the one function this
//     fix actually guards is the only way to deterministically
//     exercise the throw path without that risk -- same
//     module-cache-injection convention already established in
//     _test_employee_creation_domain_fallback.js for testing an
//     analogous optional-lookup error boundary.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "detailsresilience_owner@groworgs.internal";
const OWNER_PASSWORD = "DetailsResilienceOwner!2026Pwd";
const SLUG = "detailsresiliencetest_a";

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
    const res = await fetch(`${BASE_URL}${pathname}`, {
        method: "GET",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

// Minimal fake req/res for calling getCompanyDetails() directly --
// same convention as _test_employee_creation_domain_fallback.js's
// makeReqRes.
function makeReqRes(companyId) {
    const req = { params: { id: String(companyId) } };
    const res = {
        statusCode: null,
        payload: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; },
    };
    return { req, res };
}

(async () => {

    // ==========================================
    // CASE 6 & 7 -- migration idempotency, existing tables untouched
    // ==========================================
    console.log("6&7. CASE 6&7 -- email platform tables migration is idempotent and never drops/overwrites");

    const beforeFirstRun = {};
    for (const table of EXPECTED_TABLES) beforeFirstRun[table] = await tableExists(table);
    console.log("  tables before:", beforeFirstRun);

    await runEmailTablesMigration();
    const afterFirstRun = {};
    for (const table of EXPECTED_TABLES) afterFirstRun[table] = await tableExists(table);
    check("CASE 6: all four tables exist after running the migration", EXPECTED_TABLES.every((t) => afterFirstRun[t]), JSON.stringify(afterFirstRun));

    // If email_domains already had rows (real usage on this
    // environment), prove the migration didn't touch them -- CREATE
    // TABLE IF NOT EXISTS is a no-op against an existing table, so
    // running it can never lose data; this asserts that directly
    // rather than just trusting the SQL shape.
    const [[beforeRowCount]] = await platformPool.query(`SELECT COUNT(*) AS c FROM email_domains`);

    let secondRunThrew = false;
    try {
        await runEmailTablesMigration();
    } catch (_error) {
        secondRunThrew = true;
    }
    check("CASE 6: running the migration a second time does not throw (idempotent)", !secondRunThrew);

    const [[afterRowCount]] = await platformPool.query(`SELECT COUNT(*) AS c FROM email_domains`);
    check("CASE 7: email_domains row count unchanged across repeated migration runs (no data touched)", Number(beforeRowCount.c) === Number(afterRowCount.c), `before=${beforeRowCount.c} after=${afterRowCount.c}`);

    const afterSecondRun = {};
    for (const table of EXPECTED_TABLES) afterSecondRun[table] = await tableExists(table);
    check("CASE 7: all four tables still present after a second run (nothing dropped)", EXPECTED_TABLES.every((t) => afterSecondRun[t]), JSON.stringify(afterSecondRun));

    // ==========================================
    // Setup -- platform owner + one throwaway company
    // ==========================================
    console.log("\nSETUP -- platform owner + one throwaway company");

    const ownerPasswordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "Details Resilience Test Owner", email: OWNER_EMAIL, passwordHash: ownerPasswordHash, role: "platform_owner" });

    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: platform owner login succeeded", loginRes.status === 200 && !!ownerToken);

    const createCompany = await apiPost("/api/platform/companies", { companyName: "Details Resilience Test", companySlug: SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: company created", createCompany.status === 201);
    const companyId = createCompany.body?.company?.id;

    // ==========================================
    // CASE 1 -- Company Details loads normally when email tables exist
    // (real HTTP, real platform DB, tables confirmed present by CASE 6)
    // ==========================================
    console.log("\n1. CASE 1 -- GET company details succeeds when email summary tables exist");

    const detailsRes = await apiGet(`/api/platform/companies/${companyId}`, ownerToken);
    check("CASE 1: request succeeded -> 200", detailsRes.status === 200, JSON.stringify(detailsRes.body));
    check("CASE 1: response is the expected company", detailsRes.body?.company?.id === companyId);

    // ==========================================
    // CASE 4 -- logo-related fields are still returned (branding
    // untouched by this fix)
    // ==========================================
    console.log("\n4. CASE 4 -- logo-related fields (hasLogo) are still present on the response");

    check("CASE 4: hasLogo field present and false for a brand-new company", detailsRes.body?.company?.hasLogo === false, JSON.stringify(detailsRes.body?.company));

    // ==========================================
    // CASE 5 -- existing email summary behavior is unchanged when the
    // lookup succeeds (a fresh company has zero domains/mailboxes --
    // this proves the REAL emailDomainService call, not a stub,
    // produced this shape)
    // ==========================================
    console.log("\n5. CASE 5 -- email summary reflects real (zero) counts for a fresh company, unchanged shape");

    check(
        "CASE 5: email summary has the expected shape and real zero counts",
        detailsRes.body?.company?.email?.emailEnabled === false &&
        detailsRes.body?.company?.email?.domainCount === 0 &&
        detailsRes.body?.company?.email?.verifiedDomainCount === 0 &&
        detailsRes.body?.company?.email?.mailboxCount === 0,
        JSON.stringify(detailsRes.body?.company?.email)
    );

    // ==========================================
    // CASE 2 & 3 -- getCompanyDetails() does NOT fail when
    // getEmailSummaryForCompany throws; the response instead carries a
    // safe default summary. Calls the REAL controller function
    // directly (no HTTP/Express involved) against the SAME real
    // company/platform DB used above -- only the one email-summary
    // function is monkey-patched, and only for the duration of this
    // one call.
    // ==========================================
    console.log("\n2&3. CASE 2&3 -- getCompanyDetails survives getEmailSummaryForCompany throwing, with a safe default summary");

    const originalGetEmailSummaryForCompany = emailDomainService.getEmailSummaryForCompany;
    emailDomainService.getEmailSummaryForCompany = async () => {
        const err = new Error('relation "email_domains" does not exist');
        err.code = "42P01";
        throw err;
    };

    let directCallThrew = false;
    const { req: directReq, res: directRes } = makeReqRes(companyId);
    try {
        await getCompanyDetails(directReq, directRes);
    } catch (_error) {
        directCallThrew = true;
    } finally {
        emailDomainService.getEmailSummaryForCompany = originalGetEmailSummaryForCompany;
    }

    check("CASE 2: getCompanyDetails did not throw/crash when the email lookup failed", !directCallThrew);
    check("CASE 2: the request still succeeds -> 200 (this was the production bug: it returned 500)", directRes.statusCode === 200, JSON.stringify(directRes.payload));
    check("CASE 2: the company itself is still returned correctly", directRes.payload?.company?.id === companyId);
    check("CASE 4 (again): hasLogo is still present even when the email lookup fails", directRes.payload?.company?.hasLogo === false, JSON.stringify(directRes.payload?.company));
    check(
        "CASE 3: email summary falls back to a safe empty/default shape, not the real (unreachable) data",
        directRes.payload?.company?.email?.emailEnabled === false &&
        directRes.payload?.company?.email?.domainCount === 0 &&
        directRes.payload?.company?.email?.verifiedDomainCount === 0 &&
        directRes.payload?.company?.email?.mailboxCount === 0,
        JSON.stringify(directRes.payload?.company?.email)
    );

    // Confirm the real function is actually restored (not left
    // monkey-patched for any other concurrent request against this
    // shared server process).
    check("CLEANUP: emailDomainService.getEmailSummaryForCompany was restored to the real implementation", emailDomainService.getEmailSummaryForCompany === originalGetEmailSummaryForCompany);

    // ---------- Report ----------
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);

    // ---------- Cleanup ----------
    console.log("\nCLEANUP -- dropping test company and platform fixtures");

    try {
        await platformPool.query(`DELETE FROM companies WHERE company_slug = ?`, [SLUG]);
    } catch (error) {
        console.error("Cleanup (company) error:", error.message);
    }

    try {
        await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    } catch (error) {
        console.error("Cleanup (platform user) error:", error.message);
    }

    await platformPool.end();

    process.exit(failures === 0 ? 0 : 1);

})().catch((error) => {
    console.error("TEST SCRIPT ERROR:", error);
    process.exit(1);
});
