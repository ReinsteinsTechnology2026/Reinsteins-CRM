// Explicit, cwd-independent path -- same reason as the other _migrate_*.js scripts.
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const { buildTargets, isMissingDatabaseError } = require("./_migrate_add_must_change_password");

// ==========================================
// ONE-TIME ROLLOUT: REQUIRE EXISTING ACCOUNTS TO REPLACE THEIR PASSWORD
//
// _migrate_add_must_change_password.js flagged the existing EMPLOYEES in the run that created the column and
// left Admin / Super Admin accounts alone. This script extends the same forced password change to EVERY account
// that is still unflagged -- existing employees (managers, executives, HR, department heads, team leads included),
// admins and super admins -- in the legacy database and in EVERY registered tenant database (users table), with ONE
// exception per database: the designated System Administrator (users.is_system_administrator = TRUE). Platform
// owners (platform_users, separate login) are NOT included.
//
// MANUAL, NOT PART OF THE DEPLOY. Run it by hand on the production host (see PASSWORD_CHANGE_ROLLOUT.md):
//   node server/_migrate_flag_existing_accounts_password_change.js            DRY RUN (default): writes nothing
//   node server/_migrate_flag_existing_accounts_password_change.js --apply    flags the accounts
// Options:  --scope=all|employees|admins (default all)   --skip-employee-ids=RS001,RS007 (never flagged)
//           --legacy-without-system-administrator (the legacy database only; see LEGACY DATABASE below)
//
// WHO IS FLAGGED: users with must_change_password = FALSE AND password_changed_at IS NULL AND status <> 'pending'
// AND is_system_administrator IS NOT TRUE that belong to the chosen scope --
//   employees = role 'employee' whose system_access is not admin / super_admin
//   admins    = role 'admin', or system_access admin / super_admin (a Super Admin may have role 'employee')
// Never touched: the System Administrator, accounts already flagged, accounts that changed their password through
// the forced flow (password_changed_at is set only by that flow), pending self-registrations, and any password hash.
//
// THE SYSTEM ADMINISTRATOR is identified ONLY by users.is_system_administrator -- never by role, system_access,
// full_name or creation order. The column is set solely by tenantUserService.createFirstAdmin() and
// _migrate_backfill_system_administrator.js, and a partial unique index allows at most one TRUE row. The preflight
// requires the column and EXACTLY ONE such row in every database (none -> nobody to exclude safely, so it fails
// rather than guess), and the apply transaction checks it again under the lock.
//
// LEGACY DATABASE: its users table has no is_system_administrator column, so by default it fails the preflight
// (and with it the whole run). --legacy-without-system-administrator is the explicit decision that the legacy
// database has NO exempt account: its eligible accounts are flagged without the exclusion. It applies only to the
// legacy target (buildTargets marks it `legacy: true`), never to a tenant, and only while that column is ABSENT --
// checked in the preflight and again inside the apply transaction; if the column exists the run refuses.
//
// LIMITATION: the Settings "change password" screen does not record password_changed_at, so a password a person
// chose themselves there cannot be told apart from a temporary one; those people are asked once more. List them
// with --skip-employee-ids if you know who they are. The dry run prints exactly how many accounts per database.
//
// SAFETY
//   * Dry run is the default and only SELECTs. Nothing is written unless --apply is given.
//   * PREFLIGHT FIRST: every target database must pass (users table and columns present -- i.e. the first
//     migration has run --, privileges, marker table sane) before ANY database is written; one failure and nothing
//     is applied. Legacy: a database that does not exist, or an unset DB_NAME, is skipped (as in the first migration).
//   * Each database is applied in ONE transaction under an advisory lock with a 30s lock_timeout. Databases are
//     applied one after another and the run STOPS at the first failure (a cross-database transaction does not
//     exist); re-running finishes the rest because of the run-once marker.
//   * RUN-ONCE MARKER: a row per group in the table password_change_rollouts, written in the same transaction as
//     the update, with the ids it flagged. A group that has its marker is never flagged again, even if an
//     administrator later clears a flag by hand. The marker names carry the rule version
//     (existing-employees-v2 / existing-admins-v2), so a marker written under different rules can never close a
//     group under these ones; a marker from the earlier rules (existing-employees / existing-admins) fails the
//     preflight instead of being silently honoured or silently ignored -- a human decides.
//   * NO SILENT GAPS: the preflight fails if an eligible account falls in neither group.
// ==========================================

