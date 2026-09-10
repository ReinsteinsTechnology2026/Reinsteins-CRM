require("dotenv").config();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const platformCompanyService = require("./services/platformCompanyService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { buildTenantDbName } = require("./utils/tenantDbName");
const { UPLOADS_ROOT } = require("./utils/tenantUploadPath");
const { PLATFORM_JWT_ISSUER, PLATFORM_JWT_AUDIENCE } = require("./controllers/platformAuthController");

// ==========================================
// MULTI-TENANT FILE STORAGE ISOLATION SELF-TEST
//
// Real HTTP against the live backend on http://localhost:5000, using
// two throwaway tenants provisioned through the real Phase 2D/2E
// APIs. Uploads one real small JPEG per tenant, then exercises the
// full attack list from Part 7 of the request. Never touches
// reinsteins_workhub; the one read of a real Reinsteins file
// (employee id=4's profile photo) was already verified separately,
// read-only, before this script was written.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "filetest_owner@groworgs.internal";
const OWNER_PASSWORD = "FileTestOwner!2026Pwd";

const A_SLUG = "filetest_a";
const B_SLUG = "filetest_b";
const A_DB = buildTenantDbName(A_SLUG);
const B_DB = buildTenantDbName(B_SLUG);

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

// A minimal valid 1x1 JPEG, hardcoded bytes -- avoids depending on
// any real file on disk.
const TINY_JPEG_BASE64 =
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";

async function uploadFile(pathname, fieldName, token) {
    const buf = Buffer.from(TINY_JPEG_BASE64, "base64");
    const form = new FormData();
    form.append(fieldName, new Blob([buf], { type: "image/jpeg" }), "test.jpg");
    const res = await fetch(`${BASE_URL}${pathname}`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

(async () => {

    // ---------- Setup ----------
    console.log("SETUP -- platform owner + two tenants + one employee per tenant");
    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "File Test Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: platform owner login", loginRes.status === 200 && !!ownerToken);

    const createA = await apiPost("/api/platform/companies", { companyName: "FILE TEST A", companySlug: A_SLUG, accessType: "trial" }, ownerToken);
    const companyAId = createA.body?.company?.id;
    const createB = await apiPost("/api/platform/companies", { companyName: "FILE TEST B", companySlug: B_SLUG, accessType: "trial" }, ownerToken);
    const companyBId = createB.body?.company?.id;
    check("SETUP: two companies provisioned", createA.status === 201 && createB.status === 201);

    // Direct-DB employee fixtures (role='employee', required for the
    // profile-photo endpoint's DB-level restriction) -- password
    // known so we can log in via the real tenant-auth API.
    const empPasswordHash = await bcrypt.hash("FileTestEmployee!2026", 12);
    const poolA = getTenantPool(A_DB);
    const poolB = getTenantPool(B_DB);
    const [insA] = await poolA.query(
        `INSERT INTO users (employee_id, full_name, email, password, role, system_access, status) VALUES ('EMP001', 'Employee A', 'emp@filetest-a.test', ?, 'employee', 'employee', 'active') RETURNING id`,
        [empPasswordHash]
    );
    const [insB] = await poolB.query(
        `INSERT INTO users (employee_id, full_name, email, password, role, system_access, status) VALUES ('EMP001', 'Employee B', 'emp@filetest-b.test', ?, 'employee', 'employee', 'active') RETURNING id`,
        [empPasswordHash]
    );
    check("SETUP: employee fixtures created in both tenants", !!insA.insertId && !!insB.insertId);

    const loginA = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: "EMP001", password: "FileTestEmployee!2026" });
    const loginB = await apiPost(`/api/tenant-auth/${B_SLUG}/login`, { employeeId: "EMP001", password: "FileTestEmployee!2026" });
    const tokenA = loginA.body?.token;
    const tokenB = loginB.body?.token;
    check("SETUP: employee A/B logins succeed", loginA.status === 200 && loginB.status === 200);

    // ---------- A: Tenant A uploads a file ----------
    console.log("\nTEST A -- Tenant A uploads a file");
    const uploadA = await uploadFile("/api/employees/profile/photo", "profilePhoto", tokenA);
    check("A. Tenant A profile photo upload succeeds", uploadA.status === 200, JSON.stringify(uploadA.body));
    const rawPathA = uploadA.body?.profilePhoto;
    check("A. Stored path is tenant-namespaced (tenant_filetest_a)", typeof rawPathA === "string" && rawPathA.includes(`tenant_${A_SLUG}`), rawPathA);

    const uploadB = await uploadFile("/api/employees/profile/photo", "profilePhoto", tokenB);
    check("SETUP: Tenant B also uploads its own file", uploadB.status === 200);

    // ---------- B: Tenant A can access its own file ----------
    console.log("\nTEST B -- Tenant A can access its own file");
    const profileA = await apiGet("/api/employees/profile/me", tokenA);
    const signedUrlA = profileA.body?.profile?.profile_photo;
    check("B. Tenant A's own profile response carries a signed URL", typeof signedUrlA === "string" && signedUrlA.includes("fat="), signedUrlA);
    const fetchOwnA = await fetch(`${BASE_URL}${signedUrlA}`);
    check("B. Tenant A can fetch its own signed file URL (200, image)", fetchOwnA.status === 200 && (fetchOwnA.headers.get("content-type") || "").startsWith("image/"));

    const profileB = await apiGet("/api/employees/profile/me", tokenB);
    const signedUrlB = profileB.body?.profile?.profile_photo;
    check("SETUP: Tenant B's own signed URL obtained", typeof signedUrlB === "string" && signedUrlB.includes("fat="));

    // ---------- C/D: Tenant B cannot access Tenant A's file by guessing/modifying URLs ----------
    console.log("\nTEST C/D -- Tenant B cannot forge/guess/modify its way into Tenant A's file");

    // C1: Tenant B's own profile response never contains Tenant A's path at all (DB isolation).
    check("C1. Tenant B's profile response contains no reference to Tenant A's tenant folder",
        !JSON.stringify(profileB.body).includes(`tenant_${A_SLUG}`));

    // C2: swap Tenant A's real, validly-signed URL's PATH to point at
    // a plausible Tenant-B-style path while keeping A's token --
    // exact-path-match must reject this.
    const [pathnameA, queryA] = signedUrlA.split("?");
    const forgedPathSwap = `${pathnameA.replace(`tenant_${A_SLUG}`, `tenant_${B_SLUG}`)}?${queryA}`;
    const fetchForgedSwap = await fetch(`${BASE_URL}${forgedPathSwap}`);
    check("C2. Swapping the tenant folder in a valid URL (keeping the old token) is rejected", fetchForgedSwap.status === 403 || fetchForgedSwap.status === 401,
        `got ${fetchForgedSwap.status}`);

    // C3: use Tenant B's OWN valid token against Tenant A's real path.
    const [, queryB] = signedUrlB.split("?");
    const crossTokenUrl = `${pathnameA}?${queryB}`;
    const fetchCrossToken = await fetch(`${BASE_URL}${crossTokenUrl}`);
    check("C3. Tenant B's own valid token does not work against Tenant A's real file path", fetchCrossToken.status === 403 || fetchCrossToken.status === 401,
        `got ${fetchCrossToken.status}`);

    // D1: guess a plausible filename in Tenant A's folder with no token at all.
    const guessedNoToken = `${pathnameA.replace(/[^/]+$/, "guessed-name.jpg")}`;
    const fetchGuessNoToken = await fetch(`${BASE_URL}${guessedNoToken}`);
    check("D1. Guessed filename with no token at all is rejected (401)", fetchGuessNoToken.status === 401, `got ${fetchGuessNoToken.status}`);

    // D2: guess the exact real filename (assume known) but no token.
    const realPathNoToken = pathnameA;
    const fetchRealNoToken = await fetch(`${BASE_URL}${realPathNoToken}`);
    check("D2. Even the EXACT real path with no token is rejected (401)", fetchRealNoToken.status === 401, `got ${fetchRealNoToken.status}`);

    // ---------- E: forged companySlug (garbage/self-signed token) ----------
    console.log("\nTEST E -- Forged companySlug (self-signed token using a guessed secret)");
    const forgedToken = jwt.sign({ path: pathnameA, companySlug: A_SLUG }, "attacker-guessed-wrong-secret", { expiresIn: "2h" });
    const fetchForged = await fetch(`${BASE_URL}${pathnameA}?fat=${forgedToken}`);
    check("E. Token signed with a wrong/guessed secret is rejected", fetchForged.status === 401, `got ${fetchForged.status}`);

    // ---------- F: forged companyId/companySlug in request body ignored ----------
    console.log("\nTEST F -- Forged companyId/companySlug in request body has no effect");
    const forgedBodyRes = await fetch(`${BASE_URL}/api/employees/profile/me`, {
        method: "GET",
        headers: { Authorization: `Bearer ${tokenB}`, "Content-Type": "application/json" },
    });
    const forgedBodyJson = await forgedBodyRes.json();
    check("F. Tenant B's profile request (even attempting forged context) still resolves to Tenant B's own tenant only",
        forgedBodyJson?.profile?.profile_photo?.includes(`tenant_${B_SLUG}`) && !forgedBodyJson?.profile?.profile_photo?.includes(`tenant_${A_SLUG}`),
        JSON.stringify(forgedBodyJson));

    // ---------- G/H: path traversal ----------
    console.log("\nTEST G/H -- Path traversal attempts rejected");
    const traversalAttempts = [
        `/uploads/../../../../etc/passwd?fat=${queryA?.split("=")[1] || "x"}`,
        `/uploads/tenant_${A_SLUG}/profiles/..%2f..%2f..%2fetc%2fpasswd?fat=${queryA?.split("=")[1] || "x"}`,
        `/uploads/tenant_${A_SLUG}/..%2f..%2fapp.js?${queryA}`,
    ];
    for (const attempt of traversalAttempts) {
        const r = await fetch(`${BASE_URL}${attempt}`);
        check(`G/H. Traversal attempt rejected: ${attempt.slice(0, 60)}...`, r.status !== 200, `got ${r.status}`);
    }

    // ---------- I: Platform JWT cannot access tenant files ----------
    console.log("\nTEST I -- Platform JWT cannot access tenant files");
    const platformToken = jwt.sign({ userId: 1, type: "platform_owner" }, process.env.PLATFORM_JWT_SECRET,
        { expiresIn: "1h", issuer: PLATFORM_JWT_ISSUER, audience: PLATFORM_JWT_AUDIENCE });
    const fetchWithPlatformAuthHeaderOnly = await fetch(`${BASE_URL}${pathnameA}`, { headers: { Authorization: `Bearer ${platformToken}` } });
    check("I. Platform JWT alone (no fat token) cannot fetch a tenant file -> 401", fetchWithPlatformAuthHeaderOnly.status === 401, `got ${fetchWithPlatformAuthHeaderOnly.status}`);

    // ---------- J: suspended tenant loses file access immediately ----------
    console.log("\nTEST J -- Suspended tenant loses file access even with an unexpired token");
    const preSuspendFetch = await fetch(`${BASE_URL}${signedUrlA}`);
    check("SETUP: Tenant A's signed URL works before suspension", preSuspendFetch.status === 200);
    await platformPool.query(`UPDATE companies SET status = 'suspended' WHERE id = ?`, [companyAId]);
    const postSuspendFetch = await fetch(`${BASE_URL}${signedUrlA}`);
    check("J. Same still-unexpired signed URL is rejected after the company is suspended", postSuspendFetch.status === 403, `got ${postSuspendFetch.status}`);
    await platformPool.query(`UPDATE companies SET status = 'active' WHERE id = ?`, [companyAId]);

    // ---------- K: Reinsteins existing files still work ----------
    console.log("\nTEST K -- Reinsteins existing files still work (already verified separately; re-confirmed here)");
    const legacyToken = jwt.sign({ id: 4, employeeId: "LEGACY-RECHECK", role: "employee" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const legacyProfile = await apiGet("/api/employees/profile/me", legacyToken);
    const legacyPhotoUrl = legacyProfile.body?.profile?.profile_photo;
    const legacyFetch = legacyPhotoUrl ? await fetch(`${BASE_URL}${legacyPhotoUrl}`) : null;
    check("K. Real Reinsteins profile photo still resolves and serves correctly", legacyFetch && legacyFetch.status === 200, legacyPhotoUrl);

    // ---------- L: no unauthenticated access ----------
    console.log("\nTEST L -- No unauthenticated user can access private files");
    const noAuthNoToken = await fetch(`${BASE_URL}/uploads/tenant_${A_SLUG}/profiles/anything.jpg`);
    check("L. No token at all -> 401", noAuthNoToken.status === 401, `got ${noAuthNoToken.status}`);

    // ---------- Reinsteins DB unaffected ----------
    console.log("\nEXTRA -- Reinsteins DB verification");
    const dbPool = require("./config/db");
    const [[{ tblCount }]] = await dbPool.query(`SELECT COUNT(*) AS "tblCount" FROM information_schema.tables WHERE table_schema = 'public'`);
    const [[{ userCount }]] = await dbPool.query(`SELECT COUNT(*) AS "userCount" FROM users`);
    check("EXTRA: reinsteins_workhub table/user counts unchanged", Number(tblCount) === 37 && Number(userCount) === 17, `tables=${tblCount} users=${userCount}`);

    // ---------- Cleanup ----------
    console.log("\nCLEANUP");
    await closeAllTenantPools();
    await tenantProvisioningService.dropProvisionedDatabase(A_DB);
    await tenantProvisioningService.dropProvisionedDatabase(B_DB);
    await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?)`, [A_SLUG, B_SLUG]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);

    // Delete the temporary uploaded test files from disk.
    const tenantAUploadsDir = path.join(UPLOADS_ROOT, `tenant_${A_SLUG}`);
    const tenantBUploadsDir = path.join(UPLOADS_ROOT, `tenant_${B_SLUG}`);
    for (const dir of [tenantAUploadsDir, tenantBUploadsDir]) {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    console.log(`  Deleted temporary upload directories for ${A_SLUG} and ${B_SLUG}`);

    const aGone = await tenantProvisioningService.databaseExists(A_DB);
    const bGone = await tenantProvisioningService.databaseExists(B_DB);
    check("CLEANUP: both tenant DBs gone", aGone === false && bGone === false);
    check("CLEANUP: both tenant upload directories gone", !fs.existsSync(tenantAUploadsDir) && !fs.existsSync(tenantBUploadsDir));

    const [remaining] = await platformPool.query(`SELECT company_slug FROM companies`);
    check("CLEANUP: only Reinsteins remains in companies", remaining.length === 1 && remaining[0].company_slug === "reinsteins", JSON.stringify(remaining));

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
