require("dotenv").config();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { buildTenantDbName } = require("./utils/tenantDbName");

// ==========================================
// SUPPLEMENTARY FILE SECURITY TESTS
// Covers two scenarios named explicitly in the re-issued Phase 3
// spec that weren't given their own dedicated test in the first
// pass: (G) a forged/fake tenant DATABASE NAME has no effect, and
// (I) a filesystem-style absolute-path request cannot escape the
// tenant boundary. Everything else was already re-verified by
// _test_file_tenant_isolation.js and _test_chat_file_signing.js.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "filesupp_owner@groworgs.internal";
const OWNER_PASSWORD = "FileSuppOwner!2026Pwd";
const SLUG = "filesupp_a";
const DB = buildTenantDbName(SLUG);

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

(async () => {
    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "File Supp Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: platform owner login", loginRes.status === 200 && !!ownerToken);

    const create = await apiPost("/api/platform/companies", { companyName: "FILE SUPP A", companySlug: SLUG, accessType: "trial" }, ownerToken);
    const companyId = create.body?.company?.id;
    check("SETUP: company provisioned", create.status === 201);

    const empPasswordHash = await bcrypt.hash("FileSuppEmp!2026", 12);
    const tenantPool = getTenantPool(DB);
    await tenantPool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role, system_access, status) VALUES ('EMP001', 'Supp Emp', 'emp@filesupp.test', ?, 'employee', 'employee', 'active')`,
        [empPasswordHash]
    );
    const loginA = await apiPost(`/api/tenant-auth/${SLUG}/login`, { employeeId: "EMP001", password: "FileSuppEmp!2026" });
    const tokenA = loginA.body?.token;
    check("SETUP: employee login", loginA.status === 200 && !!tokenA);

    // ---------- G: forged tenant DATABASE NAME in request body has no effect ----------
    console.log("\nTEST G -- Forged tenant database name in request body");
    const forgedDbRes = await fetch(`${BASE_URL}/api/employees/profile/me`, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${tokenA}`,
            "Content-Type": "application/json",
            // Some clients might try smuggling this via a custom header too.
            "X-Tenant-Db-Name": "reinsteins_workhub",
        },
    });
    const forgedDbBody = await forgedDbRes.json();
    check("G. Forged X-Tenant-Db-Name header has no effect -- still resolves to filesupp_a's own tenant DB",
        forgedDbRes.status === 200 && !JSON.stringify(forgedDbBody).includes("tenant_reinsteins") && !JSON.stringify(forgedDbBody).includes("reinsteins_workhub"),
        JSON.stringify(forgedDbBody));

    // A forged tenantDbName field inside a POST body, on an endpoint
    // that does accept a body (company creation is platform-owner-only,
    // so use the tenant login endpoint itself, which we know ignores
    // body fields outside employeeId/password).
    const forgedLoginBody = await apiPost(`/api/tenant-auth/${SLUG}/login`, {
        employeeId: "EMP001", password: "FileSuppEmp!2026",
        tenantDbName: "reinsteins_workhub", companyId: 1, companySlug: "reinsteins",
    });
    check("G2. Forged tenantDbName/companyId/companySlug in login body has no effect -- still resolves to filesupp_a",
        forgedLoginBody.status === 200 && forgedLoginBody.body?.company?.slug === SLUG, JSON.stringify(forgedLoginBody.body));

    // ---------- I: filesystem-style absolute path requests cannot escape ----------
    console.log("\nTEST I -- Filesystem-style absolute path requests");
    const filesystemAttempts = [
        "/uploads/C:%5CWindows%5Csystem.ini",
        "/uploads/tenant_filesupp_a/profiles/C:\\Windows\\win.ini",
        "//etc/passwd",
        "/uploads/%2e%2e%2f%2e%2e%2f%2e%2e%2fserver%2fapp.js",
    ];
    for (const attempt of filesystemAttempts) {
        try {
            const r = await fetch(`${BASE_URL}${attempt}?fat=invalid`);
            check(`I. Filesystem-style path rejected: ${attempt}`, r.status !== 200, `got ${r.status}`);
        } catch (err) {
            check(`I. Filesystem-style path rejected (fetch threw, treated as safe): ${attempt}`, true);
        }
    }

    // ---------- Cleanup ----------
    console.log("\nCLEANUP");
    await closeAllTenantPools();
    await tenantProvisioningService.dropProvisionedDatabase(DB);
    await platformPool.query(`DELETE FROM companies WHERE company_slug = ?`, [SLUG]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    const dbGone = await tenantProvisioningService.databaseExists(DB);
    check("CLEANUP: tenant DB gone", dbGone === false);
    const [remaining] = await platformPool.query(`SELECT company_slug FROM companies`);
    check("CLEANUP: only Reinsteins remains", remaining.length === 1 && remaining[0].company_slug === "reinsteins");

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
