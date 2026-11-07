// Explicit, cwd-independent path (same reason as the other _migrate_*.js scripts): this runs as
// `node server/_migrate_add_ziovault.js` from the repo root during an unattended deploy.
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const { ZIOVAULT_MIGRATION_STATEMENTS, ZIOVAULT_TABLES, ZIOVAULT_REQUIRED_USER_COLUMNS } = require("./schemas/ziovaultDdl");

// ==========================================
// ADD ZIOVAULT TABLES, FUNCTIONS AND TRIGGERS to the legacy database and EVERY registered tenant database.
//
// tenantSchema.postgresql.sql already contains them, so every NEWLY provisioned tenant has them. This script is the companion
// for databases that existed before the feature.
//
// Safe to run any number of times: tables/indexes are CREATE ... IF NOT EXISTS, functions are CREATE OR REPLACE, a trigger is
// dropped and re-created. It never drops or alters an existing table, never reads or writes user data, and each database is
// processed in ONE transaction (PostgreSQL DDL is transactional), so a failure leaves that database exactly as it was. A
// transaction-scoped advisory lock stops two overlapping runs from racing.
//
// Preflight: the offboarding trigger needs users.status and users.employment_status. A database that lacks them is NOT
// changed and the run fails with a clear message (deploy.yml stops before the restart) -- the trigger is never silently skipped.
//
// A legacy database that does not exist (PostgreSQL 3D000) is skipped; any other failure, including an unreachable registered
// tenant database, exits non-zero. `--dry-run` only reports what would be created.
// ==========================================

// Arbitrary constant, namespaced away from the other migrations' advisory-lock keys.
const ZIOVAULT_MIGRATION_LOCK_KEY = 7310441208;

async function existingTables(queryable) {
    const [rows] = await queryable.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY(?)`,
        [ZIOVAULT_TABLES]
    );
    return new Set(rows.map((row) => row.table_name));
}

async function missingUserColumns(queryable) {
    const [rows] = await queryable.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = ANY(?)`,
        [ZIOVAULT_REQUIRED_USER_COLUMNS]
    );
    const present = new Set(rows.map((row) => row.column_name));
    return ZIOVAULT_REQUIRED_USER_COLUMNS.filter((name) => !present.has(name));
}

async function migrateDatabase(label, pool, { dryRun = false } = {}) {
    const missingColumns = await missingUserColumns(pool);
    if (missingColumns.length > 0) {
        throw new Error(`users table lacks column(s) ${missingColumns.join(", ")}; the offboarding trigger cannot be installed, nothing was changed`);
    }

    const before = await existingTables(pool);
    const missing = ZIOVAULT_TABLES.filter((name) => !before.has(name));

    if (dryRun) {
        console.log(`  [dry-run] ${label} -- would create: ${missing.length ? missing.join(", ") : "nothing (all tables exist; functions and triggers would be refreshed)"}`);
        return { label, action: "dry-run", missing };
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        await connection.query("SELECT pg_advisory_xact_lock(?)", [ZIOVAULT_MIGRATION_LOCK_KEY]);

        for (const statement of ZIOVAULT_MIGRATION_STATEMENTS) {
            await connection.query(statement);
        }

        await connection.commit();
    } catch (error) {
        try {
            await connection.rollback();
        } catch (_rollbackError) {
            // The original error is the one worth reporting.
        }
        throw error;
    } finally {
        connection.release();
    }

    console.log(
        missing.length
            ? `  [migrated] ${label} -- created: ${missing.join(", ")}`
            : `  [skip] ${label} -- ziovault tables already exist (functions and triggers refreshed)`
    );
    return { label, action: missing.length ? "migrated" : "skipped", missing };
}

// PostgreSQL "invalid_catalog_name": the database itself does not exist.
const isMissingDatabaseError = (error) => Boolean(error) && error.code === "3D000";

async function runTargets(targets, { dryRun = false } = {}) {
    let failures = 0;
    let skipped = 0;

    for (const target of targets) {
        try {
            await migrateDatabase(target.label, target.getPool(), { dryRun });
        } catch (error) {
            if (target.skipIfMissing && isMissingDatabaseError(error)) {
                skipped += 1;
                console.log(`  [skip] ${target.label} -- the database does not exist (nothing to migrate)`);
                continue;
            }

            failures += 1;
            console.error(`  [FAILED] ${target.label}: ${error.message}`);
        }
    }

    return { failures, skipped };
}

async function main() {
    const dryRun = process.argv.includes("--dry-run");
    const { buildTargets } = require("./_migrate_add_smart_sheets");

    const platformPool = require("./config/platformDb");
    const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
    const legacyPool = require("./config/db").__legacyPool;

    console.log(`ZioVault tables migration${dryRun ? " (DRY RUN -- nothing is written)" : ""}\n`);

    const [companies] = await platformPool.query(
        `SELECT company_slug, tenant_db_name FROM companies WHERE tenant_db_name IS NOT NULL AND tenant_db_name <> '' ORDER BY id`
    );

    const { targets, notices } = buildTargets({ legacyPool, legacyDbName: process.env.DB_NAME, companies, getTenantPool });

    notices.forEach((line) => console.log(line));

    const { failures } = await runTargets(targets, { dryRun });

    await closeAllTenantPools();
    await legacyPool.end();
    await platformPool.end();

    console.log(`\n${failures === 0 ? "Done." : `${failures} database(s) failed -- see errors above.`}`);
    process.exit(failures === 0 ? 0 : 1);
}

if (require.main === module) {
    main().catch((error) => {
        console.error("MIGRATION SCRIPT ERROR:", error.message);
        process.exit(1);
    });
}

module.exports = { migrateDatabase, runTargets, isMissingDatabaseError, missingUserColumns, ZIOVAULT_MIGRATION_LOCK_KEY };
