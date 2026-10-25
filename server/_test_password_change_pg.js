// Mandatory password change: the REAL migration SQL (server/_migrate_add_must_change_password.js) run against a
// REAL PostgreSQL server. _test_password_change.js covers the same script with scripted fake pools; this file is
// the part those fakes cannot prove (ALTER ... IF NOT EXISTS, the backfill WHERE, pg_has_role, advisory lock,
// transactional rollback, real error codes).
//
// SAFETY -- this file only ever talks to a DISPOSABLE server, and refuses everything else before connecting:
//   * it never reads server/.env or the application's configuration; the server comes ONLY from PG_TEST_* variables;
//   * the host must be loopback, the user and the maintenance database must be named wh_ci*, and the variables must
//     not match the application's own PLATFORM_DB_* / DB_* settings;
//   * after connecting, EVERY database on the server must be postgres, a template, wh_ci* or a wh_test_* database
//     this run created -- a server that holds anything else (e.g. a real application database) is refused;
//   * all work happens in throw-away wh_test_<random> databases, dropped at the end.
// Nothing in a failure message repeats a host, user, database name or password.
//
// Runs in the pr-checks "migration-postgres" job (PostgreSQL service container, PG_TEST_REQUIRED=1: missing
// configuration FAILS there). Without PG_TEST_* variables the database tests are skipped (the guard tests still run).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { createCompatPool } = require('./config/pgCompat');
const migration = require('./_migrate_add_must_change_password');

const REQUIRED = process.env.PG_TEST_REQUIRED === '1';
const VARIABLES = ['PG_TEST_HOST', 'PG_TEST_PORT', 'PG_TEST_USER', 'PG_TEST_PASSWORD', 'PG_TEST_ADMIN_DB'];
const MISSING = VARIABLES.filter((name) => !process.env[name]);
const SKIP = !REQUIRED && MISSING.length > 0 ? 'PG_TEST_* variables are not set (this test runs in the pr-checks migration-postgres job)' : false;

// ---------------------------------------------------------------- the guard (no connection is made by these)
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const TEST_NAME = /^wh_ci(_[a-z0-9]+)*$/;
const DISPOSABLE_DATABASE = /^(postgres|template0|template1|wh_ci(_[a-z0-9]+)*|wh_test_[0-9a-f]{10}(_[a-z]+)?)$/;

function assertDisposableTarget(config, appEnv = process.env) {
  if (!LOOPBACK.has(config.host)) throw new Error('PG_TEST_HOST must be a loopback address');
  if (!/^\d{1,5}$/.test(String(config.port)) || Number(config.port) < 1 || Number(config.port) > 65535) throw new Error('PG_TEST_PORT must be a port number');
  if (!TEST_NAME.test(config.user || '')) throw new Error('PG_TEST_USER must be a wh_ci* test user');
  if (!TEST_NAME.test(config.adminDb || '')) throw new Error('PG_TEST_ADMIN_DB must be a wh_ci* test database');
  for (const [host, port, user] of [['PLATFORM_DB_HOST', 'PLATFORM_DB_PORT', 'PLATFORM_DB_USER'], ['DB_HOST', 'DB_PORT', 'DB_USER']]) {
    const sameServer = appEnv[host] && appEnv[host] === config.host && String(appEnv[port] || 5432) === String(config.port);
    if (sameServer || (appEnv[user] && appEnv[user] === config.user)) throw new Error('the PG_TEST_* settings match the application\'s own database settings');
  }
}

function assertOnlyDisposableDatabases(names) {
  const unexpected = names.filter((name) => !DISPOSABLE_DATABASE.test(name));
  if (unexpected.length) throw new Error(`the server holds ${unexpected.length} database(s) that are not disposable test databases`);
}

