const fs = require("fs");
const path = require("path");
const platformPool = require("./config/platformDb");
require("dotenv").config();

// ==========================================
// GROWORGS PLATFORM DATABASE -- BOOTSTRAP (PostgreSQL, Phase 4;
// extended for the Phase 10-14 tables merged in afterward)
//
// PostgreSQL-native replacement for the original MySQL bootstrap.
// Consolidates what were three separate historical scripts
// (_setup_platform_db.js, _migrate_add_subscriptions.js,
// _setup_demo_requests_table.js) into one idempotent run, because
// this is a from-scratch PostgreSQL bootstrap rather than a live
// incremental migration -- there's no need to replay that history
// step by step. Those two other scripts are now superseded; they
// are left in place, unconverted, as historical record, but should
// not be run against this database (see their own headers). The same
// applies to five LATER MySQL-era scripts merged in afterward
// (_migrate_add_payments.js, _migrate_add_plan_pricing.js,
// _migrate_add_subscription_lifecycle.js, _migrate_add_email_billing.js,
// _migrate_add_security_hardening.js) -- their tables/columns were
// translated into schemas/platformSchema.postgresql.sql's "PHASE
// 10-14 ADDITIONS" section instead of being replayed as separate
// scripts, exactly like the original three.
//
// Confirmed by inspecting PLATFORM_DB_NAME/DB_NAME in .env before
// writing this script: platform tables intentionally live in the
// SAME database as the tenant schema (both are "reinsteins_crm" in
// this deployment) -- not a separate platform database. This script
// therefore never issues CREATE DATABASE/DROP DATABASE; it only
// adds the platform tables to the database that's already there, and
// never touches any of the existing tenant tables.
//
// Schema lives in schemas/platformSchema.postgresql.sql (CREATE
// TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout,
// cross-checked column-by-column against every services/*.js query
// that touches these tables). Applied via the raw driver
// (platformPool.nativePool) using PostgreSQL's simple query protocol,
// which both allows multiple ";"-separated statements in one call AND
// correctly treats each file's DO $$ ... END $$ block as one
// statement (its semicolons don't split it) -- the same mechanism
// `psql -f file.sql` uses. PostgreSQL also runs a multi-statement
// simple-query call as one implicit transaction, so a failure partway
// through leaves no partial schema behind.
//
// Idempotent overall: safe to run more than once. Never drops or
// truncates anything.
//
//   node _setup_platform_db.js
// ==========================================

const SCHEMA_FILE_PATH = path.join(__dirname, "schemas", "platformSchema.postgresql.sql");

const PLATFORM_TABLES = [
    "platform_users", "subscription_plans", "companies", "demo_requests",
    "payments", "subscription_history", "platform_audit_logs", "platform_notifications", "email_delivery_logs",
];

const DEFAULT_PLANS = [
    {
        name: "Complimentary",
        slug: "complimentary",
        description: "Free, unrestricted access -- used for internal/partner companies with no billing relationship.",
        employeeLimit: null,
        storageLimitMb: null,
        features: {},
    },
    {
        name: "Trial",
        slug: "trial",
        description: "Time-limited evaluation access. Pair with a company's trial_ends_at date.",
        employeeLimit: 10,
        storageLimitMb: 1024,
        features: {},
    },
    {
        name: "Starter",
        slug: "starter",
        description: "Entry-level paid plan for small teams.",
        employeeLimit: 25,
        storageLimitMb: 5120,
        features: {},
    },
    {
        name: "Professional",
        slug: "professional",
        description: "Mid-tier paid plan for growing companies.",
        employeeLimit: 100,
        storageLimitMb: 20480,
        features: {},
    },
    {
        name: "Enterprise",
        slug: "enterprise",
        description: "Unrestricted paid plan for large organizations.",
        employeeLimit: null,
        storageLimitMb: null,
        features: {},
    },
];

