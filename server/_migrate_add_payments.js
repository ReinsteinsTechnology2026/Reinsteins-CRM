const platformPool = require("./config/platformDb");

// ==========================================
// MIGRATION: PAYMENTS TABLE (Phase 10A)
//
// New table, additive only -- nothing existing is altered. Lives in
// groworgs_platform_db alongside companies/subscription_plans/
// platform_users/demo_requests; never touches any tenant database.
//
// DESIGN NOTES:
//
//   - No card numbers, CVV, bank credentials, or any payment secret
//     is ever a column here -- only provider-issued reference IDs
//     (provider_payment_id, provider_order_id), which are safe,
//     non-sensitive identifiers a gateway itself uses to look up a
//     transaction. This matches how Razorpay/Stripe are meant to be
//     integrated: the gateway holds the sensitive card data, this
//     table only holds what it told us about the result.
//
//   - company_id / plan_id use ON DELETE RESTRICT (the same
//     protective pattern already used for subscription_plans, which
//     has no delete operation at all -- see subscriptionPlanService.js).
//     This is a deliberate trade-off: a company with real payment
//     history can no longer be deleted through the existing
//     DELETE /api/platform/companies/:id endpoint (that endpoint now
//     catches this specific case and returns a clear message rather
//     than a raw DB error -- see platformCompanyController.js's
//     deleteCompany). Financial records must never silently disappear
//     just because a company row was removed.
//
//   - provider_payment_id and invoice_number are UNIQUE but nullable.
//     MySQL allows multiple NULLs in a UNIQUE index, so a 'pending'
//     manually-entered payment (no provider transaction yet, no
//     invoice generated yet) is fine; once a real value is set, it
//     can never collide with another row -- this is what makes
//     webhook processing idempotent (see paymentService.js's
//     createOrUpdateFromProvider).
//
// Idempotent: safe to run more than once.
// ==========================================

async function tableExists(table) {
    const [rows] = await platformPool.query(`SHOW TABLES LIKE ?`, [table]);
    return rows.length > 0;
}

(async () => {

    if (!(await tableExists("payments"))) {

        await platformPool.query(`
            CREATE TABLE payments (
                id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                company_id INT UNSIGNED NOT NULL,
                plan_id INT UNSIGNED NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                currency VARCHAR(3) NOT NULL DEFAULT 'INR',
                billing_cycle ENUM('monthly', 'yearly', 'one_time') NOT NULL,
                payment_status ENUM('pending', 'paid', 'failed', 'refunded', 'cancelled') NOT NULL DEFAULT 'pending',
                payment_provider VARCHAR(50) NULL,
                provider_payment_id VARCHAR(255) NULL,
                provider_order_id VARCHAR(255) NULL,
                invoice_number VARCHAR(50) NULL,
                notes VARCHAR(500) NULL,
                paid_at DATETIME NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                CONSTRAINT uq_payments_provider_payment_id UNIQUE (provider_payment_id),
                CONSTRAINT uq_payments_invoice_number UNIQUE (invoice_number),
                CONSTRAINT fk_payments_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT,
                CONSTRAINT fk_payments_plan_id FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE RESTRICT,
                INDEX idx_payments_company_id (company_id),
                INDEX idx_payments_status (payment_status),
                INDEX idx_payments_paid_at (paid_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        console.log("Created table: payments");

    } else {
        console.log("payments already exists — skipped.");
    }

    console.log("\nPayments migration complete.");
    process.exit(0);

})().catch((e) => { console.error(e); process.exit(1); });
