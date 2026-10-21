const { __runWithTenantContext: runWithTenantContext } = require("../config/db");
const platformCompanyService = require("../services/platformCompanyService");
const tenantConnectionManager = require("../config/tenantConnectionManager");
const { createNotification } = require("../services/notificationService");
const {
    taskDueSoonEmail,
    taskOverdueEmail,
} = require("../services/emailTemplates");

// ==========================================
// NOTIFICATION SWEEP — DUE SOON / OVERDUE
//
// The one notification path in this feature that
// isn't triggered by a single user action -- it's
// a small periodic job, deliberately kept out of
// app.js (per the approved architecture) and
// isolated in its own module so it's easy to find,
// disable, or reconfigure without touching request
// handling at all.
//
// Recipient is always the task's own assigned_to --
// never anything client-supplied, since this job
// has no request/client input at all. A task's
// assignee always has visibility into their own
// task regardless of project membership rules
// (they're the assignee), so no extra permission
// check is needed there; this job additionally
// skips tasks whose project is completed/cancelled
// and assignees who are no longer active, so it
// never nags about dead work.
//
// Duplicate prevention: before creating a
// task_due_soon or task_overdue notification for a
// given (user, task), it checks whether one of that
// exact type already exists for that task+user and
// skips if so -- so re-running the sweep every hour
// against a task that's still "due in 2 days"
// creates exactly one notification, not one per
// sweep tick. (Known limitation: if a task's due
// date is pushed out and then pulled back in, the
// old notification row still counts as "already
// notified" — documented, not fixed, to keep this
// change additive and simple.)
//
// TENANT ISOLATION: there is no request (and so no
// tenantProtect-established context) here, so a bare
// pool.query() would hit the legacy database. Instead
// each pass enumerates companies from the platform
// database and sweeps each tenant database on its own,
// inside runWithTenantContext -- the same mechanism
// tenantProtect and the Socket.IO handlers use -- so
// createNotification()'s INSERT, its recipient-email
// lookup, and its Socket.IO room all resolve to that
// same tenant. Task/user IDs read from one tenant are
// only ever used within that tenant's own pass. One
// tenant's failure is logged by slug and never stops
// the remaining tenants.
//
// CAPS: a pass creates at most MAX_PER_TENANT
// notifications in any one tenant and MAX_PER_RUN in
// total (each notification is at most one email).
// Eligibility and due-soon/overdue classification are
// exactly as above -- a cap only decides how many of
// the eligible tasks are handled THIS pass. A deferred
// task gets no notification row, so the duplicate check
// still sees it as un-notified and a later pass picks
// it up, re-evaluated against that pass's "today".
//
// ORDER within a tenant: due-soon before overdue (a
// due-soon reminder is only useful before the due
// date), each by due date then task id, oldest first.
// Consequence of deferral: a due-soon task still
// deferred when its due date passes is classified
// overdue on its turn, so it gets task_overdue and
// never task_due_soon. Overdue never turns back into
// due-soon, so deferring an overdue task only delays it.
//
// FAIRNESS across tenants: tenants are visited in
// company-id order, starting from the tenant the
// previous pass's run-wide budget ran out on, so a few
// large backlogs can't keep later tenants waiting pass
// after pass. Once the budget is spent, the remaining
// tenants' databases are not queried at all this pass.
//
// EMAIL FAILURES ARE NOT RETRIED: createNotification()
// writes the row first and then attempts the email;
// emailService.sendMail never throws and a failure only
// leaves email_sent_at NULL. Because the duplicate check
// keys on the row, that task is never emailed again --
// the in-app notification is the only delivery.
//
// FUTURE HARDENING: the overlap guard below is
// in-process only, and the duplicate check is a
// check-then-insert with no unique constraint behind
// it. That's safe while production runs a single Node
// process (one systemd unit, no cluster). Before ever
// running more than one, take a per-tenant
// pg_try_advisory_lock around sweepTenant.
// ==========================================

