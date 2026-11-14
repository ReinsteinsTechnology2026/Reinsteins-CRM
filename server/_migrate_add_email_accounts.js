// Explicit, cwd-independent path -- same reason as every other _migrate_*.js (unattended deploy run).
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const fs = require("fs");
const path = require("path");

// ==========================================
// ADD THE EMAIL ACCOUNT TABLES (PLATFORM DB)
//
// Applies server/schemas/emailAccountsSchema.postgresql.sql: four NEW tables (email_accounts, email_account_oauth_states,
// email_push_subscriptions, email_new_mail_events). It alters no existing table, drops nothing, reads no row and never touches
// a tenant database. Idempotent: every statement is CREATE ... IF NOT EXISTS or guarded, so re-running changes nothing.
//
// Prerequisite: `companies` must exist (any provisioned platform database has it). Unlike the earlier company-mailbox migration,
// this one does NOT need email_domains / mailboxes: connecting a personal account needs no verified company domain.
//
// Applied through the raw driver (platformPool.nativePool): the DO $$ ... END $$ guards contain semicolons. Exit code 0 on success
// (or nothing to do), 1 on any failure, so `set -e` in the deploy stops before the build/restart steps.
// ==========================================

const SCHEMA_PATH = path.join(__dirname, "schemas", "emailAccountsSchema.postgresql.sql");
const NEW_TABLES = ["email_accounts", "email_account_oauth_states", "email_push_subscriptions", "email_new_mail_events"];

async function tableExists(pool, name) {
    const [rows] = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ? LIMIT 1`,
        [name]
    );
    return rows.length > 0;
}

// `pool` is injectable so the migration can be verified against a disposable database; the default is the platform pool.
async function run(pool = require("./config/platformDb"), { dryRun = false, log = console.log } = {}) {
    log("Add email account tables -- checking platform database...\n");

    if (!(await tableExists(pool, "companies"))) {
        throw new Error('Required table "companies" is missing: this is not a provisioned platform database.');
    }

    const missingTables = [];
    for (const table of NEW_TABLES) {
        if (!(await tableExists(pool, table))) missingTables.push(table);
    }
    log("  Missing tables:", missingTables.length ? missingTables.join(", ") : "none");

    if (dryRun) {
        log("\n  [dry-run] nothing applied.");
        return { applied: false, missingTables };
    }

    // Always applied: the statements are idempotent, and this also repairs a half-applied earlier run.
    const executor = pool.nativePool || pool;
    await executor.query(fs.readFileSync(SCHEMA_PATH, "utf8"));

    for (const table of NEW_TABLES) {
        if (!(await tableExists(pool, table))) throw new Error(`Migration did not create expected table "${table}".`);
    }
    log("  [done] email account tables present");
    return { applied: true, missingTables };
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

module.exports = { run, SCHEMA_PATH, NEW_TABLES };
