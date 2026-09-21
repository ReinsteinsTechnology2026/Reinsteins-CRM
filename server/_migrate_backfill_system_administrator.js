// Explicit, cwd-independent path -- same fix as
// _migrate_backfill_admin_group_permissions.js (see its own header
// comment for why this is needed for an unattended deploy-pipeline run).
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const platformPool = require("./config/platformDb");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");

// ==========================================
// BACKFILL is_system_administrator FOR EXISTING TENANTS
//
// server/schemas/tenantSchema.postgresql.sql already includes the
// users.is_system_administrator column and its partial unique index
// for every NEWLY provisioned tenant -- but editing that schema
// SNAPSHOT file has no effect on a tenant database that was already
// provisioned before this change shipped. This is the one-off
// companion for those tenants (including the real Reinsteins
// database), same pattern as _migrate_add_techops_recycle_bin.js:
// every step checks information_schema/pg_indexes before doing
// anything, so it's safe to run against a tenant that already has
// the column/index (a no-op) as well as one that doesn't yet.
//
// tenantUserService.createFirstAdmin() marks a tenant's first
// administrator as the System Administrator at creation time -- that
// only covers tenants created AFTER this change shipped. This script
// enumerates every tenant via the platform companies table (same
// pattern as _migrate_backfill_admin_group_permissions.js), and per
// tenant:
//   1. Ensures the column + partial unique index exist (idempotent).
//   2. Backfills exactly one flagged account, deliberately
//      conservative -- this flag grants unconditional access to
//      every project in a tenant, so guessing wrong is a real
//      security mistake, not just a cosmetic one:
//        - Idempotent: any tenant that already has exactly one
//          is_system_administrator = TRUE row is skipped untouched.
//        - Never silently overwrites: if a tenant is ever found with
//          MORE than one TRUE row (should be impossible once the
//          unique index exists, but checked defensively rather than
//          assumed), this is logged as an inconsistency and the
//          tenant is skipped -- never "fixed" by picking one.
//        - Reinsteins ONLY: identified explicitly by full_name =
//          'System Administrator' (the real, confirmed account --
//          see this session's architecture review), never by
//          created_at ordering or "the first admin found". If more
//          than one admin matches that exact name (ambiguous), this
//          is logged and the tenant is skipped rather than guessing
//          which one is real.
//        - EVERY OTHER TENANT is left alone. This script does not
//          guess which of a tenant's admin accounts should become
//          its System Administrator -- it logs a [NEEDS DECISION]
//          line listing that tenant's existing role='admin' accounts
//          and moves on. A human must decide per tenant; no tenant
//          is auto-assigned one.
// ==========================================

const INDEX_NAME = "uq_users_one_system_administrator";
const INDEX_DEFINITION_SQL = `CREATE UNIQUE INDEX "${INDEX_NAME}" ON "users" ("is_system_administrator") WHERE "is_system_administrator" = TRUE`;

// ------------------------------------------
// Schema helpers -- same convention as _migrate_add_techops_recycle_bin.js's
// columnExists()/addColumnIfMissing(). Indexes are checked via
// pg_indexes rather than pg_constraint (that file's constraintExists()
// pattern): a plain CREATE UNIQUE INDEX, unlike an ALTER TABLE ... ADD
// CONSTRAINT ... UNIQUE, never appears in pg_constraint at all.
// ------------------------------------------

