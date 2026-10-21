// Unit tests: in-memory fake pool and no email transport. No real PostgreSQL or SMTP.
// The fake pool models a single task row with a row lock held by
// `SELECT ... FOR UPDATE` until commit/rollback, like PostgreSQL. It checks
// the service's logic, not PostgreSQL's locking itself.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const db = require('./config/db');
const taskService = require('./services/taskService');
const notificationService = require('./services/notificationService');
const { taskTransferredEmail, taskAssignedEmail } = require('./services/emailTemplates');

function fakeTaskPool(row) {
  let owner = null;
  const waiters = [];
  const acquire = async (conn) => {
    while (owner && owner !== conn) await new Promise((r) => waiters.push(r));
    owner = conn;
  };
  const release = (conn) => {
    if (owner === conn) { owner = null; waiters.splice(0).forEach((r) => r()); }
  };
  const exec = async (conn, sql, p = []) => {
    await new Promise((r) => setImmediate(r)); // force interleaving between requests
    if (/FOR UPDATE/.test(sql)) { await acquire(conn); return [[{ ...row }]]; }
    if (/^\s*UPDATE tasks\s+SET\s+task_title/.test(sql)) { row.assigned_to = p[2]; row.assigned_by = p[3]; return [[]]; }
    if (/IS DISTINCT FROM/.test(sql)) {
      if (row.assigned_to === p[0]) return [[]];
      row.assigned_to = p[0];
      return [[{ id: 1 }]];
    }
    return [[{ ...row }]];
  };
  return {
    query: (sql, p) => exec({}, sql, p),
    getConnection: async () => {
      const conn = {};
      Object.assign(conn, {
        beginTransaction: async () => {}, commit: async () => release(conn),
        rollback: async () => release(conn), release: () => release(conn),
        query: (s, p) => exec(conn, s, p),
      });
      return conn;
    },
  };
}
const inTenant = (pool, fn) => db.__runWithTenantContext({ tenantPool: pool, companySlug: 'acme' }, fn);
const edit = (id, assigned_to) => taskService.updateTask(id,
  { title: 't', description: 'd', assigned_to, priority: 'High', status: 'todo' }, 1);

test('competing updateTask requests for the same assignee: exactly one transition', async () => {
  const pool = fakeTaskPool({ assigned_to: 5, assigned_by: 1 });
  const results = await inTenant(pool, () => Promise.all([edit(1, 7), edit(1, 7), edit(1, 7)]));
  assert.equal(results.filter((r) => r.assignmentChanged).length, 1);
  assert.equal(results.find((r) => r.assignmentChanged).previousAssignee, 5);
});

test('competing requests for different assignees: each real transition once, based on persisted state', async () => {
  const pool = fakeTaskPool({ assigned_to: null, assigned_by: 1 });
  const [a, b] = await inTenant(pool, () => Promise.all([edit(1, 7), edit(1, 8)]));
  assert.ok(a.assignmentChanged && b.assignmentChanged);
  assert.equal(a.previousAssignee, null);
  assert.equal(b.previousAssignee, 7);
});

test('unchanged assignee reports no transition', async () => {
  const pool = fakeTaskPool({ assigned_to: 5, assigned_by: 1 });
  const r = await inTenant(pool, () => edit(1, 5));
  assert.equal(r.assignmentChanged, false);
});

test('competing transfers: one wins, the duplicate is rejected', async () => {
  const pool = fakeTaskPool({ assigned_to: 5, assigned_by: 1 });
  const out = await inTenant(pool, () => Promise.all([
    taskService.transferTask(1, 1, 9, ''), taskService.transferTask(1, 1, 9, '')]));
  assert.deepEqual(out.slice().sort(), [false, true]);
});

test('transfer links use recipient role, tenant prefix and APP_BASE_URL', () => {
  const saved = process.env.APP_BASE_URL;
  const base = { taskTitle: 'T', taskNumber: 1, projectName: 'P', actorName: 'A', taskId: 42 };
  try {
    process.env.APP_BASE_URL = 'https://workhub.example/ignored/path';
    db.__runWithTenantContext({ tenantPool: { query() {} }, companySlug: 'acme' }, () => {
      assert.match(taskTransferredEmail({ ...base, recipientRole: 'admin' }).html,
        /https:\/\/workhub\.example\/acme\/admin\/task-workspace\/42/);
      assert.match(taskTransferredEmail({ ...base, recipientRole: 'employee' }).text,
        /https:\/\/workhub\.example\/acme\/employee\/task-workspace\/42/);
    });
    // Legacy tenant: no slug prefix
    assert.match(taskAssignedEmail({ ...base, recipientRole: 'admin' }).text,
      /workhub\.example\/admin\/task-workspace\/42/);
    process.env.APP_BASE_URL = 'javascript:alert(1)';
    const original = console.error;
    console.error = () => {};
    try {
      assert.equal(taskTransferredEmail(base), null); // refused: no email, no throw
    } finally { console.error = original; }
  } finally {
    if (saved === undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL = saved;
  }
});

test('notification failure after the assignment is committed is swallowed', async () => {
  const pool = { query: async () => { throw Object.assign(new Error('db down'), { code: 'XX000' }); } };
  const original = console.error;
  console.error = () => {};
  try {
    const r = await inTenant(pool, () => notificationService.notifyTaskAssignment({}, 1, 7, 1));
    assert.equal(r, null);
  } finally { console.error = original; }
});

test('missing outbox table: in-app notification still created, no email queued', async () => {
  const sqls = [];
  const pool = {
    query: async (sql) => {
      sqls.push(sql);
      if (/to_regclass/.test(sql)) return [[{ name: null }]];
      if (/INSERT INTO notifications/.test(sql)) return [[{ id: 3 }]];
      return [[]];
    },
    getConnection: async () => { throw new Error('must not open a transaction'); },
  };
  const original = console.error;
  console.error = () => {};
  try {
    const id = await inTenant(pool, () => notificationService.createNotification({
      userId: 7, title: 't', message: 'm', type: 'task_assigned',
      email: { subject: 's', html: 'h', text: 't' } }));
    assert.equal(id, 3);
  } finally { console.error = original; }
  assert.equal(sqls.some((s) => /INSERT INTO notification_email_outbox/.test(s)), false);
});
