require("dotenv").config();

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
// Idempotent (CREATE TABLE IF NOT EXISTS), additive only. Not run
// automatically.
// ==========================================

async function migrate(label, db) {
    await db.query(schema);
    await db.query(dueIndexSql);
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
