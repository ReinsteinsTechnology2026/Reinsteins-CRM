require("dotenv").config();

// ==========================================
// EMPLOYEE CREATION -- OPTIONAL COMPANY EMAIL DOMAIN REGRESSION TEST
//
// Reproduces the production bug where "Create Employee" failed with a
// generic 500 whenever the optional company-email-domain lookup
// (server/services/emailDomainService.js -> email_domains, a
// PLATFORM-level table) could not be read -- e.g. because the Phase
// 16A migration (server/_setup_platform_db.js) had not yet been run
// against this environment. That lookup is supposed to be entirely
// optional (see employeeController.js's own comments and the Add
// Employee form's "This employee can still log in with their
// Employee ID" copy), but createEmployee had no error boundary around
// it, so ANY failure there -- not just the normal "no domain
// registered yet" case -- aborted employee creation outright.
//
// This test never touches a real database or network -- it mocks
// ../config/db (tenant pool) with a tiny in-memory "users" table and
// ../config/platformDb (platform pool) to control exactly what
// emailDomainService.listDomainsForCompany() sees, then calls the
// real createEmployee controller function directly for two cases:
//
//   Case A: a verified, active domain exists -> employee is created
//           AND a company email is auto-generated from it.
//   Case B: the domain lookup itself throws (simulating the missing
//           email_domains table / any other infra failure) -> employee
//           creation must still succeed, with a null company email,
//           exactly like the already-correct "no domain registered"
//           path.
//
//   node _test_employee_creation_domain_fallback.js
// ==========================================

const path = require("path");

