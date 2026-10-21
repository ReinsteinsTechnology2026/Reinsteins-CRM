# TechOps email notifications

Task assignment, reassignment, transfer, and task discussion mentions use the
existing tenant `notifications` table. Email requests are stored in that
tenant's `notification_email_outbox` table alongside the in-app notification.
The worker in `jobs/notificationEmailWorker.js` sends them after commit. It
rechecks the recipient in the same tenant database before sending.

Set `SMTP_HOST`, `SMTP_PORT`, optional `SMTP_USER`/`SMTP_PASS`, `SMTP_FROM`,
and the trusted frontend origin `APP_BASE_URL` in `server/.env`. Keep these
values out of Git. Without `SMTP_HOST`, queued rows remain `pending`; no email
is reported as sent. For a local SMTP capture server, use MailDev or another
test transport and inspect its inbox.

**Migration required.** The app never creates tables at runtime. New tenant
databases get `notification_email_outbox` from
`schemas/tenantSchema.postgresql.sql`. The legacy database and existing tenants
need `node _migrate_add_notification_email_outbox.js` (idempotent, additive,
not run automatically) before assignment/mention emails can be queued. Until
then the in-app notification is still created, the email is not queued, and
`[notificationEmail] notification_email_outbox is missing` is logged once per
database; the worker also logs it and sends nothing.

`status` is `pending`, `processing`, `sent`, `failed`, or `skipped`.
`attempts`, `next_attempt_at`, and `last_error_code` support diagnosis and
bounded retry. Failures store a code, not an SMTP error message or credential.
Rows marked `processing` are reclaimed after two minutes if a worker stops.
Multiple instances claim different rows using PostgreSQL row locks.

SMTP acceptance is not proof of inbox delivery. If the process stops after
SMTP accepts a message but before the row is marked `sent`, a retry can send
it again. Delivery is therefore at least once, not exactly once. Assignment emails are
created only for a transition actually persisted: `updateTask` reads the previous
assignee under a row lock in the same transaction as its UPDATE, and `assignTask`
and `transferTask` use an atomic `IS DISTINCT FROM ... RETURNING` update, so
competing requests produce one email for one transition.
Removing an assignee sends no new-owner email. Self-assignment sends no email.

Post-commit policy: once a task, comment or edit has been saved, a failure while
queuing its notification or email is logged (error code only) and never turns the
request into a 500. Business and validation errors before the save are still
reported. Comment edits lock the comment row, record newly mentioned users in
`task_mentions`, then notify only those users, so competing edits cannot notify the
same person twice (`task_mentions` has no unique constraint, so the lock is what
provides this). Email links use the recipient's role read from the tenant database.

Worker claims and leases: jobs are claimed in batches of 5. Each job's 2-minute lease
is renewed immediately before that job is processed, and every state update is
conditioned on `status = 'processing' AND attempts = <claim>` so a worker that lost
its claim cannot send or overwrite state. This narrows, but does not remove, the
duplicate window (e.g. a send that outlasts a lease, or a crash after SMTP accepts):
delivery remains at-least-once.

`APP_BASE_URL`: when `NODE_ENV=production` it must be set to a valid http(s) origin.
Otherwise no email is created or queued (the in-app notification still is) and one
error is logged. Outside production the localhost default is kept.

Outstanding (not addressed here): sweep notifications for tenant databases,
outbox retention/purge, adding the due-index to the tenant schema file.

Delivery targets: the worker and the migration process the legacy database plus every
tenant database registered in the platform database (the worker: active companies only;
the migration: every company with a tenant database). No company is skipped by slug.
A database reached through two registrations is processed once, identified by what the
database server reports (start time, port, database name, oid), not by host text.
Email links get a `/<slug>` prefix whenever the request ran on any database other than
the legacy one, regardless of the company slug.

Send deadline and Message-ID: each send is abandoned after `SMTP_SEND_DEADLINE_MS`
(default 90000, never more than 100000, below the 2-minute lease). A timeout is retried
like any temporary failure and is recorded as `send_timeout`. A timeout does NOT prove the
server rejected the message; it may already have accepted it, so a retry can deliver a
second copy. Every attempt for one outbox job carries the same
`Message-ID: <outbox.<label>.<job id>.<notification id>@<sender domain>>`, which some
receiving systems use to recognise a duplicate; this is not guaranteed. Delivery remains
at-least-once, never exactly-once.

## Delivery guarantee and known duplicate-send risks

Delivery is **at-least-once. It is not exactly-once**, and nothing here can make it so:
SMTP gives no way to learn atomically that a message was accepted and to record that fact.
A recipient can receive the same email more than once when:

1. **The worker stops after the SMTP server accepted the message but before the row was
   marked `sent`.** After the lease expires, another run sends it again.
2. **A send times out** (`SMTP_SEND_DEADLINE_MS`). A timeout does not mean the server
   rejected the message; it may have accepted it. Each retry can send another copy, up to
   the attempt limit (4). A job can therefore end as `failed` / `send_timeout` even though
   one or more copies were delivered. Observed in an isolated test: with a server that
   accepted every message but acknowledged slowly, 4 copies were received.
3. **A send outlasts the job lease** and another worker reclaims the job. The claim checks
   stop the first worker from overwriting state, but the message it was already sending can
   still arrive in addition to the second worker's copy.
4. The mail provider itself delivers a message twice.

Every attempt for one outbox job carries the same Message-ID. Some receiving systems drop a
repeat with the same Message-ID, but this is not guaranteed and must not be relied on.

Two workers never process the same pending row at the same time (`FOR UPDATE SKIP LOCKED`),
and a worker that lost its claim skips the job instead of sending it.
