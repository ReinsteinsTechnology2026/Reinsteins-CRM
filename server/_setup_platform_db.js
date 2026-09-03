const mysql = require("mysql2/promise");
require("dotenv").config();

// ==========================================
// GROWORGS PLATFORM DATABASE — SETUP (Phase 2A)
//
// Creates the platform-level database and its
// two foundation tables:
//   - companies       (which companies exist on
//                       GrowOrgs, their status and
//                       access type)
//   - platform_users  (GrowOrgs Platform Owners --
//                       NOT tenant employees, NOT
//                       stored in the existing
//                       `users` table)
//
// This script ONLY ever connects to/creates
// PLATFORM_DB_NAME (default groworgs_platform_db).
// It never opens a connection to the existing
// tenant database and never touches any of its
// 37 tables.
//
// Idempotent: safe to run more than once. Uses
// CREATE TABLE IF NOT EXISTS and re-runnable
// existence checks throughout, mirroring the
// existing _migrate_add_organizations.js convention.
// ==========================================

const DB_NAME = process.env.PLATFORM_DB_NAME || "groworgs_platform_db";

// Env-config-controlled, not user input -- still validated defensively
// before being interpolated into a CREATE DATABASE/USE statement, since
// those can't take a bound `?` placeholder for an identifier.
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(DB_NAME)) {
    console.error(`Refusing to run: PLATFORM_DB_NAME "${DB_NAME}" is not a safe identifier.`);
    process.exit(1);
}

async function tableExists(connection, table) {
    const [rows] = await connection.query(`SHOW TABLES LIKE ?`, [table]);
    return rows.length > 0;
}

(async () => {

    // ==========================================
    // 1. Bootstrap connection -- NO database
    // selected yet, so we can CREATE DATABASE
    // IF NOT EXISTS regardless of whether it
    // already exists.
    // ==========================================

    const bootstrap = await mysql.createConnection({
        host: process.env.PLATFORM_DB_HOST,
        port: process.env.PLATFORM_DB_PORT,
        user: process.env.PLATFORM_DB_USER,
        password: process.env.PLATFORM_DB_PASSWORD,
    });

    await bootstrap.query(
        `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    console.log(`Database "${DB_NAME}" ready.`);

    await bootstrap.end();

    // ==========================================
    // 2. Real connection, scoped to the platform
    // database only.
    // ==========================================

    const connection = await mysql.createConnection({
        host: process.env.PLATFORM_DB_HOST,
        port: process.env.PLATFORM_DB_PORT,
        user: process.env.PLATFORM_DB_USER,
        password: process.env.PLATFORM_DB_PASSWORD,
        database: DB_NAME,
    });

    // ==========================================
    // 3. companies
    //
    // tenant_db_name is deliberately included even
    // though it wasn't in the suggested field list --
    // this table's stated future job (Platform Owner
    // -> Create Company -> Create Tenant Database ->
    // ... -> Activate Company) requires somewhere to
    // record which physical tenant database a company
    // maps to. Left NULL until a later phase actually
    // creates/links a tenant database -- nothing in
    // this phase writes to it beyond leaving it NULL
    // for the Reinsteins seed row below.
    // ==========================================

    if (!(await tableExists(connection, "companies"))) {

        await connection.query(`
            CREATE TABLE companies (
                id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                company_name VARCHAR(255) NOT NULL,
                company_slug VARCHAR(100) NOT NULL,
                status ENUM('active', 'suspended', 'pending') NOT NULL DEFAULT 'pending',
                access_type ENUM('complimentary', 'trial', 'paid') NOT NULL DEFAULT 'trial',
                tenant_db_name VARCHAR(64) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                CONSTRAINT uq_companies_slug UNIQUE (company_slug)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        console.log("Created table: companies");

    } else {
        console.log("companies already exists — skipped.");
    }

    // ==========================================
    // 4. platform_users
    //
    // Entirely separate from the tenant `users`
    // table -- GrowOrgs Platform Owners are not
    // company employees/admins and never will be
    // rows in any tenant database.
    // ==========================================

    if (!(await tableExists(connection, "platform_users"))) {

        await connection.query(`
            CREATE TABLE platform_users (
                id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role ENUM('platform_owner') NOT NULL DEFAULT 'platform_owner',
                status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                CONSTRAINT uq_platform_users_email UNIQUE (email)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        console.log("Created table: platform_users");

    } else {
        console.log("platform_users already exists — skipped.");
    }

    // ==========================================
    // 5. SEED: Reinsteins Technology as a platform
    // company record ONLY. This writes exclusively
    // to the new groworgs_platform_db -- it does
    // not touch, migrate, rename, or connect to the
    // existing tenant database in any way. Status is
    // 'active' (it's the live, currently-operating
    // company); tenant_db_name stays NULL until a
    // later phase actually performs the tenant
    // migration.
    // ==========================================

    const [[existingCompany]] = await connection.query(
        `SELECT id FROM companies WHERE company_slug = 'reinsteins' LIMIT 1`
    );

    if (existingCompany) {

        console.log(`Company "reinsteins" already exists (id=${existingCompany.id}) — skipped.`);

    } else {

        const [result] = await connection.query(
            `INSERT INTO companies (company_name, company_slug, status, access_type, tenant_db_name)
             VALUES (?, ?, 'active', 'complimentary', NULL)`,
            ["Reinsteins Technology", "reinsteins"]
        );

        console.log(`Created company record: "Reinsteins Technology" (slug=reinsteins, id=${result.insertId}, access_type=complimentary, tenant_db_name=NULL)`);

    }

    console.log("\nPlatform DB setup complete.");

    await connection.end();
    process.exit(0);

})().catch((e) => { console.error(e); process.exit(1); });