const DUE_SOON_WINDOW_DAYS = Number(process.env.NOTIFICATION_DUE_SOON_DAYS) || 2;
const SWEEP_INTERVAL_MS = Number(process.env.NOTIFICATION_SWEEP_INTERVAL_MS) || 60 * 60 * 1000; // hourly
const SWEEP_ENABLED = process.env.NOTIFICATION_SWEEP_ENABLED !== "false"; // enabled unless explicitly disabled

const DEFAULT_MAX_PER_TENANT = 50;
const DEFAULT_MAX_PER_RUN = 200;

// 0 = unlimited; anything that isn't a non-negative integer falls back to the default.
function readCap(value, fallback) {
    if (value === undefined || value === null || String(value).trim() === "") {
        return fallback;
    }
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) {
        return fallback;
    }
    return n === 0 ? Infinity : n;
}

function formatCap(cap) {
    return cap === Infinity ? "unlimited" : String(cap);
}

const MAX_PER_TENANT = readCap(process.env.NOTIFICATION_SWEEP_MAX_PER_TENANT, DEFAULT_MAX_PER_TENANT);
const MAX_PER_RUN = readCap(process.env.NOTIFICATION_SWEEP_MAX_PER_RUN, DEFAULT_MAX_PER_RUN);

let intervalHandle = null;
let sweepInProgress = false;

// Company id the next pass starts from (see FAIRNESS above); null = the
// lowest id. In memory only -- a restart simply starts from the top.
let nextStartCompanyId = null;

async function hasExistingNotification(db, userId, taskId, type) {

    const [rows] = await db.query(
        `
        SELECT id FROM notifications
        WHERE user_id = ?
        AND reference_type = 'task'
        AND reference_id = ?
        AND type = ?
        LIMIT 1
        `,
        [userId, taskId, type]
    );

    return rows.length > 0;

}

