require("dotenv").config();

const {
    provisionTenantDatabase,
    databaseExists,
    compareTenantSchema,
    getRowCounts,
    dropProvisionedDatabase,
} = require("./services/tenantProvisioningService");
const { isValidTenantDbName } = require("./utils/tenantDbName");

// ==========================================
// TENANT PROVISIONING SELF-TEST (Phase 2C)
//
// Exercises the REAL provisionTenantDatabase() exactly as production
// code will eventually call it -- against a database name that is
// itself a legitimate tenant_* name (so the test is realistic), but
// whose slug ("zzz_provisioning_test") can never collide with a real
// company and is unmistakably a throwaway.
//
// Touches ONLY:
//   - the throwaway database this script creates and then drops
//   - read-only SELECTs against reinsteins_workhub (DB_NAME), for
//     schema comparison and before/after verification
//
// Never writes to, alters, or drops reinsteins_workhub. Safe to
// re-run at any time.
//
//   node _test_tenant_provisioning.js
// ==========================================

const TEST_DB_NAME = "tenant_zzz_provisioning_test";

let failures = 0;

function check(label, condition, detail) {
    if (condition) {
        console.log(`  [PASS] ${label}`);
    } else {
        failures++;
        console.log(`  [FAIL] ${label}${detail ? " -- " + detail : ""}`);
    }
}