test('guard: only a loopback server with wh_ci* names that is not the application database is accepted', () => {
  const good = { host: '127.0.0.1', port: '5432', user: 'wh_ci', adminDb: 'wh_ci_admin' };
  assert.doesNotThrow(() => assertDisposableTarget(good, {}));
  assert.doesNotThrow(() => assertDisposableTarget({ ...good, host: 'localhost' }, {}));
  // [setting, refused value]: the refusal must not repeat the refused value
  const refusals = [
    ['host', 'db.example.com'], ['host', '10.0.0.5'], ['host', undefined], ['port', 'abc'], ['port', '0'],
    ['user', 'crm_prod_owner'], ['user', 'postgres'], ['adminDb', 'groworgs_platform_db'], ['adminDb', 'postgres'], ['adminDb', undefined],
  ];
  for (const [setting, value] of refusals) {
    assert.throws(() => assertDisposableTarget({ ...good, [setting]: value }, {}), (error) => {
      assert.ok(!value || String(value).length < 4 || !error.message.includes(String(value)), `the message repeats a refused value: ${error.message}`);
      return true;
    });
  }
  assert.throws(() => assertDisposableTarget(good, { PLATFORM_DB_HOST: '127.0.0.1', PLATFORM_DB_PORT: '5432' }), /application's own/);
  assert.throws(() => assertDisposableTarget(good, { DB_HOST: '127.0.0.1' }), /application's own/);
  assert.throws(() => assertDisposableTarget(good, { DB_USER: 'wh_ci' }), /application's own/);
  assert.doesNotThrow(() => assertDisposableTarget(good, { PLATFORM_DB_HOST: '127.0.0.1', PLATFORM_DB_PORT: '5433' }));
});

test('guard: a server that holds any non-test database is refused, and the message never names it', () => {
  assert.doesNotThrow(() => assertOnlyDisposableDatabases(['postgres', 'template0', 'template1', 'wh_ci_admin', 'wh_test_0123456789', 'wh_test_0123456789_nope']));
  for (const bad of ['groworgs_platform_db', 'tenant_reinsteins', 'reinsteins_workhub', 'wh_test_xyz', 'postgres2']) {
    assert.throws(() => assertOnlyDisposableDatabases(['postgres', bad]), (error) => !error.message.includes(bad) && /1 database/.test(error.message));
  }
});

// ---------------------------------------------------------------- connection to the disposable server
let target = null;      // { host, port, user, password, adminDb } once accepted
let admin = null;       // pool on the maintenance database
const databases = [];   // wh_test_* databases created by this run
const roles = [];       // wh_ci_* roles created by this run
const pools = [];       // every pool opened, ended in `after`

// Silences the migration's console output; re-entrant, because two migrations run concurrently in one test.
const real = { log: console.log, error: console.error };
let silenced = 0;
const quiet = async (fn) => {
  silenced += 1;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally {
    silenced -= 1;
    if (silenced === 0) { console.log = real.log; console.error = real.error; }
  }
};
const newName = (suffix = '') => `wh_test_${crypto.randomBytes(5).toString('hex')}${suffix}`;
const compat = (database, extra = {}) => {
  const pool = createCompatPool({ host: target.host, port: Number(target.port), user: target.user, password: target.password, database, max: 4, connectionTimeoutMillis: 10000, ...extra });
  pool.on('error', () => {});
  pools.push(pool);
  return pool;
};

test('setup: the configured server is the disposable PostgreSQL service (guard + database list)', { skip: SKIP }, async () => {
  assert.deepEqual(MISSING, [], `missing configuration: ${MISSING.join(', ')}`);
  const config = { host: process.env.PG_TEST_HOST, port: process.env.PG_TEST_PORT, user: process.env.PG_TEST_USER, password: process.env.PG_TEST_PASSWORD, adminDb: process.env.PG_TEST_ADMIN_DB };
  assertDisposableTarget(config);

  const pool = new Pool({ host: config.host, port: Number(config.port), user: config.user, password: config.password, database: config.adminDb, max: 2, connectionTimeoutMillis: 10000 });
  pool.on('error', () => {});
  try {
    const { rows } = await pool.query('SELECT datname FROM pg_database');
    assertOnlyDisposableDatabases(rows.map((row) => row.datname));
  } catch (error) {
    await pool.end().catch(() => {});
    if (/not disposable test databases/.test(error.message)) throw error;
    throw new Error(`could not use the disposable PostgreSQL service (${error.code || 'error'})`);
  }
  target = config;
  admin = pool;
});

test.after(async () => {
  for (const pool of pools) await Promise.resolve(pool.end()).catch(() => {});
  if (!admin) return;
  for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
  for (const name of roles) await admin.query(`DROP ROLE IF EXISTS ${name}`).catch(() => {});
  await admin.end().catch(() => {});
});

// ---------------------------------------------------------------- schema and data
// The users table exactly as the canonical tenant schema defines it (a fresh tenant gets the new columns from it).
const SCHEMA = fs.readFileSync(path.join(__dirname, 'schemas', 'tenantSchema.postgresql.sql'), 'utf8');
const USERS_DDL = /CREATE TABLE "users" \([\s\S]*?\r?\n\);/.exec(SCHEMA)?.[0];
const NEW_COLUMNS = ['must_change_password', 'password_changed_at'];

// employee_id, role, system_access, status, expected to be flagged by the one-time reset
const SEED = [
  ['E01', 'employee', 'employee', 'active', true],
  ['E02', 'employee', 'employee', 'inactive', true],
  ['E03', 'employee', 'manager', 'active', true],
  ['E04', 'employee', 'hr', 'active', true],
  ['A01', 'admin', 'admin', 'active', false],          // Admin
  ['S01', 'employee', 'super_admin', 'active', false], // Super Admin (role employee, system_access super_admin)
  ['A02', 'admin', 'employee', 'active', false],       // role admin
  ['P01', 'employee', 'employee', 'pending', false],   // pending self-registration
];
const EXPECTED_FLAGGED = SEED.filter((row) => row[4]).map((row) => row[0]).sort();

async function createDatabase(suffix) {
  assert.ok(admin, 'the disposable server is not configured (see the setup test)');
  assert.ok(USERS_DDL, 'could not find the users table in the canonical tenant schema');
  const name = newName(suffix);
  databases.push(name);
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = compat(name);
  await pool.nativePool.query(USERS_DDL);
  return { name, pool, raw: pool.nativePool };
}

// An existing database from before this feature: the users table WITHOUT the two new columns.
async function oldDatabase({ seed = true } = {}) {
  const db = await createDatabase();
  await db.raw.query(`ALTER TABLE users DROP COLUMN must_change_password, DROP COLUMN password_changed_at`);
  if (seed) {
    for (const [id, role, access, status] of SEED) {
      await db.raw.query(
        `INSERT INTO users (employee_id, full_name, email, password, role, system_access, status) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, `Test ${id}`, `${id.toLowerCase()}@example.test`, `not-a-real-hash-${id}`, role, access, status]
      );
    }
  }
  return db;
}

const columnsOf = async (raw, names = NEW_COLUMNS) => (await raw.query(
  `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'users' AND column_name = ANY($1) ORDER BY column_name`, [names])).rows;
// sorted in JavaScript, not by the database: PostgreSQL's collation orders underscores differently
const allColumns = async (raw) => (await raw.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users'`)).rows.map((r) => r.column_name).sort();
const snapshot = async (raw) => ({ columns: await allColumns(raw), rows: (await raw.query(`SELECT * FROM users ORDER BY id`)).rows });
const flaggedIds = async (raw) => (await raw.query(`SELECT employee_id FROM users WHERE must_change_password ORDER BY employee_id`)).rows.map((r) => r.employee_id);
const migrate = (pool, options) => quiet(() => migration.migrateDatabase('test database', pool, options));

// ---------------------------------------------------------------- the real migration
test('real PostgreSQL: the old schema really lacks the columns and has the seeded accounts', { skip: SKIP }, async () => {
  const db = await oldDatabase();
  assert.deepEqual(await columnsOf(db.raw), []);
  assert.equal((await db.raw.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n, SEED.length);
});

test('real PostgreSQL: --dry-run reports the count and changes NOTHING (schema or data)', { skip: SKIP }, async () => {
  const db = await oldDatabase();
  const before = await snapshot(db.raw);

  const summary = await migrate(db.pool, { dryRun: true });

  assert.deepEqual([summary.action, summary.flagged], ['dry-run', EXPECTED_FLAGGED.length]);
  assert.deepEqual(await snapshot(db.raw), before);
  assert.deepEqual(await columnsOf(db.raw), []);
});

test('real PostgreSQL: migrates an old schema, flags exactly the eligible employees, matches the canonical schema, touches no password', { skip: SKIP }, async () => {
  const db = await oldDatabase();
  const before = await snapshot(db.raw);

  const summary = await migrate(db.pool);

  assert.deepEqual([summary.action, summary.flagged], ['migrated', EXPECTED_FLAGGED.length]);
  assert.deepEqual(await flaggedIds(db.raw), EXPECTED_FLAGGED, 'only E01..E04 are flagged; Admin, Super Admin, role admin and pending are not');

  // the new columns are defined exactly as a freshly provisioned tenant defines them
  const fresh = await createDatabase('_fresh');
  assert.deepEqual(await columnsOf(db.raw), await columnsOf(fresh.raw));
  assert.deepEqual((await columnsOf(db.raw)).map((c) => [c.column_name, c.data_type, c.is_nullable]),
    [['must_change_password', 'boolean', 'NO'], ['password_changed_at', 'timestamp with time zone', 'YES']]);

  // nothing but the two new columns changed: every pre-existing column of every row is identical
  const after = await snapshot(db.raw);
  assert.deepEqual(after.columns, [...before.columns, ...NEW_COLUMNS].sort());
  const strip = (rows) => rows.map((row) => { const copy = { ...row }; NEW_COLUMNS.forEach((c) => delete copy[c]); return copy; });
  assert.deepEqual(strip(after.rows), before.rows);
  assert.ok(after.rows.every((row) => row.password_changed_at === null));
});

test('real PostgreSQL: a repeat run is a no-op -- an employee who already changed their password is never re-flagged', { skip: SKIP }, async () => {
  const db = await oldDatabase();
  await migrate(db.pool);

  await db.raw.query(`UPDATE users SET must_change_password = FALSE, password_changed_at = now() WHERE employee_id = 'E01'`);
  const before = await snapshot(db.raw);

  const again = await migrate(db.pool);
  const dry = await migrate(db.pool, { dryRun: true });

  assert.deepEqual([again.action, again.flagged], ['skipped', 0]);
  assert.deepEqual([dry.action, dry.flagged], ['skipped', 0]);
  assert.deepEqual(await snapshot(db.raw), before);
  assert.deepEqual(await flaggedIds(db.raw), ['E02', 'E03', 'E04']);
});

test('real PostgreSQL: a database that has the flag but not password_changed_at only gains that column (no re-flagging)', { skip: SKIP }, async () => {
  const db = await oldDatabase();
  await db.raw.query(`ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT FALSE`);

  const summary = await migrate(db.pool);

  assert.deepEqual([summary.action, summary.flagged], ['migrated', 0]);
  assert.deepEqual(await flaggedIds(db.raw), []);
  assert.equal((await columnsOf(db.raw)).length, 2);
});

test('real PostgreSQL: two overlapping runs -- one migrates, the other waits on the advisory lock and then does nothing', { skip: SKIP }, async () => {
  const db = await oldDatabase();
  const second = compat(db.name);

  const results = await Promise.all([migrate(db.pool), migrate(second)]);

  assert.deepEqual(results.map((r) => r.action).sort(), ['migrated', 'skipped']);
  assert.equal(results.reduce((sum, r) => sum + r.flagged, 0), EXPECTED_FLAGGED.length);
  assert.deepEqual(await flaggedIds(db.raw), EXPECTED_FLAGGED);
});

test('real PostgreSQL: a failure part-way rolls EVERYTHING back (columns included), and a retry then succeeds', { skip: SKIP }, async () => {
  const db = await oldDatabase();
  await db.raw.query(`
    CREATE FUNCTION wh_test_block_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'blocked by the test trigger'; END $$;
    CREATE TRIGGER wh_test_block BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION wh_test_block_update();`);
  const before = await snapshot(db.raw);

  await assert.rejects(() => migrate(db.pool), /blocked by the test trigger/);

  assert.deepEqual(await snapshot(db.raw), before, 'the ALTERs were rolled back together with the failed UPDATE');
  assert.deepEqual(await columnsOf(db.raw), []);

  await db.raw.query(`DROP TRIGGER wh_test_block ON users`);
  const retry = await migrate(db.pool);
  assert.deepEqual([retry.action, retry.flagged], ['migrated', EXPECTED_FLAGGED.length]);
});

test('real PostgreSQL: the dry run reports a user that cannot ALTER users (pg_has_role) and writes nothing', { skip: SKIP }, async () => {
  const db = await oldDatabase();
  const role = `wh_ci_notowner_${crypto.randomBytes(4).toString('hex')}`;
  const password = crypto.randomBytes(12).toString('hex');
  roles.push(role);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  await admin.query(`GRANT CONNECT ON DATABASE ${db.name} TO ${role}`);
  await db.raw.query(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT ON users TO ${role}`);
  const before = await snapshot(db.raw);

  const limited = compat(db.name, { user: role, password });
  await assert.rejects(() => migrate(limited, { dryRun: true }), /cannot ALTER the users table/);

  assert.deepEqual(await snapshot(db.raw), before);
});

test('real PostgreSQL: a missing database is skipped only for the legacy target; other databases keep going and the failure is counted', { skip: SKIP }, async () => {
  const missing = compat(newName('_nope'));
  const legacy = await quiet(() => migration.runTargets([{ label: 'legacy database', getPool: () => missing, skipIfMissing: true }]));
  assert.deepEqual(legacy, { failures: 0, skipped: 1 }, 'a real 3D000 (database does not exist) is the legacy skip');

  const tenant = await quiet(() => migration.runTargets([{ label: 'acme (tenant_acme)', getPool: () => missing }]));
  assert.deepEqual(tenant, { failures: 1, skipped: 0 }, 'a registered tenant database must exist');

  const first = await oldDatabase();
  const last = await oldDatabase();
  const run = await quiet(() => migration.runTargets([
    { label: 'one', getPool: () => first.pool },
    { label: 'gone', getPool: () => missing },
    { label: 'two', getPool: () => last.pool },
  ]));
  assert.deepEqual(run, { failures: 1, skipped: 0 });
  assert.deepEqual(await flaggedIds(first.raw), EXPECTED_FLAGGED);
  assert.deepEqual(await flaggedIds(last.raw), EXPECTED_FLAGGED, 'a failing database does not stop the ones after it');
});
