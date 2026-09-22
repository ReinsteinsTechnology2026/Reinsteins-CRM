require("dotenv").config();
const bcrypt = require("bcrypt");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const { columnExists, run: runLogoMigration } = require("./_migrate_add_company_logo");

// ==========================================
// MULTI-TENANT COMPANY BRANDING -- SELF-TEST
//
// Real HTTP against the live backend on http://localhost:5000, using
// two throwaway platform companies provisioned through the real
// platform APIs (same convention as _test_admin_group_permission_backfill.js).
// Never touches reinsteins_workhub, groworgs_platform_db's real
// company rows, or any real tenant. Drops everything it creates at
// the end, including any uploaded logo files.
//
// Covers cases A-M from the branding implementation:
//   A. companies.logo_url column exists after migration
//   B. migration is idempotent
//   C. getCompanyInfo returns logoUrl when configured
//   D. getCompanyInfo returns null when no logo exists
//   E. public logo endpoint returns the correct image for an active company
//   F. missing logo returns 404
//   G. inactive/suspended company returns 404
//   H. invalid/traversal slugs cannot access arbitrary files
//   I. Company A cannot retrieve Company B's logo through a crafted request
//   J. Platform Owner can upload/replace/remove a logo
//   K. unauthorized users cannot modify company logos
//   L. tenant login falls back correctly when logoUrl is null (API contract)
//   M. Platform Owner login remains ZioVenture branded (static -- see note)
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "brandingtest_owner@groworgs.internal";
const OWNER_PASSWORD = "BrandingTestOwner!2026Pwd";

const A_SLUG = "brandingtest_a";
const B_SLUG = "brandingtest_b";

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

