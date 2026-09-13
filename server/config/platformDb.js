const { createCompatPool } = require("./pgCompat");
require("dotenv").config();

// ==========================================
// GROWORGS PLATFORM DATABASE CONNECTION
// PostgreSQL version
// ==========================================

const platformPool = createCompatPool({
  host: process.env.PLATFORM_DB_HOST,
  port: process.env.PLATFORM_DB_PORT,
  user: process.env.PLATFORM_DB_USER,
  password: process.env.PLATFORM_DB_PASSWORD,
  database: process.env.PLATFORM_DB_NAME,
  max: 10,
});

// Required by node-postgres: an idle client that hits a background
// error (lost network, DB restart, an admin/FORCE-terminated
// connection elsewhere) emits 'error' on the pool. With no listener,
// Node treats that as an uncaught exception and crashes the whole
// process -- for every tenant, not just the one connection that
// failed. Log and continue; the pool recovers the connection itself.
platformPool.on("error", (err) => {
  console.error("platformPool: unexpected idle client error:", err.message);
});

module.exports = platformPool;
