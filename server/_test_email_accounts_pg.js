// Unified email accounts (Gmail, Google Workspace, Outlook.com, Microsoft 365) on REAL PostgreSQL: schema, additive migration, isolation, OAuth
// callback security, encrypted tokens, sync, notifications, push and the unified inbox. The cases live in _email_accounts_pg_cases.js.
//
// Needs a DISPOSABLE PostgreSQL (PG_TEST_* variables, see the guard below); without them the database tests are skipped, and the
// migration-postgres CI job runs them with PG_TEST_REQUIRED=1 so a missing database fails there instead of passing quietly.
// Run: PG_TEST_HOST=127.0.0.1 PG_TEST_PORT=5432 PG_TEST_USER=wh_ci PG_TEST_PASSWORD=... PG_TEST_ADMIN_DB=wh_ci_admin node --test _test_email_accounts_pg.js

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const { createCompatPool } = require("./config/pgCompat");
const { createCompanyFeatureService } = require("./services/companyFeatureService");
const { FEATURE_IDS } = require("./config/tenantFeatures");
const { COMPANY_FEATURES_DDL } = require("./schemas/companyFeaturesDdl");
const migration = require("./_migrate_add_company_features");

const REQUIRED = process.env.PG_TEST_REQUIRED === "1";
const VARIABLES = ["PG_TEST_HOST", "PG_TEST_PORT", "PG_TEST_USER", "PG_TEST_PASSWORD", "PG_TEST_ADMIN_DB"];
const MISSING = VARIABLES.filter((name) => !process.env[name]);
const SKIP = !REQUIRED && MISSING.length > 0 ? "PG_TEST_* variables are not set (this test runs in the pr-checks migration-postgres job)" : false;

// ---------------------------------------------------------------- the guard (same rules as _test_smart_sheets_pg.js)
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const TEST_NAME = /^wh_ci(_[a-z0-9]+)*$/;
const DISPOSABLE_DATABASE = /^(postgres|template0|template1|wh_ci(_[a-z0-9]+)*|wh_test_[0-9a-f]{10}(_[a-z]+)?)$/;

function assertDisposableTarget(config, appEnv = process.env) {
    if (!LOOPBACK.has(config.host)) throw new Error("PG_TEST_HOST must be a loopback address");
    if (!/^\d{1,5}$/.test(String(config.port)) || Number(config.port) < 1 || Number(config.port) > 65535) throw new Error("PG_TEST_PORT must be a port number");
    if (!TEST_NAME.test(config.user || "")) throw new Error("PG_TEST_USER must be a wh_ci* test user");
    if (!TEST_NAME.test(config.adminDb || "")) throw new Error("PG_TEST_ADMIN_DB must be a wh_ci* test database");
    for (const [host, port, user] of [["PLATFORM_DB_HOST", "PLATFORM_DB_PORT", "PLATFORM_DB_USER"], ["DB_HOST", "DB_PORT", "DB_USER"]]) {
        const sameServer = appEnv[host] && appEnv[host] === config.host && String(appEnv[port] || 5432) === String(config.port);
        if (sameServer || (appEnv[user] && appEnv[user] === config.user)) throw new Error("the PG_TEST_* settings match the application's own database settings");
    }
}
function assertOnlyDisposableDatabases(names) {
    const unexpected = names.filter((name) => !DISPOSABLE_DATABASE.test(name));
    if (unexpected.length) throw new Error(`the server holds ${unexpected.length} database(s) that are not disposable test databases`);
}

