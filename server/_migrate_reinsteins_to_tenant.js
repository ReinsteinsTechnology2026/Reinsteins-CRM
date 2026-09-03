require("dotenv").config();
const mysql = require("mysql2/promise");

const tenantProvisioningService = require("./services/tenantProvisioningService");
const platformPool = require("./config/platformDb");
const { isValidTenantDbName } = require("./utils/tenantDbName");

// ==========================================
// REINSTEINS -> tenant_reinsteins MIGRATION
// (GrowOrgs Fast Completion Phase, Part 2)
//
// Copies Reinsteins Technology's data from the original
// reinsteins_workhub database into a new, real tenant database
// (tenant_reinsteins), WITHOUT modifying, renaming, or deleting
// reinsteins_workhub in any way. The source database remains the
// rollback point for as long as needed.
//
// This script does NOT switch the live application to
// tenant_reinsteins. It only:
//   1. verifies the source (read-only)
//   2. provisions tenant_reinsteins via the existing, safety-guarded
//      tenantProvisioningService (same mechanism as every other
//      tenant -- refuses to run if tenant_reinsteins already exists)
//   3. bulk-copies every row, preserving primary key values, via
//      server-side INSERT ... SELECT (both databases are on the same
//      MySQL server) -- not a row-by-row re-insert, so IDs and FK
//      relationships are preserved exactly as-is
//   4. fixes up AUTO_INCREMENT counters to continue after the
//      highest copied id in each table
//   5. verifies table count, row counts, and FK count match
//   6. updates ONLY groworgs_platform_db.companies.tenant_db_name for
//      the Reinsteins row (status/access_type untouched), guarded to
//      only fire if that row is still in its exact expected
//      pre-migration state
//
// Run with: node _migrate_reinsteins_to_tenant.js
// Safe to inspect before running -- makes no destructive changes to
// reinsteins_workhub at any point (only SELECT statements touch it).
// ==========================================

const SOURCE_DB = process.env.DB_NAME; // reinsteins_workhub
const TARGET_DB = "tenant_reinsteins";

