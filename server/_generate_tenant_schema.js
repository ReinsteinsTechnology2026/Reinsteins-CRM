require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

// ==========================================
// GENERATE TENANT SCHEMA (Phase 2C)
//
// READ-ONLY against the existing tenant database (DB_NAME). Runs
// nothing but SHOW CREATE TABLE / information_schema SELECTs against
// it -- never INSERT, UPDATE, DELETE, ALTER, or DROP.
//
// Produces server/schemas/tenantSchema.sql: a canonical, versioned
// snapshot of the tenant DDL (tables only -- this schema has no
// views/triggers/routines/events, confirmed separately). This file,
// not a live connection to the source database, is what
// tenantProvisioningService.js applies when creating a new tenant
// database. That keeps ordinary provisioning runs from ever touching
// the real tenant database at all.
//
// Re-run this script (from server/) whenever the tenant schema
// changes and the canonical snapshot needs to catch up:
//
//   node _generate_tenant_schema.js
//
// It only ever reads DB_NAME (the existing tenant DB) and only ever
// writes schemas/tenantSchema.sql on disk.
// ==========================================

const OUTPUT_PATH = path.join(__dirname, "schemas", "tenantSchema.sql");

(async () => {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    const [tables] = await conn.query(
        `SELECT TABLE_NAME FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
         ORDER BY TABLE_NAME`,
        [process.env.DB_NAME]
    );

    if (tables.length === 0) {
        console.error("No tables found -- refusing to write an empty schema file.");
        process.exit(1);
    }

    const statements = [];

    for (const { TABLE_NAME } of tables) {
        const [[row]] = await conn.query(`SHOW CREATE TABLE \`${TABLE_NAME}\``);
        // Strip the source DB's current AUTO_INCREMENT value -- a fresh
        // tenant database must start its own counters at 1, not inherit
        // Reinsteins' current row-count position.
        const ddl = row["Create Table"].replace(/ AUTO_INCREMENT=\d+/, "");
        statements.push(ddl + ";");
    }

    await conn.end();

    const header =
        `-- ==========================================\n` +
        `-- GROWORGS CANONICAL TENANT SCHEMA (Phase 2C)\n` +
        `-- Generated ${new Date().toISOString()} via SHOW CREATE TABLE\n` +
        `-- against the live tenant database "${process.env.DB_NAME}".\n` +
        `-- Source table count: ${tables.length}\n` +
        `--\n` +
        `-- This file contains STRUCTURE ONLY -- no rows, no business\n` +
        `-- data. It is applied verbatim to a freshly created, empty\n` +
        `-- tenant database by tenantProvisioningService.js.\n` +
        `--\n` +
        `-- Regenerate with: node _generate_tenant_schema.js\n` +
        `-- ==========================================\n\n` +
        `SET FOREIGN_KEY_CHECKS=0;\n\n`;

    const footer = `\nSET FOREIGN_KEY_CHECKS=1;\n`;

    const sql = header + statements.join("\n\n") + footer;

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, sql, "utf8");

    console.log(`Wrote ${tables.length} CREATE TABLE statements to ${OUTPUT_PATH}`);
})();
