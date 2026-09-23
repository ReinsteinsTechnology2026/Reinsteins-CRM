// Explicit, cwd-independent path -- same fix as
// _migrate_backfill_admin_group_permissions.js/_migrate_add_shift_schedules.js/
// _migrate_add_company_logo.js (see their header comments for why this
// is needed for an unattended deploy-pipeline run).
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const platformPool = require("./config/platformDb");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");

// ==========================================
// ADD assigned_to / assigned_by TO epics / features / user_stories
// (per-tenant, one-off companion for tenants provisioned before this
// change)
//
// server/schemas/tenantSchema.postgresql.sql already includes these
// columns for every NEWLY provisioned tenant. This is the one-off
// migration for already-existing tenant databases -- same pattern as
// _migrate_add_techops_recycle_bin.js/_migrate_add_shift_schedules.js.
//
// tasks needs NO schema change -- assigned_to/assigned_by already
// exist there (added in an earlier phase) and are untouched by this
// migration.
//
// Idempotent and safe to run more than once: every step checks
// information_schema/pg_constraint first, and never drops, truncates,
// or modifies any existing table, row, or the existing owner_id
// column (left completely untouched -- see the accompanying code
// change's header comments for why).
// ==========================================

async function columnExists(tenantPool, tableName, columnName) {
    const [rows] = await tenantPool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ? AND column_name = ? LIMIT 1`,
        [tableName, columnName]
    );
    return rows.length > 0;
}

async function constraintExists(tenantPool, constraintName) {
    const [rows] = await tenantPool.query(
        `SELECT 1 FROM pg_constraint WHERE conname = ? LIMIT 1`,
        [constraintName]
    );
    return rows.length > 0;
}

async function addColumnIfMissing(tenantPool, table, column, definition) {
    if (await columnExists(tenantPool, table, column)) {
        return;
    }
    await tenantPool.query(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
    console.log(`    + ${table}.${column}`);
}

async function addConstraintIfMissing(tenantPool, table, constraintName, definition) {
    if (await constraintExists(tenantPool, constraintName)) {
        return;
    }
    await tenantPool.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${constraintName}" ${definition}`);
    console.log(`    + constraint ${constraintName}`);
}

async function addWorkItemAssignmentColumns(tenantPool, table) {
    await addColumnIfMissing(tenantPool, table, "assigned_to", `integer DEFAULT NULL`);
    await addColumnIfMissing(tenantPool, table, "assigned_by", `integer DEFAULT NULL`);
    await addConstraintIfMissing(tenantPool, table, `fk_${table}_assigned_to`, `FOREIGN KEY ("assigned_to") REFERENCES "users" ("id")`);
    await addConstraintIfMissing(tenantPool, table, `fk_${table}_assigned_by`, `FOREIGN KEY ("assigned_by") REFERENCES "users" ("id")`);
    await tenantPool.query(`CREATE INDEX IF NOT EXISTS "fk_${table}_assigned_to" ON "${table}" ("assigned_to")`);
    await tenantPool.query(`CREATE INDEX IF NOT EXISTS "fk_${table}_assigned_by" ON "${table}" ("assigned_by")`);
}

async function migrateTenant(companySlug, tenantDbName) {
    const tenantPool = getTenantPool(tenantDbName);

    const alreadyDone =
        (await columnExists(tenantPool, "epics", "assigned_to")) &&
        (await columnExists(tenantPool, "features", "assigned_to")) &&
        (await columnExists(tenantPool, "user_stories", "assigned_to"));

    if (alreadyDone) {
        console.log(`  [skip] ${companySlug} (${tenantDbName}) -- assignment columns already exist`);
        return;
    }

    console.log(`  [migrate] ${companySlug} (${tenantDbName}) -- adding assigned_to/assigned_by...`);

    await addWorkItemAssignmentColumns(tenantPool, "epics");
    await addWorkItemAssignmentColumns(tenantPool, "features");
    await addWorkItemAssignmentColumns(tenantPool, "user_stories");

    console.log(`  [done] ${companySlug} (${tenantDbName})`);
}

async function run() {
    console.log("Add Epic/Feature/User Story assignment columns -- enumerating provisioned tenant databases...\n");

    const [companies] = await platformPool.query(
        `SELECT company_slug, tenant_db_name FROM companies WHERE tenant_db_name IS NOT NULL AND tenant_db_name <> ''`
    );

    if (companies.length === 0) {
        console.log("No provisioned tenant databases found.");
    }

    let failures = 0;

    for (const company of companies) {
        try {
            await migrateTenant(company.company_slug, company.tenant_db_name);
        } catch (error) {
            failures++;
            console.error(`  [FAILED] ${company.company_slug} (${company.tenant_db_name}):`, error.message);
        }
    }

    await closeAllTenantPools();
    await platformPool.end();

    console.log(`\n${failures === 0 ? "All tenants migrated successfully." : `${failures} tenant(s) failed -- see errors above.`}`);
    return failures;
}

if (require.main === module) {
    run()
        .then((failures) => process.exit(failures === 0 ? 0 : 1))
        .catch((error) => {
            console.error("MIGRATION SCRIPT ERROR:", error);
            process.exit(1);
        });
}

module.exports = { columnExists, migrateTenant, run };
