// Unit tests: mocked database and mocked email transport only.
// No real PostgreSQL, no real SMTP, nothing is sent.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const emailService = require('./services/emailService');
const worker = require('./jobs/notificationEmailWorker');
const { processPool } = worker;

function fakeDb({ jobs, user, outbox = true, lostClaim = false }) {
  const log = [];
  const run = async (sql, params = []) => {
    log.push({ sql, params });
    if (/^\s*UPDATE notification_email_outbox\s+SET locked_until/.test(sql)) return [lostClaim ? [] : [{ id: 1 }]];
    if (/to_regclass/.test(sql)) return [[{ name: outbox ? 'notification_email_outbox' : null }]];
    if (/RETURNING id, notification_id/.test(sql)) return [jobs];
    if (/FROM users/.test(sql)) return [user ? [user] : []];
    return [[]];
  };
  return {
    log, query: run,
    getConnection: async () => ({ beginTransaction: async () => {}, commit: async () => {},
      rollback: async () => {}, release: () => {}, query: run }),
  };
}
const job = (attempts, id = 1) => ({ id, notification_id: 9, user_id: 5, subject: 's', html: '<p>h</p>', plain_text: 'h', attempts });
const statusOf = (db) => db.log.filter((l) => /SET status/.test(l.sql)).pop();

async function withMail(impl, fn) {
  const orig = emailService.sendMail;
  emailService.sendMail = impl;
  try { return await fn(); } finally { emailService.sendMail = orig; }
}

test('successful send marks sent and records email_sent_at', async () => {
  const sent = [];
  const db = fakeDb({ jobs: [job(1)], user: { email: 'a@test.invalid' } });
  await withMail(async (m) => { sent.push(m); return { sent: true }; }, () => processPool(db));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'a@test.invalid');
  assert.ok(db.log.some((l) => /status = 'sent'/.test(l.sql)));
  assert.ok(db.log.some((l) => /SET email_sent_at/.test(l.sql)));
});

test('temporary failure returns to pending with backoff', async () => {
  const db = fakeDb({ jobs: [job(2)], user: { email: 'a@test.invalid' } });
  await withMail(async () => ({ sent: false, reason: 'send_failed' }), () => processPool(db));
  const u = statusOf(db);
  assert.equal(u.params[0], 'pending');
  assert.equal(u.params[3], 4);
});

test('failure at the attempt limit becomes failed with an error code only', async () => {
  const db = fakeDb({ jobs: [job(4)], user: { email: 'a@test.invalid' } });
  await withMail(async () => ({ sent: false, reason: 'send_failed', error: 'secret-host' }), () => processPool(db));
  assert.equal(statusOf(db).params[0], 'failed');
  assert.equal(JSON.stringify(db.log).includes('secret-host'), false);
});

test('SMTP disappearing mid-run keeps the job pending without using an attempt', async () => {
  const db = fakeDb({ jobs: [job(4)], user: { email: 'a@test.invalid' } });
  await withMail(async () => ({ sent: false, reason: 'smtp_not_configured' }), () => processPool(db));
  const u = statusOf(db);
  assert.equal(u.params[0], 'pending');
  assert.equal(u.params[2], 1);
});

test('inactive or missing recipient is skipped and nothing is sent', async () => {
  let called = false;
  const db = fakeDb({ jobs: [job(1)], user: null });
  await withMail(async () => { called = true; return { sent: true }; }, () => processPool(db));
  assert.equal(called, false);
  assert.ok(db.log.some((l) => /status = 'skipped'/.test(l.sql)));
});

test('missing SMTP_HOST: runOnce sends nothing and the sender reports it honestly', async () => {
  const saved = process.env.SMTP_HOST;
  delete process.env.SMTP_HOST;
  let called = false;
  try {
    await withMail(async () => { called = true; return { sent: true }; }, () => worker.runOnce());
    assert.equal(called, false);
  } finally {
    if (saved !== undefined) process.env.SMTP_HOST = saved;
  }
  if (!process.env.SMTP_HOST) {
    assert.equal((await emailService.sendMail({ to: 'a@test.invalid', subject: 's' })).reason, 'smtp_not_configured');
  }
});