const LOCK_KEY = 727401002; // fixed key, distinct from the first migration's; advisory locks are per database
const MARKER_TABLE = "password_change_rollouts";

const ADMIN_MATCH = `(role = 'admin' OR COALESCE(system_access, 'employee') IN ('admin', 'super_admin'))`;
const GROUPS = {
    employees: { marker: "existing-employees-v2", where: `(role = 'employee' AND COALESCE(system_access, 'employee') NOT IN ('admin', 'super_admin'))` },
    admins: { marker: "existing-admins-v2", where: ADMIN_MATCH },
};
// Markers written under the earlier rules (which did not exclude the System Administrator).
const PREVIOUS_MARKERS = ["existing-employees", "existing-admins"];
const ELIGIBLE_BASE = `must_change_password = FALSE AND password_changed_at IS NULL AND status <> 'pending'`;
// IS NOT TRUE: only an explicit TRUE is excluded; a NULL can never hide an account.
const ELIGIBLE = `${ELIGIBLE_BASE} AND is_system_administrator IS NOT TRUE`;
// withoutSystemAdministrator: only ever true for the legacy target under --legacy-without-system-administrator.
const eligibleFor = (withoutSystemAdministrator) => (withoutSystemAdministrator === true ? ELIGIBLE_BASE : ELIGIBLE);
// NULL-safe: an account without an employee_id is never dropped just because a skip list was given.
const NOT_SKIPPED = `COALESCE(employee_id <> ALL(?), TRUE)`;
const UNGROUPED = `NOT COALESCE(${GROUPS.employees.where}, FALSE) AND NOT COALESCE(${GROUPS.admins.where}, FALSE)`;
const REQUIRED_USER_COLUMNS = ["id", "employee_id", "role", "system_access", "status", "must_change_password", "password_changed_at"];
const SYSTEM_ADMINISTRATOR_COLUMN = "is_system_administrator";

function parseArgs(argv) {
    const options = { apply: false, scope: "all", skipIds: [], legacyWithoutSystemAdministrator: false };
    let dryRunFlag = false;

    for (const arg of argv) {
        let match;
        if (arg === "--apply") options.apply = true;
        else if (arg === "--dry-run") dryRunFlag = true;
        else if (arg === "--legacy-without-system-administrator") options.legacyWithoutSystemAdministrator = true;
        else if ((match = /^--scope=(all|employees|admins)$/.exec(arg))) options.scope = match[1];
        else if ((match = /^--skip-employee-ids=(.*)$/.exec(arg))) {
            const ids = match[1].split(",").map((id) => id.trim()).filter(Boolean);
            if (ids.some((id) => !/^[A-Za-z0-9_-]{1,30}$/.test(id))) throw new Error("--skip-employee-ids takes a comma-separated list of employee ids");
            options.skipIds = [...new Set([...options.skipIds, ...ids])];
        } else throw new Error(`Unknown argument: ${arg}`);
    }

    if (options.apply && dryRunFlag) throw new Error("Use either --dry-run or --apply, not both");

    return options;
}

const groupsFor = (scope) => (scope === "all" ? ["employees", "admins"] : [scope]);

async function markerTableExists(pool) {
    const [rows] = await pool.query(`SELECT to_regclass(?) IS NOT NULL AS present`, [`public.${MARKER_TABLE}`]);

    return rows[0].present === true;
}

