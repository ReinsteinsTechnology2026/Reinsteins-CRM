// ==========================================
// SUPERSEDED (PostgreSQL migration) -- this is a MySQL-era script;
// its tables/columns were translated into
// schemas/platformSchema.postgresql.sql's "PHASE 10-14 ADDITIONS"
// section instead. Left in place, unconverted, as historical record
// only -- DO NOT RUN this against the current PostgreSQL database
// (its SHOW TABLES/AUTO_INCREMENT/DATABASE() syntax is not valid
// PostgreSQL).
// ==========================================

const platformPool = require("./config/platformDb");

// ==========================================
// SUBSCRIPTION LIFECYCLE MIGRATION (Phase 12)
//
// Idempotent, additive, groworgs_platform_db ONLY -- no tenant
// database is touched. Adds:
//   1. companies.grace_period_ends_at -- the one new column genuinely
//      required for grace-period support (see
//      platformCompanyService.isCompanyAccessAllowed).
//   2. subscription_history -- append-only lifecycle event log AND
//      the durable dedupe store for reminder emails (see
//      subscriptionHistoryService.hasEvent). ON DELETE CASCADE
//      (unlike payments.company_id's RESTRICT) -- a subscription's
//      operational history has no financial/legal retention
//      requirement the way payment records do, so it should never
//      block deleting a company the way real financial records
//      correctly do.
//   3. platform_audit_logs -- Platform Owner action audit trail.
//      company_id is ON DELETE SET NULL, not CASCADE -- an audit log
//      is a record of what the OWNER did, which must survive even if
//      its target company is later deleted.
//   4. platform_notifications -- durable, DB-backed Platform Owner
//      notification feed (distinct from the existing per-tenant
//      `notifications` table, which lives in each tenant's own
//      database and has no concept of cross-company platform events).
// ==========================================

async function columnExists(table, column) {
    const [rows] = await platformPool.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    return rows.length > 0;
}

async function tableExists(table) {
    const [rows] = await platformPool.query(`SHOW TABLES LIKE ?`, [table]);
    return rows.length > 0;
}

(async () => {

    if (!(await columnExists("companies", "grace_period_ends_at"))) {
        await platformPool.query(
            `ALTER TABLE companies ADD COLUMN grace_period_ends_at DATETIME NULL AFTER subscription_expires_at`
        );
        console.log("Added column: companies.grace_period_ends_at");
    } else {
        console.log("companies.grace_period_ends_at already exists — skipped.");
    }

    if (!(await tableExists("subscription_history"))) {
        await platformPool.query(`
            CREATE TABLE subscription_history (
                id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                company_id INT UNSIGNED NOT NULL,
                plan_id INT UNSIGNED NULL,
                event_type VARCHAR(50) NOT NULL,
                previous_status VARCHAR(20) NULL,
                new_status VARCHAR(20) NULL,
                previous_plan_id INT UNSIGNED NULL,
                new_plan_id INT UNSIGNED NULL,
                effective_at DATETIME NULL,
                source VARCHAR(20) NOT NULL DEFAULT 'system',
                reference_payment_id INT UNSIGNED NULL,
                notes VARCHAR(500) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_subhist_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
                CONSTRAINT fk_subhist_payment_id FOREIGN KEY (reference_payment_id) REFERENCES payments(id) ON DELETE SET NULL,
                INDEX idx_subhist_company_id (company_id),
                INDEX idx_subhist_event_type (event_type),
                INDEX idx_subhist_dedupe (company_id, event_type, effective_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log("Created table: subscription_history");
    } else {
        console.log("subscription_history already exists — skipped.");
    }

    if (!(await tableExists("platform_audit_logs"))) {
        await platformPool.query(`
            CREATE TABLE platform_audit_logs (
                id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                platform_user_id INT UNSIGNED NULL,
                action_type VARCHAR(50) NOT NULL,
                target_type VARCHAR(30) NOT NULL,
                target_id INT UNSIGNED NULL,
                company_id INT UNSIGNED NULL,
                metadata JSON NULL,
                ip_address VARCHAR(45) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_audit_platform_user_id FOREIGN KEY (platform_user_id) REFERENCES platform_users(id) ON DELETE SET NULL,
                CONSTRAINT fk_audit_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL,
                INDEX idx_audit_action_type (action_type),
                INDEX idx_audit_company_id (company_id),
                INDEX idx_audit_created_at (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log("Created table: platform_audit_logs");
    } else {
        console.log("platform_audit_logs already exists — skipped.");
    }

    if (!(await tableExists("platform_notifications"))) {
        await platformPool.query(`
            CREATE TABLE platform_notifications (
                id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                platform_user_id INT UNSIGNED NOT NULL,
                title VARCHAR(255) NOT NULL,
                message VARCHAR(1000) NOT NULL,
                type VARCHAR(50) NOT NULL DEFAULT 'general',
                reference_type VARCHAR(30) NULL,
                reference_id INT UNSIGNED NULL,
                company_id INT UNSIGNED NULL,
                is_read BOOLEAN NOT NULL DEFAULT FALSE,
                email_sent_at DATETIME NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_pnotif_platform_user_id FOREIGN KEY (platform_user_id) REFERENCES platform_users(id) ON DELETE CASCADE,
                CONSTRAINT fk_pnotif_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL,
                INDEX idx_pnotif_owner_unread (platform_user_id, is_read),
                INDEX idx_pnotif_created_at (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log("Created table: platform_notifications");
    } else {
        console.log("platform_notifications already exists — skipped.");
    }

    console.log("\nSubscription lifecycle migration complete.");
    process.exit(0);

})().catch((e) => { console.error(e); process.exit(1); });