function formatDueDate(dueDate) {
    return new Date(dueDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

// Due-soon first, then overdue; within each, earliest due date, then
// lowest task id -- a total order, so a capped pass is deterministic.
function compareCandidates(a, b) {
    if (a.isOverdue !== b.isOverdue) {
        return a.isOverdue ? 1 : -1;
    }
    return (new Date(a.task.due_date) - new Date(b.task.due_date)) || (a.task.id - b.task.id);
}

// Lowest company id first, rotated to begin at `startId` (or the next
// id after it, if that company is gone); wraps around.
function orderCompanies(companies, startId) {

    const sorted = [...companies].sort((a, b) => a.id - b.id);

    if (startId == null) {
        return sorted;
    }

    const start = sorted.findIndex((company) => company.id >= startId);

    return start <= 0 ? sorted : [...sorted.slice(start), ...sorted.slice(0, start)];

}

// ==========================================
// RUN ONE SWEEP PASS
// Exported separately from the interval so it can
// be invoked directly (e.g. from a test script or a
// future manual "run now" admin action) without
// waiting for the timer.
//
// `options` ({ maxPerTenant, maxPerRun }) overrides
// the configured caps for this one pass, with the
// same 0 = unlimited / invalid = default rules.
// ==========================================

async function runSweepOnce(io, options = {}) {

    // A pass that outlives the interval (many tenants, slow SMTP)
    // must not overlap with the next tick.
    if (sweepInProgress) {
        console.log("[notificationSweep] Previous sweep pass still running -- skipping this tick.");
        return { skipped: true, dueSoonCreated: 0, overdueCreated: 0, capped: false, tenants: [] };
    }

    sweepInProgress = true;

    try {
        return await sweepAllTenants(io, {
            maxPerTenant: readCap(options.maxPerTenant, MAX_PER_TENANT),
            maxPerRun: readCap(options.maxPerRun, MAX_PER_RUN),
        });
    } finally {
        sweepInProgress = false;
    }

}

async function sweepAllTenants(io, { maxPerTenant, maxPerRun }) {

    const companies = orderCompanies(
        (await platformCompanyService.listCompanies()).filter(
            (company) => company.tenant_db_name && platformCompanyService.isCompanyAccessAllowed(company)
        ),
        nextStartCompanyId
    );

    const tenants = [];
    let dueSoonCreated = 0;
    let overdueCreated = 0;
    let capped = false;
    let deferredTenants = 0;

    // First tenant that didn't get its full turn because the run-wide
    // budget ran out -- where the next pass starts.
    let resumeCompanyId = null;

    for (const company of companies) {

        const companySlug = company.company_slug;

        const runBudget = maxPerRun - (dueSoonCreated + overdueCreated);

        // Run-wide budget spent: leave this tenant's database untouched
        // until the next pass.
        if (runBudget <= 0) {
            capped = true;
            deferredTenants += 1;
            if (resumeCompanyId === null) {
                resumeCompanyId = company.id;
            }
            tenants.push({ companySlug, dueSoonCreated: 0, overdueCreated: 0, capped: true, deferred: true });
            continue;
        }

        const limit = Math.min(maxPerTenant, runBudget);

        // Updated by sweepTenant as each notification is created, so a
        // tenant that throws partway still has what it already created
        // (and emailed) counted against the run-wide budget.
        const progress = { dueSoonCreated: 0, overdueCreated: 0, capped: false };

        try {

            // Re-validates tenant_db_name; throws on anything invalid.
            const tenantPool = tenantConnectionManager.getTenantPoolForCompany(company);

            // eslint-disable-next-line no-await-in-loop
            await runWithTenantContext(
                { tenantPool, companySlug },
                () => sweepTenant(io, tenantPool, companySlug, limit, progress)
            );

            tenants.push({ companySlug, ...progress });

            // Stopped by the run-wide budget rather than its own cap.
            if (progress.capped && limit < maxPerTenant && resumeCompanyId === null) {
                resumeCompanyId = company.id;
            }

        } catch (error) {

            console.error(`[notificationSweep] Sweep failed for tenant "${companySlug}":`, error.message);
            tenants.push({ companySlug, ...progress, error: error.message });

        }

        dueSoonCreated += progress.dueSoonCreated;
        overdueCreated += progress.overdueCreated;
        capped = capped || progress.capped;

    }

    nextStartCompanyId = resumeCompanyId;

    if (deferredTenants > 0) {
        console.log(`[notificationSweep] Per-run cap (${formatCap(maxPerRun)}) reached -- ${deferredTenants} tenant(s) deferred to the next pass.`);
    }

    return { dueSoonCreated, overdueCreated, capped, tenants };

}

// One tenant's pass. `db` is that tenant's own pool, and this always
// runs inside its runWithTenantContext, so createNotification() writes
// to the same database the candidates were read from. Creates at most
// `limit` notifications; the rest wait for a later pass. Counts go into
// the caller's `progress` as they happen (see sweepAllTenants).
async function sweepTenant(io, db, companySlug, limit, progress) {

    const [candidates] = await db.query(
        `
        SELECT
            t.id, t.task_number, t.task_title, t.assigned_to, t.due_date, t.project_id,
            p.name AS project_name, p.status AS project_status,
            u.employment_status AS assignee_status
        FROM tasks t
        LEFT JOIN projects p ON p.id = t.project_id
        LEFT JOIN users u ON u.id = t.assigned_to
        WHERE t.assigned_to IS NOT NULL
        AND t.status != 'closed'
        AND t.due_date IS NOT NULL
        AND t.deleted_at IS NULL
        `
    );

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dueSoonCutoff = new Date(today);
    dueSoonCutoff.setDate(dueSoonCutoff.getDate() + DUE_SOON_WINDOW_DAYS);

    // Same eligibility and classification as always; only collected
    // first so they can be handled in a fixed order.
    const eligible = [];

    for (const task of candidates) {

        if (task.project_id && ["completed", "cancelled"].includes(task.project_status)) {
            continue;
        }

        if (task.assignee_status !== "active") {
            continue;
        }

        const dueDate = new Date(task.due_date);
        dueDate.setHours(0, 0, 0, 0);

        const isOverdue = dueDate < today;
        const isDueSoon = !isOverdue && dueDate <= dueSoonCutoff;

        if (!isOverdue && !isDueSoon) {
            continue;
        }

        eligible.push({ task, isOverdue });

    }

    eligible.sort(compareCandidates);

    for (const { task, isOverdue } of eligible) {

        const type = isOverdue ? "task_overdue" : "task_due_soon";

        // eslint-disable-next-line no-await-in-loop
        if (await hasExistingNotification(db, task.assigned_to, task.id, type)) {
            continue;
        }

        // Checked after the duplicate check, so `capped` means at least
        // one eligible, not-yet-notified task is being deferred -- and
        // checked before createNotification, so it gets no row yet.
        if (progress.dueSoonCreated + progress.overdueCreated >= limit) {
            progress.capped = true;
            break;
        }

        const dueDateLabel = formatDueDate(task.due_date);

        const emailBuilder = isOverdue ? taskOverdueEmail : taskDueSoonEmail;

        const email = emailBuilder({
            taskTitle: task.task_title,
            taskNumber: task.task_number || task.id,
            projectName: task.project_name,
            dueDateLabel,
            taskId: task.id,
        });

        const title = isOverdue ? "Task overdue" : "Task due soon";

        const message = isOverdue
            ? `"${task.task_title}" was due on ${dueDateLabel} and is still open.`
            : `"${task.task_title}" is due on ${dueDateLabel}.`;

        // eslint-disable-next-line no-await-in-loop
        await createNotification({
            io,
            userId: task.assigned_to,
            title,
            message,
            type,
            referenceType: "task",
            referenceId: task.id,
            email,
        });

        if (isOverdue) {
            progress.overdueCreated += 1;
        } else {
            progress.dueSoonCreated += 1;
        }

    }

    if (progress.dueSoonCreated > 0 || progress.overdueCreated > 0) {
        console.log(`[notificationSweep] [${companySlug}] Created ${progress.dueSoonCreated} due-soon and ${progress.overdueCreated} overdue notification(s).`);
    }

    if (progress.capped) {
        console.log(`[notificationSweep] [${companySlug}] Cap of ${limit} reached -- remaining eligible tasks deferred to the next pass.`);
    }

}

// ==========================================
// START / STOP
// start(io) is called once from app.js. Safe to
// call multiple times (e.g. in tests) -- it clears
// any previous interval first.
// ==========================================

function start(io) {

    if (!SWEEP_ENABLED) {
        console.log("[notificationSweep] Disabled via NOTIFICATION_SWEEP_ENABLED=false.");
        return;
    }

    if (intervalHandle) {
        clearInterval(intervalHandle);
    }

    intervalHandle = setInterval(() => {
        runSweepOnce(io).catch((error) => {
            console.error("[notificationSweep] Sweep pass failed:", error.message);
        });
    }, SWEEP_INTERVAL_MS);

    // Unref so this timer never keeps the process alive on its own
    // (matches how the rest of this app already relies on the HTTP
    // server as the sole reason to stay running).
    if (intervalHandle.unref) {
        intervalHandle.unref();
    }

    console.log(`[notificationSweep] Started (interval: ${SWEEP_INTERVAL_MS}ms, due-soon window: ${DUE_SOON_WINDOW_DAYS} day(s), cap: ${formatCap(MAX_PER_TENANT)}/tenant, ${formatCap(MAX_PER_RUN)}/pass).`);

}

function stop() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
}

module.exports = {
    start,
    stop,
    runSweepOnce,
};
