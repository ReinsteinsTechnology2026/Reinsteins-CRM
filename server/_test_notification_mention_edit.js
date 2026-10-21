// Unit tests: in-memory fake pool, no real PostgreSQL, no email transport.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const db = require('./config/db');
const { editActivity } = require('./services/taskActivityService');

const USERS = {
  1: { id: 1, full_name: 'Alice', role: 'employee' },
  7: { id: 7, full_name: 'Bob', role: 'admin' },
  8: { id: 8, full_name: 'Carol', role: 'admin' },
};

function fakePool({ authorId = 1, alreadyMentioned = [7], failMentions = false } = {}) {
  const notified = [];
  const updates = [];
  const run = async (sql, p = []) => {
    if (/to_regclass/.test(sql)) return [[{ name: 'notification_email_outbox' }]];
    if (/FROM task_activity/.test(sql)) return [[{ id: 5, task_id: 3, author_id: authorId, activity_type: 'comment' }]];
    if (/UPDATE task_activity/.test(sql)) { updates.push(p); return [[]]; }
    if (/FROM task_mentions/.test(sql)) {
      if (failMentions) throw new Error('db down');
      return [alreadyMentioned.map((id) => ({ mentioned_user_id: id }))];
    }
    if (/FROM tasks/.test(sql)) return [[{ id: 3, task_title: 'T', task_number: 3, project_id: null, assigned_to: 1, assigned_by: 1 }]];
    if (/SELECT full_name FROM users/.test(sql)) return [[USERS[p[0]]]];
    if (/FROM users WHERE id = \?/.test(sql)) return [USERS[p[0]] ? [USERS[p[0]]] : []];
    if (/INSERT INTO notifications/.test(sql)) { notified.push(p[0]); return [[{ id: 100 + notified.length }]]; }
    return [[]];
  };
  return {
    notified, updates, query: run,
    getConnection: async () => ({ beginTransaction: async () => {}, commit: async () => {},
      rollback: async () => {}, release: () => {}, query: run }),
  };
}
const inTenant = (pool, fn) => db.__runWithTenantContext({ tenantPool: pool, companySlug: 'acme' }, fn);
const quiet = async (fn) => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};

test('edit notifies only newly mentioned users, not those already mentioned', async () => {
  const pool = fakePool({ alreadyMentioned: [7] });
  const r = await inTenant(pool, () => editActivity(5, { id: 1 }, '@Bob and @Carol please look', [7, 8]));
  assert.equal(r.success, true);
  assert.deepEqual(pool.notified, [8]);
});

test('edit requires the token to be present in the saved text and ignores self', async () => {
  const pool = fakePool({ alreadyMentioned: [] });
  await inTenant(pool, () => editActivity(5, { id: 1 }, 'Carol only, no token. @Alice', [8, 1]));
  assert.deepEqual(pool.notified, []);
});

test('a failed edit (not the author) notifies nobody and does not update', async () => {
  const pool = fakePool({ authorId: 99 });
  const r = await inTenant(pool, () => editActivity(5, { id: 1 }, '@Carol hi', [8]));
  assert.equal(r.success, false);
  assert.deepEqual(pool.notified, []);
  assert.equal(pool.updates.length, 0);
});

test('mention-notification failure after the edit is saved does not fail the edit', async () => {
  const pool = fakePool({ failMentions: true });
  const r = await quiet(() => inTenant(pool, () => editActivity(5, { id: 1 }, '@Carol hi', [8])));
  assert.equal(r.success, true);
  assert.equal(pool.updates.length, 1);
});

// Stateful fake: task_mentions persists across edits and SELECT ... FOR UPDATE on the
// activity row is a mutex held until commit/rollback (models a PostgreSQL row lock).
// MOCKED: it checks the service's claim logic, not PostgreSQL locking itself.
function statefulPool() {
  const mentions = [];
  const notified = [];
  let owner = null;
  const waiters = [];
  const release = (c) => { if (owner === c) { owner = null; waiters.splice(0).forEach((r) => r()); } };
  const exec = async (conn, sql, p = []) => {
    await new Promise((r) => setImmediate(r));
    if (/to_regclass/.test(sql)) return [[{ name: 'notification_email_outbox' }]];
    if (/FROM task_activity/.test(sql) && !/FOR UPDATE/.test(sql)) return [[{ id: 5, task_id: 3 }]];
    if (/FROM task_activity/.test(sql)) {
      while (owner && owner !== conn) await new Promise((r) => waiters.push(r));
      owner = conn;
      return [[{ id: 5, task_id: 3, author_id: 1, activity_type: 'comment' }]];
    }
    if (/UPDATE task_activity/.test(sql)) return [[]];
    if (/FROM task_mentions/.test(sql)) return [mentions.map((id) => ({ mentioned_user_id: id }))];
    if (/INSERT INTO task_mentions/.test(sql)) { mentions.push(p[1]); return [[]]; }
    if (/FROM tasks/.test(sql)) return [[{ id: 3, task_title: 'T', task_number: 3, project_id: null, assigned_to: 1, assigned_by: 1 }]];
    if (/SELECT full_name FROM users/.test(sql)) return [[USERS[p[0]]]];
    if (/FROM users WHERE id = \?/.test(sql)) return [[USERS[p[0]]]];
    if (/INSERT INTO notifications/.test(sql)) { notified.push(p[0]); return [[{ id: 200 + notified.length }]]; }
    return [[]];
  };
  return {
    mentions, notified, query: (s, p) => exec({}, s, p),
    getConnection: async () => {
      const conn = {};
      Object.assign(conn, { beginTransaction: async () => {}, commit: async () => release(conn),
        rollback: async () => release(conn), release: () => release(conn), query: (s, p) => exec(conn, s, p) });
      return conn;
    },
  };
}

test('MOCKED: simultaneous edits mentioning the same new user notify and record exactly once', async () => {
  const pool = statefulPool();
  const body = '@Carol please look';
  await inTenant(pool, () => Promise.all([
    editActivity(5, { id: 1 }, body, [8]), editActivity(5, { id: 1 }, body, [8]),
    editActivity(5, { id: 1 }, body, [8]),
  ]));
  assert.deepEqual(pool.notified, [8]);
  assert.deepEqual(pool.mentions, [8]);
});

test('MOCKED: simultaneous edits mentioning different new users notify each once', async () => {
  const pool = statefulPool();
  await inTenant(pool, () => Promise.all([
    editActivity(5, { id: 1 }, '@Bob @Carol hi', [7, 8]), editActivity(5, { id: 1 }, '@Carol @Bob hi', [8, 7]),
  ]));
  assert.deepEqual(pool.notified.slice().sort(), [7, 8]);
});
