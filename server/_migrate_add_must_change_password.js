// Explicit, cwd-independent path -- same reason as the other _migrate_*.js scripts: this is
// invoked as `node server/_migrate_....js` from the repo root by the deploy pipeline.
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

// ==========================================
// MANDATORY PASSWORD CHANGE -- COLUMNS + ONE-TIME RESET OF EXISTING EMPLOYEES
//
// For the legacy database and EVERY registered tenant database it:
//   1. adds users.must_change_password  boolean NOT NULL DEFAULT FALSE
//   2. adds users.password_changed_at   timestamptz (an instant; compared with a JWT `iat`)
//   3. ONLY when step 1 actually created the column, flags the existing employee accounts
//      (role = 'employee', not Admin / Super Admin, not a pending self-registration) so each
//      must replace their temporary password at their next login.
//
// IDEMPOTENT AND NON-REPEATING: the flagging happens in the SAME TRANSACTION as the ADD COLUMN
// and only if the column did not exist. A second run (the deploy re-runs every migration) finds
// the column and changes nothing, so an employee who has already changed their password is
// never flagged again. Because the column and the flagging commit together, a failure part-way
// leaves nothing half-done (PostgreSQL DDL is transactional).
//
// NEVER reads, writes, logs or resets any password or password hash -- it touches only the two
// new columns and logs row COUNTS. Nothing is dropped, truncated or deleted.
//
// CONCURRENCY: the decision "was the column missing?" is made INSIDE the transaction, after taking
// a per-database advisory lock. Two overlapping runs (e.g. two quick pushes) therefore cannot both
// decide to flag: the second waits, then sees the column and does nothing. The cheap check done
// before the transaction is only a shortcut so the common re-run skips without locking.
//
// LEGACY DATABASE: processed like the tenants, with ONE exception -- if it does not exist at all
// (PostgreSQL error 3D000; e.g. it was retired after the move to tenant databases) there is nothing
// to migrate and it is skipped with a notice. Any other legacy failure (unreachable, bad credentials,
// permission) is a real failure and stops the deploy. A registered TENANT database that cannot be
// reached or does not exist is ALWAYS a failure.
//
// `--dry-run` changes nothing (it only SELECTs) and is the pre-flight to run on the production host
// before merging: for every database it reports whether the columns exist, how many accounts a real
// run would flag, and whether the connected user can actually ALTER the users table (ownership), so
// a missing database, an unreachable one, bad credentials or a permission problem show up BEFORE the
// deploy instead of during it. If DB_NAME is not set in server/.env no legacy database is configured
// and that target is skipped (PostgreSQL would otherwise default to a database named after the user).
//
// Like the other migrations it continues past a failing database so every reachable one is
// handled, then exits non-zero if ANY failed (the deploy's `set -e` then stops before the
// restart, so the new code is never started against a database without the column).
// ==========================================

// Accounts that are NOT flagged by the one-time reset. Employees only: Admin / Super Admin and
// the 'admin' role are left alone, and a 'pending' row is a self-registration whose owner chose
// their own password. (Newly created employees are flagged by the employee-creation code, not
// by this script.)
// One fixed key per migration; advisory locks are scoped to the current database.
const MIGRATION_LOCK_KEY = 727401001;

const BACKFILL_WHERE = `role = 'employee'
        AND COALESCE(system_access, 'employee') NOT IN ('admin', 'super_admin')
        AND status <> 'pending'`;