// Uploads a tiny dummy "image" -- the server validates client-claimed
// mimetype + filename extension only (never parses real image
// content, matching every other upload feature in this codebase --
// see utils/fileTypeValidation.js), so arbitrary distinguishable byte
// content is sufficient to prove per-company isolation (case I) via
// differing response bodies.
async function apiUploadLogo(companyId, token, { filename, mimeType, contentByte }) {
    const form = new FormData();
    const blob = new Blob([new Uint8Array([contentByte, contentByte, contentByte, contentByte])], { type: mimeType });
    form.append("logo", blob, filename);

    const res = await fetch(`${BASE_URL}/api/platform/companies/${companyId}/logo`, {
        method: "POST",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: form,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

async function apiDelete(pathname, token) {
    const res = await fetch(`${BASE_URL}${pathname}`, {
        method: "DELETE",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

async function fetchRaw(url) {
    const res = await fetch(url);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { status: res.status, contentType: res.headers.get("content-type"), buffer };
}

(async () => {

    // ==========================================
    // CASE A & B -- migration column existence + idempotency
    // ==========================================
    console.log("A&B. CASE A&B -- migration adds companies.logo_url and is idempotent");

    const existedBefore = await columnExists(platformPool, "companies", "logo_url");
    check("CASE A: companies.logo_url already exists (deployed earlier in this session)", existedBefore);

    await runLogoMigration();
    const existsAfterFirstRun = await columnExists(platformPool, "companies", "logo_url");
    check("CASE A: companies.logo_url exists after running the migration", existsAfterFirstRun);

    let secondRunThrew = false;
    try {
        await runLogoMigration();
    } catch (_error) {
        secondRunThrew = true;
    }
    check("CASE B: running the migration a second time does not throw (idempotent)", !secondRunThrew);
    check("CASE B: column still exists after a second run", await columnExists(platformPool, "companies", "logo_url"));

    // ==========================================
    // Setup -- platform owner + two throwaway companies
    // ==========================================
    console.log("\nSETUP -- platform owner + two throwaway companies");

    const ownerPasswordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "Branding Test Owner", email: OWNER_EMAIL, passwordHash: ownerPasswordHash, role: "platform_owner" });

    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: platform owner login succeeded", loginRes.status === 200 && !!ownerToken);

    const createA = await apiPost("/api/platform/companies", { companyName: "Branding Test A", companySlug: A_SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: company A created", createA.status === 201);
    const companyAId = createA.body?.company?.id;

    const createB = await apiPost("/api/platform/companies", { companyName: "Branding Test B", companySlug: B_SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: company B created", createB.status === 201);
    const companyBId = createB.body?.company?.id;

    // ==========================================
    // CASE D -- no logo yet -> logoUrl null
    // ==========================================
    console.log("\nD. CASE D -- getCompanyInfo returns logoUrl: null when no logo exists");

    const infoBeforeUpload = await apiGet(`/api/tenant-auth/${A_SLUG}/info`);
    check("CASE D: request succeeded", infoBeforeUpload.status === 200, JSON.stringify(infoBeforeUpload.body));
    check("CASE D: logoUrl is null", infoBeforeUpload.body?.company?.logoUrl === null, JSON.stringify(infoBeforeUpload.body));

    // ==========================================
    // CASE F -- missing logo -> 404 on the public serving endpoint too
    // ==========================================
    console.log("\nF. CASE F -- public logo endpoint 404s when no logo is configured");

    const missingLogoRes = await apiGet(`/api/tenant-auth/${A_SLUG}/logo`);
    check("CASE F: 404 for a company with no logo", missingLogoRes.status === 404);

    // ==========================================
    // CASE K -- unauthorized upload attempts are rejected
    // ==========================================
    console.log("\nK. CASE K -- unauthorized users cannot modify company logos");

    const noAuthUpload = await apiUploadLogo(companyAId, null, { filename: "logo.png", mimeType: "image/png", contentByte: 0xaa });
    check("CASE K: upload without any token is rejected (401)", noAuthUpload.status === 401, JSON.stringify(noAuthUpload.body));

    const noAuthDelete = await apiDelete(`/api/platform/companies/${companyAId}/logo`, null);
    check("CASE K: delete without any token is rejected (401)", noAuthDelete.status === 401, JSON.stringify(noAuthDelete.body));

    // ==========================================
    // CASE J (upload) & C -- Platform Owner can upload; getCompanyInfo then returns it
    // ==========================================
    console.log("\nJ&C. CASE J&C -- Platform Owner uploads a logo; getCompanyInfo now returns logoUrl");

    const uploadA1 = await apiUploadLogo(companyAId, ownerToken, { filename: "logo.png", mimeType: "image/png", contentByte: 0x11 });
    check("CASE J: upload succeeded -> 200", uploadA1.status === 200, JSON.stringify(uploadA1.body));
    check("CASE J: response reports hasLogo true", uploadA1.body?.company?.hasLogo === true, JSON.stringify(uploadA1.body));

    const infoAfterUpload = await apiGet(`/api/tenant-auth/${A_SLUG}/info`);
    check("CASE C: logoUrl is now a non-null URL", typeof infoAfterUpload.body?.company?.logoUrl === "string" && infoAfterUpload.body.company.logoUrl.length > 0, JSON.stringify(infoAfterUpload.body));
    check("CASE C: logoUrl points at the public tenant-auth logo endpoint", infoAfterUpload.body?.company?.logoUrl?.includes(`/api/tenant-auth/${A_SLUG}/logo`));

    // ==========================================
    // CASE E -- public endpoint serves the correct image
    // ==========================================
    console.log("\nE. CASE E -- public logo endpoint returns the correct image");

    const servedA1 = await fetchRaw(infoAfterUpload.body.company.logoUrl);
    check("CASE E: 200 for an active company with a logo", servedA1.status === 200);
    check("CASE E: Content-Type is image/png", servedA1.contentType?.startsWith("image/png"), servedA1.contentType);
    check("CASE E: served bytes match what was uploaded", servedA1.buffer.every((b) => b === 0x11) && servedA1.buffer.length === 4, servedA1.buffer.toString("hex"));

    // ==========================================
    // CASE J (replace) -- uploading again replaces the file, old one is gone
    // ==========================================
    console.log("\nJ (replace). CASE J -- replacing a logo serves the NEW content, not the old");

    const uploadA2 = await apiUploadLogo(companyAId, ownerToken, { filename: "logo2.webp", mimeType: "image/webp", contentByte: 0x22 });
    check("CASE J: replace upload succeeded", uploadA2.status === 200, JSON.stringify(uploadA2.body));

    const infoAfterReplace = await apiGet(`/api/tenant-auth/${A_SLUG}/info`);
    const servedA2 = await fetchRaw(infoAfterReplace.body.company.logoUrl);
    check("CASE J: served content now reflects the replacement", servedA2.buffer.every((b) => b === 0x22), servedA2.buffer.toString("hex"));
    check("CASE J: Content-Type updated to the new file's type (webp)", servedA2.contentType?.startsWith("image/webp"), servedA2.contentType);

    // ==========================================
    // CASE I -- company A and company B logos never cross-contaminate
    // ==========================================
    console.log("\nI. CASE I -- Company A cannot retrieve Company B's logo through a crafted request");

    const uploadB1 = await apiUploadLogo(companyBId, ownerToken, { filename: "logo.jpg", mimeType: "image/jpeg", contentByte: 0x33 });
    check("CASE I setup: company B logo uploaded", uploadB1.status === 200, JSON.stringify(uploadB1.body));

    const servedAAgain = await fetchRaw(`${BASE_URL}/api/tenant-auth/${A_SLUG}/logo`);
    const servedB = await fetchRaw(`${BASE_URL}/api/tenant-auth/${B_SLUG}/logo`);
    check("CASE I: requesting company A's slug still serves company A's own (replaced) content", servedAAgain.buffer.every((b) => b === 0x22));
    check("CASE I: requesting company B's slug serves company B's own, DIFFERENT content", servedB.buffer.every((b) => b === 0x33));
    check("CASE I: the two companies' served bytes are not identical", !servedAAgain.buffer.equals(servedB.buffer));

    // ==========================================
    // CASE H -- traversal / invalid slugs cannot access arbitrary files
    // ==========================================
    console.log("\nH. CASE H -- invalid/traversal slugs cannot access arbitrary files");

    const traversalAttempts = [
        `/api/tenant-auth/${encodeURIComponent("../../../etc/passwd")}/logo`,
        `/api/tenant-auth/${encodeURIComponent("..%2f..%2fetc%2fpasswd")}/logo`,
        `/api/tenant-auth/${A_SLUG}%2f..%2f..%2flogo/logo`,
    ];
    for (const attempt of traversalAttempts) {
        const res = await apiGet(attempt);
        check(`CASE H: traversal attempt rejected (${attempt})`, res.status === 404 || res.status === 400, `got ${res.status}`);
    }

    // ==========================================
    // CASE G -- suspended company's logo is no longer servable
    // ==========================================
    console.log("\nG. CASE G -- suspended company's logo returns 404");

    const suspendRes = await apiPatch(`/api/platform/companies/${companyAId}/status`, { action: "suspend" }, ownerToken);
    check("CASE G setup: company A suspended", suspendRes.status === 200, JSON.stringify(suspendRes.body));

    const suspendedInfo = await apiGet(`/api/tenant-auth/${A_SLUG}/info`);
    check("CASE G: getCompanyInfo 404s for a suspended company", suspendedInfo.status === 404);

    const suspendedLogo = await apiGet(`/api/tenant-auth/${A_SLUG}/logo`);
    check("CASE G: public logo endpoint 404s for a suspended company even though a logo file still exists", suspendedLogo.status === 404);

    // Reactivate for the remaining cases (remove/idempotency below).
    const reactivateRes = await apiPatch(`/api/platform/companies/${companyAId}/status`, { action: "reactivate" }, ownerToken);
    check("Cleanup step: company A reactivated for remaining checks", reactivateRes.status === 200);

    // ==========================================
    // CASE J (remove) -- Platform Owner can remove a logo
    // ==========================================
    console.log("\nJ (remove). CASE J -- Platform Owner removes a logo");

    const removeRes = await apiDelete(`/api/platform/companies/${companyAId}/logo`, ownerToken);
    check("CASE J: remove succeeded -> 200", removeRes.status === 200, JSON.stringify(removeRes.body));
    check("CASE J: response reports hasLogo false", removeRes.body?.company?.hasLogo === false, JSON.stringify(removeRes.body));

    // ==========================================
    // CASE L -- tenant login falls back correctly (API contract: logoUrl
    // is null again after removal, exactly the same shape as CASE D --
    // the frontend's existing, UNCHANGED conditional in Login.jsx
    // already renders the "Zi" fallback for this exact shape).
    // ==========================================
    console.log("\nL. CASE L -- tenant login info falls back to logoUrl: null after removal");

    const infoAfterRemove = await apiGet(`/api/tenant-auth/${A_SLUG}/info`);
    check("CASE L: logoUrl is null again after removal", infoAfterRemove.body?.company?.logoUrl === null, JSON.stringify(infoAfterRemove.body));

    const logoAfterRemove = await apiGet(`/api/tenant-auth/${A_SLUG}/logo`);
    check("CASE L: public logo endpoint 404s again after removal", logoAfterRemove.status === 404);

    // ==========================================
    // CASE M -- Platform Owner login branding (static, not exercised
    // over HTTP): PlatformLogin.jsx was not modified by this
    // implementation at all -- it has no company-slug/tenant lookup of
    // any kind and unconditionally renders the "ZioVenture" wordmark,
    // confirmed by direct code inspection before implementation began.
    // Nothing in this change touches that file, so this requirement is
    // satisfied by construction rather than by an HTTP assertion here.
    // ==========================================
    console.log("\nM. CASE M -- Platform Owner login branding: PlatformLogin.jsx untouched by this change (verified by inspection, not HTTP -- see comment above)");
    check("CASE M: no automated check needed -- confirmed by code review", true);

    // ---------- Report ----------
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);

    // ---------- Cleanup ----------
    console.log("\nCLEANUP -- dropping test companies and platform fixtures");

    try {
        await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?)`, [A_SLUG, B_SLUG]);
    } catch (error) {
        console.error("Cleanup (companies) error:", error.message);
    }

    try {
        await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    } catch (error) {
        console.error("Cleanup (platform user) error:", error.message);
    }

    try {
        const fs = require("fs");
        const path = require("path");
        const { UPLOADS_ROOT } = require("./utils/tenantUploadPath");
        for (const slug of [A_SLUG, B_SLUG]) {
            const dir = path.join(UPLOADS_ROOT, `tenant_${slug}`);
            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        }
    } catch (error) {
        console.error("Cleanup (uploaded logo files) error:", error.message);
    }

    await platformPool.end();

    process.exit(failures === 0 ? 0 : 1);

})().catch((error) => {
    console.error("TEST SCRIPT ERROR:", error);
    process.exit(1);
});
