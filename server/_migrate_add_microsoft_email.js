// Explicit, cwd-independent path -- same reason as every other _migrate_*.js (unattended deploy run).
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const fs = require("fs");
const path = require("path");

// ==========================================
// ADD THE MICROSOFT 365 COMPANY-EMAIL TABLES (PLATFORM DB)
//
// Applies server/schemas/emailMicrosoftSchema.postgresql.sql, which is additive only: new tables, three new
// columns on mailboxes, one on email_domains, and guarded constraints. It never drops, truncates, renames or
// rewrites anything, never reads a row, and never touches a tenant database. Idempotent: every statement is
// CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / pg_constraint-guarded, so re-running changes nothing.
//
// Prerequisite: the earlier email platform tables (email_domains, mailboxes) must exist. In the deploy this
// script runs AFTER _migrate_add_email_platform_tables.js; if they are missing it stops with a clear message
// instead of creating a half schema.
//
// Applied through the raw driver (platformPool.nativePool): the DO $$ ... END $$ guards contain semicolons.
// Exit code 0 on success (or nothing to do), 1 on any failure, so `set -e` in the deploy stops before the
// build/restart steps.
// ==========================================

const SCHEMA_PATH = path.join(__dirname, "schemas", "emailMicrosoftSchema.postgresql.sql");

const NEW_TABLES = [
    "email_ms_company_connections",
    "email_ms_oauth_states",
    "email_ms_user_connections",
    "email_ms_user_settings",
    "email_audit_log",
];

const NEW_COLUMNS = [
    ["email_domains", "mail_hosting"],
    ["mailboxes", "provider"],
    ["mailboxes", "link_state"],
    ["mailboxes", "linked_at"],
];

async function tableExists(pool, name) {
    const [rows] = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ? LIMIT 1`,
        [name]
    );
    return rows.length > 0;
}

async function columnExists(pool, table, column) {
    const [rows] = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ? AND column_name = ? LIMIT 1`,
        [table, column]
    );
    return rows.length > 0;
}

// `pool` is injectable so the migration can be verified against a disposable database; the default is the platform pool.
async function run(pool = require("./config/platformDb"), { dryRun = false, log = console.log } = {}) {
    log("Add Microsoft 365 email tables -- checking platform database...\n");

    for (const required of ["companies", "email_domains", "mailboxes"]) {
        if (!(await tableExists(pool, required))) {
            throw new Error(
                `Required table "${required}" is missing. Run _migrate_add_email_platform_tables.js first (the deploy does this).`
            );
        }
    }

    const missingTables = [];
    for (const table of NEW_TABLES) {
        if (!(await tableExists(pool, table))) missingTables.push(table);
    }
    const missingColumns = [];
    for (const [table, column] of NEW_COLUMNS) {
        if (!(await columnExists(pool, table, column))) missingColumns.push(`${table}.${column}`);
    }

    log("  Missing tables :", missingTables.length ? missingTables.join(", ") : "none");
    log("  Missing columns:", missingColumns.length ? missingColumns.join(", ") : "none");

    if (dryRun) {
        log("\n  [dry-run] nothing applied.");
        return { applied: false, missingTables, missingColumns };
    }

    // Always applied: the statements are idempotent, and this also repairs a half-applied earlier run.
    const sql = fs.readFileSync(SCHEMA_PATH, "utf8");
    const executor = pool.nativePool || pool;
    await executor.query(sql);

    for (const table of NEW_TABLES) {
        if (!(await tableExists(pool, table))) throw new Error(`Migration did not create expected table "${table}".`);
    }
    for (const [table, column] of NEW_COLUMNS) {
        if (!(await columnExists(pool, table, column))) throw new Error(`Migration did not add expected column "${table}.${column}".`);
    }

    log("  [done] Microsoft 365 email tables and columns present");
    return { applied: true, missingTables, missingColumns };
}

if (require.main === module) {
    const pool = require("./config/platformDb");
    run(pool, { dryRun: process.argv.includes("--dry-run") })
        .then(async () => {
            await pool.end();
            console.log("\nMigration completed.");
            process.exit(0);
        })
        .catch((error) => {
            console.error("MIGRATION SCRIPT ERROR:", error.message);
            process.exit(1);
        });
}

module.exports = { run, SCHEMA_PATH, NEW_TABLES, NEW_COLUMNS };