async function columnExists(pool, column) {
    const [rows] = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'users' AND column_name = ? LIMIT 1`,
        [column]
    );

    return rows.length > 0;
}

async function countRows(pool, where) {
    const [rows] = await pool.query(`SELECT COUNT(*)::int AS n FROM users${where ? ` WHERE ${where}` : ""}`);

    return rows[0].n;
}

// ALTER TABLE needs ownership of the table (or membership in the owning role). The dry run checks
// this so a permission problem is found before the deploy; a real run would simply fail at ALTER.
async function canAlterUsersTable(pool) {
    const [rows] = await pool.query(
        `SELECT pg_has_role(current_user, c.relowner, 'USAGE') AS can_alter
         FROM pg_class c WHERE c.relname = 'users' AND c.relnamespace = 'public'::regnamespace`
    );

    return rows.length > 0 && rows[0].can_alter === true;
}

// Returns a summary object; throws on failure (the caller records it).
async function migrateDatabase(label, pool, { dryRun = false } = {}) {
    const hasFlag = await columnExists(pool, "must_change_password");
    const hasChangedAt = await columnExists(pool, "password_changed_at");

    if (hasFlag && hasChangedAt) {
        console.log(`  [skip] ${label} -- columns already present (no accounts touched)`);
        return { label, action: "skipped", flagged: 0 };
    }

    const wouldFlag = hasFlag ? 0 : await countRows(pool, BACKFILL_WHERE);

    if (dryRun) {
        if (!(await canAlterUsersTable(pool))) {
            throw new Error("dry run: the connected database user cannot ALTER the users table (it is not the owner, or the table is missing)");
        }

        console.log(`  [dry-run] ${label} -- would add ${hasFlag ? "" : "must_change_password "}${hasChangedAt ? "" : "password_changed_at "}and flag ${wouldFlag} employee account(s)`);
        return { label, action: "dry-run", flagged: wouldFlag };
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // `users` is a hot table: ALTER TABLE queues for an exclusive lock and blocks new queries on the
        // table while it waits. If something holds a conflicting lock, fail fast (the deploy stops, nothing
        // is changed, it can simply be retried) instead of stalling the live application behind this script.
        await connection.query(`SET LOCAL lock_timeout = '30s'`);

        // Serialise concurrent runs, THEN decide from what is true now (not from the pre-check).
        await connection.query(`SELECT pg_advisory_xact_lock(?)`, [MIGRATION_LOCK_KEY]);

        const flagPresent = await columnExists(connection, "must_change_password");
        const changedAtPresent = await columnExists(connection, "password_changed_at");

        if (flagPresent && changedAtPresent) {
            // Another run finished while this one waited for the lock: nothing left to do.
            await connection.commit();
            console.log(`  [skip] ${label} -- migrated by a concurrent run (no accounts touched)`);
            return { label, action: "skipped", flagged: 0 };
        }

        if (!changedAtPresent) {
            await connection.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz DEFAULT NULL`);
        }

        let flagged = 0;

        if (!flagPresent) {
            await connection.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT FALSE`);

            // One-time reset: only here, in the same transaction that created the column.
            const [result] = await connection.query(`UPDATE users SET must_change_password = TRUE WHERE ${BACKFILL_WHERE}`);
            flagged = result.affectedRows ?? 0;
        }

        await connection.commit();

        console.log(`  [done] ${label} -- columns added, ${flagged} employee account(s) flagged`);
        return { label, action: "migrated", flagged };
    } catch (error) {
        // a dead connection must not hide the real error behind a rollback failure
        await Promise.resolve(connection.rollback()).catch(() => {});
        throw error;
    } finally {
        connection.release();
    }
}

// PostgreSQL "invalid_catalog_name": the database itself does not exist.
const isMissingDatabaseError = (error) => Boolean(error) && error.code === "3D000";

// Runs every target, continues past failures, returns the counts. A target may set
// `skipIfMissing` (legacy only): a database that does not exist is skipped, not failed.
async function runTargets(targets, { dryRun = false } = {}) {
    let failures = 0;
    let skipped = 0;

    for (const target of targets) {
        try {
            await migrateDatabase(target.label, target.getPool(), { dryRun });
        } catch (error) {
            if (target.skipIfMissing && isMissingDatabaseError(error)) {
                skipped += 1;
                console.log(`  [skip] ${target.label} -- the database does not exist (nothing to migrate)`);
                continue;
            }

            failures += 1;
            console.error(`  [FAILED] ${target.label}: ${error.message}`);
        }
    }

    return { failures, skipped };
}

// Which databases to process, in order, plus notices for anything deliberately left out.
function buildTargets({ legacyPool, legacyDbName, companies, getTenantPool }) {
    const targets = [];
    const notices = [];

    if (typeof legacyDbName === "string" && legacyDbName.trim()) {
        // `legacy`: lets _migrate_flag_existing_accounts_password_change.js scope its legacy-only option to this target.
        targets.push({ label: "legacy database", getPool: () => legacyPool, skipIfMissing: true, legacy: true });
    } else {
        notices.push("  [skip] legacy database -- DB_NAME is not set in server/.env (no legacy database is configured)");
    }

    for (const company of companies) {
        targets.push({
            label: `${company.company_slug} (${company.tenant_db_name})`,
            getPool: () => getTenantPool(company.tenant_db_name),
        });
    }

    return { targets, notices };
}

async function main() {
    const dryRun = process.argv.includes("--dry-run");

    const platformPool = require("./config/platformDb");
    const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
    const legacyPool = require("./config/db").__legacyPool;

    console.log(`Mandatory password change migration${dryRun ? " (DRY RUN -- nothing is written)" : ""}\n`);

    const [companies] = await platformPool.query(
        `SELECT company_slug, tenant_db_name FROM companies WHERE tenant_db_name IS NOT NULL AND tenant_db_name <> '' ORDER BY id`
    );

    const { targets, notices } = buildTargets({ legacyPool, legacyDbName: process.env.DB_NAME, companies, getTenantPool });

    notices.forEach((line) => console.log(line));

    const { failures } = await runTargets(targets, { dryRun });

    await closeAllTenantPools();
    await legacyPool.end();
    await platformPool.end();

    console.log(`\n${failures === 0 ? "Done." : `${failures} database(s) failed -- see errors above.`}`);
    process.exit(failures === 0 ? 0 : 1);
}

if (require.main === module) {
    main().catch((error) => {
        console.error("MIGRATION SCRIPT ERROR:", error.message);
        process.exit(1);
    });
}

module.exports = { migrateDatabase, runTargets, buildTargets, canAlterUsersTable, isMissingDatabaseError, BACKFILL_WHERE, MIGRATION_LOCK_KEY };
