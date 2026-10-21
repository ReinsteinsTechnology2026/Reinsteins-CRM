const legacyPool = require('../config/db').__legacyPool;
const platformPool = require('../config/platformDb');
const { getTenantPoolForCompany } = require('../config/tenantConnectionManager');
const { isOutboxAvailable, reportOutboxMissing, listOutboxTargets, isEmailDeliveryEnabled } = require('../services/notificationEmailOutbox');
const emailService = require('../services/emailService');

const MAX_ATTEMPTS = 4;
// Small batches keep the wait for later jobs short; each job also renews its own lease.
const BATCH_SIZE = 5;
const INTERVAL_MS = Math.max(10000, Number(process.env.NOTIFICATION_EMAIL_INTERVAL_MS) || 30000);
let timer;
let running = false;

// Hard overall deadline for ONE send. Must stay below the 2-minute job lease, so a
// stuck send is abandoned (and retried) before another worker could reclaim the job.
// A timeout does NOT prove the SMTP server rejected the message: it may still have
// been accepted, so a retry can deliver a second copy (at-least-once).
const LEASE_MS = 120000;
function sendDeadlineMs() {
  const configured = Number(process.env.SMTP_SEND_DEADLINE_MS);
  const wanted = Number.isFinite(configured) && configured > 0 ? configured : 90000;
  return Math.min(wanted, LEASE_MS - 20000);
}

// Deterministic per outbox job, identical on every retry: lets receiving systems
// recognise a re-send. Contains only the database label, row ids and the sender's
// domain -- no personal data. Not a delivery guarantee.
function buildMessageId(target, job) {
  const label = String(target || 'legacy').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40) || 'legacy';
  const from = String(process.env.SMTP_FROM || '');
  const address = (from.match(/<([^>]+)>/) || [null, from])[1] || '';
  const domain = (address.split('@')[1] || '').trim().toLowerCase();
  const safeDomain = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain) ? domain : 'workhub.invalid';
  return `<outbox.${label}.${job.id}.${job.notification_id}@${safeDomain}>`;
}

