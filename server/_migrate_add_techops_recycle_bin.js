require("dotenv").config();

const platformPool = require("./config/platformDb");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");

// ==========================================
// TECHOPS HIERARCHY ENHANCEMENT -- SCHEMA MIGRATION
//
// server/schemas/tenantSchema.postgresql.sql already includes all of
// this for every NEWLY provisioned tenant. This is the one-off
// companion for tenants that were already provisioned before this
// phase -- same pattern as _migrate_add_sops.js/_migrate_add_shift_schedules.js.
//
// Adds, per tenant database:
//   - epics.epic_code / features.feature_code / user_stories.story_code
//     (new backend-generated, concurrency-safe work item codes --
//     EPIC-001/FEAT-001/US-001 -- backfilled below for pre-existing rows)
//   - user_stories.sprint_id (User Stories previously had NO Sprint
//     association at all -- only Tasks did)
//   - deleted_at / deleted_by on epics/features/user_stories/tasks/sprints
//     (Recycle Bin soft-delete support)
//   - a UNIQUE constraint on tasks.task_number, but ONLY if no existing
//     duplicate values are found first -- task_number has never been
//     unique-constrained, and this migration must never fail or corrupt
//     data because of pre-existing, unrelated duplicates.
//
// Idempotent and safe to run more than once: every step checks
// information_schema/pg_constraint before doing anything, and never
// drops, truncates, or overwrites any existing row's real data.
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

// ==========================================
// BACKFILL A CODE COLUMN FOR PRE-EXISTING ROWS
// Assigns EPIC-001, EPIC-002, ... in ascending id order to every row
// that doesn't already have one -- deterministic, one-time only
// (never re-numbers a row that already has a code).
// ==========================================

async function backfillCodes(tenantPool, table, column, prefix) {

    const [rows] = await tenantPool.query(
        `SELECT id FROM "${table}" WHERE "${column}" IS NULL ORDER BY id ASC`
    );

    if (rows.length === 0) {
        return 0;
    }

    for (const row of rows) {
        const [[highest]] = await tenantPool.query(
            `
            SELECT ${column}
            FROM "${table}"
            WHERE "${column}" ~ ?
            ORDER BY CAST(SUBSTRING("${column}", ?::integer) AS INTEGER) DESC
            LIMIT 1
            `,
            [`^${prefix}-[0-9]+$`, prefix.length + 2]
        );

        const nextNumber = highest
            ? parseInt(String(highest[column]).slice(prefix.length + 1), 10) + 1
            : 1;

        const code = `${prefix}-${String(nextNumber).padStart(3, "0")}`;

        await tenantPool.query(`UPDATE "${table}" SET "${column}" = ? WHERE id = ?`, [code, row.id]);
    }

    return rows.length;

}

