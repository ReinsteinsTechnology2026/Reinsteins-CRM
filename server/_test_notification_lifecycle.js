// Unit tests: permissive in-memory fake pool, no real PostgreSQL, no email transport.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const db = require('./config/db');
const controller = require('./controllers/taskManagementController');
const sweep = require('./jobs/notificationSweep');

// These tests exercise the queueing path, which is off unless explicitly enabled outside development/test.
process.env.NOTIFICATION_EMAIL_ENABLED = 'true';

const TASK = {
  id: 3, task_number: 3, task_title: 'T', project_id: null, project_name: null,
  assigned_to: 7, assigned_by: 1, status: 'pending_review', due_date: '2020-01-01',
  role: 'admin', full_name: 'Someone',
};

function fakePool({ failNotifications = false, rows = {} } = {}) {
  const log = [];
  const run = async (sql, p = []) => {
    log.push(sql);
    if (/to_regclass/.test(sql)) return [[{ name: 'notification_email_outbox' }]];
    if (failNotifications && /INSERT INTO notifications|notification_email_outbox\s*\(/.test(sql)) {
      throw Object.assign(new Error('boom secret'), { code: 'XX001' });
    }
    if (/INSERT INTO notifications/.test(sql)) return [[{ id: 55 }]];
    if (/RETURNING id/.test(sql)) return [[{ id: 9 }]];
    for (const [re, value] of Object.entries(rows)) if (new RegExp(re).test(sql)) return [value];
    if (/FROM notifications/.test(sql)) return [[]];
    return [[{ ...TASK }]];
  };
  return {
    log, query: run,
    getConnection: async () => ({ beginTransaction: async () => {}, commit: async () => {},
      rollback: async () => {}, release: () => {}, query: run }),
  };
}
const inTenant = (pool, fn) => db.__runWithTenantContext({ tenantPool: pool, companySlug: 'acme' }, fn);
const res = () => {
  const r = { code: 200 };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};
const req = () => ({ params: { id: '3' }, body: {}, user: { id: 1, role: 'admin' },
  app: { get: () => null } });
const quiet = async (fn) => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};

test('sendBackTask: operation saved, notification/outbox failure does not return 500', async () => {
  const pool = fakePool({ failNotifications: true });
  const r = res();
  await quiet(() => inTenant(pool, () => controller.sendBackTask(req(), r)));
  assert.equal(r.code, 200);
  assert.equal(r.body.success, true);
  assert.ok(pool.log.some((s) => /UPDATE tasks/.test(s))); // business change was persisted
  assert.ok(pool.log.some((s) => /INSERT INTO notifications/.test(s))); // the failing step really ran
});

test('sendBackTask: a business error before persistence is still reported', async () => {
  const pool = fakePool({ rows: { 'FROM tasks': [{ ...TASK, status: 'todo' }] } });
  const r = res();
  await inTenant(pool, () => controller.sendBackTask(req(), r));
  assert.equal(r.code, 400);
  assert.equal(pool.log.some((s) => /UPDATE tasks/.test(s)), false);
});

test('sweep: one failing notification does not stop the pass and links use the recipient role', async () => {
  const savedBase = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = 'https://workhub.example';
  const inserted = [];
  const mk = (id, role) => ({ id, task_number: id, task_title: 'T' + id, assigned_to: 10 + id,
    due_date: '2020-01-01', project_id: null, project_name: null, assignee_status: 'active', assignee_role: role });
  const base = fakePool({ rows: { 'FROM tasks t': [mk(1, 'admin'), mk(2, 'employee'), mk(3, 'employee')] } });
  let outboxInserts = 0;
  const wrap = (q) => async (sql, p) => {
    if (/INSERT INTO notification_email_outbox/.test(sql)) {
      outboxInserts += 1;
      if (outboxInserts === 2) throw Object.assign(new Error('x'), { code: 'XX001' });
      inserted.push(p[3]); // html
    }
    return q(sql, p);
  };
  const pool = { ...base, query: wrap(base.query),
    getConnection: async () => { const c = await base.getConnection(); return { ...c, query: wrap(c.query) }; } };
  try {
    const result = await quiet(() => inTenant(pool, () => sweep.runSweepOnce(null)));
    assert.equal(result.overdueCreated, 2);
    assert.match(inserted[0], /acme\/admin\/task-workspace\/1/);
    assert.match(inserted[1], /acme\/employee\/task-workspace\/3/);
  } finally {
    if (savedBase === undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL = savedBase;
  }
});