// The one account this rollout must not flag. Throws unless there is exactly one; never guesses.
async function findSystemAdministrator(db) {
    const [rows] = await db.query(`SELECT id, employee_id FROM users WHERE is_system_administrator = TRUE`);

    if (rows.length !== 1) {
        throw new Error(
            `expected exactly one designated System Administrator (users.is_system_administrator = TRUE), found ${rows.length} -- ` +
            "not guessing which account to exclude; designate it (see PASSWORD_CHANGE_ROLLOUT.md) and run again"
        );
    }

    return { id: rows[0].id, employeeId: rows[0].employee_id };
}

const userColumns = async (db) => {
    const [rows] = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users'`
    );

    return new Set(rows.map((row) => row.column_name));
};

// --legacy-without-system-administrator is valid only while the database has no way to designate one.
function assertNoSystemAdministratorColumn(present) {
    if (present.has(SYSTEM_ADMINISTRATOR_COLUMN)) {
        throw new Error(
            `--legacy-without-system-administrator refused: this database has a ${SYSTEM_ADMINISTRATOR_COLUMN} column, ` +
            "so its System Administrator must be designated and excluded -- run without the option"
        );
    }
}

// The flagging rule for this database plus, unless the legacy option applies, its System Administrator.
async function resolveExclusion(db, present, withoutSystemAdministrator) {
    if (withoutSystemAdministrator === true) {
        assertNoSystemAdministratorColumn(present);
        return null;
    }

    if (!present.has(SYSTEM_ADMINISTRATOR_COLUMN)) {
        throw new Error(
            `the users table has no ${SYSTEM_ADMINISTRATOR_COLUMN} column, so the System Administrator cannot be identified -- ` +
            "not guessing; nothing is flagged (for the legacy database only, see --legacy-without-system-administrator)"
        );
    }

    return findSystemAdministrator(db);
}

// Read-only. Throws when this database is not ready; otherwise says which groups are still open and how many
// accounts each would flag.
async function preflightDatabase(label, pool, { scope, skipIds, withoutSystemAdministrator = false }) {
    const present = await userColumns(pool);
    const missing = REQUIRED_USER_COLUMNS.filter((column) => !present.has(column));

    if (missing.length) {
        throw new Error("the users table is missing required columns (has _migrate_add_must_change_password.js been run on this database?)");
    }

    const systemAdministrator = await resolveExclusion(pool, present, withoutSystemAdministrator);
    const eligible = eligibleFor(withoutSystemAdministrator);

    const [ungrouped] = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE ${eligible} AND ${UNGROUPED}`);

    if (ungrouped[0].n !== 0) {
        throw new Error(`${ungrouped[0].n} eligible account(s) belong to neither the employees nor the admins group (unexpected role) -- refusing to leave them out silently`);
    }

    const markerPresent = await markerTableExists(pool);
    const [privilegeRows] = await pool.query(
        `SELECT has_table_privilege(current_user, 'public.users', 'UPDATE') AS can_update,
                has_schema_privilege(current_user, 'public', 'CREATE') AS can_create`
    );
    const privileges = privilegeRows[0];

    if (privileges.can_update !== true) throw new Error("the connected database user cannot UPDATE the users table");

    let doneMarkers = new Set();

    if (markerPresent) {
        const [markerColumns] = await pool.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${MARKER_TABLE}'`
        );
        const markerHas = new Set(markerColumns.map((row) => row.column_name));

        if (!["name", "scope", "flagged_count", "flagged_user_ids"].every((column) => markerHas.has(column))) {
            throw new Error(`the existing ${MARKER_TABLE} table does not have the expected columns`);
        }

        const [insertRows] = await pool.query(`SELECT has_table_privilege(current_user, 'public.${MARKER_TABLE}', 'INSERT') AS ok`);

        if (insertRows[0].ok !== true) throw new Error(`the connected database user cannot INSERT into ${MARKER_TABLE}`);

        const [rows] = await pool.query(`SELECT name FROM ${MARKER_TABLE}`);
        doneMarkers = new Set(rows.map((row) => row.name));

        const previous = PREVIOUS_MARKERS.filter((name) => doneMarkers.has(name));

        if (previous.length) {
            throw new Error(`${MARKER_TABLE} holds marker(s) from the earlier rollout rules (${previous.join(", ")}) -- review them by hand; they neither close nor reopen a group under the current rules`);
        }
    } else if (privileges.can_create !== true) {
        throw new Error(`the connected database user cannot create the ${MARKER_TABLE} table`);
    }

    const open = {};
    const already = [];

    for (const name of groupsFor(scope)) {
        if (doneMarkers.has(GROUPS[name].marker)) {
            already.push(name);
            continue;
        }

        const [rows] = await pool.query(
            `SELECT COUNT(*)::int AS n FROM users WHERE ${eligible} AND ${GROUPS[name].where} AND ${NOT_SKIPPED}`,
            [skipIds]
        );
        open[name] = rows[0].n;
    }

    return { label, open, already, systemAdministrator };
}

