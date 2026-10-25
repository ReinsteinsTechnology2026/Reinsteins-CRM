// One-time rollout that flags existing employees/admins/super admins (server/_migrate_flag_existing_accounts_
// password_change.js): argument handling and orchestration against scripted fake pools. No PostgreSQL, no network.
// The real SQL is exercised in _test_password_change_pg.js (migration-postgres CI job).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rollout = require('./_migrate_flag_existing_accounts_password_change');

const norm = (sql) => sql.replace(/\s+/g, ' ').trim();
const rowsOf = (list, extra = {}) => Object.assign([...list], extra);
const REQUIRED = ['id', 'employee_id', 'role', 'system_access', 'status', 'must_change_password', 'password_changed_at'];
const MARKER_COLUMNS = ['name', 'scope', 'flagged_count', 'flagged_user_ids'];

// Answers exactly the statements the script issues; throws on any other so a changed query is noticed.
function makePool({ columns = REQUIRED, markers = null, canUpdate = true, canCreate = true, counts = { employees: 3, admins: 2 }, failOn = null } = {}) {
  const statements = []; const events = []; const inserted = [];
  const answer = async (sql, params = []) => {
    const q = norm(sql); statements.push({ q, params });
    if (failOn && failOn.test(q)) throw new Error('boom');
    if (/FROM information_schema\.columns .* table_name = 'users'/.test(q)) return [rowsOf(columns.map((column_name) => ({ column_name })))];
    if (/to_regclass/.test(q)) return [rowsOf([{ present: markers !== null }])];
    if (/FROM information_schema\.columns .* table_name = 'password_change_rollouts'/.test(q)) return [rowsOf(MARKER_COLUMNS.map((column_name) => ({ column_name })))];
    if (/has_table_privilege\(current_user, 'public\.users'/.test(q)) return [rowsOf([{ can_update: canUpdate, can_create: canCreate }])];
    if (/has_table_privilege\(current_user, 'public\.password_change_rollouts'/.test(q)) return [rowsOf([{ ok: true }])];
    if (/^SELECT name FROM password_change_rollouts/.test(q)) return [rowsOf((markers || []).map((name) => ({ name })))];
    if (/^SELECT COUNT\(\*\)/.test(q)) return [rowsOf([{ n: /role = 'admin'/.test(q) ? counts.admins : counts.employees }])];
    if (/^SET LOCAL lock_timeout/.test(q) || /pg_advisory_xact_lock/.test(q) || /^CREATE TABLE IF NOT EXISTS password_change_rollouts/.test(q)) return [rowsOf([])];
    if (/^SELECT 1 FROM password_change_rollouts/.test(q)) return [rowsOf((markers || []).includes(params[0]) ? [{ '?column?': 1 }] : [])];
    if (/^UPDATE users SET must_change_password = TRUE/.test(q)) return [rowsOf(Array.from({ length: /role = 'admin'/.test(q) ? counts.admins : counts.employees }, (_, i) => ({ id: i + 1 })))];
    if (/^INSERT INTO password_change_rollouts/.test(q)) { inserted.push(params); return [rowsOf([])]; }
    throw new Error('unexpected query ' + q);
  };
  return {
    statements, events, inserted, query: answer,
    async getConnection() {
      events.push('connect');
      return { query: answer, beginTransaction: async () => events.push('begin'), commit: async () => events.push('commit'), rollback: async () => events.push('rollback'), release: () => events.push('release') };
    },
  };
}

const run = async (targets, options) => {
  const { log, error } = console; console.log = () => {}; console.error = () => {};
  try { return await rollout.runRollout(targets, { scope: 'all', skipIds: [], apply: false, ...options }); } finally { console.log = log; console.error = error; }
};
const target = (label, pool, extra = {}) => ({ label, getPool: () => pool, ...extra });

test('arguments: dry run is the default; --apply, --scope and --skip-employee-ids are parsed; anything else is refused', () => {
  assert.deepEqual(rollout.parseArgs([]), { apply: false, scope: 'all', skipIds: [] });
  assert.deepEqual(rollout.parseArgs(['--dry-run']), { apply: false, scope: 'all', skipIds: [] });
  assert.deepEqual(rollout.parseArgs(['--apply', '--scope=admins', '--skip-employee-ids=RS001, RS007,RS001']), { apply: true, scope: 'admins', skipIds: ['RS001', 'RS007'] });
  for (const bad of [['--aply'], ['--scope=everyone'], ['--skip-employee-ids=RS001;DROP'], ['--apply', '--dry-run'], ['apply']]) {
    assert.throws(() => rollout.parseArgs(bad), Error, `should refuse ${bad}`);
  }
});

test('dry run: only SELECTs, no connection, no transaction, no marker table; reports the counts', async () => {
  const pool = makePool();
  const result = await run([target('acme', pool)], { skipIds: ['RS001'] });

  assert.deepEqual([result.ok, result.applied], [true, 0]);
  assert.deepEqual(pool.events, [], 'no getConnection / BEGIN');
  assert.ok(pool.statements.every(({ q }) => /^SELECT/.test(q)), 'only SELECTs: ' + pool.statements.map((s) => s.q.slice(0, 30)));
  assert.deepEqual(pool.statements.filter(({ q }) => /^SELECT COUNT/.test(q)).map((s) => s.params), [[['RS001']], [['RS001']]], 'the skip list reaches the count queries');
});

test('apply: one transaction per database -- lock, marker table, update per group, marker row with the ids; no password column is written', async () => {
  const pool = makePool({ counts: { employees: 3, admins: 2 } });
  const result = await run([target('acme', pool)], { apply: true });

  assert.deepEqual([result.ok, result.applied], [true, 1]);
  assert.deepEqual(pool.events, ['connect', 'begin', 'commit', 'release']);
  const qs = pool.statements.map((s) => s.q).filter((q) => !/information_schema|to_regclass|has_table_privilege|^SELECT COUNT|^SELECT name FROM/.test(q));
  assert.match(qs[0], /^SET LOCAL lock_timeout/);
  assert.match(qs[1], /pg_advisory_xact_lock/);
  assert.match(qs[2], /^CREATE TABLE IF NOT EXISTS password_change_rollouts/);
  assert.equal(pool.inserted.length, 2);
  assert.deepEqual(pool.inserted.map((p) => [p[0], p[1], p[2], p[3]]), [['existing-employees', 'all', 3, [1, 2, 3]], ['existing-admins', 'all', 2, [1, 2]]]);
  assert.ok(!pool.statements.some(({ q }) => /\bpassword\s*=|SET password\b|DELETE|DROP|TRUNCATE/i.test(q)), 'never writes a password, deletes or drops');
});

test('preflight: ONE database that is not ready stops everything -- no other database is written', async () => {
  const good = makePool(); const old = makePool({ columns: REQUIRED.filter((c) => c !== 'must_change_password') });
  const noPrivilege = makePool({ canUpdate: false });
  const result = await run([target('one', good), target('old', old), target('noperm', noPrivilege)], { apply: true });

  assert.deepEqual([result.ok, result.applied, result.failures], [false, 0, 2]);
  assert.deepEqual(good.events, [], 'the healthy database was not touched');
  assert.match(result.message, /nothing was applied/);
});

test('apply stops at the first failure; completed databases stay done and the rest are untouched', async () => {
  const first = makePool(); const failing = makePool({ failOn: /^UPDATE users SET must_change_password/ }); const third = makePool();
  const result = await run([target('one', first), target('two', failing), target('three', third)], { apply: true });

  assert.deepEqual([result.ok, result.applied], [false, 1]);
  assert.deepEqual(first.events, ['connect', 'begin', 'commit', 'release']);
  assert.deepEqual(failing.events, ['connect', 'begin', 'rollback', 'release'], 'the failed database is rolled back');
  assert.deepEqual(third.events, [], 'nothing after the failure runs');
  assert.match(result.message, /Re-run the same command/);
});

test('run-once: databases whose marker exists are skipped, per group', async () => {
  const both = makePool({ markers: ['existing-employees', 'existing-admins'] });
  const done = await run([target('acme', both)], { apply: true });
  assert.deepEqual([done.ok, done.applied, both.events], [true, 0, []]);

  const employeesOnly = makePool({ markers: ['existing-employees'] });
  const rest = await run([target('acme', employeesOnly)], { apply: true });
  assert.equal(rest.applied, 1);
  assert.deepEqual(employeesOnly.inserted.map((p) => p[0]), ['existing-admins'], 'only the group without a marker is flagged');
});

test('legacy: a database that does not exist is skipped; a tenant that does not exist is a failure', async () => {
  const missing = () => { throw Object.assign(new Error('database does not exist'), { code: '3D000' }); };
  const ok = makePool();
  const legacy = await run([{ label: 'legacy database', getPool: missing, skipIfMissing: true }, target('acme', ok)], { apply: true });
  assert.deepEqual([legacy.ok, legacy.applied], [true, 1]);

  const tenant = await run([{ label: 'acme', getPool: missing }], { apply: true });
  assert.equal(tenant.ok, false);
});

test('the rollout is manual: it is not part of the deploy workflow, and platform owners are not touched', () => {
  const deploy = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'deploy.yml'), 'utf8');
  assert.ok(!/_migrate_flag_existing_accounts_password_change/.test(deploy));
  const source = fs.readFileSync(path.join(__dirname, '_migrate_flag_existing_accounts_password_change.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/platform_users/.test(source));
});
