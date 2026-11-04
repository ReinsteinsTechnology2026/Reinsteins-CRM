// Tenant feature management on REAL PostgreSQL: the company_features table, the platform schema file, the migration and its
// backfill for companies that already exist, persistence, rollback, isolation between companies, cascade on delete.
//
// Needs a DISPOSABLE PostgreSQL (PG_TEST_* variables, see the guard below); without them the database tests are skipped, and the
// migration-postgres CI job runs them with PG_TEST_REQUIRED=1 so a missing database fails there instead of passing quietly.
// Run: PG_TEST_HOST=127.0.0.1 PG_TEST_PORT=5432 PG_TEST_USER=wh_ci PG_TEST_PASSWORD=... PG_TEST_ADMIN_DB=wh_ci_admin node --test _test_company_features_pg.js

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
const featureRows = async (pool, companyId) => (await pool.query(`SELECT feature_id, enabled FROM company_features WHERE company_id = ? ORDER BY feature_id`, [companyId]))[0];

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

// ---------------------------------------------------------------- tests

test("a NEW platform database (the full schema file) contains company_features with the right shape", { skip: SKIP }, async () => {
    const pool = await newPlatformDatabase({ withFeatureTable: true });
    const [columns] = await pool.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'company_features' ORDER BY ordinal_position`);
    assert.deepEqual(columns.map((c) => c.column_name), ["company_id", "feature_id", "enabled", "updated_by", "updated_at"]);
    assert.equal(columns.find((c) => c.column_name === "enabled").data_type, "boolean");
    const [keys] = await pool.query(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = 'company_features'::regclass AND i.indisprimary ORDER BY a.attname`);
    assert.deepEqual(keys.map((k) => k.attname), ["company_id", "feature_id"], "one row per (company, feature)");
    const [fk] = await pool.query(`SELECT confdeltype FROM pg_constraint WHERE conname = 'fk_company_features_company_id'`);
    assert.equal(fk[0].confdeltype, "c", "ON DELETE CASCADE");
});

test("PERSISTENCE: a company created with a selection stores exactly that selection (every module has an explicit row)", { skip: SKIP }, async () => {
    const pool = await newPlatformDatabase({ withFeatureTable: true });
    const service = createCompanyFeatureService({ pool });
    const a = await addCompany(pool, "company_a");
    const selection = ["dashboard", "employee_management", "attendance", "task_management"];
    const { before, after } = await service.setCompanyFeatures(a, selection, null);
    assert.deepEqual(before, FEATURE_IDS, "an unconfigured company had every module");
    assert.deepEqual(after, selection);

    const rows = await featureRows(pool, a);
    assert.equal(rows.length, FEATURE_IDS.length, "one row per catalog feature, enabled or not");
    assert.deepEqual(rows.filter((r) => r.enabled).map((r) => r.feature_id).sort(), [...selection].sort());
    assert.ok(rows.filter((r) => !r.enabled).every((r) => !selection.includes(r.feature_id)));
    assert.deepEqual((await service.getFeatureStates(a)).enabled, selection);

    // a brand-new company with only a few modules
    const small = await addCompany(pool, "small_co");
    await service.setCompanyFeatures(small, ["dashboard", "sops"], null);
    assert.deepEqual((await service.getFeatureStates(small)).enabled, ["dashboard", "sops"]);
});

test("UPDATING: enable more, disable some; only company_features changes; re-enabling brings the module back", { skip: SKIP }, async () => {
    const pool = await newPlatformDatabase({ withFeatureTable: true });
    const service = createCompanyFeatureService({ pool, now: () => 0 });
    const a = await addCompany(pool, "company_a");
    await service.setCompanyFeatures(a, ["dashboard", "employee_management", "task_management"], 7);
    const companiesBefore = JSON.stringify((await pool.query(`SELECT * FROM companies ORDER BY id`))[0]);

    const change = await service.setCompanyFeatures(a, ["dashboard", "employee_management", "chat", "meetings"], 7);
    assert.deepEqual(change.before, ["dashboard", "employee_management", "task_management"]);
    assert.deepEqual(change.after, ["dashboard", "employee_management", "chat", "meetings"]);
    assert.equal((await service.getFeatureStates(a)).enabled.includes("task_management"), false, "disabled, and visible at once (cache invalidated)");
    assert.equal(JSON.stringify((await pool.query(`SELECT * FROM companies ORDER BY id`))[0]), companiesBefore, "the company record itself is untouched");
    assert.ok((await featureRows(pool, a)).every((row) => row.feature_id));
    assert.equal((await pool.query(`SELECT updated_by FROM company_features WHERE company_id = ? AND feature_id = 'chat'`, [a]))[0][0].updated_by, 7, "who changed it is recorded");

    await service.setCompanyFeatures(a, ["dashboard", "employee_management", "task_management"], 7); // task management back on
    assert.equal((await service.getFeatureStates(a)).enabled.includes("task_management"), true);
});