test('claim query uses SKIP LOCKED and reclaims stale processing rows (structural check)', async () => {
  const db = fakeDb({ jobs: [], user: null });
  await processPool(db);
  const claim = db.log.find((l) => /SKIP LOCKED/.test(l.sql)).sql;
  assert.match(claim, /FOR UPDATE SKIP LOCKED/);
  assert.match(claim, /status = 'processing' AND locked_until < CURRENT_TIMESTAMP/);
  assert.match(claim, /attempts = attempts \+ 1/);
});

test('missing outbox table: worker reports it, claims nothing and sends nothing', async () => {
  let called = false;
  const db = fakeDb({ jobs: [job(1)], user: { email: 'a@test.invalid' }, outbox: false });
  const errors = [];
  const original = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    await withMail(async () => { called = true; return { sent: true }; }, () => processPool(db));
  } finally { console.error = original; }
  assert.equal(called, false);
  assert.equal(db.log.some((l) => /SKIP LOCKED/.test(l.sql)), false);
  assert.ok(errors.some((m) => /notification_email_outbox is missing/.test(m)));
});

test('tenant isolation (logic level): each job resolves its recipient in its own pool', async () => {
  const a = fakeDb({ jobs: [job(1, 1)], user: { email: 'a@tenant-a.invalid' } });
  const b = fakeDb({ jobs: [job(1, 2)], user: { email: 'b@tenant-b.invalid' } });
  const sent = [];
  await withMail(async (m) => { sent.push(m.to); return { sent: true }; },
    async () => { await processPool(a); await processPool(b); });
  assert.deepEqual(sent, ['a@tenant-a.invalid', 'b@tenant-b.invalid']);
  assert.equal(a.log.some((l) => l.params.includes(2)), false);
});

test('MOCKED: a job whose claim was lost is not sent and its state is not overwritten', async () => {
  let called = false;
  const db = fakeDb({ jobs: [job(2)], user: { email: 'a@test.invalid' }, lostClaim: true });
  const errors = [];
  const original = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    await withMail(async () => { called = true; return { sent: true }; }, () => processPool(db));
  } finally { console.error = original; }
  assert.equal(called, false);
  assert.equal(db.log.some((l) => /SET status = '(sent|pending|failed|skipped)'|SET status = \?/.test(l.sql)), false);
  assert.ok(errors.some((m) => /Lost claim on job 1/.test(m)));
});

test('MOCKED: every state update is conditioned on this worker\'s claim (status and attempts)', async () => {
  const db = fakeDb({ jobs: [job(3)], user: { email: 'a@test.invalid' } });
  await withMail(async () => ({ sent: false, reason: 'send_failed' }), () => processPool(db));
  const updates = db.log.filter((l) => /^\s*UPDATE notification_email_outbox/.test(l.sql)
    && !/SET status = 'processing'/.test(l.sql));
  assert.ok(updates.length >= 2);
  for (const u of updates) {
    assert.match(u.sql, /status = 'processing' AND attempts = \?/);
    assert.equal(u.params[u.params.length - 1], 3);
  }
});

// Two workers share one in-memory outbox. Worker A's first send is slow, and during it
// worker B reclaims A's second job (its lease expired). A must then NOT send that job.
test('MOCKED: slow batch - jobs reclaimed by another worker during a long send are not sent twice', async () => {
  const table = new Map([[1, { id: 1, attempts: 1 }], [2, { id: 2, attempts: 1 }]]);
  const sentIds = [];
  const dbA = {
    query: async (sql, p = []) => {
      if (/to_regclass/.test(sql)) return [[{ name: 'x' }]];
      if (/RETURNING id, notification_id/.test(sql)) {
        return [[job(1, 1), job(1, 2)]];
      }
      if (/SET locked_until/.test(sql)) {
        const row = table.get(p[0]);
        return [row && row.attempts === p[1] ? [{ id: p[0] }] : []];
      }
      if (/FROM users/.test(sql)) return [[{ email: 'a@test.invalid' }]];
      return [[]];
    },
    getConnection: async () => ({ beginTransaction: async () => {}, commit: async () => {},
      rollback: async () => {}, release: () => {}, query: async () => [[]] }),
  };
  await withMail(async (m) => {
    sentIds.push(m.subject);
    // While job 1 is "slowly" sending, worker B reclaims job 2: attempts 1 -> 2.
    table.get(2).attempts = 2;
    return { sent: true };
  }, () => processPool(dbA));
  assert.equal(sentIds.length, 1); // only job 1; job 2 now belongs to worker B
});
