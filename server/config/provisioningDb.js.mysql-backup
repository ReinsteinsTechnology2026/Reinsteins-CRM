const mysql = require("mysql2/promise");
require("dotenv").config();

// ==========================================
// TENANT PROVISIONING CONNECTION (Phase 2C)
//
// A server-level pool with NO fixed `database` -- required for
// CREATE DATABASE / DROP DATABASE / information_schema.SCHEMATA
// existence checks, none of which can run against a connection
// that's pinned to one database.
//
// Uses the PLATFORM_DB_* credentials (Phase 2A), not the tenant
// DB_* credentials from config/db.js. Reasoning: creating a brand
// new tenant database is a platform-level administrative action,
// not something scoped to the existing Reinsteins tenant connection.
// This file does not import config/db.js and never touches the
// existing tenant pool in any way.
// ==========================================

const provisioningPool = mysql.createPool({
    host: process.env.PLATFORM_DB_HOST,
    port: process.env.PLATFORM_DB_PORT,
    user: process.env.PLATFORM_DB_USER,
    password: process.env.PLATFORM_DB_PASSWORD,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
});

module.exports = provisioningPool;