async function migrateTenant(companySlug, tenantDbName) {

    const tenantPool = getTenantPool(tenantDbName);

    // Checks the MOST RECENTLY added column (deleted_batch_id, added for
    // "Restore All") rather than the oldest (epic_code) -- so a tenant
    // that already ran an earlier version of this migration (has
    // epic_code but not yet deleted_batch_id) is NOT skipped, and picks
    // up the newer addition. Every step below is independently
    // idempotent regardless (addColumnIfMissing/addConstraintIfMissing
    // check first), so re-running the whole function for such a tenant
    // is always safe.
    const alreadyDone = await columnExists(tenantPool, "epics", "deleted_batch_id");

    if (alreadyDone) {
        console.log(`  [skip] ${companySlug} (${tenantDbName}) -- already migrated`);
        return;
    }

    console.log(`  [migrate] ${companySlug} (${tenantDbName})...`);

    // ---- epics ----
    await addColumnIfMissing(tenantPool, "epics", "epic_code", `varchar(20) DEFAULT NULL`);
    await addColumnIfMissing(tenantPool, "epics", "deleted_at", `timestamp DEFAULT NULL`);
    await addColumnIfMissing(tenantPool, "epics", "deleted_by", `integer DEFAULT NULL`);
    await addConstraintIfMissing(tenantPool, "epics", "uq_epics_code", `UNIQUE ("epic_code")`);
    await addConstraintIfMissing(tenantPool, "epics", "fk_epics_deleted_by", `FOREIGN KEY ("deleted_by") REFERENCES "users" ("id") ON DELETE SET NULL`);
    await tenantPool.query(`CREATE INDEX IF NOT EXISTS "idx_epics_deleted_at" ON "epics" ("deleted_at")`);

    // ---- features ----
    await addColumnIfMissing(tenantPool, "features", "feature_code", `varchar(20) DEFAULT NULL`);
    await addColumnIfMissing(tenantPool, "features", "deleted_at", `timestamp DEFAULT NULL`);
    await addColumnIfMissing(tenantPool, "features", "deleted_by", `integer DEFAULT NULL`);
    await addConstraintIfMissing(tenantPool, "features", "uq_features_code", `UNIQUE ("feature_code")`);
    await addConstraintIfMissing(tenantPool, "features", "fk_features_deleted_by", `FOREIGN KEY ("deleted_by") REFERENCES "users" ("id") ON DELETE SET NULL`);
    await tenantPool.query(`CREATE INDEX IF NOT EXISTS "idx_features_deleted_at" ON "features" ("deleted_at")`);

    // ---- user_stories ----
    await addColumnIfMissing(tenantPool, "user_stories", "story_code", `varchar(20) DEFAULT NULL`);
    await addColumnIfMissing(tenantPool, "user_stories", "sprint_id", `integer DEFAULT NULL`);
    await addColumnIfMissing(tenantPool, "user_stories", "deleted_at", `timestamp DEFAULT NULL`);
    await addColumnIfMissing(tenantPool, "user_stories", "deleted_by", `integer DEFAULT NULL`);
    await addConstraintIfMissing(tenantPool, "user_stories", "uq_user_stories_code", `UNIQUE ("story_code")`);
    await addConstraintIfMissing(tenantPool, "user_stories", "fk_user_stories_deleted_by", `FOREIGN KEY ("deleted_by") REFERENCES "users" ("id") ON DELETE SET NULL`);
    await addConstraintIfMissing(tenantPool, "user_stories", "fk_user_stories_sprint", `FOREIGN KEY ("sprint_id") REFERENCES "sprints" ("id") ON DELETE SET NULL`);
    await tenantPool.query(`CREATE INDEX IF NOT EXISTS "idx_user_stories_deleted_at" ON "user_stories" ("deleted_at")`);
    await tenantPool.query(`CREATE INDEX IF NOT EXISTS "fk_user_stories_sprint" ON "user_stories" ("sprint_id")`);

    // ---- tasks ----
    await addColumnIfMissing(tenantPool, "tasks", "deleted_at", `timestamp DEFAULT NULL`);
    await addColumnIfMissing(tenantPool, "tasks", "deleted_by", `integer DEFAULT NULL`);
    await addConstraintIfMissing(tenantPool, "tasks", "fk_tasks_deleted_by", `FOREIGN KEY ("deleted_by") REFERENCES "users" ("id") ON DELETE SET NULL`);
    await tenantPool.query(`CREATE INDEX IF NOT EXISTS "idx_tasks_deleted_at" ON "tasks" ("deleted_at")`);

    // ---- "Restore All" cascade-group tracking (deleted_batch_id) ----
    // Added after epic_code/deleted_at etc. -- see the top-of-function
    // skip gate, which checks THIS column specifically so a tenant that
    // already ran an earlier version of this same migration still picks
    // up this later addition instead of being skipped entirely.
    await addColumnIfMissing(tenantPool, "epics", "deleted_batch_id", `uuid DEFAULT NULL`);
    await addColumnIfMissing(tenantPool, "features", "deleted_batch_id", `uuid DEFAULT NULL`);
    await addColumnIfMissing(tenantPool, "user_stories", "deleted_batch_id", `uuid DEFAULT NULL`);
    await addColumnIfMissing(tenantPool, "tasks", "deleted_batch_id", `uuid DEFAULT NULL`);
    await tenantPool.query(`CREATE INDEX IF NOT EXISTS "idx_epics_deleted_batch" ON "epics" ("deleted_batch_id")`);
    await tenantPool.query(`CREATE INDEX IF NOT EXISTS "idx_features_deleted_batch" ON "features" ("deleted_batch_id")`);
    await tenantPool.query(`CREATE INDEX IF NOT EXISTS "idx_user_stories_deleted_batch" ON "user_stories" ("deleted_batch_id")`);
    await tenantPool.query(`CREATE INDEX IF NOT EXISTS "idx_tasks_deleted_batch" ON "tasks" ("deleted_batch_id")`);

    // task_number has never been unique-constrained. Only add the
    // constraint if no duplicates already exist -- this migration must
    // never fail or block on pre-existing, unrelated data.
    const [dupRows] = await tenantPool.query(`
        SELECT task_number, COUNT(*) AS cnt
        FROM tasks
        WHERE task_number IS NOT NULL
        GROUP BY task_number
        HAVING COUNT(*) > 1
    `);

    if (dupRows.length === 0) {
        await addConstraintIfMissing(tenantPool, "tasks", "uq_tasks_task_number", `UNIQUE ("task_number")`);
    } else {
        console.log(`    ! ${dupRows.length} duplicate task_number value(s) found -- skipping UNIQUE constraint (generation logic is fixed regardless)`);
    }

    // ---- sprints ----
    await addColumnIfMissing(tenantPool, "sprints", "deleted_at", `timestamp DEFAULT NULL`);
    await addColumnIfMissing(tenantPool, "sprints", "deleted_by", `integer DEFAULT NULL`);
    await addConstraintIfMissing(tenantPool, "sprints", "fk_sprints_deleted_by", `FOREIGN KEY ("deleted_by") REFERENCES "users" ("id") ON DELETE SET NULL`);
    await tenantPool.query(`CREATE INDEX IF NOT EXISTS "idx_sprints_deleted_at" ON "sprints" ("deleted_at")`);

    // ---- backfill codes for pre-existing rows ----
    const epicCount = await backfillCodes(tenantPool, "epics", "epic_code", "EPIC");
    const featureCount = await backfillCodes(tenantPool, "features", "feature_code", "FEAT");
    const storyCount = await backfillCodes(tenantPool, "user_stories", "story_code", "US");

    console.log(`    backfilled codes: ${epicCount} epic(s), ${featureCount} feature(s), ${storyCount} user stor(y/ies)`);

    console.log(`  [done] ${companySlug} (${tenantDbName})`);
}

(async () => {
    console.log("TechOps hierarchy enhancement migration -- enumerating provisioned tenant databases...\n");

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
    process.exit(failures === 0 ? 0 : 1);
})().catch(async (error) => {
    console.error("MIGRATION SCRIPT ERROR:", error);
    process.exit(1);
});