// Writes. One transaction per database; the marker decision is made INSIDE it, under the lock.
async function applyDatabase(label, pool, { scope, skipIds, withoutSystemAdministrator = false }) {
    const connection = await pool.getConnection();
    const eligible = eligibleFor(withoutSystemAdministrator);

    try {
        await connection.beginTransaction();
        await connection.query(`SET LOCAL lock_timeout = '30s'`);
        await connection.query(`SELECT pg_advisory_xact_lock(?)`, [LOCK_KEY]);
        // Again inside the transaction: the exclusion the update relies on (one designated System Administrator,
        // or -- legacy option -- no column to designate one) must still hold right now.
        await resolveExclusion(connection, await userColumns(connection), withoutSystemAdministrator);
        await connection.query(
            `CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (
                name varchar(100) PRIMARY KEY,
                scope varchar(20) NOT NULL,
                completed_at timestamptz NOT NULL DEFAULT now(),
                flagged_count integer NOT NULL,
                flagged_user_ids integer[] NOT NULL
            )`
        );

        const flagged = {};
        const skippedGroups = [];

        for (const name of groupsFor(scope)) {
            const [marked] = await connection.query(`SELECT 1 FROM ${MARKER_TABLE} WHERE name = ? LIMIT 1`, [GROUPS[name].marker]);

            if (marked.length) {
                skippedGroups.push(name);
                continue;
            }

            const [updated] = await connection.query(
                `UPDATE users SET must_change_password = TRUE
                 WHERE ${eligible} AND ${GROUPS[name].where} AND ${NOT_SKIPPED}
                 RETURNING id`,
                [skipIds]
            );
            const ids = updated.map((row) => row.id);

            await connection.query(
                `INSERT INTO ${MARKER_TABLE} (name, scope, flagged_count, flagged_user_ids) VALUES (?, ?, ?, ?)`,
                [GROUPS[name].marker, scope, ids.length, ids]
            );
            flagged[name] = ids.length;
        }

        await connection.commit();

        return { label, flagged, skippedGroups };
    } catch (error) {
        await Promise.resolve(connection.rollback()).catch(() => {});
        throw error;
    } finally {
        connection.release();
    }
}

const describeCounts = (counts) => Object.entries(counts).map(([name, n]) => `${name}: ${n}`).join(", ") || "nothing";

// The legacy option reaches the legacy target only; tenants always keep the System Administrator exclusion.
const optionsFor = (target, options) => ({
    ...options,
    withoutSystemAdministrator: options.legacyWithoutSystemAdministrator === true && target.legacy === true,
});