(async () => {
    // --- Explicit safety guard, before anything else ---
    if (
        !isValidTenantDbName(TEST_DB_NAME) ||
        TEST_DB_NAME === process.env.DB_NAME ||
        TEST_DB_NAME === process.env.PLATFORM_DB_NAME
    ) {
        console.error(`Refusing to run: "${TEST_DB_NAME}" failed the pre-flight safety guard.`);
        process.exit(1);
    }

    console.log(`Test database: ${TEST_DB_NAME}`);
    console.log(`Source (tenant) database: ${process.env.DB_NAME}\n`);

    // --- 0. Baseline: source DB before we do anything ---
    console.log("STEP 0 -- Baseline source verification");
    const mysql = require("mysql2/promise");
    const sourceConn = await mysql.createConnection({
        host: process.env.DB_HOST, port: process.env.DB_PORT,
        user: process.env.DB_USER, password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });
    const [[{ tblCountBefore }]] = await sourceConn.query(
        `SELECT COUNT(*) AS tblCountBefore FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
        [process.env.DB_NAME]
    );
    const [[{ userCountBefore }]] = await sourceConn.query(`SELECT COUNT(*) AS userCountBefore FROM users`);
    console.log(`  reinsteins_workhub: ${tblCountBefore} tables, ${userCountBefore} users\n`);

    // --- 1. Reject invalid / malicious names outright ---
    console.log("STEP 1 -- Invalid database name rejection");
    const badNames = [
        "reinsteins_workhub",              // protected
        "reinsteins_db",                    // protected (future name)
        "tenant_x`; DROP TABLE users; --",  // injection attempt
        "TENANT_UPPERCASE",                 // wrong case
        "tenant_ has spaces",               // spaces
        "not_prefixed",                     // missing tenant_ prefix
        "mysql",                            // system schema
    ];
    for (const name of badNames) {
        const result = await provisionTenantDatabase({ databaseName: name });
        check(`rejected "${name}"`, result.success === false && result.code !== undefined);
    }
    console.log("");

    // --- 2. Pre-clean in case a previous crashed run left it behind ---
    if (await databaseExists(TEST_DB_NAME)) {
        console.log(`STEP 2 -- Pre-existing leftover test DB found, dropping it first`);
        await dropProvisionedDatabase(TEST_DB_NAME);
    }

    // --- 3. Rollback/failure-path test: deliberately broken schema ---
    console.log("STEP 3 -- Failure/rollback path (deliberately broken statement)");
    const brokenStatements = [
        "CREATE TABLE `tenant_test_ok` (`id` int unsigned NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`)) ENGINE=InnoDB",
        "CREATE TABLE this is not valid sql at all",
    ];
    const failResult = await provisionTenantDatabase({
        databaseName: TEST_DB_NAME,
        _schemaStatementsForTesting: brokenStatements,
    });
    check("provisioning reported failure", failResult.success === false);
    check("failure was marked rolledBack", failResult.rolledBack === true);
    const existsAfterFailure = await databaseExists(TEST_DB_NAME);
    check("partially-created database was actually dropped", existsAfterFailure === false,
        `databaseExists() returned ${existsAfterFailure}`);
    console.log("");

    // --- 4. Real provisioning run ---
    console.log("STEP 4 -- Real provisioning run (full canonical schema)");
    const result = await provisionTenantDatabase({ databaseName: TEST_DB_NAME });
    check("provisioning succeeded", result.success === true, JSON.stringify(result));
    if (!result.success) {
        console.error("Cannot continue -- aborting remaining steps.");
        await sourceConn.end();
        process.exit(1);
    }
    console.log(`  Created "${TEST_DB_NAME}" with ${result.tableCount} tables.\n`);

    // --- 5. Idempotency: second call must not overwrite ---
    console.log("STEP 5 -- Idempotency (re-provisioning an existing tenant DB)");
    const secondAttempt = await provisionTenantDatabase({ databaseName: TEST_DB_NAME });
    check("second call refused, did not overwrite", secondAttempt.success === false && secondAttempt.code === "ALREADY_EXISTS");
    console.log("");

    // --- 6. Structural comparison against the live source schema ---
    console.log("STEP 6 -- Schema comparison vs. reinsteins_workhub");
    const comparison = await compareTenantSchema(process.env.DB_NAME, TEST_DB_NAME);
    check("table names match exactly", comparison.tableNamesMatch,
        `missing=${JSON.stringify(comparison.missingInTarget)} unexpected=${JSON.stringify(comparison.unexpectedInTarget)}`);
    check("table count matches", comparison.sourceTableCount === comparison.targetTableCount,
        `source=${comparison.sourceTableCount} target=${comparison.targetTableCount}`);
    check("foreign key count matches", comparison.foreignKeysMatch,
        `source=${comparison.sourceForeignKeyCount} target=${comparison.targetForeignKeyCount}`);
    check("index count matches", comparison.indexesMatch,
        `source=${comparison.sourceIndexCount} target=${comparison.targetIndexCount}`);
    console.log("");

    // --- 7. No business data present ---
    console.log("STEP 7 -- Verify no Reinsteins business data exists in the new tenant DB");
    const rowCounts = await getRowCounts(TEST_DB_NAME);
    const nonEmptyTables = Object.entries(rowCounts).filter(([, c]) => c > 0);
    check("every table in the new tenant DB is empty", nonEmptyTables.length === 0,
        JSON.stringify(nonEmptyTables));
    console.log("");

    // --- 8. Explicit safety guard before dropping ---
    console.log("STEP 8 -- Safe teardown of the temporary database");
    if (TEST_DB_NAME !== "tenant_zzz_provisioning_test") {
        console.error("Safety guard tripped: TEST_DB_NAME was mutated unexpectedly. Aborting drop.");
        process.exit(1);
    }
    if (TEST_DB_NAME === process.env.DB_NAME || TEST_DB_NAME === process.env.PLATFORM_DB_NAME) {
        console.error("Safety guard tripped: TEST_DB_NAME matches a live configured database. Aborting drop.");
        process.exit(1);
    }
    const dropResult = await dropProvisionedDatabase(TEST_DB_NAME);
    check("temporary database dropped", dropResult.dropped === true);
    const stillExists = await databaseExists(TEST_DB_NAME);
    check("temporary database confirmed gone", stillExists === false);
    console.log("");

    // --- 9. Re-verify source DB completely unaffected ---
    console.log("STEP 9 -- Post-test source verification");
    const [[{ tblCountAfter }]] = await sourceConn.query(
        `SELECT COUNT(*) AS tblCountAfter FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
        [process.env.DB_NAME]
    );
    const [[{ userCountAfter }]] = await sourceConn.query(`SELECT COUNT(*) AS userCountAfter FROM users`);
    check("reinsteins_workhub table count unchanged", tblCountAfter === tblCountBefore,
        `before=${tblCountBefore} after=${tblCountAfter}`);
    check("reinsteins_workhub user count unchanged", userCountAfter === userCountBefore,
        `before=${userCountBefore} after=${userCountAfter}`);

    await sourceConn.end();

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
})();
