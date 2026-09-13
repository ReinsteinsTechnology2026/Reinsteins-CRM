const platformPool = require("./config/platformDb");

// ==========================================
// SECURITY HARDENING MIGRATION (Phase 14)
//
// Idempotent, additive, groworgs_platform_db ONLY -- no tenant
// database is touched. Scoped to platform_users only: account
// lockout, TOTP-based 2FA, and token versioning are implemented for
// the Platform Owner account specifically (see Phase 14 report for
// why this scope was chosen over extending per-account lockout to
// every tenant's own `users` table).
//
//   failed_login_attempts / locked_until  -- account lockout (Part B)
//   totp_secret / totp_enabled / backup_codes -- 2FA (Part D). Backup
//     codes are stored as a JSON array of BCRYPT HASHES, never plain
//     text -- same as a password, one-way only.
//   token_version -- incremented on password change / 2FA enable /
//     2FA disable, so an already-issued JWT can be invalidated after
//     a security-relevant event without needing a server-side session
//     store (Part E).
//   last_login_at / last_failed_login_at -- real audit-trail dates,
//     not synthetic.
// ==========================================

async function columnExists(table, column) {
    const [rows] = await platformPool.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    return rows.length > 0;
}

async function addColumnIfMissing(table, column, definition) {
    if (!(await columnExists(table, column))) {
        await platformPool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        console.log(`Added column: ${table}.${column}`);
    } else {
        console.log(`${table}.${column} already exists — skipped.`);
    }
}

(async () => {

    await addColumnIfMissing("platform_users", "failed_login_attempts", "INT UNSIGNED NOT NULL DEFAULT 0");
    await addColumnIfMissing("platform_users", "locked_until", "DATETIME NULL");
    await addColumnIfMissing("platform_users", "last_login_at", "DATETIME NULL");
    await addColumnIfMissing("platform_users", "last_failed_login_at", "DATETIME NULL");
    await addColumnIfMissing("platform_users", "totp_secret", "VARCHAR(255) NULL");
    await addColumnIfMissing("platform_users", "totp_enabled", "BOOLEAN NOT NULL DEFAULT FALSE");
    await addColumnIfMissing("platform_users", "backup_codes", "JSON NULL");
    await addColumnIfMissing("platform_users", "token_version", "INT UNSIGNED NOT NULL DEFAULT 0");

    console.log("\nSecurity hardening migration complete.");
    process.exit(0);

})().catch((e) => { console.error(e); process.exit(1); });
