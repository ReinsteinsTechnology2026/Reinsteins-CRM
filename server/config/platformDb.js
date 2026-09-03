const mysql = require("mysql2/promise");
require("dotenv").config();

// ==========================================
// GROWORGS PLATFORM DATABASE CONNECTION
//
// Completely separate from config/db.js (the
// existing tenant/Reinsteins connection). This
// pool only ever points at the platform-level
// database (companies, platform_users, and any
// future platform metadata) -- never at tenant
// business data. The two pools share no state
// and use independent env vars, so tenant DB
// credentials are never required to run platform
// queries and vice versa.
// ==========================================

const platformPool = mysql.createPool({
  host: process.env.PLATFORM_DB_HOST,
  port: process.env.PLATFORM_DB_PORT,
  user: process.env.PLATFORM_DB_USER,
  password: process.env.PLATFORM_DB_PASSWORD,
  database: process.env.PLATFORM_DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

module.exports = platformPool;
