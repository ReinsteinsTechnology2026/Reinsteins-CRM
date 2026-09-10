const mysql = require("mysql2/promise");
require("dotenv").config();

// ==========================================
// SUPERSEDED (Phase 4, PostgreSQL migration) -- this script connects
// via raw mysql2 and is NOT PostgreSQL-compatible; it has NOT been
// converted. Its job (creating demo_requests) is now done in one
// pass by _setup_platform_db.js against
// schemas/platformSchema.postgresql.sql. Do not run this script
// against the PostgreSQL database. Left in place only as historical
// record of the original migration.
// ==========================================

// ==========================================
// DEMO REQUESTS TABLE — SETUP (Phase 6)
//
// Creates ONE new table, `demo_requests`, inside the existing
// groworgs_platform_db -- never touches `companies` or
// `platform_users`, never touches any tenant database, never touches
// reinsteins_workhub. Idempotent: CREATE TABLE IF NOT EXISTS, safe to
// re-run, mirrors the exact convention already used by
// _setup_platform_db.js / _migrate_add_organizations.js.
//
// Deliberately its OWN table, not a repurposed corner of `companies`:
// a demo request is a sales lead, not a company -- keeping the two
// physically separate is what makes "submitting this form can never
// create a company" true by construction, not just by controller
// logic (see controllers/publicController.js).
// ==========================================

const DB_NAME = process.env.PLATFORM_DB_NAME || "groworgs_platform_db";

async function tableExists(connection, table) {
    const [rows] = await connection.query(`SHOW TABLES LIKE ?`, [table]);
    return rows.length > 0;
}

(async () => {

    const connection = await mysql.createConnection({
        host: process.env.PLATFORM_DB_HOST,
        port: process.env.PLATFORM_DB_PORT,
        user: process.env.PLATFORM_DB_USER,
        password: process.env.PLATFORM_DB_PASSWORD,
        database: DB_NAME,
    });

    if (!(await tableExists(connection, "demo_requests"))) {

        await connection.query(`
            CREATE TABLE demo_requests (
                id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(150) NOT NULL,
                company_name VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL,
                phone VARCHAR(30) NULL,
                employee_count VARCHAR(50) NULL,
                message TEXT NULL,
                status ENUM('new', 'contacted', 'closed') NOT NULL DEFAULT 'new',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT chk_demo_requests_email CHECK (email LIKE '%_@__%.__%')
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await connection.query(`CREATE INDEX idx_demo_requests_status ON demo_requests (status)`);
        await connection.query(`CREATE INDEX idx_demo_requests_created_at ON demo_requests (created_at)`);

        console.log("Created table: demo_requests");

    } else {
        console.log("demo_requests already exists — skipped.");
    }

    console.log("\nDemo requests table setup complete.");

    await connection.end();
    process.exit(0);

})().catch((e) => { console.error(e); process.exit(1); });
