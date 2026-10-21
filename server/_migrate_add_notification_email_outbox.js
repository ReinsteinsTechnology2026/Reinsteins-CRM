// Explicit, cwd-independent path (same as the other migrations run by the deploy
// workflow). This script is started as `node server/_migrate_....js` from the
// repository root, where dotenv's no-argument default finds no .env file.
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

// Fail closed: without database settings the pg client silently falls back to its
// own defaults (local socket / OS user), i.e. possibly the wrong database.
for (const name of ["DB_HOST", "DB_NAME", "PLATFORM_DB_HOST", "PLATFORM_DB_NAME"]) {
    if (!process.env[name]) {
        console.error(`Refusing to run: ${name} is not set (server/.env not loaded?). Nothing was changed.`);
        process.exit(1);
    }
}

const legacyPool = require("./config/db").__legacyPool;
const platformPool = require("./config/platformDb");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { schema, dueIndexSql, listOutboxTargets } = require("./services/notificationEmailOutbox");

// ==========================================
// TECHOPS EMAIL NOTIFICATION OUTBOX -- SCHEMA MIGRATION
//
// server/schemas/tenantSchema.postgresql.sql already includes
// notification_email_outbox for every NEWLY provisioned tenant. This is
// the one-off companion for the legacy (reinsteins) database and tenants
// provisioned earlier -- same pattern as _migrate_add_sops.js.
//
// MUST be applied before assignment/mention emails can be queued. The app
// never creates the table itself; without it the in-app notification is
// still created, the email is not queued, and an error is logged.
//
// Idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS), additive
// only. Run by .github/workflows/deploy.yml before the restart step (never at
// application startup). It keeps going after a failing database so every
// reachable one is migrated, then exits 1 if ANY database failed -- under the
// workflow's `set -e` that stops the deploy before the build/restart steps.
// ==========================================

async function migrate(label, db) {
    await db.query(schema);
    await db.query(dueIndexSql);

    // Do not trust the DDL alone: confirm the table and the due index really exist
    // in THIS database before reporting it as done.
    const [[found]] = await db.query(
        `SELECT to_regclass('notification_email_outbox') AS tbl,
                (SELECT count(*) FROM pg_indexes
                 WHERE tablename = 'notification_email_outbox'
                   AND indexname = 'idx_notification_email_outbox_due') AS idx`
    );
    if (!found.tbl || Number(found.idx) !== 1) {
        throw new Error("verification failed: outbox table or due index missing after migration");
    }
    console.log(`  [done] ${label}`);
}

(async () => {
    console.log("Notification email outbox migration...");
    console.log("");
    let failures = 0;

    // Legacy database + every registered tenant database (any status, no slug
    // excluded), de-duplicated by the identity the database server reports.
    const targets = await listOutboxTargets({
        platformPool, legacyPool, activeOnly: false,
        resolveTenantPool: (company) => getTenantPool(company.tenant_db_name),
    });

    for (const target of targets) {
        const label = target.kind === "legacy"
            ? "legacy database (reinsteins)"
            : `${target.label}`;
        if (target.duplicateOf) {
            console.log(`  [skip] ${label} is the same database as ${target.duplicateOf}`);
            continue;
        }
        try {
            if (target.error) throw target.error;
            await migrate(target.kind === "legacy" ? label : `${target.label}`, target.db);
        } catch (error) {
            failures++;
            console.error(`  [FAILED] ${target.kind === "legacy" ? "legacy database" : target.label}:`, error.message);
        }
    }

    await closeAllTenantPools();
    await platformPool.end();
    console.log("");
    console.log(failures === 0 ? "All databases migrated." : `${failures} database(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((error) => { console.error("MIGRATION SCRIPT ERROR:", error.message); process.exit(1); });