let failures = 0;
function check(label, condition, detail) {
    if (condition) console.log(`  [PASS] ${label}`);
    else { failures++; console.log(`  [FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

// ------------------------------------------
// Fake tenant pool (../config/db) -- an in-memory "users" table just
// large enough for createEmployee's own queries to work against.
// ------------------------------------------

function makeFakeTenantPool() {

    const users = []; // { id, employee_id, email, ... }
    let nextId = 1;

    async function query(sql, params = []) {

        const normalized = sql.replace(/\s+/g, " ").trim();

        // generateNextIdentifier: SELECT employee_id FROM users WHERE employee_id ~ ...
        if (/SELECT employee_id\s+FROM users\s+WHERE employee_id ~/i.test(normalized)) {
            const prefixPattern = params[0]; // e.g. "^RS[0-9]+$"
            const prefix = prefixPattern.replace(/^\^/, "").replace(/\[0-9\]\+\$$/, "");
            const matching = users
                .map((u) => u.employee_id)
                .filter((id) => id.startsWith(prefix) && new RegExp(prefixPattern).test(id));
            matching.sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
            const rows = matching.length > 0 ? [{ employee_id: matching[0] }] : [];
            rows.affectedRows = rows.length;
            rows.insertId = undefined;
            return [rows, undefined];
        }

        // generateUniqueCompanyEmail: SELECT id FROM users WHERE LOWER(email) = ?
        if (/SELECT id\s+FROM users\s+WHERE LOWER\(email\) = \?/i.test(normalized)) {
            const candidate = params[0];
            const match = users.find((u) => (u.email || "").toLowerCase() === candidate);
            const rows = match ? [{ id: match.id }] : [];
            rows.affectedRows = rows.length;
            rows.insertId = undefined;
            return [rows, undefined];
        }

        // createEmployee's main INSERT
        if (/INSERT INTO users/i.test(normalized)) {
            const [
                employeeId, fullName, email, designation, hashedPassword,
                employmentType, joiningDate, internshipEndDate, mentorId,
                stipend, departmentId, reportingManagerId, systemAccess,
            ] = params;

            const row = {
                id: nextId++,
                employee_id: employeeId,
                full_name: fullName,
                email,
                designation,
                employment_type: employmentType,
            };

            users.push(row);

            const rows = [{ id: row.id }];
            rows.affectedRows = 1;
            rows.insertId = row.id;
            return [rows, undefined];
        }

        // Post-insert UPDATE joining_date
        if (/UPDATE users SET joining_date/i.test(normalized)) {
            const rows = [];
            rows.affectedRows = 1;
            rows.insertId = undefined;
            return [rows, undefined];
        }

        // employment_history INSERT
        if (/INSERT INTO employment_history/i.test(normalized)) {
            const rows = [];
            rows.affectedRows = 1;
            rows.insertId = undefined;
            return [rows, undefined];
        }

        throw new Error(`Fake tenant pool got an unexpected query: ${normalized}`);
    }

    return {
        query,
        getConnection: async () => {
            throw new Error("Fake tenant pool: getConnection() not needed for createEmployee");
        },
        __getCurrentCompanySlug: () => "faketest",
        __runWithTenantContext: (_ctx, fn) => fn(),
        __legacyPool: null,
        __LEGACY_COMPANY_SLUG: "reinsteins",
        on: () => {},
    };
}

// ------------------------------------------
// Fake platform pool (../config/platformDb) -- controls exactly what
// emailDomainService.listDomainsForCompany() sees.
// ------------------------------------------

function makeFakePlatformPool(mode) {
    return {
        query: async (sql) => {
            if (/FROM email_domains/i.test(sql)) {
                if (mode === "verified-domain") {
                    const rows = [{
                        id: 1,
                        company_id: 42,
                        domain: "fallbacktest.example",
                        verification_status: "verified",
                        status: "active",
                    }];
                    rows.affectedRows = 1;
                    rows.insertId = undefined;
                    return [rows, undefined];
                }

                if (mode === "table-missing") {
                    // Mirrors a real node-postgres error for a genuinely
                    // missing relation (e.g. the Phase 16A migration
                    // never having been run against this environment).
                    const err = new Error('relation "email_domains" does not exist');
                    err.code = "42P01";
                    throw err;
                }
            }

            throw new Error(`Fake platform pool got an unexpected query: ${sql}`);
        },
        on: () => {},
    };
}

// ------------------------------------------
// Load employeeController fresh, with ../config/db and
// ../config/platformDb pre-seeded in the module cache so every
// transitive require() of them (organizationService,
// accessMiddleware, tenantUploadPath, emailDomainService, ...)
// resolves to our fakes instead of opening a real connection.
// ------------------------------------------

function loadControllerWithMocks(platformMode) {

    for (const key of Object.keys(require.cache)) {
        if (key.includes(`${path.sep}server${path.sep}`) || key.startsWith(__dirname)) {
            delete require.cache[key];
        }
    }

    const dbPath = require.resolve("./config/db");
    const platformDbPath = require.resolve("./config/platformDb");

    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: makeFakeTenantPool() };
    require.cache[platformDbPath] = { id: platformDbPath, filename: platformDbPath, loaded: true, exports: makeFakePlatformPool(platformMode) };

    return require("./controllers/employeeController");
}

function makeReqRes(body, tenantCompanyId = 42) {
    const req = {
        body,
        tenantCompany: tenantCompanyId ? { id: tenantCompanyId } : undefined,
        userAccess: { systemAccess: "admin" },
    };

    const res = {
        statusCode: null,
        payload: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; },
    };

    return { req, res };
}

(async () => {

    // ---------- Case A: verified domain exists -> email auto-generated ----------
    console.log("TEST -- Case A: verified email domain exists");

    const { createEmployee: createEmployeeA } = loadControllerWithMocks("verified-domain");
    const { req: reqA, res: resA } = makeReqRes({
        fullName: "Case A Person",
        designation: "Engineer",
        password: "Passw0rd!A",
    });

    await createEmployeeA(reqA, resA);

    check("Case A: employee created -> 201", resA.statusCode === 201, JSON.stringify(resA.payload));
    check(
        "Case A: company email generated from the verified domain",
        resA.payload?.email === "caseaperson@fallbacktest.example" && resA.payload?.emailGenerated === true,
        JSON.stringify(resA.payload)
    );
    check("Case A: employee ID still generated", resA.payload?.employeeId === "RS001", JSON.stringify(resA.payload));

    // ---------- Case B: domain lookup throws (e.g. table missing) -> must still succeed ----------
    console.log("\nTEST -- Case B: email-domain lookup fails (e.g. email_domains table missing)");

    const { createEmployee: createEmployeeB } = loadControllerWithMocks("table-missing");
    const { req: reqB, res: resB } = makeReqRes({
        fullName: "Case B Person",
        designation: "Engineer",
        password: "Passw0rd!B",
    });

    await createEmployeeB(reqB, resB);

    check(
        "Case B: employee creation still succeeds -> 201 (this was the production bug: it returned 500)",
        resB.statusCode === 201,
        JSON.stringify(resB.payload)
    );
    check(
        "Case B: company email is null, emailGenerated: false (never a fake/guessed domain)",
        resB.payload?.email === null && resB.payload?.emailGenerated === false,
        JSON.stringify(resB.payload)
    );
    check("Case B: employee still receives an Employee ID", !!resB.payload?.employeeId, JSON.stringify(resB.payload));
    check("Case B: response still reports success", resB.payload?.success === true, JSON.stringify(resB.payload));

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);

})().catch((err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