async function tableExists(table) {
    const [rows] = await platformPool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ?`,
        [table]
    );
    return rows.length > 0;
}

(async () => {

    // ==========================================
    // 0. SAFETY: report exactly what already exists before touching
    // anything -- never assumed, always checked live.
    // ==========================================

    const before = {};
    for (const table of PLATFORM_TABLES) {
        before[table] = await tableExists(table);
    }
    console.log("Platform tables before bootstrap:", before);

    if (Object.values(before).every(Boolean)) {
        console.log("All 4 platform tables already exist -- schema step skipped, still seeding idempotently below.\n");
    }

    // ==========================================
    // 1. APPLY SCHEMA (idempotent: CREATE TABLE/INDEX IF NOT EXISTS,
    // constraint guarded by a DO block that checks pg_constraint
    // first)
    // ==========================================

    if (!fs.existsSync(SCHEMA_FILE_PATH)) {
        throw new Error(
            `Platform schema file not found at ${SCHEMA_FILE_PATH}.`
        );
    }

    const schemaSql = fs.readFileSync(SCHEMA_FILE_PATH, "utf8");

    // Raw driver, not the ?-placeholder compat wrapper -- this is a
    // static, parameter-free multi-statement DDL file, executed via
    // PostgreSQL's simple query protocol (same mechanism `psql -f`
    // uses), which is what allows the DO $$ ... END $$ block to be
    // sent correctly alongside the CREATE TABLE statements around it.
    await platformPool.nativePool.query(schemaSql);

    const after = {};
    for (const table of PLATFORM_TABLES) {
        after[table] = await tableExists(table);
    }
    console.log("Platform tables after schema step:", after);

    for (const table of PLATFORM_TABLES) {
        if (!after[table]) {
            throw new Error(`Schema application did not create expected table "${table}".`);
        }
    }

    // ==========================================
    // 2. SEED: 5 default subscription plans (idempotent by slug)
    // ==========================================

    for (const plan of DEFAULT_PLANS) {

        const [result] = await platformPool.query(
            `INSERT INTO subscription_plans
                (name, slug, description, status, employee_limit, storage_limit_mb, features)
             VALUES (?, ?, ?, 'active', ?, ?, ?)
             ON CONFLICT (slug) DO NOTHING
             RETURNING id`,
            [
                plan.name,
                plan.slug,
                plan.description,
                plan.employeeLimit,
                plan.storageLimitMb,
                JSON.stringify(plan.features),
            ]
        );

        if (result[0]) {
            console.log(`Created plan: "${plan.name}" (id=${result[0].id})`);
        } else {
            console.log(`Plan "${plan.slug}" already exists -- skipped.`);
        }

    }

    // ==========================================
    // 3. SEED: Reinsteins Technology as a platform company record
    // ONLY. Writes exclusively to companies -- does not touch,
    // migrate, rename, or connect to the existing tenant database.
    // tenant_db_name stays NULL until an operator actually links a
    // tenant database to this company (out of scope here).
    //
    // plan_id is backfilled to the Complimentary plan just seeded
    // above -- matches the original _migrate_add_subscriptions.js's
    // backfill ("every existing company row defaults to
    // plan=Complimentary, subscription_status=active, no expiry" --
    // i.e. unchanged from its pre-subscription-fields behavior),
    // reproduced here directly since this is a from-scratch
    // bootstrap rather than a live migration of an existing row.
    // ==========================================

    const [[complimentaryPlan]] = await platformPool.query(
        `SELECT id FROM subscription_plans WHERE slug = 'complimentary' LIMIT 1`
    );

    const [[existingCompany]] = await platformPool.query(
        `SELECT id FROM companies WHERE company_slug = 'reinsteins' LIMIT 1`
    );

    if (existingCompany) {
        console.log(`Company "reinsteins" already exists (id=${existingCompany.id}) -- skipped.`);

        const [backfillResult] = await platformPool.query(
            `UPDATE companies
             SET plan_id = ?, subscription_status = 'active', subscription_started_at = COALESCE(subscription_started_at, created_at)
             WHERE id = ? AND plan_id IS NULL`,
            [complimentaryPlan.id, existingCompany.id]
        );

        if (backfillResult.affectedRows > 0) {
            console.log(`Backfilled "reinsteins" company row to plan=Complimentary (was missing a plan_id).`);
        }

    } else {

        const [result] = await platformPool.query(
            `INSERT INTO companies (company_name, company_slug, status, access_type, tenant_db_name, plan_id, subscription_status, subscription_started_at)
             VALUES (?, ?, 'active', 'complimentary', NULL, ?, 'active', CURRENT_TIMESTAMP)
             RETURNING id`,
            ["Reinsteins Technology", "reinsteins", complimentaryPlan.id]
        );

        console.log(`Created company record: "Reinsteins Technology" (slug=reinsteins, id=${result[0].id}, access_type=complimentary, tenant_db_name=NULL)`);

    }

    console.log("\nPlatform DB bootstrap complete.");

    process.exit(0);

})().catch((e) => { console.error(e); process.exit(1); });