test("guard: only a loopback server with wh_ci* names that is not the application database is accepted", () => {
    const good = { host: "127.0.0.1", port: "5432", user: "wh_ci", adminDb: "wh_ci_admin" };
    assert.doesNotThrow(() => assertDisposableTarget(good, {}));
    for (const [setting, value] of [["host", "db.example.com"], ["user", "postgres"], ["adminDb", "postgres"]]) assert.throws(() => assertDisposableTarget({ ...good, [setting]: value }, {}));
    assert.throws(() => assertDisposableTarget(good, { PLATFORM_DB_HOST: "127.0.0.1", PLATFORM_DB_PORT: "5432" }), /application's own/);
    for (const bad of ["groworgs_platform_db", "tenant_reinsteins"]) assert.throws(() => assertOnlyDisposableDatabases(["postgres", bad]), (error) => !error.message.includes(bad));
});

// ---------------------------------------------------------------- connection
let target = null;
let admin = null;
const databases = [];
const pools = [];
const newName = () => `wh_test_${crypto.randomBytes(5).toString("hex")}`;
const compat = (database) => {
    const pool = createCompatPool({ host: target.host, port: Number(target.port), user: target.user, password: target.password, database, max: 4, connectionTimeoutMillis: 10000 });
    pool.on("error", () => {});
    pools.push(pool);
    return pool;
};

const SCHEMA = fs.readFileSync(path.join(__dirname, "schemas", "platformSchema.postgresql.sql"), "utf8").replace(/\r\n/g, "\n");
const DDL_NORMALISED = COMPANY_FEATURES_DDL.replace(/\r\n/g, "\n");

async function newPlatformDatabase({ withFeatureTable }) {
    const name = newName();
    await admin.query(`CREATE DATABASE ${name}`);
    databases.push(name);
    const pool = compat(name);
    // simple query protocol: the schema file has DO $$ ... END $$ blocks
    await pool.nativePool.query(withFeatureTable ? SCHEMA : SCHEMA.replace(DDL_NORMALISED, ""));
    return pool;
}
const addCompany = async (pool, slug) => (await pool.query(`INSERT INTO companies (company_name, company_slug, status) VALUES (?, ?, 'active') RETURNING id`, [slug.toUpperCase(), slug]))[0][0].id;


// The platform schema as a brand-new database gets it (with the Microsoft block), or as a database provisioned BEFORE this
// feature has it (without), which is what the migration must upgrade.
const FULL_SCHEMA = fs.readFileSync(path.join(__dirname, "schemas", "platformSchema.postgresql.sql"), "utf8").replace(/\r\n/g, "\n");
const MS_MARKER = "-- ==========================================\n-- EMAIL ACCOUNTS (PLATFORM DB)";
const LEGACY_SCHEMA = FULL_SCHEMA.slice(0, FULL_SCHEMA.indexOf(MS_MARKER));

async function newPlatformDatabase({ withAccountsSchema }) {
    const name = newName();
    await admin.query(`CREATE DATABASE ${name}`);
    databases.push(name);
    const pool = compat(name);
    // simple query protocol: the schema file has DO $$ ... END $$ blocks
    await pool.nativePool.query(withAccountsSchema ? FULL_SCHEMA : LEGACY_SCHEMA);
    return pool;
}

test("setup: the configured server is the disposable PostgreSQL service (guard + database list)", { skip: SKIP }, async () => {
    assert.deepEqual(MISSING, [], `missing configuration: ${MISSING.join(", ")}`);
    const config = { host: process.env.PG_TEST_HOST, port: process.env.PG_TEST_PORT, user: process.env.PG_TEST_USER, password: process.env.PG_TEST_PASSWORD, adminDb: process.env.PG_TEST_ADMIN_DB };
    assertDisposableTarget(config);
    const pool = new Pool({ host: config.host, port: Number(config.port), user: config.user, password: config.password, database: config.adminDb, max: 2, connectionTimeoutMillis: 10000 });
    pool.on("error", () => {});
    try {
        const { rows } = await pool.query("SELECT datname FROM pg_database");
        assertOnlyDisposableDatabases(rows.map((row) => row.datname));
    } catch (error) {
        await pool.end().catch(() => {});
        if (/not disposable test databases/.test(error.message)) throw error;
        throw new Error(`could not use the disposable PostgreSQL service (${error.code || "error"})`);
    }
    target = config;
    admin = pool;
});

test.after(async () => {
    for (const pool of pools) await Promise.resolve(pool.end()).catch(() => {});
    if (!admin) return;
    for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
});

require("./_email_accounts_pg_cases").defineCases({
    test: (name, fn) => test(name, { skip: SKIP }, fn),
    newPlatformDatabase,
});
