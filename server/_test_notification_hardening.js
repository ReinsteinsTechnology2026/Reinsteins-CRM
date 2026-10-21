// MOCKED unit tests (in-memory fakes). They exercise this code's control flow and its
// SAVEPOINT / ownership logic against a model of PostgreSQL's aborted-transaction
// rule. They do NOT validate real PostgreSQL transaction, locking or isolation behavior.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const db = require('./config/db');
const { editActivity, createActivity } = require('./services/taskActivityService');
const activityController = require('./controllers/taskActivityController');
const emailTemplates = require('./services/emailTemplates');

const USERS = {
  1: { id: 1, full_name: 'Alice', role: 'employee' },
  8: { id: 8, full_name: 'Carol', role: 'admin' },
};
const TASK = { id: 3, task_title: 'T', task_number: 3, project_id: null, assigned_to: 1, assigned_by: 1 };

// Models: statements failing inside a transaction abort it; until ROLLBACK TO SAVEPOINT
// every statement errors; COMMIT of an aborted transaction silently discards the work.
function txModelPool({ failMentionSelect = false, failMentionInsert = false,
  failMentionWrites = false, failUsers = false } = {}) {
  const state = { body: 'old', mentions: [], notified: [], pastCommitErrors: 0 };
  const exec = async (conn, sql, p = []) => {
    await new Promise((r) => setImmediate(r));
    const tx = conn.tx;
    if (tx && tx.aborted && !/ROLLBACK/.test(sql)) {
      throw Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
    }
    const fail = (code) => { if (tx) tx.aborted = true; throw Object.assign(new Error('boom'), { code }); };
    if (/ROLLBACK TO SAVEPOINT/.test(sql)) { tx.aborted = false; tx.mentions = [...tx.saved]; return [[]]; }
    if (/RELEASE SAVEPOINT/.test(sql)) return [[]];
    if (/^\s*SAVEPOINT/.test(sql)) { tx.saved = [...tx.mentions]; return [[]]; }
    if (/to_regclass/.test(sql)) return [[{ name: 'notification_email_outbox' }]];
    if (/FROM task_activity/.test(sql)) return [[{ id: 5, task_id: 3, author_id: 1, activity_type: 'comment' }]];
    if (/UPDATE task_activity/.test(sql)) { tx.body = p[0]; return [[]]; }
    if (/FROM task_mentions/.test(sql)) {
      if (failMentionSelect) fail('42501');
      return [tx.mentions.map((id) => ({ mentioned_user_id: id }))];
    }
    if (/INSERT INTO task_mentions/.test(sql)) {
      if (failMentionInsert || failMentionWrites) fail('23505');
      if (tx) tx.mentions.push(p[1]); else state.mentions.push(p[1]);
      return [[]];
    }
    if (/FROM tasks/.test(sql)) return [[{ ...TASK }]];
    if (failUsers && /FROM users/.test(sql)) throw Object.assign(new Error('x'), { code: '08006' });
    if (/SELECT full_name FROM users/.test(sql)) return [[USERS[p[0]]]];
    if (/FROM users WHERE id = \?/.test(sql)) return [[USERS[p[0]]]];
    if (/INSERT INTO notifications/.test(sql)) { state.notified.push(p[0]); return [[{ id: 300 + state.notified.length }]]; }
    if (/INSERT INTO task_activity/.test(sql)) return [[{ id: 11 }]];
    return [[{ id: 11 }]];
  };
  const connection = () => {
    const conn = { tx: null };
    return Object.assign(conn, {
      beginTransaction: async () => { conn.tx = { aborted: false, body: state.body, mentions: [...state.mentions], saved: [] }; },
      commit: async () => {
        if (conn.tx && !conn.tx.aborted) { state.body = conn.tx.body; state.mentions = conn.tx.mentions; } else state.pastCommitErrors += 0;
        conn.tx = null;
      },
      rollback: async () => { conn.tx = null; },
      release: () => {},
      query: (s, p) => exec(conn, s, p),
    });
  };
  return { state, query: (s, p) => exec({ tx: null }, s, p), getConnection: async () => connection() };
}
const inTenant = (pool, fn) => db.__runWithTenantContext({ tenantPool: pool, companySlug: 'acme' }, fn);
const quiet = async (fn) => {
  const original = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try { return { value: await fn(), logged }; } finally { console.error = original; }
};

test('MOCKED: edit with no mention failure saves the edit and records/notifies the new mention', async () => {
  const pool = txModelPool();
  const { value } = await quiet(() => inTenant(pool, () => editActivity(5, { id: 1 }, '@Carol look', [8])));
  assert.equal(value.success, true);
  assert.equal(pool.state.body, '@Carol look');
  assert.deepEqual(pool.state.mentions, [8]);
  assert.deepEqual(pool.state.notified, [8]);
});

