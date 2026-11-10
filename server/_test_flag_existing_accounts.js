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
const REQUIRED = ['id', 'employee_id', 'role', 'system_access', 'status', 'must_change_password', 'password_changed_at', 'is_system_administrator'];
const SYSADMIN = [{ id: 99, employee_id: 'SYS1' }];
const LEGACY_COLUMNS = REQUIRED.filter((c) => c !== 'is_system_administrator'); // the legacy users table today
const MARKER_COLUMNS = ['name', 'scope', 'flagged_count', 'flagged_user_ids'];

// Answers exactly the statements the script issues; throws on any other so a changed query is noticed.
// sysAdmins / columns: what the preflight sees; the *InTransaction variants: what the apply transaction sees
// (default: the same).
function makePool({ columns = REQUIRED, columnsInTransaction = columns, markers = null, canUpdate = true, canCreate = true, counts = { employees: 3, admins: 2 }, failOn = null, sysAdmins = SYSADMIN, sysAdminsInTransaction = sysAdmins, ungrouped = 0 } = {}) {
  const statements = []; const events = []; const inserted = [];
  const answerIn = (inTransaction) => async (sql, params = []) => {
    const q = norm(sql); statements.push({ q, params, inTransaction });
    if (failOn && failOn.test(q)) throw new Error('boom');
    if (/^SELECT id, employee_id FROM users WHERE is_system_administrator = TRUE$/.test(q)) return [rowsOf(inTransaction ? sysAdminsInTransaction : sysAdmins)];
    if (/^SELECT COUNT\(\*\)::int AS n FROM users WHERE .* AND NOT COALESCE\(/.test(q)) return [rowsOf([{ n: ungrouped }])];
    if (/FROM information_schema\.columns .* table_name = 'users'/.test(q)) return [rowsOf((inTransaction ? columnsInTransaction : columns).map((column_name) => ({ column_name })))];
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
    statements, events, inserted, query: answerIn(false),
    async getConnection() {
      events.push('connect');
      return { query: answerIn(true), beginTransaction: async () => events.push('begin'), commit: async () => events.push('commit'), rollback: async () => events.push('rollback'), release: () => events.push('release') };
    },
  };
}

const run = async (targets, options) => {
  const { log, error } = console; console.log = () => {}; console.error = () => {};
  try { return await rollout.runRollout(targets, { scope: 'all', skipIds: [], apply: false, ...options }); } finally { console.log = log; console.error = error; }
};
const target = (label, pool, extra = {}) => ({ label, getPool: () => pool, ...extra });
const legacyTarget = (pool) => target('legacy database', pool, { skipIfMissing: true, legacy: true });
const updates = (pool) => pool.statements.filter(({ q }) => /^UPDATE users SET must_change_password = TRUE/.test(q)).map(({ q }) => q);

test('arguments: dry run is the default; --apply, --scope, --skip-employee-ids and the legacy option are parsed; anything else is refused', () => {
  const defaults = { apply: false, scope: 'all', skipIds: [], legacyWithoutSystemAdministrator: false };
  assert.deepEqual(rollout.parseArgs([]), defaults);
  assert.deepEqual(rollout.parseArgs(['--dry-run']), defaults);
  assert.deepEqual(rollout.parseArgs(['--apply', '--scope=admins', '--skip-employee-ids=RS001, RS007,RS001']), { ...defaults, apply: true, scope: 'admins', skipIds: ['RS001', 'RS007'] });
  assert.deepEqual(rollout.parseArgs(['--legacy-without-system-administrator']), { ...defaults, legacyWithoutSystemAdministrator: true }, 'the option alone is still a dry run');
  for (const bad of [['--aply'], ['--scope=everyone'], ['--skip-employee-ids=RS001;DROP'], ['--apply', '--dry-run'], ['apply'], ['--legacy-without-system-administrator=yes'], ['--without-system-administrator']]) {
    assert.throws(() => rollout.parseArgs(bad), Error, `should refuse ${bad}`);
  }
});

test('dry run: only SELECTs, no connection, no transaction, no marker table; reports the counts', async () => {
  const pool = makePool();
  const result = await run([target('acme', pool)], { skipIds: ['RS001'] });

  assert.deepEqual([result.ok, result.applied], [true, 0]);
  assert.deepEqual(pool.events, [], 'no getConnection / BEGIN');
  assert.ok(pool.statements.every(({ q }) => /^SELECT/.test(q)), 'only SELECTs: ' + pool.statements.map((s) => s.q.slice(0, 30)));
  assert.deepEqual(pool.statements.filter(({ q }) => /^SELECT COUNT/.test(q) && !/NOT COALESCE/.test(q)).map((s) => s.params), [[['RS001']], [['RS001']]], 'the skip list reaches the count queries');
});

test('apply: one transaction per database -- lock, marker table, update per group, marker row with the ids; no password column is written', async () => {
  const pool = makePool({ counts: { employees: 3, admins: 2 } });
  const result = await run([target('acme', pool)], { apply: true });

  assert.deepEqual([result.ok, result.applied], [true, 1]);
  assert.deepEqual(pool.events, ['connect', 'begin', 'commit', 'release']);
  const qs = pool.statements.filter((s) => s.inTransaction).map((s) => s.q);
  assert.match(qs[0], /^SET LOCAL lock_timeout/);
  assert.match(qs[1], /pg_advisory_xact_lock/);
  assert.match(qs[2], /FROM information_schema\.columns .* table_name = 'users'/, 'the schema is read again under the lock');
  assert.match(qs[3], /^SELECT id, employee_id FROM users WHERE is_system_administrator = TRUE$/, 'the System Administrator is checked again under the lock');
  assert.match(qs[4], /^CREATE TABLE IF NOT EXISTS password_change_rollouts/);
  assert.equal(pool.inserted.length, 2);
  assert.deepEqual(pool.inserted.map((p) => [p[0], p[1], p[2], p[3]]), [['existing-employees-v2', 'all', 3, [1, 2, 3]], ['existing-admins-v2', 'all', 2, [1, 2]]]);
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
  const both = makePool({ markers: ['existing-employees-v2', 'existing-admins-v2'] });
  const done = await run([target('acme', both)], { apply: true });
  assert.deepEqual([done.ok, done.applied, both.events], [true, 0, []]);

  const employeesOnly = makePool({ markers: ['existing-employees-v2'] });
  const rest = await run([target('acme', employeesOnly)], { apply: true });
  assert.equal(rest.applied, 1);
  assert.deepEqual(employeesOnly.inserted.map((p) => p[0]), ['existing-admins-v2'], 'only the group without a marker is flagged');
});

test('run-once: a marker from the earlier rules fails the preflight -- it neither closes a group nor is ignored', async () => {
  for (const previous of rollout.PREVIOUS_MARKERS) {
    const old = makePool({ markers: [previous] }); const good = makePool();
    const result = await run([target('good', good), target('old', old)], { apply: true });
    assert.deepEqual([result.ok, result.applied, result.failures], [false, 0, 1], previous);
    assert.deepEqual([good.events, old.events], [[], []], 'nothing is written anywhere');
  }
});

test('System Administrator: excluded by is_system_administrator only; every other account in the groups is eligible', () => {
  assert.match(rollout.ELIGIBLE, /AND is_system_administrator IS NOT TRUE$/, 'IS NOT TRUE: only an explicit TRUE is excluded, never a NULL');
  for (const { where } of Object.values(rollout.GROUPS)) {
    assert.doesNotMatch(where, /is_system_administrator|full_name|created_at|designation/, 'groups are by role / system_access only');
  }
  assert.deepEqual(Object.values(rollout.GROUPS).map((g) => g.marker), ['existing-employees-v2', 'existing-admins-v2']);
  assert.equal(rollout.NOT_SKIPPED, 'COALESCE(employee_id <> ALL(?), TRUE)', 'a NULL employee_id is never dropped by a skip list');
});

test('System Administrator: missing column, none, or more than one -> the preflight fails and nothing is applied anywhere', async () => {
  const cases = {
    'no column': { columns: REQUIRED.filter((c) => c !== 'is_system_administrator') },
    'none designated': { sysAdmins: [] },
    'two designated': { sysAdmins: [{ id: 1, employee_id: 'A' }, { id: 2, employee_id: 'B' }] },
  };
  for (const [name, options] of Object.entries(cases)) {
    const good = makePool(); const bad = makePool(options);
    const result = await run([target('good', good), target('bad', bad)], { apply: true });
    assert.deepEqual([result.ok, result.applied, result.failures], [false, 0, 1], name);
    assert.deepEqual(good.events, [], `${name}: the healthy database was not touched`);
    assert.ok(!bad.statements.some(({ q }) => /^SELECT COUNT\(\*\)::int AS n FROM users WHERE must_change_password/.test(q) && !/NOT COALESCE/.test(q)), `${name}: no would-flag count is produced`);
  }
});

test('System Administrator: if the designation changed after the preflight, the apply transaction rolls back', async () => {
  const pool = makePool({ sysAdminsInTransaction: [] });
  const result = await run([target('acme', pool)], { apply: true });
  assert.deepEqual([result.ok, result.applied], [false, 0]);
  assert.deepEqual(pool.events, ['connect', 'begin', 'rollback', 'release']);
  assert.ok(!pool.statements.some(({ q }) => /^UPDATE users/.test(q)), 'no account was flagged');
});

test('legacy option: the legacy database is flagged without an exemption; tenants keep excluding their System Administrator', async () => {
  const legacy = makePool({ columns: LEGACY_COLUMNS, counts: { employees: 0, admins: 1 } });
  const tenant = makePool();
  const result = await run([legacyTarget(legacy), target('acme', tenant)], { apply: true, legacyWithoutSystemAdministrator: true });

  assert.deepEqual([result.ok, result.applied], [true, 2]);
  assert.deepEqual(legacy.events, ['connect', 'begin', 'commit', 'release']);
  assert.ok(!legacy.statements.some(({ q }) => /is_system_administrator/.test(q)), 'legacy: the absent column is never referenced');
  assert.ok(updates(legacy).length === 2 && updates(legacy).every((q) => q.includes(rollout.ELIGIBLE_BASE) && !/is_system_administrator/.test(q)));
  assert.deepEqual(legacy.inserted.map((p) => [p[0], p[2]]), [['existing-employees-v2', 0], ['existing-admins-v2', 1]], 'run-once markers as usual');

  assert.ok(updates(tenant).length === 2 && updates(tenant).every((q) => q.includes(rollout.ELIGIBLE)), 'tenant: the exclusion stays');
  assert.equal(tenant.statements.filter(({ q }) => /WHERE is_system_administrator = TRUE$/.test(q)).length, 2, 'tenant: exactly-one checked in preflight and in the transaction');
});

test('legacy option: the dry run writes nothing and reports the legacy database as having no exempt account', async () => {
  const legacy = makePool({ columns: LEGACY_COLUMNS });
  const lines = []; const { log } = console; console.log = (line) => lines.push(String(line));
  let result;
  try { result = await rollout.runRollout([legacyTarget(legacy)], { scope: 'all', skipIds: [], apply: false, legacyWithoutSystemAdministrator: true }); } finally { console.log = log; }

  assert.deepEqual([result.ok, result.applied, legacy.events], [true, 0, []]);
  assert.ok(legacy.statements.every(({ q }) => /^SELECT/.test(q)), 'only SELECTs');
  assert.ok(lines.some((line) => /\[no-system-administrator\] legacy database -- .*--legacy-without-system-administrator/.test(line)));
});

test('legacy without the option: no is_system_administrator column fails the preflight; nothing is applied anywhere', async () => {
  const legacy = makePool({ columns: LEGACY_COLUMNS }); const tenant = makePool();
  const result = await run([legacyTarget(legacy), target('acme', tenant)], { apply: true });

  assert.deepEqual([result.ok, result.applied, result.failures], [false, 0, 1]);
  assert.deepEqual([legacy.events, tenant.events], [[], []]);
});

test('legacy option refused when the legacy database HAS an is_system_administrator column -- in the preflight', async () => {
  const legacy = makePool(); const tenant = makePool();
  const result = await run([legacyTarget(legacy), target('acme', tenant)], { apply: true, legacyWithoutSystemAdministrator: true });

  assert.deepEqual([result.ok, result.applied, result.failures], [false, 0, 1]);
  assert.deepEqual([legacy.events, tenant.events], [[], []], 'nothing is written anywhere');
});

test('legacy option refused when the column appears between the preflight and the apply -- the transaction rolls back', async () => {
  const legacy = makePool({ columns: LEGACY_COLUMNS, columnsInTransaction: REQUIRED });
  const result = await run([legacyTarget(legacy)], { apply: true, legacyWithoutSystemAdministrator: true });

  assert.deepEqual([result.ok, result.applied], [false, 0]);
  assert.deepEqual(legacy.events, ['connect', 'begin', 'rollback', 'release']);
  assert.deepEqual(updates(legacy), [], 'no account was flagged');
});

test('legacy option never reaches a tenant: a tenant without the column, or without exactly one System Administrator, still fails', async () => {
  for (const [name, options] of Object.entries({ 'no column': { columns: LEGACY_COLUMNS }, 'none designated': { sysAdmins: [] } })) {
    const tenant = makePool(options);
    // a tenant target is anything without legacy: true -- even one carrying the legacy label or skipIfMissing
    for (const t of [target('acme', tenant), target('legacy database', tenant, { skipIfMissing: true })]) {
      const result = await run([t], { apply: true, legacyWithoutSystemAdministrator: true });
      assert.deepEqual([result.ok, result.applied, result.failures], [false, 0, 1], name);
    }
    assert.deepEqual(tenant.events, [], `${name}: nothing written`);
  }
});

test('no silent gaps: an eligible account in neither group fails the preflight', async () => {
  const pool = makePool({ ungrouped: 1 });
  const result = await run([target('acme', pool)], { apply: true });
  assert.deepEqual([result.ok, result.applied, result.failures], [false, 0, 1]);
  assert.deepEqual(pool.events, []);
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