async function columnExists(tenantPool, tableName, columnName) {
    const [rows] = await tenantPool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ? AND column_name = ? LIMIT 1`,
        [tableName, columnName]
    );
    return rows.length > 0;
}

async function indexExists(tenantPool, indexName) {
    const [rows] = await tenantPool.query(
        `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = ? LIMIT 1`,
        [indexName]
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

async function addUniqueIndexIfMissing(tenantPool, indexName, createIndexSql) {
    if (await indexExists(tenantPool, indexName)) {
        return;
    }
    await tenantPool.query(createIndexSql);
    console.log(`    + index ${indexName}`);
}

// Column is added with DEFAULT FALSE, so every pre-existing row is
// FALSE the instant the column exists -- there is no ordering hazard
// where the index-creation step could ever encounter a pre-existing
// duplicate TRUE value. Column, then index, then (in backfillTenant)
// the data-level check, in that order, every time.
async function ensureSchema(tenantPool) {
    await addColumnIfMissing(tenantPool, "users", "is_system_administrator", "boolean NOT NULL DEFAULT FALSE");
    await addUniqueIndexIfMissing(tenantPool, INDEX_NAME, INDEX_DEFINITION_SQL);
}

async function getSystemAdministrators(tenantPool) {
    const [rows] = await tenantPool.query(
        `SELECT id, employee_id FROM users WHERE is_system_administrator = TRUE`
    );
    return rows;
}

async function backfillTenant(companySlug, tenantDbName) {
    const tenantPool = getTenantPool(tenantDbName);

    await ensureSchema(tenantPool);

    const existing = await getSystemAdministrators(tenantPool);

    if (existing.length === 1) {
        console.log(`  [skip] ${companySlug} (${tenantDbName}) -- already has a System Administrator (id=${existing[0].id})`);
        return;
    }

    if (existing.length > 1) {
        // Should be impossible once the unique index exists -- checked
        // defensively rather than assumed. Never "fixed" automatically.
        console.log(`  [INCONSISTENT -- NOT TOUCHED] ${companySlug} (${tenantDbName}) -- found ${existing.length} accounts flagged is_system_administrator=TRUE (ids: ${existing.map((r) => r.id).join(", ")}); this should not be possible under the unique index -- resolve manually before re-running`);
        return;
    }

    if (companySlug === "reinsteins") {

        const [candidates] = await tenantPool.query(
            `SELECT id, employee_id FROM users WHERE role = 'admin' AND full_name = 'System Administrator'`
        );

        if (candidates.length === 0) {
            console.log(`  [NEEDS DECISION] ${companySlug} (${tenantDbName}) -- expected an admin named exactly "System Administrator" but found none; not guessing, skipping`);
            return;
        }

        if (candidates.length > 1) {
            console.log(`  [AMBIGUOUS -- NOT APPLIED] ${companySlug} (${tenantDbName}) -- found ${candidates.length} admin accounts named exactly "System Administrator" (ids: ${candidates.map((r) => r.id).join(", ")}); not guessing which one is real, skipping`);
            return;
        }

        const admin = candidates[0];

        await tenantPool.query(
            `UPDATE users SET is_system_administrator = TRUE WHERE id = ?`,
            [admin.id]
        );

        console.log(`  [done] ${companySlug} (${tenantDbName}) -- flagged user id=${admin.id} (employee_id=${admin.employee_id}) as System Administrator`);
        return;

    }

    const [others] = await tenantPool.query(
        `SELECT id, employee_id, full_name, created_at FROM users WHERE role = 'admin' ORDER BY created_at ASC`
    );

    if (others.length === 0) {
        console.log(`  [skip] ${companySlug} (${tenantDbName}) -- no admin accounts exist yet`);
        return;
    }

    console.log(`  [NEEDS DECISION] ${companySlug} (${tenantDbName}) -- ${others.length} existing admin account(s), none auto-selected:`);
    for (const candidate of others) {
        console.log(`      id=${candidate.id} employee_id=${candidate.employee_id} full_name="${candidate.full_name}" created_at=${candidate.created_at.toISOString()}`);
    }

}

async function runMigration() {
    console.log("Backfill System Administrator -- enumerating provisioned tenant databases...\n");

    const [companies] = await platformPool.query(
        `SELECT company_slug, tenant_db_name FROM companies WHERE tenant_db_name IS NOT NULL AND tenant_db_name <> ''`
    );

    if (companies.length === 0) {
        console.log("No provisioned tenant databases found.");
    }

    let failures = 0;

    for (const company of companies) {
        try {
            await backfillTenant(company.company_slug, company.tenant_db_name);
        } catch (error) {
            failures++;
            console.error(`  [FAILED] ${company.company_slug} (${company.tenant_db_name}):`, error.message);
        }
    }

    await closeAllTenantPools();
    await platformPool.end();

    console.log(`\n${failures === 0 ? "Migration completed (see [NEEDS DECISION]/[AMBIGUOUS]/[INCONSISTENT] lines above, if any, for tenants requiring a manual choice)." : `${failures} tenant(s) failed -- see errors above.`}`);
    return failures;
}

// Guarded so this file can be safely `require()`d by
// _test_system_administrator.js (to unit-test backfillTenant()'s
// schema-provisioning and Reinsteins-identification logic against
// disposable tenants, without ever touching the real "reinsteins"
// platform company row) without that require ALSO triggering a real
// run against every registered tenant as a side effect. Only actually
// runs when invoked directly: `node _migrate_backfill_system_administrator.js`.
if (require.main === module) {
    runMigration()
        .then((failures) => process.exit(failures === 0 ? 0 : 1))
        .catch(async (error) => {
            console.error("MIGRATION SCRIPT ERROR:", error);
            process.exit(1);
        });
}

module.exports = { backfillTenant, ensureSchema, columnExists, indexExists, getSystemAdministrators, runMigration };
