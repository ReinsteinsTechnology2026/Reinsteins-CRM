require("dotenv").config();
const bcrypt = require("bcrypt");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { buildTenantDbName } = require("./utils/tenantDbName");

// ==========================================
// SOP LIBRARY SELF-TEST (Phase 17c)
//
// Real HTTP against the live backend on http://localhost:5000, using
// two throwaway tenants provisioned through the real platform APIs.
// Never touches reinsteins_workhub or any real tenant. Drops
// everything it creates at the end.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "soptest_owner@groworgs.internal";
const OWNER_PASSWORD = "SopTestOwner!2026Pwd";

const A_SLUG = "soptest_a";
const B_SLUG = "soptest_b";
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

async function apiDelete(pathname, token) {
    const res = await fetch(`${BASE_URL}${pathname}`, { method: "DELETE", headers: token ? { Authorization: `Bearer ${token}` } : {} });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

// A minimal valid 1x1 JPEG and a minimal valid PDF header, hardcoded
// bytes -- avoids depending on any real file on disk.
const TINY_JPEG_BASE64 =
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";

const TINY_PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF");

async function uploadSop(token, { title, filename, mimeType, bytes }) {
    const form = new FormData();
    if (title !== undefined) form.append("title", title);
    form.append("sopFile", new Blob([bytes], { type: mimeType }), filename);
    const res = await fetch(`${BASE_URL}/api/sops`, {
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
    console.log("SETUP -- platform owner + two tenants + employee fixtures");

    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "SOP Test Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });

    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: platform owner login succeeded", loginRes.status === 200 && !!ownerToken);

    const createA = await apiPost("/api/platform/companies", { companyName: "Sop Test A", companySlug: A_SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: company A created", createA.status === 201);
    const companyAId = createA.body?.company?.id;

    const createB = await apiPost("/api/platform/companies", { companyName: "Sop Test B", companySlug: B_SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: company B created", createB.status === 201);
    const companyBId = createB.body?.company?.id;

    const adminACreate = await apiPost(`/api/platform/companies/${companyAId}/admin`, { name: "Admin A", email: "admin@soptest-a.test", password: "AdminPass123!Sop_A" }, ownerToken);
    const adminAEmployeeId = adminACreate.body?.admin?.employeeId;
    const loginAdminA = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: adminAEmployeeId, password: "AdminPass123!Sop_A" });
    const tokenAdminA = loginAdminA.body?.token;
    check("SETUP: admin A login succeeded", loginAdminA.status === 200 && !!tokenAdminA);

    const adminBCreate = await apiPost(`/api/platform/companies/${companyBId}/admin`, { name: "Admin B", email: "admin@soptest-b.test", password: "AdminPass123!Sop_B" }, ownerToken);
    const adminBEmployeeId = adminBCreate.body?.admin?.employeeId;
    const loginAdminB = await apiPost(`/api/tenant-auth/${B_SLUG}/login`, { employeeId: adminBEmployeeId, password: "AdminPass123!Sop_B" });
    const tokenAdminB = loginAdminB.body?.token;
    check("SETUP: admin B login succeeded", loginAdminB.status === 200 && !!tokenAdminB);

    const poolA = getTenantPool(A_DB);
    const employeePasswordHash = await bcrypt.hash("Employee123!Sop", 10);

    async function seedUser(employeeId, fullName, systemAccess, employmentType) {
        const [result] = await poolA.query(
            `INSERT INTO users (employee_id, full_name, email, password, role, system_access, employment_type, employment_status, status, designation)
             VALUES (?, ?, ?, ?, 'employee', ?, ?, 'active', 'active', ?) RETURNING id`,
            [employeeId, fullName, `${employeeId.toLowerCase()}@soptest-a.test`, employeePasswordHash, systemAccess, employmentType, "Staff"]
        );
        return result[0].id;
    }

    const empUserId = await seedUser("SO001", "Plain Employee", "employee", "employee");
    const internUserId = await seedUser("SO002", "Intern Person", "employee", "intern");
    const superAdminUserId = await seedUser("SO003", "Super Admin Person", "super_admin", "employee");

    async function loginAs(employeeId) {
        const res = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId, password: "Employee123!Sop" });
        return res.body?.token;
    }

    const tokenEmp = await loginAs("SO001");
    const tokenIntern = await loginAs("SO002");
    const tokenSuperAdmin = await loginAs("SO003");

    check("SETUP: all fixture logins succeeded", !!(tokenEmp && tokenIntern && tokenSuperAdmin));

    // ---------- Admin upload succeeds ----------
    console.log("\nTEST -- Admin upload succeeds");
    const adminUpload = await uploadSop(tokenAdminA, { title: "Onboarding Checklist", filename: "onboarding.pdf", mimeType: "application/pdf", bytes: TINY_PDF_BYTES });
    check("Admin upload -> 201", adminUpload.status === 201, JSON.stringify(adminUpload.body));
    const adminUploadedId = adminUpload.body?.id;

    // ---------- Super Admin upload succeeds ----------
    console.log("\nTEST -- Super Admin upload succeeds");
    const jpegBytes = Buffer.from(TINY_JPEG_BASE64, "base64");
    const superAdminUpload = await uploadSop(tokenSuperAdmin, { title: "Security Policy", filename: "security.jpg", mimeType: "image/jpeg", bytes: jpegBytes });
    check("Super Admin upload -> 201", superAdminUpload.status === 201, JSON.stringify(superAdminUpload.body));
    const superAdminUploadedId = superAdminUpload.body?.id;

    // ---------- Employee upload rejected ----------
    console.log("\nTEST -- Employee upload rejected");
    const empUpload = await uploadSop(tokenEmp, { title: "Should Fail", filename: "x.pdf", mimeType: "application/pdf", bytes: TINY_PDF_BYTES });
    check("Employee upload -> 403", empUpload.status === 403, JSON.stringify(empUpload.body));

    // ---------- Intern upload rejected ----------
    console.log("\nTEST -- Intern upload rejected");
    const internUpload = await uploadSop(tokenIntern, { title: "Should Fail", filename: "x.pdf", mimeType: "application/pdf", bytes: TINY_PDF_BYTES });
    check("Intern upload -> 403", internUpload.status === 403, JSON.stringify(internUpload.body));

    // ---------- All authenticated users can list SOPs ----------
    console.log("\nTEST -- All authenticated users can list SOPs");
    const listAsAdmin = await apiGet("/api/sops", tokenAdminA);
    const listAsEmp = await apiGet("/api/sops", tokenEmp);
    const listAsIntern = await apiGet("/api/sops", tokenIntern);
    check("Admin can list -> 200, 2 entries", listAsAdmin.status === 200 && listAsAdmin.body?.sops?.length === 2, JSON.stringify(listAsAdmin.body));
    check("Employee can list -> 200, 2 entries", listAsEmp.status === 200 && listAsEmp.body?.sops?.length === 2, JSON.stringify(listAsEmp.body));
    check("Intern can list -> 200, 2 entries", listAsIntern.status === 200 && listAsIntern.body?.sops?.length === 2, JSON.stringify(listAsIntern.body));

    // ---------- All authenticated users can view/download SOPs ----------
    console.log("\nTEST -- All authenticated users can view/download SOPs");
    const sopFilePath = listAsEmp.body?.sops?.find((s) => s.id === adminUploadedId)?.file_path;
    check("SETUP: SOP response carries a signed URL", typeof sopFilePath === "string" && sopFilePath.includes("fat="), sopFilePath);
    const downloadAsEmp = await fetch(`${BASE_URL}${sopFilePath}`);
    check("Employee can download via the signed URL -> 200", downloadAsEmp.status === 200, `status=${downloadAsEmp.status}`);

    // ---------- Normal user delete rejected ----------
    console.log("\nTEST -- Normal user delete rejected");
    const empDeleteAttempt = await apiDelete(`/api/sops/${adminUploadedId}`, tokenEmp);
    check("Employee delete -> 403", empDeleteAttempt.status === 403, JSON.stringify(empDeleteAttempt.body));

    const internDeleteAttempt = await apiDelete(`/api/sops/${adminUploadedId}`, tokenIntern);
    check("Intern delete -> 403", internDeleteAttempt.status === 403, JSON.stringify(internDeleteAttempt.body));

    // ---------- Admin delete succeeds ----------
    console.log("\nTEST -- Admin delete succeeds");
    const adminDelete = await apiDelete(`/api/sops/${adminUploadedId}`, tokenAdminA);
    check("Admin delete -> 200", adminDelete.status === 200, JSON.stringify(adminDelete.body));

    const listAfterDelete = await apiGet("/api/sops", tokenAdminA);
    check("Deleted SOP no longer listed", listAfterDelete.body?.sops?.length === 1, JSON.stringify(listAfterDelete.body));

    const downloadDeletedFile = await fetch(`${BASE_URL}${sopFilePath}`);
    check("Deleted SOP's file no longer resolves -> 404", downloadDeletedFile.status === 404, `status=${downloadDeletedFile.status}`);

    // ---------- Invalid extension rejected ----------
    console.log("\nTEST -- Invalid extension rejected");
    const badExtension = await uploadSop(tokenAdminA, { title: "Bad Extension", filename: "malware.exe", mimeType: "application/pdf", bytes: TINY_PDF_BYTES });
    check("Disallowed .exe extension rejected (4xx/5xx, not 201)", badExtension.status !== 201, JSON.stringify(badExtension.body));

    // ---------- Invalid MIME type rejected (mismatched mimetype vs extension) ----------
    console.log("\nTEST -- Invalid MIME type rejected");
    const badMime = await uploadSop(tokenAdminA, { title: "Bad Mime", filename: "fake.pdf", mimeType: "application/x-msdownload", bytes: TINY_PDF_BYTES });
    check("PDF extension with a disallowed mimetype rejected (4xx/5xx, not 201)", badMime.status !== 201, JSON.stringify(badMime.body));

    // ---------- Oversized file rejected ----------
    console.log("\nTEST -- Oversized file rejected");
    const oversizedBytes = Buffer.alloc(21 * 1024 * 1024, 1); // 21 MB > the 20 MB limit
    const oversized = await uploadSop(tokenAdminA, { title: "Too Big", filename: "big.pdf", mimeType: "application/pdf", bytes: oversizedBytes });
    check("Oversized file rejected (4xx/5xx, not 201)", oversized.status !== 201, `status=${oversized.status}`);

    // ---------- Path traversal / suspicious filenames ----------
    console.log("\nTEST -- Path traversal / suspicious filenames safely handled");
    const traversalName = "../../../../etc/passwd_style_name.pdf";
    const traversalUpload = await uploadSop(tokenAdminA, { title: "Traversal Attempt", filename: traversalName, mimeType: "application/pdf", bytes: TINY_PDF_BYTES });
    check(
        "Malicious original filename (safe extension) still uploads -- server-generated storage name, never the raw original",
        traversalUpload.status === 201,
        JSON.stringify(traversalUpload.body)
    );
    const [traversalRow] = await poolA.query(`SELECT stored_filename, original_filename, file_path FROM sops WHERE id = ?`, [traversalUpload.body?.id]);
    check(
        "Stored filename contains no path separators/traversal sequences (server-generated, never derived from the original name)",
        traversalRow[0] && !traversalRow[0].stored_filename.includes("..") && !traversalRow[0].stored_filename.includes("/"),
        JSON.stringify(traversalRow[0])
    );
    // multer/busboy itself already strips any directory portion from
    // the client-supplied filename before file.originalname is ever
    // visible to application code -- confirmed directly (the raw
    // "../../../../etc/passwd_style_name.pdf" sent above arrives here
    // as just "passwd_style_name.pdf"), an additional layer beneath
    // this codebase's own server-generated-filename defense.
    check(
        "original_filename is safely reduced to its basename by the upload layer itself",
        traversalRow[0]?.original_filename === "passwd_style_name.pdf",
        JSON.stringify(traversalRow[0])
    );

    // ---------- Tenant isolation ----------
    console.log("\nTEST -- Tenant A cannot access Tenant B's SOP records/files");
    const listAsTenantB = await apiGet("/api/sops", tokenAdminB);
    check("Tenant B's own SOP list has zero Tenant A entries", listAsTenantB.status === 200 && (listAsTenantB.body?.sops || []).length === 0, JSON.stringify(listAsTenantB.body));

    const superAdminSopPath = (await apiGet("/api/sops", tokenAdminA)).body?.sops?.find((s) => s.id === superAdminUploadedId)?.file_path;

    // The /uploads/*splat route authorizes purely from the signed
    // `fat` query-string token embedded in the URL itself -- it never
    // reads an Authorization header at all, so sending tokenAdminB as
    // a Bearer header here would prove nothing (the URL's OWN
    // already-valid tenant-A token is what legitimately authorizes
    // it). The real cross-tenant question is whether a token signed
    // for TENANT B can be swapped onto TENANT A's path -- upload a
    // throwaway file as tenant B to get a genuine tenant-B-signed
    // `fat` token, then splice it onto tenant A's path.
    const tenantBOwnUpload = await uploadSop(tokenAdminB, { title: "Tenant B Own File", filename: "b.pdf", mimeType: "application/pdf", bytes: TINY_PDF_BYTES });
    const tenantBOwnPath = (await apiGet("/api/sops", tokenAdminB)).body?.sops?.find((s) => s.id === tenantBOwnUpload.body?.id)?.file_path;
    const tenantBFatToken = tenantBOwnPath.split("fat=")[1];
    const forgedPath = `${superAdminSopPath.split("?")[0]}?fat=${tenantBFatToken}`;
    const tenantBTriesDownload = await fetch(`${BASE_URL}${forgedPath}`);
    check("Tenant B's own valid signed token does not work against Tenant A's real file path -> 403", tenantBTriesDownload.status === 403, `status=${tenantBTriesDownload.status}`);

    const tenantBTriesDelete = await apiDelete(`/api/sops/${superAdminUploadedId}`, tokenAdminB);
    check("Tenant B admin cannot delete Tenant A's SOP by id (not found in ITS OWN tenant DB) -> 404", tenantBTriesDelete.status === 404, JSON.stringify(tenantBTriesDelete.body));

    // ---------- Cleanup ----------
    console.log("\nCLEANUP");
    await closeAllTenantPools();
    await tenantProvisioningService.dropProvisionedDatabase(A_DB);
    await tenantProvisioningService.dropProvisionedDatabase(B_DB);
    console.log(`  Dropped "${A_DB}" and "${B_DB}"`);

    await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?)`, [A_SLUG, B_SLUG]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    console.log(`  Deleted company rows and temp platform owner`);

    const aGone = await tenantProvisioningService.databaseExists(A_DB);
    const bGone = await tenantProvisioningService.databaseExists(B_DB);
    check("CLEANUP: tenant A DB gone", aGone === false);
    check("CLEANUP: tenant B DB gone", bGone === false);

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
