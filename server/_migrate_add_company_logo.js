// Explicit, cwd-independent path -- same fix as
// _migrate_backfill_admin_group_permissions.js/_migrate_backfill_system_administrator.js/
// _migrate_add_shift_schedules.js (see their header comments for why
// this is needed for an unattended deploy-pipeline run).
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const platformPool = require("./config/platformDb");

// ==========================================
// ADD companies.logo_url (PLATFORM DB, one-off companion for an
// already-provisioned platform database)
//
// server/schemas/platformSchema.postgresql.sql already includes this
// column via a trailing ALTER TABLE ... ADD COLUMN IF NOT EXISTS,
// applied automatically to a brand-new platform database bootstrap
// (_setup_platform_db.js). This script is the equivalent one-off for
// the already-running production platform database, whose schema was
// bootstrapped before this column existed -- same reasoning as
// _migrate_add_shift_schedules.js / _migrate_add_techops_recycle_bin.js,
// just against groworgs_platform_db instead of a tenant database (the
// companies table lives in exactly one database, so there is no
// per-tenant loop here).
//
// Idempotent and safe to run more than once: checks
// information_schema.columns first, and PostgreSQL's own
// "ADD COLUMN IF NOT EXISTS" is itself idempotent besides. Never
// modifies, reads, or touches any existing row's data -- adding a
// nullable column with no default computation is a metadata-only
// operation.
// ==========================================

async function columnExists(pool, tableName, columnName) {
    const [rows] = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ? AND column_name = ? LIMIT 1`,
        [tableName, columnName]
    );
    return rows.length > 0;
}

async function run() {
    console.log("Add companies.logo_url -- checking platform database...\n");

    if (await columnExists(platformPool, "companies", "logo_url")) {
        console.log("  [skip] companies.logo_url already exists");
    } else {
        await platformPool.query(`ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "logo_url" varchar(255) DEFAULT NULL`);
        console.log("  [done] companies.logo_url added");
    }

    await platformPool.end();
    console.log("\nMigration completed.");
}

if (require.main === module) {
    run()
        .then(() => process.exit(0))
        .catch((error) => {
            console.error("MIGRATION SCRIPT ERROR:", error);
            process.exit(1);
        });
}

module.exports = { columnExists, run };
