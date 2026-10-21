// Unit tests: fakes and a local TCP socket only. No PostgreSQL, no real SMTP, nothing is sent.
// (Real-PostgreSQL / SMTP-capture coverage for the same features lives in the isolated harness.)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { test } = require('node:test');
const db = require('./config/db');
const emailService = require('./services/emailService');
const worker = require('./jobs/notificationEmailWorker');
const templates = require('./services/emailTemplates');
const { listOutboxTargets, dueIndexSql } = require('./services/notificationEmailOutbox');

const withEnv = async (vars, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

test('Message-ID is deterministic per job, uses the sender domain and carries no personal data', async () => {
  await withEnv({ SMTP_FROM: 'WorkHub <noreply@Mail.Example.com>' }, () => {
    const job = { id: 7, notification_id: 42, user_id: 5, subject: 'secret subject' };
    const a = worker.buildMessageId('acme', job);
    assert.equal(a, '<outbox.acme.7.42@mail.example.com>');
    assert.equal(worker.buildMessageId('acme', job), a); // identical on every retry
    assert.notEqual(worker.buildMessageId('legacy', job), a); // legacy vs tenant differ
    assert.equal(a.includes('secret') || a.includes('user'), false);
    assert.equal(worker.buildMessageId('A c/m\r\ne!', job), '<outbox.a-c-m--e-.7.42@mail.example.com>'); // sanitized label
  });
  await withEnv({ SMTP_FROM: 'not an address' }, () => {
    assert.match(worker.buildMessageId('x', { id: 1, notification_id: 2 }), /@workhub\.invalid>$/);
  });
});

test('send deadline defaults to 90s and never reaches the 120s lease', async () => {
  await withEnv({ SMTP_SEND_DEADLINE_MS: undefined }, () => assert.equal(worker.sendDeadlineMs(), 90000));
  await withEnv({ SMTP_SEND_DEADLINE_MS: '5000' }, () => assert.equal(worker.sendDeadlineMs(), 5000));
  await withEnv({ SMTP_SEND_DEADLINE_MS: '999999' }, () => assert.equal(worker.sendDeadlineMs(), 100000));
  await withEnv({ SMTP_SEND_DEADLINE_MS: 'abc' }, () => assert.equal(worker.sendDeadlineMs(), 90000));
});

test('sendMail abandons a stuck send at the deadline with a retryable send_timeout (local silent TCP server)', async () => {
  const server = net.createServer(() => { /* accepts and never speaks SMTP */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const original = console.error;
  console.error = () => {};
  try {
    const t0 = Date.now();
    const result = await withEnv({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.address().port) },
      () => emailService.sendMail({ to: 'a@test.invalid', subject: 's', text: 't', deadlineMs: 400 }));
    assert.deepEqual(result, { sent: false, reason: 'send_timeout' });
    assert.ok(Date.now() - t0 < 3000, 'returned promptly after the deadline');
  } finally { console.error = original; server.close(); }
});

test('MOCKED: send_timeout is retryable (back to pending with backoff) and is recorded as an error code only', async () => {
  const log = [];
  const run = async (sql, params = []) => {
    log.push({ sql, params });
    if (/to_regclass/.test(sql)) return [[{ name: 'x' }]];
    if (/RETURNING id, notification_id/.test(sql)) return [[{ id: 1, notification_id: 9, user_id: 5, subject: 's', html: 'h', plain_text: 't', attempts: 2 }]];
    if (/SET locked_until/.test(sql)) return [[{ id: 1 }]];
    if (/FROM users/.test(sql)) return [[{ email: 'a@test.invalid' }]];
    return [[]];
  };
  const fake = { query: run, getConnection: async () => ({ query: run, beginTransaction() {}, commit() {}, rollback() {}, release() {} }) };
  const seen = [];
  const orig = emailService.sendMail;
  emailService.sendMail = async (m) => { seen.push(m); return { sent: false, reason: 'send_timeout' }; };
  try { await worker.processPool(fake, 'acme'); } finally { emailService.sendMail = orig; }
  assert.match(seen[0].messageId, /^<outbox\.acme\.1\.9@[^>]+>$/);
  assert.ok(seen[0].deadlineMs > 0 && seen[0].deadlineMs < 120000);
  const upd = log.filter((l) => /SET status = \?/.test(l.sql)).pop();
  assert.equal(upd.params[0], 'pending');
  assert.equal(upd.params[1], 'send_timeout');
});

// ---- target enumeration (fake pools whose "server identity" we control) ----
const fakeDb = (identity, { fail } = {}) => ({
  query: async () => { if (fail) throw Object.assign(new Error('boom'), { code: fail }); return [[identity]]; },
});
const id = (db, started = 'T1') => ({ db, port: 5432, started, oid: db + '-oid' });
const platform = (companies) => ({ query: async (sql) => { platform.lastSql = sql; return [companies]; } });

test('MOCKED: targets = legacy + every registered tenant; no company is skipped by slug (incl. reinsteins)', async () => {
  const legacy = fakeDb(id('reinsteins_workhub'));
  const pools = { tenant_reinsteins: fakeDb(id('tenant_reinsteins')), tenant_acme: fakeDb(id('tenant_acme')) };
  const targets = await listOutboxTargets({
    platformPool: platform([{ id: 1, company_slug: 'reinsteins', tenant_db_name: 'tenant_reinsteins' }, { id: 2, company_slug: 'acme', tenant_db_name: 'tenant_acme' }]),
    legacyPool: legacy, resolveTenantPool: (c) => pools[c.tenant_db_name], activeOnly: true,
  });
  assert.deepEqual(targets.map((t) => `${t.kind}:${t.label}`), ['legacy:legacy', 'tenant:reinsteins', 'tenant:acme']);
  assert.ok(targets.every((t) => t.db && !t.error && !t.duplicateOf));
  assert.match(platform.lastSql, /status = 'active'/);
  await listOutboxTargets({ platformPool: platform([]), legacyPool: legacy, resolveTenantPool: () => null, activeOnly: false });
  assert.doesNotMatch(platform.lastSql, /status = 'active'/);
});

test('MOCKED: the same database reached through different settings is processed once (identity from the server)', async () => {
  const same = id('tenant_shared');
  const targets = await listOutboxTargets({
    platformPool: platform([{ id: 1, company_slug: 'dupco', tenant_db_name: 'tenant_shared' }]),
    legacyPool: fakeDb(same), resolveTenantPool: () => fakeDb(same), activeOnly: true,
  });
  assert.equal(targets.length, 2);
  assert.ok(targets[0].db && !targets[0].duplicateOf);
  assert.equal(targets[1].duplicateOf, 'legacy');
  // same database name on a different server instance is NOT a duplicate
  const other = await listOutboxTargets({
    platformPool: platform([{ id: 1, company_slug: 'x', tenant_db_name: 'tenant_shared' }]),
    legacyPool: fakeDb(same), resolveTenantPool: () => fakeDb(id('tenant_shared', 'T2')), activeOnly: true,
  });
  assert.ok(other.every((t) => t.db));
});

test('MOCKED: an unreachable target is reported with its error and does not affect the others', async () => {
  const targets = await listOutboxTargets({
    platformPool: platform([{ id: 1, company_slug: 'gone', tenant_db_name: 'tenant_gone' }, { id: 2, company_slug: 'ok', tenant_db_name: 'tenant_ok' }]),
    legacyPool: fakeDb(id('legacy_db')),
    resolveTenantPool: (c) => (c.company_slug === 'gone' ? fakeDb(null, { fail: '3D000' }) : fakeDb(id('tenant_ok'))), activeOnly: true,
  });
  assert.equal(targets[1].error.code, '3D000');
  assert.ok(targets[0].db && targets[2].db);
});

// ---- link prefix follows the ACTIVE DATABASE, not the slug ----
const data = { taskTitle: 'T', taskNumber: 1, projectName: 'P', actorName: 'A', taskId: 9, recipientRole: 'admin' };
const linkIn = (ctx) => {
  const make = () => templates.taskAssignedEmail(data).text.match(/https?:\/\/\S+/)[0];
  return ctx ? db.__runWithTenantContext(ctx, make) : make();
};
test('link prefix: legacy pool => none; any other pool => /<slug>, including a tenant registered as "reinsteins"', async () => {
  await withEnv({ APP_BASE_URL: 'https://workhub.example', NODE_ENV: 'test' }, () => {
    assert.equal(linkIn(null), 'https://workhub.example/admin/task-workspace/9');
    assert.equal(linkIn({ tenantPool: db.__legacyPool, companySlug: 'reinsteins' }), 'https://workhub.example/admin/task-workspace/9');
    assert.equal(linkIn({ tenantPool: { query() {} }, companySlug: 'reinsteins' }), 'https://workhub.example/reinsteins/admin/task-workspace/9');
    assert.equal(linkIn({ tenantPool: { query() {} }, companySlug: 'acme' }), 'https://workhub.example/acme/admin/task-workspace/9');
  });
});

test('schema file contains the due index with the same definition the migration uses', () => {
  const file = fs.readFileSync(path.join(__dirname, 'schemas/tenantSchema.postgresql.sql'), 'utf8');
  const norm = (s) => s.replace(/"/g, '').replace(/IF NOT EXISTS /i, '').replace(/\s+/g, ' ').replace(/ \(/g, ' (').trim().toLowerCase();
  const inFile = file.split(';').map((s) => s.trim()).filter((s) => /idx_notification_email_outbox_due/.test(s)).map(norm);
  assert.equal(inFile.length, 1);
  assert.equal(inFile[0].replace(/\s*,\s*/g, ','), norm(dueIndexSql).replace(/\s*,\s*/g, ','));
});

// ---- shared SMTP behavior is unchanged; the new behavior is scoped to the outbox worker ----
// MOCKED: nodemailer.createTransport is replaced, so nothing is ever sent.
function loadEmailServiceWithFakeNodemailer(sendImpl) {
  const nodemailer = require('nodemailer');
  const created = [];
  const original = nodemailer.createTransport;
  nodemailer.createTransport = (options) => { created.push(options); return { sendMail: sendImpl }; };
  delete require.cache[require.resolve('./services/emailService')];
  const service = require('./services/emailService');
  return { service, created, restore: () => { nodemailer.createTransport = original; delete require.cache[require.resolve('./services/emailService')]; } };
}
const capture = async (fn) => {
  const out = { log: [], error: [] };
  const [l, e] = [console.log, console.error];
  console.log = (...a) => out.log.push(a.join(' '));
  console.error = (...a) => out.error.push(a.join(' '));
  try { out.value = await fn(); } finally { console.log = l; console.error = e; }
  return out;
};

test('MOCKED: the shared transport has no new timeouts; only the outbox transport does (same host and credentials)', async () => {
  const f = loadEmailServiceWithFakeNodemailer(async () => ({ messageId: '<m@x>' }));
  try {
    await withEnv({ SMTP_HOST: 'smtp.test.invalid', SMTP_PORT: '2525', SMTP_USER: 'u', SMTP_PASS: 'p' }, async () => {
      await capture(() => f.service.sendMail({ to: 'a@test.invalid', subject: 's', text: 't' }));
      await capture(() => f.service.sendMail({ to: 'a@test.invalid', subject: 's', text: 't', messageId: '<id@x>', deadlineMs: 5000 }));
    });
    assert.equal(f.created.length, 2);
    const [shared, scoped] = f.created;
    for (const key of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) assert.equal(key in shared, false, key);
    assert.deepEqual([scoped.connectionTimeout, scoped.greetingTimeout, scoped.socketTimeout], [15000, 15000, 60000]);
    for (const key of ['host', 'port', 'secure', 'auth']) assert.deepEqual(scoped[key], shared[key], key);
  } finally { f.restore(); }
});

test('MOCKED: other flows keep their original diagnostics; the outbox path logs no subject, recipient or message text', async () => {
  const ok = loadEmailServiceWithFakeNodemailer(async () => ({ messageId: '<m@x>' }));
  try {
    await withEnv({ SMTP_HOST: 'smtp.test.invalid' }, async () => {
      const shared = await capture(() => ok.service.sendMail({ to: 'a@test.invalid', subject: 'Invoice 7', text: 't' }));
      assert.match(shared.log.join('\n'), /Sent "Invoice 7" to a@test\.invalid \(messageId: <m@x>\)/); // original format
      const scoped = await capture(() => ok.service.sendMail({ to: 'a@test.invalid', subject: 'Task: secret title', text: 't', messageId: '<id@x>' }));
      assert.equal(scoped.log.join('\n').includes('secret title') || scoped.log.join('\n').includes('a@test.invalid'), false);
    });
  } finally { ok.restore(); }

  const fail = loadEmailServiceWithFakeNodemailer(async () => { throw Object.assign(new Error('550 rejected <a@test.invalid> host smtp.test.invalid'), { code: 'EENVELOPE', responseCode: 550 }); });
  try {
    await withEnv({ SMTP_HOST: 'smtp.test.invalid' }, async () => {
      const shared = await capture(() => fail.service.sendMail({ to: 'a@test.invalid', subject: 'Invoice 7', text: 't' }));
      assert.match(shared.error.join('\n'), /Failed to send "Invoice 7" to a@test\.invalid:.*550 rejected/); // original format
      assert.match(shared.value.error, /550 rejected/);
      const scoped = await capture(() => fail.service.sendMail({ to: 'a@test.invalid', subject: 'Task: secret title', text: 't', messageId: '<id@x>' }));
      const text = scoped.error.join('\n');
      assert.match(text, /SMTP delivery failed \(EENVELOPE\)/); // useful, redacted diagnostic
      assert.equal(/secret title|a@test\.invalid|rejected|smtp\.test/.test(text), false);
      assert.equal(scoped.value.error, undefined);
      assert.equal(scoped.value.errorCode, 'EENVELOPE');
    });
  } finally { fail.restore(); }
});

test('MOCKED: scoped diagnostics never include credentials', async () => {
  const fail = loadEmailServiceWithFakeNodemailer(async () => { throw Object.assign(new Error('Invalid login: 535 for user hunter2-user'), { code: 'EAUTH' }); });
  try {
    await withEnv({ SMTP_HOST: 'smtp.test.invalid', SMTP_USER: 'hunter2-user', SMTP_PASS: 'hunter2-pass' }, async () => {
      const scoped = await capture(() => fail.service.sendMail({ to: 'a@test.invalid', subject: 's', text: 't', deadlineMs: 5000 }));
      assert.equal(/hunter2/.test(JSON.stringify([scoped.log, scoped.error, scoped.value])), false);
    });
  } finally { fail.restore(); }
});
