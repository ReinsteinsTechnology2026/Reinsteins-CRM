// Explicit, cwd-independent path (same reason as the other _migrate_*.js scripts): this runs as
// `node server/_migrate_add_smart_sheets.js` from the repo root during an unattended deploy.
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const { SMART_SHEETS_MIGRATION_STATEMENTS, SMART_SHEETS_TABLES } = require("./schemas/smartSheetsDdl");

// ==========================================
// ADD SMART SHEETS TABLES (smart_sheets, smart_sheet_access, smart_sheet_worksheets,
// smart_sheet_cells) to the legacy database and EVERY registered tenant database.
//
// tenantSchema.postgresql.sql already contains these tables, so every NEWLY provisioned tenant has
// them. This script is the companion for databases that existed before the feature.
//
// Safe to run any number of times: every statement is CREATE ... IF NOT EXISTS. It only ever
// creates -- it never drops, truncates, alters or reads an existing table or row -- and each
// database is processed in ONE transaction (PostgreSQL DDL is transactional), so a failure leaves
// that database exactly as it was. A transaction-scoped advisory lock stops two overlapping runs
// from racing on CREATE TABLE. Reads/writes no user data.
//
// A legacy database that does not exist (PostgreSQL 3D000) is skipped; any other failure,
// including an unreachable registered tenant database, exits non-zero so deploy.yml (set -e) stops
// before the restart. `--dry-run` only reports what would be created.
// ==========================================

// Arbitrary constant, namespaced away from the other migrations' advisory-lock keys.
const SMART_SHEETS_MIGRATION_LOCK_KEY = 7310441207;

async function existingTables(queryable) {
    const [rows] = await queryable.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY(?)`,
        [SMART_SHEETS_TABLES]
    );
    return new Set(rows.map((row) => row.table_name));
}

async function migrateDatabase(label, pool, { dryRun = false } = {}) {
    const before = await existingTables(pool);
    const missing = SMART_SHEETS_TABLES.filter((name) => !before.has(name));

    if (dryRun) {
        console.log(`  [dry-run] ${label} -- would create: ${missing.length ? missing.join(", ") : "nothing (all tables exist)"}`);
        return { label, action: "dry-run", missing };
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        await connection.query("SELECT pg_advisory_xact_lock(?)", [SMART_SHEETS_MIGRATION_LOCK_KEY]);

        for (const statement of SMART_SHEETS_MIGRATION_STATEMENTS) {
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
            : `  [skip] ${label} -- smart sheet tables already exist`
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

function buildTargets({ legacyPool, legacyDbName, companies, getTenantPool }) {
    const targets = [];
    const notices = [];

    if (typeof legacyDbName === "string" && legacyDbName.trim()) {
        targets.push({ label: "legacy database", getPool: () => legacyPool, skipIfMissing: true });
    } else {
        notices.push("  [skip] legacy database -- DB_NAME is not set in server/.env (no legacy database is configured)");
    }

    for (const company of companies) {
        targets.push({
            label: `${company.company_slug} (${company.tenant_db_name})`,
            getPool: () => getTenantPool(company.tenant_db_name),
        });
    }

    return { targets, notices };
}

async function main() {
    const dryRun = process.argv.includes("--dry-run");

    const platformPool = require("./config/platformDb");
    const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
    const legacyPool = require("./config/db").__legacyPool;

    console.log(`Smart Sheets tables migration${dryRun ? " (DRY RUN -- nothing is written)" : ""}\n`);

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

module.exports = { migrateDatabase, runTargets, buildTargets, isMissingDatabaseError, SMART_SHEETS_MIGRATION_LOCK_KEY };