async function processPool(db, target = 'legacy') {
  if (!await isOutboxAvailable(db)) {
    reportOutboxMissing(db);
    return;
  }
  const [jobs] = await db.query(`
    UPDATE notification_email_outbox SET status = 'processing',
      locked_until = CURRENT_TIMESTAMP + INTERVAL '2 minutes', attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM notification_email_outbox
      WHERE (status = 'pending' AND next_attempt_at <= CURRENT_TIMESTAMP)
         OR (status = 'processing' AND locked_until < CURRENT_TIMESTAMP)
      ORDER BY id LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
    ) RETURNING id, notification_id, user_id, subject, html, plain_text, attempts
  `);

  for (const job of jobs) {
    // Ownership: every claim increments `attempts`, so (id, status='processing',
    // attempts = job.attempts) identifies exactly this worker's claim. If another
    // worker reclaimed the job (stale lease), `attempts` changed and none of the
    // statements below match, so this worker cannot overwrite its state.
    const owned = [job.id, job.attempts];
    try {
      // The batch is processed sequentially and a slow send can outlast the
      // lease taken at claim time. Renew the lease for THIS job right before
      // working on it; if the claim was already lost, do not send at all.
      const [renewed] = await db.query(`UPDATE notification_email_outbox
        SET locked_until = CURRENT_TIMESTAMP + INTERVAL '2 minutes'
        WHERE id = ? AND status = 'processing' AND attempts = ? RETURNING id`, owned);
      if (!renewed || renewed.length === 0) {
        console.error(`[notificationEmailWorker] Lost claim on job ${job.id}; skipped`);
        continue;
      }
      // Resolve the recipient inside this job's own tenant database at send time.
      const [[user]] = await db.query(
        `SELECT email FROM users WHERE id = ? AND status = 'active'
         AND employment_status = 'active' LIMIT 1`, [job.user_id]
      );
      if (!user?.email) {
        await db.query(`UPDATE notification_email_outbox
          SET status = 'skipped', locked_until = NULL, last_error_code = 'recipient_unavailable'
          WHERE id = ? AND status = 'processing' AND attempts = ?`, owned);
        continue;
      }
      const result = await emailService.sendMail({
        to: user.email, subject: job.subject, html: job.html, text: job.plain_text,
        messageId: buildMessageId(target, job), deadlineMs: sendDeadlineMs(),
      });
      if (result.sent) {
        const connection = await db.getConnection();
        try {
          await connection.beginTransaction();
          await connection.query(`UPDATE notification_email_outbox
            SET status = 'sent', sent_at = CURRENT_TIMESTAMP, locked_until = NULL,
                last_error_code = NULL
            WHERE id = ? AND status = 'processing' AND attempts = ?`, owned);
          await connection.query(`UPDATE notifications SET email_sent_at = CURRENT_TIMESTAMP
            WHERE id = ?`, [job.notification_id]);
          await connection.commit();
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
      } else {
        // SMTP configuration disappearing mid-run is not the message's fault:
        // keep it pending without consuming an attempt.
        const unconfigured = result.reason === 'smtp_not_configured';
        if (!unconfigured) {
          console.error(`[notificationEmailWorker] Send failed for job ${job.id}: ${result.reason}${result.errorCode ? ` (${result.errorCode})` : ''}`);
        }
        const permanent = result.reason === 'no_recipient' ||
          (!unconfigured && job.attempts >= MAX_ATTEMPTS);
        await db.query(`UPDATE notification_email_outbox
          SET status = ?, locked_until = NULL, last_error_code = ?,
              attempts = GREATEST(attempts - ?, 0),
              next_attempt_at = CURRENT_TIMESTAMP + (? * INTERVAL '1 minute')
          WHERE id = ? AND status = 'processing' AND attempts = ?`, [
          permanent ? 'failed' : 'pending',
          result.reason || 'send_failed',
          unconfigured ? 1 : 0,
          unconfigured ? 5 : Math.min(60, 2 ** job.attempts), ...owned,
        ]);
      }
    } catch (_error) {
      console.error(`[notificationEmailWorker] Delivery failed for job ${job.id}`);
      try {
        await db.query(`UPDATE notification_email_outbox
          SET status = ?, locked_until = NULL, last_error_code = 'worker_error',
              next_attempt_at = CURRENT_TIMESTAMP + (? * INTERVAL '1 minute')
          WHERE id = ? AND status = 'processing' AND attempts = ?`, [
          job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          Math.min(60, 2 ** job.attempts), ...owned,
        ]);
      } catch (_updateError) {
        // Database unavailable: the lease expires and the job is reclaimed.
        console.error(`[notificationEmailWorker] Could not record failure for job ${job.id}`);
      }
    }
  }
}

async function runOnce() {
  if (running) return;
  if (!process.env.SMTP_HOST) return;
  running = true;
  try {
    // Legacy database plus every active registered tenant database, de-duplicated
    // by the identity the database server reports. No company is skipped by slug.
    const targets = await listOutboxTargets({
      platformPool, legacyPool, activeOnly: true, resolveTenantPool: getTenantPoolForCompany,
    });
    for (const target of targets) {
      if (target.duplicateOf) continue;
      if (target.error) {
        console.error(`[notificationEmailWorker] Delivery target unavailable: ${target.label} (${target.error.code || target.error.name})`);
        continue;
      }
      try {
        await processPool(target.db, target.label);
      } catch (_error) {
        console.error(`[notificationEmailWorker] Delivery pass failed for ${target.label}`);
      }
    }
  } catch (_error) {
    console.error('[notificationEmailWorker] Delivery pass failed');
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  if (!isEmailDeliveryEnabled()) {
    console.log('[notificationEmailWorker] Not started: email delivery is disabled ' +
      '(set NOTIFICATION_EMAIL_ENABLED=true to enable; it is never on by default outside development/test).');
    return;
  }
  timer = setInterval(runOnce, INTERVAL_MS);
  timer.unref?.();
  setImmediate(runOnce);
}

function stop() { if (timer) clearInterval(timer); timer = null; }
module.exports = { start, stop, runOnce, processPool, buildMessageId, sendDeadlineMs };