async function run() {

    // ---------- Absolute safety guard ----------
    if (SOURCE_DB !== "reinsteins_workhub") {
        throw new Error(`Refusing to run: DB_NAME is "${SOURCE_DB}", expected "reinsteins_workhub".`);
    }
    if (!isValidTenantDbName(TARGET_DB) || TARGET_DB !== "tenant_reinsteins") {
        throw new Error(`Refusing to run: target database name failed validation.`);
    }
    if (TARGET_DB === SOURCE_DB) {
        throw new Error("Refusing to run: source and target must never be the same database.");
    }

    console.log(`Source (read-only): ${SOURCE_DB}`);
    console.log(`Target (new):       ${TARGET_DB}\n`);

    const adminConn = await mysql.createConnection({
        host: process.env.PLATFORM_DB_HOST,
        port: process.env.PLATFORM_DB_PORT,
        user: process.env.PLATFORM_DB_USER,
        password: process.env.PLATFORM_DB_PASSWORD,
    });

    // ---------- STEP 1: read-only source checkpoint ----------
    console.log("STEP 1 -- Source checkpoint (read-only)");
    const [tables] = await adminConn.query(
        `SELECT TABLE_NAME FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
        [SOURCE_DB]
    );
    console.log(`  ${tables.length} source tables found.`);

    const sourceRowCounts = {};
    for (const { TABLE_NAME } of tables) {
        const [[{ c }]] = await adminConn.query(`SELECT COUNT(*) AS c FROM \`${SOURCE_DB}\`.\`${TABLE_NAME}\``);
        sourceRowCounts[TABLE_NAME] = c;
    }
    const totalSourceRows = Object.values(sourceRowCounts).reduce((a, b) => a + b, 0);
    console.log(`  ${totalSourceRows} total rows across all tables.`);

    const [[{ fkCount: sourceFkCount }]] = await adminConn.query(
        `SELECT COUNT(*) AS fkCount FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [SOURCE_DB]
    );
    console.log(`  ${sourceFkCount} foreign keys.\n`);

    // ---------- STEP 2: provision tenant_reinsteins (refuses if it already exists) ----------
    console.log("STEP 2 -- Provisioning tenant_reinsteins via the existing safety-guarded provisioning system");
    const provisionResult = await tenantProvisioningService.provisionTenantDatabase({ databaseName: TARGET_DB });

    if (!provisionResult.success) {
        await adminConn.end();
        throw new Error(`Provisioning failed or refused: ${provisionResult.code} -- ${provisionResult.error}`);
    }
    console.log(`  Provisioned "${TARGET_DB}" with ${provisionResult.tableCount} empty tables.\n`);

    // ---------- STEP 3: bulk copy, preserving IDs ----------
    console.log("STEP 3 -- Copying all data (server-side INSERT...SELECT, FK checks off during copy)");
    await adminConn.query("SET FOREIGN_KEY_CHECKS=0");

    for (const { TABLE_NAME } of tables) {
        if (sourceRowCounts[TABLE_NAME] === 0) {
            console.log(`  ${TABLE_NAME}: 0 rows, skipped`);
            continue;
        }
        await adminConn.query(
            `INSERT INTO \`${TARGET_DB}\`.\`${TABLE_NAME}\` SELECT * FROM \`${SOURCE_DB}\`.\`${TABLE_NAME}\``
        );
        console.log(`  ${TABLE_NAME}: copied ${sourceRowCounts[TABLE_NAME]} rows`);
    }

    await adminConn.query("SET FOREIGN_KEY_CHECKS=1");
    console.log("");

    // ---------- STEP 4: fix up AUTO_INCREMENT counters ----------
    console.log("STEP 4 -- Fixing up AUTO_INCREMENT counters");
    const [autoIncCols] = await adminConn.query(
        `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND EXTRA = 'auto_increment'`,
        [TARGET_DB]
    );
    for (const { TABLE_NAME, COLUMN_NAME } of autoIncCols) {
        if (sourceRowCounts[TABLE_NAME] === 0) continue;
        const [[{ maxId }]] = await adminConn.query(
            `SELECT MAX(\`${COLUMN_NAME}\`) AS maxId FROM \`${TARGET_DB}\`.\`${TABLE_NAME}\``
        );
        if (maxId !== null) {
            await adminConn.query(`ALTER TABLE \`${TARGET_DB}\`.\`${TABLE_NAME}\` AUTO_INCREMENT = ?`, [maxId + 1]);
        }
    }
    console.log(`  Adjusted AUTO_INCREMENT on ${autoIncCols.length} tables.\n`);

    // ---------- STEP 5: verification ----------
    console.log("STEP 5 -- Verification");
    let allMatch = true;

    const [targetTables] = await adminConn.query(
        `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
        [TARGET_DB]
    );
    const tableCountMatch = targetTables.length === tables.length;
    console.log(`  Table count: source=${tables.length} target=${targetTables.length} ${tableCountMatch ? "MATCH" : "MISMATCH"}`);
    allMatch = allMatch && tableCountMatch;

    for (const { TABLE_NAME } of tables) {
        const [[{ c }]] = await adminConn.query(`SELECT COUNT(*) AS c FROM \`${TARGET_DB}\`.\`${TABLE_NAME}\``);
        const match = c === sourceRowCounts[TABLE_NAME];
        if (!match) {
            allMatch = false;
            console.log(`  [MISMATCH] ${TABLE_NAME}: source=${sourceRowCounts[TABLE_NAME]} target=${c}`);
        }
    }
    console.log(`  Row counts: ${allMatch ? "ALL MATCH" : "MISMATCH FOUND"}`);

    const [[{ fkCount: targetFkCount }]] = await adminConn.query(
        `SELECT COUNT(*) AS fkCount FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [TARGET_DB]
    );
    const fkMatch = targetFkCount === sourceFkCount;
    console.log(`  Foreign keys: source=${sourceFkCount} target=${targetFkCount} ${fkMatch ? "MATCH" : "MISMATCH"}`);
    allMatch = allMatch && fkMatch;

    // Representative data spot-check: users table, full byte-for-byte
    // comparison of every row's identifying + auth-relevant columns.
    const [sourceUsers] = await adminConn.query(
        `SELECT id, employee_id, email, password, role, system_access, status FROM \`${SOURCE_DB}\`.\`users\` ORDER BY id`
    );
    const [targetUsers] = await adminConn.query(
        `SELECT id, employee_id, email, password, role, system_access, status FROM \`${TARGET_DB}\`.\`users\` ORDER BY id`
    );
    const usersMatch = JSON.stringify(sourceUsers) === JSON.stringify(targetUsers);
    console.log(`  users table byte-for-byte match (${sourceUsers.length} rows, including password hashes): ${usersMatch ? "MATCH" : "MISMATCH"}`);
    allMatch = allMatch && usersMatch;

    if (!allMatch) {
        await adminConn.end();
        throw new Error("Verification failed -- see mismatches above. tenant_reinsteins was NOT linked to the platform metadata. reinsteins_workhub is unaffected.");
    }

    console.log("\nAll verification checks passed.\n");

    // ---------- STEP 6: platform metadata update (guarded) ----------
    console.log("STEP 6 -- Updating platform metadata (tenant_db_name only)");
    const [updateResult] = await platformPool.query(
        `UPDATE companies SET tenant_db_name = ?
         WHERE company_slug = 'reinsteins' AND status = 'active' AND tenant_db_name IS NULL`,
        [TARGET_DB]
    );

    if (updateResult.affectedRows === 1) {
        console.log(`  companies.tenant_db_name set to "${TARGET_DB}" for slug=reinsteins.`);
    } else {
        console.log(`  WARNING: guarded UPDATE affected ${updateResult.affectedRows} rows (expected 1) -- ` +
            `the Reinsteins row was not in the expected pre-migration state (active + tenant_db_name IS NULL). ` +
            `No metadata was changed. Data copy to ${TARGET_DB} is complete and verified regardless.`);
    }

    const [[finalRow]] = await platformPool.query(`SELECT status, access_type, tenant_db_name FROM companies WHERE company_slug = 'reinsteins'`);
    console.log(`  Final Reinsteins row: status=${finalRow.status}, access_type=${finalRow.access_type}, tenant_db_name=${finalRow.tenant_db_name}`);

    await adminConn.end();
    await platformPool.end();

    console.log("\nMIGRATION COMPLETE. reinsteins_workhub was not modified at any point (verified: only SELECT statements were issued against it).");
}

run().catch((err) => {
    console.error("\nMIGRATION FAILED:", err.message);
    console.error("reinsteins_workhub was not modified. If tenant_reinsteins was partially created, it can be safely dropped and this script re-run.");
    process.exit(1);
});