test("A failed write rolls back completely: the previous selection is intact (all-or-nothing)", { skip: SKIP }, async () => {
    const pool = await newPlatformDatabase({ withFeatureTable: true });
    const service = createCompanyFeatureService({ pool });
    const a = await addCompany(pool, "company_a");
    await service.setCompanyFeatures(a, ["dashboard", "chat"], null);
    const snapshot = JSON.stringify(await featureRows(pool, a));

    // a company that does not exist violates the foreign key on the first row written
    await assert.rejects(() => service.setCompanyFeatures(99999, ["dashboard"], null), /foreign key|violates/i);
    assert.equal((await featureRows(pool, 99999)).length, 0, "nothing was written for the unknown company");
    assert.equal(JSON.stringify(await featureRows(pool, a)), snapshot, "and the existing company is untouched");
});

test("ISOLATION: changing Company A's features never changes Company B's", { skip: SKIP }, async () => {
    const pool = await newPlatformDatabase({ withFeatureTable: true });
    const service = createCompanyFeatureService({ pool });
    const a = await addCompany(pool, "company_a");
    const b = await addCompany(pool, "company_b");
    await service.setCompanyFeatures(a, ["dashboard", "attendance"], null);
    await service.setCompanyFeatures(b, ["dashboard", "chat", "smart_sheets"], null);
    const bBefore = JSON.stringify(await featureRows(pool, b));

    await service.setCompanyFeatures(a, ["dashboard"], null);
    assert.equal(JSON.stringify(await featureRows(pool, b)), bBefore);
    assert.deepEqual((await service.getFeatureStates(b)).enabled, ["dashboard", "chat", "smart_sheets"]);
    assert.deepEqual((await service.getFeatureStates(a)).enabled, ["dashboard"]);
});

test("EXISTING TENANTS: migrating a platform database that predates the table gives every existing company every module", { skip: SKIP }, async () => {
    const pool = await newPlatformDatabase({ withFeatureTable: false });
    assert.equal((await pool.query(`SELECT to_regclass('company_features') AS t`))[0][0].t, null, "the old database has no such table");
    const old = [await addCompany(pool, "reinsteins"), await addCompany(pool, "legacy_one"), await addCompany(pool, "legacy_two")];

    const result = await migration.migrate(pool);
    assert.equal(result.existed, false);
    assert.equal(result.backfilled, 3);

    const service = createCompanyFeatureService({ pool });
    for (const id of old) {
        assert.deepEqual((await service.getFeatureStates(id)).enabled, FEATURE_IDS, `company ${id} keeps every module`);
        assert.equal((await featureRows(pool, id)).length, FEATURE_IDS.length);
    }
});

test("MIGRATION is idempotent and never overrides the Owner: a re-run keeps a disabled module disabled and leaves configured companies alone", { skip: SKIP }, async () => {
    const pool = await newPlatformDatabase({ withFeatureTable: false });
    const a = await addCompany(pool, "company_a");
    await migration.migrate(pool);
    const service = createCompanyFeatureService({ pool });
    await service.setCompanyFeatures(a, ["dashboard", "employee_management"], 1); // the Owner narrows it afterwards

    const again = await migration.migrate(pool);
    assert.equal(again.existed, true);
    assert.equal(again.backfilled, 0, "nothing to backfill: the company already has rows");
    service.invalidate();
    assert.deepEqual((await service.getFeatureStates(a)).enabled, ["dashboard", "employee_management"], "the Owner's choice survived the second run");

    // a company added later without rows is picked up by the next run (it would be read as 'every module' anyway)
    const later = await addCompany(pool, "later_co");
    assert.equal((await migration.migrate(pool)).backfilled, 1);
    assert.equal((await featureRows(pool, later)).length, FEATURE_IDS.length);
});

test("MIGRATION works on a database that already has the new schema, and twice at the same moment", { skip: SKIP }, async () => {
    const pool = await newPlatformDatabase({ withFeatureTable: true });
    await addCompany(pool, "company_a");
    const results = await Promise.all([migration.migrate(pool), migration.migrate(pool), migration.migrate(pool)]);
    assert.ok(results.every((r) => r.existed === true));
    assert.equal((await featureRows(pool, 1)).length, FEATURE_IDS.length, "exactly one set of rows, no duplicates, no failure");
});

test("deleting a company removes its feature rows (cascade) and nobody else's", { skip: SKIP }, async () => {
    const pool = await newPlatformDatabase({ withFeatureTable: true });
    const service = createCompanyFeatureService({ pool });
    const a = await addCompany(pool, "company_a");
    const b = await addCompany(pool, "company_b");
    await service.setCompanyFeatures(a, ["dashboard"], null);
    await service.setCompanyFeatures(b, ["dashboard", "chat"], null);
    await pool.query(`DELETE FROM companies WHERE id = ?`, [a]);
    assert.equal((await featureRows(pool, a)).length, 0);
    assert.equal((await featureRows(pool, b)).length, FEATURE_IDS.length);
});

test("a feature that was added to the catalog after a company was configured stays OFF for that company", { skip: SKIP }, async () => {
    const pool = await newPlatformDatabase({ withFeatureTable: true });
    const service = createCompanyFeatureService({ pool });
    const a = await addCompany(pool, "company_a");
    await service.setCompanyFeatures(a, ["dashboard", "chat", "email"], null);
    await pool.query(`DELETE FROM company_features WHERE company_id = ? AND feature_id = 'email'`, [a]); // as if 'email' did not exist yet
    service.invalidate();
    assert.deepEqual((await service.getFeatureStates(a)).enabled, ["dashboard", "chat"]);
});
