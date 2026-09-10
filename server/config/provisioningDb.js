const { Pool } = require("pg");
require("dotenv").config();

// ==========================================
// TENANT PROVISIONING CONNECTION
// PostgreSQL version
//
// This pool intentionally has NO fixed database.
// It is used for PostgreSQL-level administrative
// operations such as CREATE DATABASE / DROP DATABASE.
// ==========================================

const provisioningPool = new Pool({
  host: process.env.PLATFORM_DB_HOST,
  port: process.env.PLATFORM_DB_PORT,
  user: process.env.PLATFORM_DB_USER,
  password: process.env.PLATFORM_DB_PASSWORD,
  database: "postgres",
  max: 5,
});

// Required by node-postgres: an idle client that hits a background
// error (lost network, DB restart, an admin/FORCE-terminated
// connection elsewhere) emits 'error' on the pool. With no listener,
// Node treats that as an uncaught exception and crashes the whole
// process -- for every tenant, not just the one connection that
// failed. Log and continue; the pool recovers the connection itself.
provisioningPool.on("error", (err) => {
  console.error("provisioningPool: unexpected idle client error:", err.message);
});

module.exports = provisioningPool;
