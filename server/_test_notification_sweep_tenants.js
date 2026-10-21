const db = require("./config/db");
const platformCompanyService = require("./services/platformCompanyService");
const tenantConnectionManager = require("./config/tenantConnectionManager");
const emailService = require("./services/emailService");
const { isValidTenantDbName } = require("./utils/tenantDbName");
const notificationSweep = require("./jobs/notificationSweep");

// ==========================================
// NOTIFICATION SWEEP -- TENANT ISOLATION SELF-TEST
//
// Fully offline: never opens a connection to any real database or
// SMTP server. The platform company list, every tenant pool, and
// emailService.sendMail are replaced with in-memory fakes, and the
// legacy pool's query() is replaced with a trap -- any sweep query
// that falls through to the legacy database fails the test.
//
// Both tenants deliberately reuse the SAME task/user IDs (1, 2, ...)
// so any cross-tenant leak shows up as a row in the wrong tenant.
// ==========================================

let failures = 0;
function check(label, condition, detail) {
    if (condition) console.log(`  [PASS] ${label}`);
    else { failures++; console.log(`  [FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

function daysFromToday(n) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + n);
    return d;
}

// Minimal in-memory tenant database answering exactly the queries the
// sweep and notificationService issue. The soft-delete filter is only
// applied when the SQL itself asks for it, so removing
// `t.deleted_at IS NULL` from the sweep makes this test fail.
// `failOnInsert: n` makes the n-th notification INSERT throw, to
// simulate a tenant failing partway through its pass.
function createFakeTenantPool({ users, projects, tasks, failWith = null, gate = null, failOnInsert = null }) {

    const state = { notifications: [], queries: [], inserts: 0 };

    async function query(sql, params = []) {

        state.queries.push(sql);

        if (failWith) throw new Error(failWith);

        if (sql.includes("FROM tasks t")) {
            if (gate) await gate;
            const applySoftDelete = /t\.deleted_at IS NULL/.test(sql);
            const rows = tasks
                .filter((t) => t.assigned_to != null && t.status !== "closed" && t.due_date != null)
                .filter((t) => !applySoftDelete || t.deleted_at == null)
                .map((t) => {
                    const p = projects.find((x) => x.id === t.project_id);
                    const u = users.find((x) => x.id === t.assigned_to);
                    return {
                        id: t.id, task_number: t.task_number, task_title: t.task_title,
                        assigned_to: t.assigned_to, due_date: t.due_date, project_id: t.project_id,
                        project_name: p?.name ?? null, project_status: p?.status ?? null,
                        assignee_status: u?.employment_status ?? null,
                    };
                });
            return [rows];
        }

        if (sql.includes("SELECT id FROM notifications")) {
            const [userId, taskId, type] = params;
            return [state.notifications.filter((n) =>
                n.user_id === userId && n.reference_type === "task" && n.reference_id === taskId && n.type === type)];
        }

        if (sql.includes("INSERT INTO notifications")) {
            state.inserts += 1;
            if (failOnInsert !== null && state.inserts === failOnInsert) {
                throw new Error("simulated INSERT failure");
            }
            const [user_id, title, message, type, reference_type, reference_id] = params;
            const id = state.notifications.length + 1;
            state.notifications.push({ id, user_id, title, message, type, reference_type, reference_id, email_sent_at: null });
            return [[{ id }]];
        }

        if (sql.includes("SELECT email FROM users")) {
            const u = users.find((x) => x.id === params[0]);
            return [u ? [{ email: u.email }] : []];
        }

        if (sql.includes("UPDATE notifications SET email_sent_at")) {
            const n = state.notifications.find((x) => x.id === params[0]);
            if (n) n.email_sent_at = new Date();
            return [{ rowCount: n ? 1 : 0 }];
        }

        throw new Error(`Fake tenant pool: unexpected query: ${sql.slice(0, 80)}`);
    }

    return { query, state };
}

function buildTenantData(prefix) {
    return {
        users: [
            { id: 1, email: `alice@${prefix}.test`, employment_status: "active" },
            { id: 2, email: `bob@${prefix}.test`, employment_status: "inactive" },
        ],
        projects: [
            { id: 1, name: `${prefix} Live`, status: "active" },
            { id: 2, name: `${prefix} Done`, status: "completed" },
            { id: 3, name: `${prefix} Dropped`, status: "cancelled" },
        ],
        tasks: [
            { id: 1, task_number: "T-1", task_title: `${prefix} due soon`, assigned_to: 1, due_date: daysFromToday(1), project_id: 1, status: "open", deleted_at: null },
            { id: 2, task_number: "T-2", task_title: `${prefix} overdue`, assigned_to: 1, due_date: daysFromToday(-3), project_id: null, status: "open", deleted_at: null },
            { id: 3, task_number: "T-3", task_title: `${prefix} soft-deleted`, assigned_to: 1, due_date: daysFromToday(-1), project_id: 1, status: "open", deleted_at: new Date() },
            { id: 4, task_number: "T-4", task_title: `${prefix} far future`, assigned_to: 1, due_date: daysFromToday(30), project_id: 1, status: "open", deleted_at: null },
            { id: 5, task_number: "T-5", task_title: `${prefix} closed`, assigned_to: 1, due_date: daysFromToday(-2), project_id: 1, status: "closed", deleted_at: null },
            { id: 6, task_number: "T-6", task_title: `${prefix} completed project`, assigned_to: 1, due_date: daysFromToday(-2), project_id: 2, status: "open", deleted_at: null },
            { id: 7, task_number: "T-7", task_title: `${prefix} cancelled project`, assigned_to: 1, due_date: daysFromToday(-2), project_id: 3, status: "open", deleted_at: null },
            { id: 8, task_number: "T-8", task_title: `${prefix} inactive assignee`, assigned_to: 2, due_date: daysFromToday(-2), project_id: 1, status: "open", deleted_at: null },
            { id: 9, task_number: "T-9", task_title: `${prefix} unassigned`, assigned_to: null, due_date: daysFromToday(-2), project_id: 1, status: "open", deleted_at: null },
            { id: 10, task_number: "T-10", task_title: `${prefix} no due date`, assigned_to: 1, due_date: null, project_id: 1, status: "open", deleted_at: null },
        ],
    };
}

// One active user (id 1) and an open, unprojected task per spec:
// [taskId, dueInDays]. The tasks array is returned by reference, so a
// test can mutate a task between passes.
function buildTaskData(prefix, specs) {
    return {
        users: [{ id: 1, email: `alice@${prefix}.test`, employment_status: "active" }],
        projects: [],
        tasks: specs.map(([id, dueIn]) => ({
            id, task_number: `T-${id}`, task_title: `${prefix} task ${id}`, assigned_to: 1,
            due_date: daysFromToday(dueIn), project_id: null, status: "open", deleted_at: null,
        })),
    };
}

// `overdue` overdue tasks (id 1 oldest) then `dueSoon` tasks due
// tomorrow, listed in reverse so the sweep's own ordering is what
// puts them in order.
function buildBacklogData(prefix, overdue, dueSoon = 1) {
    const specs = [];
    for (let i = 1; i <= overdue; i++) specs.push([i, -(overdue + 1 - i)]);
    for (let i = 1; i <= dueSoon; i++) specs.push([overdue + i, 1]);
    return buildTaskData(prefix, specs.reverse());
}

function hasDuplicates(notifications) {
    const keys = notifications.map((n) => `${n.user_id}:${n.reference_id}:${n.type}`);
    return new Set(keys).size !== keys.length;
}

function ids(notifications) {
    return JSON.stringify(notifications.map((n) => n.reference_id));
}

function company(id, slug, overrides = {}) {
    return {
        id, company_slug: slug, company_name: slug, status: "active",
        subscription_status: "active", tenant_db_name: `tenant_${slug}`,
        trial_ends_at: null, subscription_expires_at: null, grace_period_ends_at: null,
        ...overrides,
    };
}

function createFakeIo() {
    const emits = [];
    return {
        emits,
        to(room) {
            return { emit(event, payload) { emits.push({ room, event, payload }); } };
        },
    };
}

async function main() {

    // ---- Install fakes ----------------------------------------------
    const legacyQueries = [];
    db.__legacyPool.query = async (sql) => {
        legacyQueries.push(sql);
        throw new Error("Legacy pool must not be used by the notification sweep");
    };

    const sentMail = [];
    emailService.sendMail = async (msg) => { sentMail.push(msg); return { sent: true }; };

    const pools = {
        tenant_alpha: createFakeTenantPool(buildTenantData("alpha")),
        tenant_beta: createFakeTenantPool(buildTenantData("beta")),
        tenant_broken: createFakeTenantPool({ users: [], projects: [], tasks: [], failWith: 'relation "tasks" does not exist' }),
        tenant_suspended: createFakeTenantPool(buildTenantData("suspended")),
        tenant_expired: createFakeTenantPool(buildTenantData("expired")),
    };

    let companies = [
        company(1, "alpha"),
        company(2, "broken"), // ordered before beta: its failure must not stop beta
        company(3, "beta"),
        company(4, "suspended", { status: "suspended" }),
        company(5, "expired", { subscription_status: "expired" }),
        company(6, "pending", { status: "pending", tenant_db_name: null }),
        company(7, "badname", { tenant_db_name: "reinsteins_db" }),
    ];

    platformCompanyService.listCompanies = async () => companies;

    const resolvedDbNames = [];
    tenantConnectionManager.getTenantPoolForCompany = (c) => {
        if (!isValidTenantDbName(c.tenant_db_name)) {
            throw new Error("Company's tenant_db_name failed validation.");
        }
        resolvedDbNames.push(c.tenant_db_name);
        const pool = pools[c.tenant_db_name];
        if (!pool) throw new Error("no fake pool");
        return pool;
    };

    const originalConsoleError = console.error;
    const loggedErrors = [];
    console.error = (...args) => { loggedErrors.push(args.join(" ")); };

    // ---- Pass 1 -----------------------------------------------------
    console.log("\nPass 1: multiple tenants");
    const io = createFakeIo();
    const r1 = await notificationSweep.runSweepOnce(io);

    check("legacy database never queried", legacyQueries.length === 0, `${legacyQueries.length} legacy queries`);
    check("only active/accessible tenants with a tenant_db_name resolved",
        JSON.stringify(resolvedDbNames) === JSON.stringify(["tenant_alpha", "tenant_broken", "tenant_beta"]),
        JSON.stringify(resolvedDbNames));
    check("suspended tenant DB untouched", pools.tenant_suspended.state.queries.length === 0);
    check("expired-subscription tenant DB untouched", pools.tenant_expired.state.queries.length === 0);
    check("invalid tenant_db_name logged and skipped", r1.tenants.some((t) => t.companySlug === "badname" && t.error));

    for (const prefix of ["alpha", "beta"]) {
        const n = pools[`tenant_${prefix}`].state.notifications;
        const byTask = (id) => n.filter((x) => x.reference_id === id);
        check(`${prefix}: exactly 2 notifications`, n.length === 2, JSON.stringify(n.map((x) => [x.reference_id, x.type])));
        check(`${prefix}: task 1 -> task_due_soon`, byTask(1).length === 1 && byTask(1)[0].type === "task_due_soon");
        check(`${prefix}: task 2 -> task_overdue`, byTask(2).length === 1 && byTask(2)[0].type === "task_overdue");
        check(`${prefix}: soft-deleted task 3 skipped`, byTask(3).length === 0);
        check(`${prefix}: closed/completed/cancelled/inactive/unassigned/no-date skipped`,
            [4, 5, 6, 7, 8, 9, 10].every((id) => byTask(id).length === 0));
        check(`${prefix}: notification text is this tenant's own task`,
            n.every((x) => x.message.includes(`${prefix} `)));
        check(`${prefix}: email_sent_at recorded in this tenant`, n.every((x) => x.email_sent_at));
        check(`${prefix}: candidate query keeps t.deleted_at IS NULL`,
            pools[`tenant_${prefix}`].state.queries.some((q) => q.includes("FROM tasks t") && q.includes("t.deleted_at IS NULL")));
    }

    check("emails go only to each tenant's own assignee",
        sentMail.length === 4 &&
        sentMail.filter((m) => m.to === "alice@alpha.test").length === 2 &&
        sentMail.filter((m) => m.to === "alice@beta.test").length === 2,
        JSON.stringify(sentMail.map((m) => m.to)));

    check("socket emits use tenant-namespaced rooms",
        io.emits.length === 4 &&
        io.emits.filter((e) => e.room === "tenant:alpha:user:1").length === 2 &&
        io.emits.filter((e) => e.room === "tenant:beta:user:1").length === 2,
        JSON.stringify(io.emits.map((e) => e.room)));

    check("broken tenant reported with error, others still processed",
        r1.tenants.find((t) => t.companySlug === "broken")?.error &&
        r1.tenants.find((t) => t.companySlug === "beta")?.overdueCreated === 1);
    check("tenant failure logged with slug",
        loggedErrors.some((l) => l.includes('"broken"')));
    check("totals aggregated across tenants", r1.dueSoonCreated === 2 && r1.overdueCreated === 2,
        JSON.stringify({ d: r1.dueSoonCreated, o: r1.overdueCreated }));

    // ---- Pass 2: duplicate prevention --------------------------------
    console.log("\nPass 2: re-run (duplicate prevention)");
    const r2 = await notificationSweep.runSweepOnce(createFakeIo());
    check("no new notifications on re-run", r2.dueSoonCreated === 0 && r2.overdueCreated === 0);
    check("alpha still has exactly 2 notifications", pools.tenant_alpha.state.notifications.length === 2);
    check("beta still has exactly 2 notifications", pools.tenant_beta.state.notifications.length === 2);
    check("no extra emails on re-run", sentMail.length === 4);

    // alpha already holds notifications for (user 1, task 1/2); a new
    // tenant with the same IDs must still be notified -- dedup reads
    // only the swept tenant's own notifications table.
    const betaData = pools.tenant_beta;
    console.log("\nPass 3: dedup is per-tenant");
    pools.tenant_gamma = createFakeTenantPool(buildTenantData("gamma"));
    companies = [company(1, "alpha"), company(8, "gamma")];
    const r3 = await notificationSweep.runSweepOnce(createFakeIo());
    check("alpha's existing notifications do not suppress gamma's (same IDs)",
        r3.tenants.find((t) => t.companySlug === "gamma")?.dueSoonCreated === 1 &&
        pools.tenant_gamma.state.notifications.length === 2);
    check("beta untouched when not listed", betaData.state.notifications.length === 2);

    // ---- Pass 4: overlap guard ---------------------------------------
    console.log("\nPass 4: overlapping runs");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    pools.tenant_slow = createFakeTenantPool({ ...buildTenantData("slow"), gate });
    companies = [company(9, "slow")];
    const first = notificationSweep.runSweepOnce(createFakeIo());
    await new Promise((resolve) => setImmediate(resolve));
    const second = await notificationSweep.runSweepOnce(createFakeIo());
    check("second run skipped while first in progress", second.skipped === true);
    release();
    const firstResult = await first;
    check("first run completed normally", !firstResult.skipped && firstResult.overdueCreated === 1);
    const third = await notificationSweep.runSweepOnce(createFakeIo());
    check("next run after completion is not skipped", !third.skipped);

    // ---- Pass 5: platform enumeration failure releases the guard ----
    console.log("\nPass 5: platform DB failure");
    platformCompanyService.listCompanies = async () => { throw new Error("platform down"); };
    let threw = false;
    try { await notificationSweep.runSweepOnce(createFakeIo()); } catch { threw = true; }
    check("platform failure surfaces to caller", threw);
    platformCompanyService.listCompanies = async () => [];
    const after = await notificationSweep.runSweepOnce(createFakeIo());
    check("guard released after platform failure", !after.skipped);

    platformCompanyService.listCompanies = async () => companies;

    // ---- Pass 6: processing order ------------------------------------
    console.log("\nPass 6: ordering (due-soon first, then overdue; each by due date, then id)");
    pools.tenant_order = createFakeTenantPool(buildTaskData("order", [
        [5, 2], [2, -1], [9, 1], [7, -4], [8, 30], [3, 1], [4, -4],
    ]));
    companies = [company(20, "order")];
    await notificationSweep.runSweepOnce(createFakeIo(), { maxPerTenant: 0, maxPerRun: 0 });
    const ordered = pools.tenant_order.state.notifications;
    check("notifications created in the defined order", ids(ordered) === "[3,9,5,4,7,2]", ids(ordered));
    check("ordering does not change classification",
        ordered.filter((n) => n.type === "task_due_soon").map((n) => n.reference_id).join() === "3,9,5" &&
        ordered.filter((n) => n.type === "task_overdue").map((n) => n.reference_id).join() === "4,7,2" &&
        !ordered.some((n) => n.reference_id === 8));

    // ---- Pass 7: per-tenant cap, deferral, next-pass pickup ----------
    console.log("\nPass 7: per-tenant cap");
    pools.tenant_backlog = createFakeTenantPool(buildBacklogData("backlog", 7, 2));
    companies = [company(30, "backlog")];
    const backlog = pools.tenant_backlog.state.notifications;
    const mailBefore7 = sentMail.length;
    const capOpts = { maxPerTenant: 3, maxPerRun: 0 };

    const c1 = await notificationSweep.runSweepOnce(createFakeIo(), capOpts);
    check("first pass stops at the per-tenant cap",
        c1.dueSoonCreated === 2 && c1.overdueCreated === 1 && c1.capped === true, JSON.stringify(c1));
    check("due-soon tasks take the budget first, then the oldest overdue", ids(backlog) === "[8,9,1]", ids(backlog));
    check("deferred tasks have no notification rows yet",
        [2, 3, 4, 5, 6, 7].every((id) => !backlog.some((n) => n.reference_id === id)));

    const c2 = await notificationSweep.runSweepOnce(createFakeIo(), capOpts);
    check("next pass picks up the next deferred tasks",
        c2.overdueCreated === 3 && c2.capped === true && ids(backlog) === "[8,9,1,2,3,4]", ids(backlog));

    const c3 = await notificationSweep.runSweepOnce(createFakeIo(), capOpts);
    check("pass that handles the last tasks is not reported as capped",
        c3.overdueCreated === 3 && c3.capped === false, JSON.stringify(c3));

    const c4 = await notificationSweep.runSweepOnce(createFakeIo(), capOpts);
    check("drained backlog creates nothing more", c4.overdueCreated === 0 && c4.dueSoonCreated === 0 && c4.capped === false);
    check("backlog: every eligible task notified exactly once", backlog.length === 9 && !hasDuplicates(backlog));
    check("backlog: deferred overdue tasks keep their overdue classification",
        backlog.filter((n) => n.type === "task_overdue").length === 7 &&
        backlog.filter((n) => n.type === "task_due_soon").map((n) => n.reference_id).join() === "8,9");
    check("backlog: one email per notification", sentMail.length - mailBefore7 === 9);

    // ---- Pass 8: what a delayed turn does to classification ----------
    // Moving a deferred task's due date into the past stands in for
    // that date passing while the task waits.
    console.log("\nPass 8: deferred due-soon task whose due date passes");
    const delayData = buildTaskData("delay", [[1, 1], [2, 1], [3, 1], [4, 1]]);
    pools.tenant_delay = createFakeTenantPool(delayData);
    companies = [company(40, "delay")];
    const delayRows = pools.tenant_delay.state.notifications;
    await notificationSweep.runSweepOnce(createFakeIo(), { maxPerTenant: 2, maxPerRun: 0 });
    check("cap of 2: tasks 1 and 2 notified due-soon, 3 and 4 deferred with no rows",
        ids(delayRows) === "[1,2]" && delayRows.every((n) => n.type === "task_due_soon"));
    delayData.tasks.find((t) => t.id === 3).due_date = daysFromToday(-1);
    delayData.tasks.find((t) => t.id === 4).status = "closed";
    await notificationSweep.runSweepOnce(createFakeIo(), { maxPerTenant: 2, maxPerRun: 0 });
    const task3 = delayRows.filter((n) => n.reference_id === 3);
    check("deferred past its due date: task_overdue only, never task_due_soon",
        task3.length === 1 && task3[0].type === "task_overdue", JSON.stringify(task3.map((n) => n.type)));
    check("deferred task closed before its turn is never notified",
        !delayRows.some((n) => n.reference_id === 4));

    // ---- Pass 9: run-wide cap and tenant fairness --------------------
    console.log("\nPass 9: run-wide cap and fairness");
    for (const slug of ["f1", "f2", "f3"]) {
        pools[`tenant_${slug}`] = createFakeTenantPool(buildBacklogData(slug, 10, 0));
    }
    // Listed out of id order: the sweep orders tenants by company id.
    companies = [company(53, "f3"), company(51, "f1"), company(52, "f2")];
    const runOpts = { maxPerTenant: 3, maxPerRun: 4 };
    const fCount = (slug) => pools[`tenant_${slug}`].state.notifications.length;

    const f1 = await notificationSweep.runSweepOnce(createFakeIo(), runOpts);
    const ft = (r, slug) => r.tenants.find((t) => t.companySlug === slug);
    check("pass 1: tenants in id order, budget split f1=3 f2=1",
        JSON.stringify(f1.tenants.map((t) => t.companySlug)) === '["f1","f2","f3"]' &&
        ft(f1, "f1").overdueCreated === 3 && ft(f1, "f2").overdueCreated === 1 && f1.capped === true,
        JSON.stringify(f1.tenants));
    check("pass 1: tenant past the budget is deferred and its DB is not queried",
        ft(f1, "f3").deferred === true && pools.tenant_f3.state.queries.length === 0);

    const f2 = await notificationSweep.runSweepOnce(createFakeIo(), runOpts);
    check("pass 2 resumes at the tenant the budget ran out on (f2, then f3)",
        JSON.stringify(f2.tenants.map((t) => t.companySlug)) === '["f2","f3","f1"]' &&
        ft(f2, "f2").overdueCreated === 3 && ft(f2, "f3").overdueCreated === 1 && ft(f2, "f1").deferred === true,
        JSON.stringify(f2.tenants));

    await notificationSweep.runSweepOnce(createFakeIo(), runOpts);
    check("after 3 passes every tenant has had an equal share",
        fCount("f1") === 4 && fCount("f2") === 4 && fCount("f3") === 4,
        JSON.stringify([fCount("f1"), fCount("f2"), fCount("f3")]));

    let fPasses = 3;
    let fCreated = 1;
    let fMax = 4;
    while (fCreated > 0 && fPasses < 30) {
        // eslint-disable-next-line no-await-in-loop
        const r = await notificationSweep.runSweepOnce(createFakeIo(), runOpts);
        fCreated = r.dueSoonCreated + r.overdueCreated;
        fMax = Math.max(fMax, fCreated);
        fPasses++;
    }
    check("no pass exceeds the run-wide cap", fMax <= 4, String(fMax));
    check("all tenants fully drained, no duplicates",
        ["f1", "f2", "f3"].every((slug) => fCount(slug) === 10 && !hasDuplicates(pools[`tenant_${slug}`].state.notifications)),
        JSON.stringify([fCount("f1"), fCount("f2"), fCount("f3")]));
    check("each tenant's rows stay in its own database",
        ["f1", "f2", "f3"].every((slug) => pools[`tenant_${slug}`].state.notifications.every((n) => n.message.includes(`${slug} `))));

    // ---- Pass 10: cap values passed per run --------------------------
    console.log("\nPass 10: cap values");
    const capCases = [
        ["0 = unlimited", { maxPerTenant: 0, maxPerRun: 0 }, 8],
        ["negative falls back to default", { maxPerTenant: -5, maxPerRun: -1 }, 8],
        ["non-numeric falls back to default", { maxPerTenant: "abc", maxPerRun: "x" }, 8],
        ["fractional falls back to default", { maxPerTenant: 1.5, maxPerRun: 2.5 }, 8],
        ["blank falls back to default", { maxPerTenant: "", maxPerRun: " " }, 8],
        ["numeric string is honoured", { maxPerTenant: "3", maxPerRun: "0" }, 3],
    ];
    for (const [label, opts, expected] of capCases) {
        const slug = `cap${capCases.findIndex((c) => c[0] === label)}`;
        pools[`tenant_${slug}`] = createFakeTenantPool(buildBacklogData(slug, 7));
        companies = [company(60, slug)];
        // eslint-disable-next-line no-await-in-loop
        const r = await notificationSweep.runSweepOnce(createFakeIo(), opts);
        check(`cap value: ${label}`, r.dueSoonCreated + r.overdueCreated === expected,
            String(r.dueSoonCreated + r.overdueCreated));
    }

    // ---- Pass 11: caps read from the environment ---------------------
    // A child process in an empty directory (so no .env is picked up)
    // loads the module and calls start() -- which only schedules an
    // unref'd timer, so nothing is queried -- and reports the caps.
    console.log("\nPass 11: environment configuration");
    const { execFileSync } = require("child_process");
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-env-"));
    const sweepPath = path.join(__dirname, "jobs", "notificationSweep.js");
    const envCases = [
        ["unset -> defaults", {}, "50/tenant, 200/pass"],
        ["0 -> unlimited", { NOTIFICATION_SWEEP_MAX_PER_TENANT: "0", NOTIFICATION_SWEEP_MAX_PER_RUN: "0" }, "unlimited/tenant, unlimited/pass"],
        ["invalid -> defaults", { NOTIFICATION_SWEEP_MAX_PER_TENANT: "-3", NOTIFICATION_SWEEP_MAX_PER_RUN: "abc" }, "50/tenant, 200/pass"],
        ["valid values used", { NOTIFICATION_SWEEP_MAX_PER_TENANT: "7", NOTIFICATION_SWEEP_MAX_PER_RUN: "9" }, "7/tenant, 9/pass"],
    ];
    for (const [label, vars, expected] of envCases) {
        const env = { ...process.env, ...vars, NOTIFICATION_SWEEP_ENABLED: "true" };
        if (!("NOTIFICATION_SWEEP_MAX_PER_TENANT" in vars)) delete env.NOTIFICATION_SWEEP_MAX_PER_TENANT;
        if (!("NOTIFICATION_SWEEP_MAX_PER_RUN" in vars)) delete env.NOTIFICATION_SWEEP_MAX_PER_RUN;
        let out = "";
        try {
            out = execFileSync(process.execPath, ["-e", `require(${JSON.stringify(sweepPath)}).start({})`],
                { cwd: emptyDir, env, timeout: 20000, encoding: "utf8" });
        } catch (error) {
            out = String(error.stdout || "") + String(error.message);
        }
        check(`env caps: ${label}`, out.includes(`cap: ${expected})`), out.trim().split("\n").pop());
    }
    fs.rmSync(emptyDir, { recursive: true, force: true });

    // ---- Pass 12: tenant failures and budget accounting -------------
    console.log("\nPass 12: tenant failures under a run-wide cap");
    const notifCount = (slug) => pools[`tenant_${slug}`].state.notifications.length;
    const tenantOf = (r, slug) => r.tenants.find((t) => t.companySlug === slug);

    // Fails before creating anything: must not use budget or block later tenants.
    pools.tenant_e1fail = createFakeTenantPool({ users: [], projects: [], tasks: [], failWith: "connection refused" });
    pools.tenant_e1next = createFakeTenantPool(buildBacklogData("e1next", 5, 0));
    companies = [company(81, "e1fail"), company(82, "e1next"), company(83, "e1bad", { tenant_db_name: "reinsteins_db" })];
    const e1 = await notificationSweep.runSweepOnce(createFakeIo(), { maxPerTenant: 0, maxPerRun: 3 });
    check("early tenant failure uses no budget: next tenant gets the full run cap",
        tenantOf(e1, "e1fail").error && tenantOf(e1, "e1next").overdueCreated === 3 && notifCount("e1next") === 3,
        JSON.stringify(e1.tenants));
    check("invalid tenant name after the budget is spent is deferred, not errored",
        tenantOf(e1, "e1bad").deferred === true && !tenantOf(e1, "e1bad").error);

    // Fails partway: notifications already created (and emailed) must
    // still count against the run-wide budget and be reported.
    pools.tenant_e2part = createFakeTenantPool({ ...buildBacklogData("e2part", 5, 0), failOnInsert: 3 });
    pools.tenant_e2next = createFakeTenantPool(buildBacklogData("e2next", 5, 0));
    companies = [company(84, "e2part"), company(85, "e2next")];
    const mailBefore12 = sentMail.length;
    const e2 = await notificationSweep.runSweepOnce(createFakeIo(), { maxPerTenant: 0, maxPerRun: 4 });
    check("partial tenant failure: its 2 created notifications are reported",
        tenantOf(e2, "e2part").error && tenantOf(e2, "e2part").overdueCreated === 2 && notifCount("e2part") === 2,
        JSON.stringify(tenantOf(e2, "e2part")));
    check("partial tenant failure: later tenant gets only the remaining budget",
        notifCount("e2next") === 2 && tenantOf(e2, "e2next").overdueCreated === 2, String(notifCount("e2next")));
    check("partial tenant failure: run total and emails never exceed the run cap",
        e2.overdueCreated === 4 && sentMail.length - mailBefore12 === 4,
        JSON.stringify({ total: e2.overdueCreated, emails: sentMail.length - mailBefore12 }));

    // ---- Pass 13: run-wide cap reached exactly at a tenant boundary --
    console.log("\nPass 13: run-wide cap reached exactly at a tenant boundary");
    pools.tenant_b1 = createFakeTenantPool(buildBacklogData("b1", 3, 0));
    pools.tenant_b2 = createFakeTenantPool(buildBacklogData("b2", 3, 0));
    pools.tenant_b3 = createFakeTenantPool(buildBacklogData("b3", 3, 0));
    companies = [company(91, "b1"), company(92, "b2"), company(93, "b3")];
    const bd1 = await notificationSweep.runSweepOnce(createFakeIo(), { maxPerTenant: 0, maxPerRun: 3 });
    check("tenant that exactly uses up the budget is not reported as capped",
        tenantOf(bd1, "b1").overdueCreated === 3 && tenantOf(bd1, "b1").capped === false);
    check("next tenant is deferred untouched and the pass is reported capped",
        tenantOf(bd1, "b2").deferred === true && tenantOf(bd1, "b3").deferred === true &&
        pools.tenant_b2.state.queries.length === 0 && bd1.capped === true);
    const bd2 = await notificationSweep.runSweepOnce(createFakeIo(), { maxPerTenant: 0, maxPerRun: 3 });
    check("next pass starts at the first deferred tenant",
        JSON.stringify(bd2.tenants.map((t) => t.companySlug)) === '["b2","b3","b1"]' &&
        tenantOf(bd2, "b2").overdueCreated === 3 && tenantOf(bd2, "b3").deferred === true,
        JSON.stringify(bd2.tenants));
    const bd3 = await notificationSweep.runSweepOnce(createFakeIo(), { maxPerTenant: 0, maxPerRun: 3 });
    check("third pass starts at b3; b1 (already drained) is deferred, not queried",
        JSON.stringify(bd3.tenants.map((t) => t.companySlug)) === '["b3","b1","b2"]' &&
        tenantOf(bd3, "b3").overdueCreated === 3 && tenantOf(bd3, "b1").deferred === true,
        JSON.stringify(bd3.tenants));
    const bd4 = await notificationSweep.runSweepOnce(createFakeIo(), { maxPerTenant: 0, maxPerRun: 3 });
    check("once drained, a pass visits every tenant and is not capped",
        bd4.tenants.length === 3 && bd4.tenants.every((t) => !t.deferred) && bd4.capped === false &&
        ["b1", "b2", "b3"].every((slug) => notifCount(slug) === 3),
        JSON.stringify(bd4.tenants));

    // Per-tenant cap equal to the remaining run budget: the tenant got a
    // full turn, so the next pass starts at the following tenant.
    pools.tenant_q1 = createFakeTenantPool(buildBacklogData("q1", 5, 0));
    pools.tenant_q2 = createFakeTenantPool(buildBacklogData("q2", 5, 0));
    companies = [company(95, "q1"), company(96, "q2")];
    await notificationSweep.runSweepOnce(createFakeIo(), { maxPerTenant: 2, maxPerRun: 2 });
    const qd = await notificationSweep.runSweepOnce(createFakeIo(), { maxPerTenant: 2, maxPerRun: 2 });
    check("tenant stopped by its own cap at the run boundary does not go first again",
        JSON.stringify(qd.tenants.map((t) => t.companySlug)) === '["q2","q1"]' && notifCount("q2") === 2,
        JSON.stringify(qd.tenants));

    // The resume tenant disappearing from the list (suspended, deleted)
    // falls through to the next id, wrapping around.
    // q1 (id 95) is now the resume point; drop it from the list.
    pools.tenant_q0 = createFakeTenantPool(buildBacklogData("q0", 1, 0));
    companies = [company(90, "q0"), company(96, "q2")];
    const qg = await notificationSweep.runSweepOnce(createFakeIo(), { maxPerTenant: 0, maxPerRun: 0 });
    check("missing resume tenant: pass starts at the next id, then wraps around",
        JSON.stringify(qg.tenants.map((t) => t.companySlug)) === '["q2","q0"]' &&
        tenantOf(qg, "q2").overdueCreated === 3 && tenantOf(qg, "q0").overdueCreated === 1,
        JSON.stringify(qg.tenants));

    // ---- Pass 14: tenants with nothing to send -----------------------
    console.log("\nPass 14: empty and already-notified tenants under a run-wide cap");
    pools.tenant_n1empty = createFakeTenantPool({ users: [], projects: [], tasks: [] });
    pools.tenant_n2done = createFakeTenantPool(buildBacklogData("n2done", 2, 0));
    pools.tenant_n3inel = createFakeTenantPool(buildTenantData("n3inel"));
    pools.tenant_n4next = createFakeTenantPool(buildBacklogData("n4next", 4, 0));
    companies = [company(102, "n2done")];
    await notificationSweep.runSweepOnce(createFakeIo(), { maxPerTenant: 0, maxPerRun: 0 });
    companies = [company(101, "n1empty"), company(102, "n2done"), company(103, "n3inel"), company(104, "n4next")];
    const nd = await notificationSweep.runSweepOnce(createFakeIo(), { maxPerTenant: 0, maxPerRun: 5 });
    check("empty and already-notified tenants use no budget and are not capped",
        tenantOf(nd, "n1empty").overdueCreated === 0 && tenantOf(nd, "n1empty").capped === false &&
        tenantOf(nd, "n2done").overdueCreated === 0 && tenantOf(nd, "n2done").capped === false);
    check("ineligible tasks use no budget: only the 2 eligible ones are created",
        notifCount("n3inel") === 2 && pools.tenant_n3inel.state.notifications.every((n) => [1, 2].includes(n.reference_id)));
    check("remaining budget reaches the last tenant", notifCount("n4next") === 3 && nd.capped === true,
        String(notifCount("n4next")));

    // ---- Pass 15: eligibility rules unchanged under a tight cap ------
    console.log("\nPass 15: eligibility under a cap of 1");
    pools.tenant_elig = createFakeTenantPool(buildTenantData("elig"));
    companies = [company(110, "elig")];
    const el1 = await notificationSweep.runSweepOnce(createFakeIo(), { maxPerTenant: 1, maxPerRun: 0 });
    const eligRows = pools.tenant_elig.state.notifications;
    check("cap 1: due-soon task 1 goes first, overdue task 2 deferred with no row",
        el1.capped === true && ids(eligRows) === "[1]" && eligRows[0].type === "task_due_soon");
    const el2 = await notificationSweep.runSweepOnce(createFakeIo(), { maxPerTenant: 1, maxPerRun: 0 });
    check("next pass: task 2 as task_overdue, not capped (nothing else eligible)",
        el2.capped === false && ids(eligRows) === "[1,2]" && eligRows[1].type === "task_overdue");
    check("soft-deleted/closed/completed/cancelled/inactive/unassigned/no-date/far-future never notified",
        [3, 4, 5, 6, 7, 8, 9, 10].every((id) => !eligRows.some((n) => n.reference_id === id)));

    // ---- Pass 16: SMTP failure (documents existing behaviour) --------
    console.log("\nPass 16: SMTP failure");
    const realSendMail = emailService.sendMail;
    emailService.sendMail = async () => ({ sent: false, reason: "send_failed", error: "connect ECONNREFUSED" });
    pools.tenant_smtp = createFakeTenantPool(buildBacklogData("smtp", 1));
    companies = [company(70, "smtp")];
    const s1 = await notificationSweep.runSweepOnce(createFakeIo());
    const smtpRows = pools.tenant_smtp.state.notifications;
    check("SMTP failure: notifications still created", s1.overdueCreated === 1 && s1.dueSoonCreated === 1);
    check("SMTP failure: email_sent_at left NULL", smtpRows.every((n) => n.email_sent_at === null));
    emailService.sendMail = realSendMail;
    const mailBefore16 = sentMail.length;
    const s2 = await notificationSweep.runSweepOnce(createFakeIo());
    check("SMTP failure: not retried on the next pass",
        s2.overdueCreated === 0 && s2.dueSoonCreated === 0 && sentMail.length === mailBefore16);

    check("legacy database never queried (all passes)", legacyQueries.length === 0);

    console.error = originalConsoleError;

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
    console.log("Test crashed:", error);
    process.exit(1);
});
