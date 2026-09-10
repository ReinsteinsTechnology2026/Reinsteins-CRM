const platformPool = require("./config/platformDb");

// ==========================================
// SUPERSEDED (Phase 4, PostgreSQL migration) -- this script's
// MySQL-era SHOW TABLES/SHOW COLUMNS calls and MySQL DDL are NOT
// PostgreSQL-compatible and this file has NOT been converted. Its
// job (creating subscription_plans, adding companies' subscription
// columns, seeding default plans) is now done in one pass by
// _setup_platform_db.js against schemas/platformSchema.postgresql.sql.
// Do not run this script against the PostgreSQL database. Left in
// place only as historical record of the original migration.
// ==========================================

// ==========================================
// MIGRATION: SUBSCRIPTION PLANS + COMPANY SUBSCRIPTION FIELDS (Phase 8)
//
// Adds the internal subscription/plan management foundation:
//   - subscription_plans (new table, platform-level, seeded with 5
//     starter plans)
//   - plan_id, subscription_status, trial_ends_at,
//     subscription_started_at, subscription_expires_at added directly
//     to companies (additive only -- status and access_type are
//     completely untouched, same columns, same values, same meaning
//     they've always had)
//
// Backward compatibility: every existing company row (in practice
// just Reinsteins today) is backfilled to plan_id=Complimentary,
// subscription_status='active', subscription_started_at=created_at,
// with no trial/expiry dates -- i.e. "always allowed", which is
// exactly its behavior before this migration ran.
//
// Idempotent: safe to run more than once (mirrors the existing
// _migrate_add_organizations.js / _setup_demo_requests_table.js
// convention -- CREATE TABLE IF NOT EXISTS, column-existence checks,
// and a backfill that only ever touches rows with plan_id IS NULL).
// ==========================================

async function tableExists(table) {
    const [rows] = await platformPool.query(`SHOW TABLES LIKE ?`, [table]);
    return rows.length > 0;
}

async function columnExists(table, column) {
    const [rows] = await platformPool.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
    return rows.length > 0;
}

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

(async () => {

    // ==========================================
    // 1. subscription_plans
    // ==========================================

    if (!(await tableExists("subscription_plans"))) {

        await platformPool.query(`
            CREATE TABLE subscription_plans (
                id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                slug VARCHAR(60) NOT NULL,
                description TEXT NULL,
                status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
                employee_limit INT UNSIGNED NULL,
                storage_limit_mb INT UNSIGNED NULL,
                features JSON NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                CONSTRAINT uq_subscription_plans_slug UNIQUE (slug)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        console.log("Created table: subscription_plans");

    } else {
        console.log("subscription_plans already exists — skipped.");
    }

    // ---------- Seed default plans (idempotent by slug) ----------

    for (const plan of DEFAULT_PLANS) {
        const [[existing]] = await platformPool.query(
            `SELECT id FROM subscription_plans WHERE slug = ? LIMIT 1`,
            [plan.slug]
        );

        if (existing) {
            console.log(`Plan "${plan.slug}" already exists (id=${existing.id}) — skipped.`);
            continue;
        }

        const [result] = await platformPool.query(
            `INSERT INTO subscription_plans
                (name, slug, description, status, employee_limit, storage_limit_mb, features)
             VALUES (?, ?, ?, 'active', ?, ?, ?)`,
            [plan.name, plan.slug, plan.description, plan.employeeLimit, plan.storageLimitMb, JSON.stringify(plan.features)]
        );

        console.log(`Created plan: "${plan.name}" (id=${result.insertId})`);
    }

    // ==========================================
    // 2. companies -- additive subscription columns
    // ==========================================

    if (!(await columnExists("companies", "plan_id"))) {
        await platformPool.query(`ALTER TABLE companies ADD COLUMN plan_id INT UNSIGNED NULL AFTER access_type`);
        console.log("Added column: companies.plan_id");
    } else {
        console.log("companies.plan_id already exists — skipped.");
    }

    if (!(await columnExists("companies", "subscription_status"))) {
        await platformPool.query(
            `ALTER TABLE companies ADD COLUMN subscription_status
             ENUM('active', 'trial', 'expired', 'cancelled') NOT NULL DEFAULT 'active' AFTER plan_id`
        );
        console.log("Added column: companies.subscription_status");
    } else {
        console.log("companies.subscription_status already exists — skipped.");
    }

    if (!(await columnExists("companies", "trial_ends_at"))) {
        await platformPool.query(`ALTER TABLE companies ADD COLUMN trial_ends_at DATETIME NULL AFTER subscription_status`);
        console.log("Added column: companies.trial_ends_at");
    } else {
        console.log("companies.trial_ends_at already exists — skipped.");
    }

    if (!(await columnExists("companies", "subscription_started_at"))) {
        await platformPool.query(`ALTER TABLE companies ADD COLUMN subscription_started_at DATETIME NULL AFTER trial_ends_at`);
        console.log("Added column: companies.subscription_started_at");
    } else {
        console.log("companies.subscription_started_at already exists — skipped.");
    }

    if (!(await columnExists("companies", "subscription_expires_at"))) {
        await platformPool.query(`ALTER TABLE companies ADD COLUMN subscription_expires_at DATETIME NULL AFTER subscription_started_at`);
        console.log("Added column: companies.subscription_expires_at");
    } else {
        console.log("companies.subscription_expires_at already exists — skipped.");
    }

    // ---------- FK: companies.plan_id -> subscription_plans.id ----------
    // Default MySQL FK reference option is RESTRICT, which is exactly
    // the "do not allow deletion if it could break companies already
    // assigned to that plan" requirement -- enforced at the schema
    // level, not just in application code.

    const [existingFk] = await platformPool.query(
        `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies'
         AND CONSTRAINT_NAME = 'fk_companies_plan_id'`
    );

    if (existingFk.length === 0) {
        await platformPool.query(
            `ALTER TABLE companies
             ADD CONSTRAINT fk_companies_plan_id FOREIGN KEY (plan_id) REFERENCES subscription_plans(id)`
        );
        console.log("Added constraint: fk_companies_plan_id");
    } else {
        console.log("fk_companies_plan_id already exists — skipped.");
    }

    // ---------- Backfill existing companies (Reinsteins today) ----------
    // Only ever touches a row that has never been assigned a plan yet
    // -- running this migration again after a Platform Owner has since
    // deliberately changed a company's plan/subscription will not
    // overwrite that choice.

    const [[complimentaryPlan]] = await platformPool.query(
        `SELECT id FROM subscription_plans WHERE slug = 'complimentary' LIMIT 1`
    );

    const [backfillResult] = await platformPool.query(
        `UPDATE companies
         SET plan_id = ?, subscription_status = 'active', subscription_started_at = created_at
         WHERE plan_id IS NULL`,
        [complimentaryPlan.id]
    );

    console.log(`Backfilled ${backfillResult.affectedRows} existing company row(s) to plan="Complimentary", subscription_status="active", no expiry.`);

    console.log("\nSubscription migration complete.");

    process.exit(0);

})().catch((e) => { console.error(e); process.exit(1); });