// targets: [{ label, getPool, skipIfMissing, legacy }] (see buildTargets). Returns { ok, applied, ready, failures }.
async function runRollout(targets, options) {
    const ready = [];
    const failures = [];

    // ---- preflight: EVERY database, before anything is written
    for (const target of targets) {
        try {
            const result = await preflightDatabase(target.label, target.getPool(), optionsFor(target, options));
            ready.push({ target, result });

            if (result.systemAdministrator) {
                console.log(`  [system-administrator] ${target.label} -- excluded: employee_id ${result.systemAdministrator.employeeId} (id ${result.systemAdministrator.id})`);
            } else {
                console.log(`  [no-system-administrator] ${target.label} -- no ${SYSTEM_ADMINISTRATOR_COLUMN} column; no account is exempt (--legacy-without-system-administrator)`);
            }

            if (Object.keys(result.open).length === 0) {
                console.log(`  [done-before] ${target.label} -- already applied for: ${result.already.join(", ")} (nothing to do)`);
            } else {
                console.log(`  [${options.apply ? "ready" : "dry-run"}] ${target.label} -- would flag ${describeCounts(result.open)}${result.already.length ? `; already applied: ${result.already.join(", ")}` : ""}`);
            }
        } catch (error) {
            if (target.skipIfMissing && isMissingDatabaseError(error)) {
                console.log(`  [skip] ${target.label} -- the database does not exist (nothing to migrate)`);
                continue;
            }

            failures.push(target.label);
            console.error(`  [FAILED] ${target.label}: ${error.message}`);
        }
    }

    if (failures.length) {
        return { ok: false, applied: 0, ready: ready.length, failures: failures.length, message: `${failures.length} database(s) failed the preflight -- nothing was applied.` };
    }

    if (!options.apply) {
        return { ok: true, applied: 0, ready: ready.length, failures: 0, message: "Dry run only -- nothing was written. Re-run with --apply to flag these accounts." };
    }

    // ---- apply: one transaction per database, stop at the first failure
    let applied = 0;

    for (const { target, result } of ready) {
        if (Object.keys(result.open).length === 0) continue;

        try {
            const summary = await applyDatabase(target.label, target.getPool(), optionsFor(target, options));
            applied += 1;
            console.log(`  [applied] ${target.label} -- flagged ${describeCounts(summary.flagged)}${summary.skippedGroups.length ? `; already applied: ${summary.skippedGroups.join(", ")}` : ""}`);
        } catch (error) {
            console.error(`  [FAILED] ${target.label}: ${error.message}`);
            return { ok: false, applied, ready: ready.length, failures: 1, message: `Stopped at the first failure after ${applied} database(s) were applied. Re-run the same command to finish; completed databases are skipped.` };
        }
    }

    return { ok: true, applied, ready: ready.length, failures: 0, message: `Done. ${applied} database(s) updated.` };
}

async function main() {
    let options;

    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(`${error.message}\nusage: node server/_migrate_flag_existing_accounts_password_change.js [--apply] [--scope=all|employees|admins] [--skip-employee-ids=ID1,ID2] [--legacy-without-system-administrator]`);
        process.exit(2);
    }

    const platformPool = require("./config/platformDb");
    const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
    const legacyPool = require("./config/db").__legacyPool;

    console.log(`Existing-account password-change rollout (${options.apply ? "APPLY" : "DRY RUN -- nothing is written"}), scope: ${options.scope}${options.skipIds.length ? `, skipping ${options.skipIds.length} employee id(s)` : ""}\n`);

    const [companies] = await platformPool.query(
        `SELECT company_slug, tenant_db_name FROM companies WHERE tenant_db_name IS NOT NULL AND tenant_db_name <> '' ORDER BY id`
    );
    const { targets, notices } = buildTargets({ legacyPool, legacyDbName: process.env.DB_NAME, companies, getTenantPool });

    notices.forEach((line) => console.log(line));

    const result = await runRollout(targets, options);

    await closeAllTenantPools();
    await legacyPool.end();
    await platformPool.end();

    console.log(`\n${result.message}`);
    process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
    main().catch((error) => {
        console.error("ROLLOUT SCRIPT ERROR:", error.message);
        process.exit(1);
    });
}

module.exports = { parseArgs, preflightDatabase, applyDatabase, runRollout, findSystemAdministrator, GROUPS, ELIGIBLE, ELIGIBLE_BASE, NOT_SKIPPED, PREVIOUS_MARKERS, MARKER_TABLE, LOCK_KEY };
