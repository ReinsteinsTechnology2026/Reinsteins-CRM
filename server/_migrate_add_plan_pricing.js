const platformPool = require("./config/platformDb");

// ==========================================
// MIGRATION: PLAN PRICING + TRIAL DURATION
//
// Additive-only: adds monthly_price, yearly_price, and
// trial_duration_days to subscription_plans. All three are nullable
// with no default, so every existing plan row (Complimentary, Trial,
// Starter, Professional, Enterprise, and any Platform-Owner-created
// plan) keeps working exactly as before -- NULL simply means "no
// price set yet" / "no fixed trial length", not zero.
//
// This does NOT wire up any payment processing. It only lets the
// Platform Owner record what a plan WOULD cost, so the Plans/
// Payments/Analytics UIs have real (Platform-Owner-entered) figures
// to show instead of inventing any, and so a future billing
// integration has a place to read prices from without a second
// migration.
//
// Idempotent: safe to run more than once.
// ==========================================

async function columnExists(table, column) {
    const [rows] = await platformPool.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
    return rows.length > 0;
}

(async () => {

    if (!(await columnExists("subscription_plans", "monthly_price"))) {
        await platformPool.query(
            `ALTER TABLE subscription_plans ADD COLUMN monthly_price DECIMAL(10,2) NULL AFTER storage_limit_mb`
        );
        console.log("Added column: subscription_plans.monthly_price");
    } else {
        console.log("subscription_plans.monthly_price already exists — skipped.");
    }

    if (!(await columnExists("subscription_plans", "yearly_price"))) {
        await platformPool.query(
            `ALTER TABLE subscription_plans ADD COLUMN yearly_price DECIMAL(10,2) NULL AFTER monthly_price`
        );
        console.log("Added column: subscription_plans.yearly_price");
    } else {
        console.log("subscription_plans.yearly_price already exists — skipped.");
    }

    if (!(await columnExists("subscription_plans", "trial_duration_days"))) {
        await platformPool.query(
            `ALTER TABLE subscription_plans ADD COLUMN trial_duration_days INT UNSIGNED NULL AFTER yearly_price`
        );
        console.log("Added column: subscription_plans.trial_duration_days");
    } else {
        console.log("subscription_plans.trial_duration_days already exists — skipped.");
    }

    console.log("\nPlan pricing migration complete.");
    process.exit(0);

})().catch((e) => { console.error(e); process.exit(1); });
