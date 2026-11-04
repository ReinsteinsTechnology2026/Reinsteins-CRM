// Explicit, cwd-independent path -- same reason as the other _migrate_*.js scripts (unattended deploy-pipeline run).
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const platformPool = require("./config/platformDb");
const { COMPANY_FEATURES_DDL } = require("./schemas/companyFeaturesDdl");
const { FEATURE_IDS } = require("./config/tenantFeatures");

// ==========================================
// ADD company_features (PLATFORM DB) and give every EXISTING company every module
//
// Tenant feature selection (config/tenantFeatures.js) starts gating modules the moment the new code runs. A company
// that existed before then must not lose anything, so this script:
//   1. creates the table (CREATE TABLE IF NOT EXISTS + a guarded foreign key), and
//   2. for every company that has NO company_features rows yet, inserts one row per catalog feature with enabled = TRUE.
//
// Idempotent and safe to repeat: step 2 only touches companies with no rows at all, so re-running it never re-enables a
// feature the Owner later switched off, and never changes a company that was already configured. Nothing is read from or
// written to any tenant database, and no existing row of any other table is modified.
// ==========================================

async function tableExists(pool, name) {
    const [rows] = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ? LIMIT 1`,
        [name]
    );
    return rows.length > 0;
}

async function backfillExistingCompanies(pool) {
    const [companies] = await pool.query(
        `SELECT c.id FROM companies c
         WHERE NOT EXISTS (SELECT 1 FROM company_features f WHERE f.company_id = c.id)
         ORDER BY c.id`
    );
    for (const company of companies) {
        for (const featureId of FEATURE_IDS) {
            await pool.query(
                `INSERT INTO company_features (company_id, feature_id, enabled) VALUES (?, ?, TRUE)
                 ON CONFLICT (company_id, feature_id) DO NOTHING`,
                [company.id, featureId]
            );
        }
    }
    return companies.length;
}

// `pool`: any platform-database pool (the application's in the real run, a disposable database's in tests).
async function migrate(pool) {
    const existed = await tableExists(pool, "company_features");
    // Simple query protocol: the DO $$ ... END $$ block contains semicolons of its own.
    await pool.nativePool.query(COMPANY_FEATURES_DDL);
    const backfilled = await backfillExistingCompanies(pool);
    return { existed, backfilled };
}

async function run() {
    console.log("Add company_features -- checking platform database...\n");

    const { existed, backfilled } = await migrate(platformPool);
    console.log(existed ? "  [skip] company_features already exists" : "  [done] company_features created");
    console.log(`  [done] ${backfilled} existing company(ies) received every module (companies already configured were not touched)`);

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

module.exports = { run, migrate, backfillExistingCompanies };