test('MOCKED: a failed mention SELECT does not lose the saved edit', async () => {
  const pool = txModelPool({ failMentionSelect: true });
  const { value, logged } = await quiet(() => inTenant(pool, () => editActivity(5, { id: 1 }, '@Carol look', [8])));
  assert.equal(value.success, true);
  assert.equal(pool.state.body, '@Carol look'); // would stay 'old' if COMMIT ran on an aborted transaction
  assert.deepEqual(pool.state.notified, []);
  assert.ok(logged.some((l) => /edit kept/.test(l)));
  assert.equal(logged.some((l) => /Carol look/.test(l)), false); // no comment text in logs
});

test('MOCKED: a failed mention INSERT does not lose the saved edit and records no mention', async () => {
  const pool = txModelPool({ failMentionInsert: true });
  const { value } = await quiet(() => inTenant(pool, () => editActivity(5, { id: 1 }, '@Carol look', [8])));
  assert.equal(value.success, true);
  assert.equal(pool.state.body, '@Carol look');
  assert.deepEqual(pool.state.mentions, []);
  assert.deepEqual(pool.state.notified, []);
});

test('MOCKED: recipient validation failure before the transaction still saves the edit', async () => {
  const pool = txModelPool({ failUsers: true });
  const { value } = await quiet(() => inTenant(pool, () => editActivity(5, { id: 1 }, '@Carol look', [8])));
  assert.equal(value.success, true);
  assert.equal(pool.state.body, '@Carol look');
});

test('MOCKED: no pool.query is issued while a transaction connection is held (pool-exhaustion guard)', async () => {
  const pool = txModelPool();
  let open = 0;
  const violations = [];
  const original = pool.getConnection;
  pool.getConnection = async () => {
    const c = await original();
    const begin = c.beginTransaction;
    const commit = c.commit;
    const rollback = c.rollback;
    c.beginTransaction = async () => { open += 1; return begin(); };
    c.commit = async () => { open -= 1; return commit(); };
    c.rollback = async () => { if (c.tx) open -= 1; return rollback(); };
    return c;
  };
  const poolQuery = pool.query;
  pool.query = (s, p) => { if (open > 0) violations.push(s.trim().slice(0, 40)); return poolQuery(s, p); };
  await quiet(() => inTenant(pool, () => editActivity(5, { id: 1 }, '@Carol look', [8])));
  assert.deepEqual(violations, []);
});

test('MOCKED: mention processing failure after comment creation does not fail the save', async () => {
  const pool = txModelPool({ failMentionWrites: true });
  const { value, logged } = await quiet(() => inTenant(pool, () => createActivity(3, 1,
    { activityType: 'comment', body: '@Carol hello', mentionedUserIds: [8] }, [], null)));
  assert.ok(value); // returned the saved activity instead of throwing
  assert.ok(logged.some((l) => /Mention not recorded/.test(l)));
  assert.equal(logged.some((l) => /hello/.test(l)), false);
});

test('MOCKED: user-lookup failure during comment creation does not fail the save (HTTP 201)', async () => {
  const pool = txModelPool({ failUsers: true });
  const res = { code: 0, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  const req = { params: { taskId: '3' }, body: { body: '@Carol hello', mentionedUserIds: '[8]' },
    user: { id: 1, role: 'admin' }, files: [], app: { get: () => null } };
  await quiet(() => inTenant(pool, () => activityController.createActivity(req, res)));
  assert.equal(res.code, 201);
});

test('production: missing or invalid APP_BASE_URL creates no email; development default still works', async () => {
  const saved = { env: process.env.NODE_ENV, base: process.env.APP_BASE_URL };
  const data = { taskTitle: 'T', taskNumber: 1, projectName: 'P', actorName: 'A', taskId: 4, recipientRole: 'admin' };
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.APP_BASE_URL;
    let r = await quiet(() => emailTemplates.taskAssignedEmail(data));
    assert.equal(r.value, null);
    assert.ok(r.logged.some((l) => /APP_BASE_URL is required in production/.test(l)));
    process.env.APP_BASE_URL = 'not a url';
    assert.equal((await quiet(() => emailTemplates.taskAssignedEmail(data))).value, null);
    process.env.APP_BASE_URL = 'ftp://workhub.example';
    assert.equal((await quiet(() => emailTemplates.taskAssignedEmail(data))).value, null);
    process.env.APP_BASE_URL = 'https://workhub.example';
    assert.match(emailTemplates.taskAssignedEmail(data).text, /https:\/\/workhub\.example\/admin\/task-workspace\/4/);
    process.env.NODE_ENV = 'development';
    delete process.env.APP_BASE_URL;
    assert.match(emailTemplates.taskAssignedEmail(data).text, /http:\/\/localhost:5173\//);
  } finally {
    for (const [k, v] of [['NODE_ENV', saved.env], ['APP_BASE_URL', saved.base]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
