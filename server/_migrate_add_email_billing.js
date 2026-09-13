const platformPool = require("./config/platformDb");

// ==========================================
// EMAIL / BILLING CONTACT MIGRATION (Phase 13)
//
// Idempotent, additive, groworgs_platform_db ONLY -- no tenant
// database is touched. Adds:
//   1. companies.billing_contact_name/email/phone -- platform-level
//      SaaS metadata, not tenant employee data (see Phase 13A: "must
//      NOT require modifying tenant employee data").
//   2. email_delivery_logs -- durable, real delivery history. Stores
//      `template_data` (small JSON of the values a template needs),
//      NOT the rendered HTML body -- enough to regenerate the exact
//      same email for a retry, without unnecessarily storing full
//      email bodies (Phase 13C's explicit guidance).
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

    if (!(await columnExists("companies", "billing_contact_name"))) {
        await platformPool.query(`ALTER TABLE companies ADD COLUMN billing_contact_name VARCHAR(255) NULL AFTER grace_period_ends_at`);
        console.log("Added column: companies.billing_contact_name");
    } else {
        console.log("companies.billing_contact_name already exists — skipped.");
    }

    if (!(await columnExists("companies", "billing_contact_email"))) {
        await platformPool.query(`ALTER TABLE companies ADD COLUMN billing_contact_email VARCHAR(255) NULL AFTER billing_contact_name`);
        console.log("Added column: companies.billing_contact_email");
    } else {
        console.log("companies.billing_contact_email already exists — skipped.");
    }

    if (!(await columnExists("companies", "billing_contact_phone"))) {
        await platformPool.query(`ALTER TABLE companies ADD COLUMN billing_contact_phone VARCHAR(30) NULL AFTER billing_contact_email`);
        console.log("Added column: companies.billing_contact_phone");
    } else {
        console.log("companies.billing_contact_phone already exists — skipped.");
    }

    if (!(await tableExists("email_delivery_logs"))) {
        await platformPool.query(`
            CREATE TABLE email_delivery_logs (
                id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                company_id INT UNSIGNED NULL,
                recipient_email VARCHAR(255) NULL,
                recipient_name VARCHAR(255) NULL,
                email_type VARCHAR(50) NOT NULL,
                subject VARCHAR(255) NOT NULL,
                template_data JSON NULL,
                status ENUM('pending', 'sent', 'failed', 'skipped') NOT NULL DEFAULT 'pending',
                provider_message_id VARCHAR(255) NULL,
                error_message VARCHAR(500) NULL,
                retry_count INT UNSIGNED NOT NULL DEFAULT 0,
                last_attempt_at DATETIME NULL,
                sent_at DATETIME NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                CONSTRAINT fk_emaillog_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL,
                INDEX idx_emaillog_company_id (company_id),
                INDEX idx_emaillog_status (status),
                INDEX idx_emaillog_email_type (email_type),
                INDEX idx_emaillog_created_at (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log("Created table: email_delivery_logs");
    } else {
        console.log("email_delivery_logs already exists — skipped.");
    }

    console.log("\nEmail/billing migration complete.");
    process.exit(0);

})().catch((e) => { console.error(e); process.exit(1); });
