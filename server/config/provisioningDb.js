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

module.exports = provisioningPool;
