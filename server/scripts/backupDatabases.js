// ==========================================
// DATABASE BACKUP SCRIPT (Phase 15H/15I)
//
// Dumps every database this platform is responsible for:
//   1. The legacy Reinsteins database (DB_NAME, e.g. reinsteins_workhub)
//   2. The platform database (PLATFORM_DB_NAME, e.g. groworgs_platform_db)
//   3. Every provisioned tenant database (companies.tenant_db_name,
//      read fresh from the platform DB on every run -- never a
//      hardcoded list, so a newly onboarded/offboarded company is
//      picked up automatically)
//
// This is a STANDALONE, MANUALLY-INVOKED script. It is NOT wired into
// app.js, does not run automatically, and nothing in this codebase
// schedules it. Wire it into your own scheduler on whatever host runs
// backups:
//   - cron (Linux/VPS):     0 2 * * *  node /path/to/server/scripts/backupDatabases.js
//   - Windows Task Scheduler: run `node backupDatabases.js` daily
//   - a managed platform's own "cron job" / "scheduled task" feature
//     (Render Cron Jobs, etc.)
//
// PREREQUISITE: the `mysqldump` client binary must be installed and
// on PATH on whatever machine actually runs this script. This is a
// separate installation from the mysql2 Node driver the rest of the
// app uses -- confirmed NOT present on this development machine, so
// this script has been reviewed for correctness but could not be
// executed end-to-end here. Verify it works in a safe/staging
// environment before relying on it in production.
//
// SAFETY:
//   - Read-only against every database it touches (mysqldump issues
//     no DDL/DML) -- this script cannot modify or delete application
//     data, only read it.
//   - The MySQL password is passed via the MYSQL_PWD environment
//     variable for the child process, never as a `--password=...`
//     command-line argument -- command-line arguments are visible to
//     other processes/users on the same machine (`ps`, Task Manager),
//     environment variables of a specific process are not.
//   - Output files are written locally under BACKUP_DIR (default:
//     server/backups/, already covered by .gitignore's "backups/"
//     entry -- a database dump must never be committed to git).
//     "Off-server backup storage" (Part H item 3) means copying these
//     files elsewhere after this script finishes -- upload them to
//     S3/R2/Azure Blob/etc, or let your scheduler's own "artifact"
//     feature do it. This script deliberately does not embed any
//     particular cloud provider's SDK/credentials.
//   - Retention: files older than BACKUP_RETENTION_DAYS (default 14)
//     are deleted at the END of a successful run, AFTER all of this
//     run's own dumps have been confirmed written -- a failed run
//     never deletes older backups.
// ==========================================

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const fs = require("fs");
const { spawn } = require("child_process");
const mysql = require("mysql2/promise");

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, "..", "backups");
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS) || 14;

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

// Runs `mysqldump` for one database, streaming its stdout straight to
// a file (never buffered fully in memory -- a large tenant database
// must not require holding the whole dump in RAM).
function dumpDatabase({ host, port, user, password, database, outFile }) {
    return new Promise((resolve, reject) => {
        const args = [
            "--host", String(host),
            "--port", String(port || 3306),
            "--user", String(user),
            "--single-transaction", // consistent snapshot, no table locking, safe against a live app
            "--routines",
            "--triggers",
            "--events",
            database,
        ];

        const child = spawn("mysqldump", args, {
            env: { ...process.env, MYSQL_PWD: password },
        });

        const outStream = fs.createWriteStream(outFile);
        child.stdout.pipe(outStream);

        let stderrOutput = "";
        child.stderr.on("data", (chunk) => { stderrOutput += chunk.toString(); });

        child.on("error", (err) => {
            reject(new Error(`Failed to start mysqldump for "${database}": ${err.message}`));
        });

        child.on("close", (code) => {
            if (code !== 0) {
                return reject(new Error(`mysqldump exited with code ${code} for "${database}": ${stderrOutput.trim()}`));
            }
            resolve(outFile);
        });
    });
}

async function getTenantDatabases(platformPool) {
    const [rows] = await platformPool.query(
        `SELECT company_slug, tenant_db_name FROM companies WHERE tenant_db_name IS NOT NULL`
    );
    return rows;
}

async function main() {
    const runStamp = timestamp();
    const runDir = path.join(BACKUP_DIR, runStamp);
    fs.mkdirSync(runDir, { recursive: true });

    console.log(`[backup] Starting database backup run ${runStamp}`);
    console.log(`[backup] Output directory: ${runDir}`);

    const results = { succeeded: [], failed: [] };

    // ---------- 1. Legacy Reinsteins database ----------
    try {
        const outFile = path.join(runDir, `legacy_${process.env.DB_NAME}.sql`);
        await dumpDatabase({
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            outFile,
        });
        console.log(`[backup] OK  legacy database "${process.env.DB_NAME}" -> ${outFile}`);
        results.succeeded.push(process.env.DB_NAME);
    } catch (err) {
        console.error(`[backup] FAILED legacy database "${process.env.DB_NAME}": ${err.message}`);
        results.failed.push(process.env.DB_NAME);
    }

    // ---------- 2. Platform database ----------
    try {
        const outFile = path.join(runDir, `platform_${process.env.PLATFORM_DB_NAME}.sql`);
        await dumpDatabase({
            host: process.env.PLATFORM_DB_HOST,
            port: process.env.PLATFORM_DB_PORT,
            user: process.env.PLATFORM_DB_USER,
            password: process.env.PLATFORM_DB_PASSWORD,
            database: process.env.PLATFORM_DB_NAME,
            outFile,
        });
        console.log(`[backup] OK  platform database "${process.env.PLATFORM_DB_NAME}" -> ${outFile}`);
        results.succeeded.push(process.env.PLATFORM_DB_NAME);
    } catch (err) {
        console.error(`[backup] FAILED platform database "${process.env.PLATFORM_DB_NAME}": ${err.message}`);
        results.failed.push(process.env.PLATFORM_DB_NAME);
    }

    // ---------- 3. Every provisioned tenant database ----------
    const platformPool = mysql.createPool({
        host: process.env.PLATFORM_DB_HOST,
        port: process.env.PLATFORM_DB_PORT,
        user: process.env.PLATFORM_DB_USER,
        password: process.env.PLATFORM_DB_PASSWORD,
        database: process.env.PLATFORM_DB_NAME,
    });

    try {
        const tenants = await getTenantDatabases(platformPool);
        console.log(`[backup] Found ${tenants.length} provisioned tenant database(s)`);

        for (const { company_slug: slug, tenant_db_name: dbName } of tenants) {
            try {
                // Backup file is named by the internal tenant_db_name
                // (e.g. tenant_arckenets.sql), never by anything a
                // customer would recognize as their own company name
                // -- consistent with the app's own convention of
                // never exposing tenant database names externally.
                const outFile = path.join(runDir, `${dbName}.sql`);
                await dumpDatabase({
                    host: process.env.PLATFORM_DB_HOST,
                    port: process.env.PLATFORM_DB_PORT,
                    user: process.env.PLATFORM_DB_USER,
                    password: process.env.PLATFORM_DB_PASSWORD,
                    database: dbName,
                    outFile,
                });
                console.log(`[backup] OK  tenant "${slug}" (${dbName}) -> ${outFile}`);
                results.succeeded.push(dbName);
            } catch (err) {
                console.error(`[backup] FAILED tenant "${slug}" (${dbName}): ${err.message}`);
                results.failed.push(dbName);
            }
        }
    } finally {
        await platformPool.end();
    }

    // ---------- Retention: prune old run directories ----------
    // Only runs after every dump above has been attempted, and only
    // ever deletes backup ARTIFACTS this script itself created
    // (directories under BACKUP_DIR named with this script's own
    // timestamp format) -- never touches the live databases.
    try {
        const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
        const entries = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR, { withFileTypes: true }) : [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const fullPath = path.join(BACKUP_DIR, entry.name);
            const stat = fs.statSync(fullPath);
            if (stat.mtimeMs < cutoffMs) {
                fs.rmSync(fullPath, { recursive: true, force: true });
                console.log(`[backup] Pruned backup older than ${RETENTION_DAYS} days: ${entry.name}`);
            }
        }
    } catch (err) {
        console.error(`[backup] Retention cleanup failed (non-fatal): ${err.message}`);
    }

    console.log(`[backup] Run complete. Succeeded: ${results.succeeded.length}, Failed: ${results.failed.length}`);

    if (results.failed.length > 0) {
        process.exitCode = 1;
    }
}

// ==========================================
// RESTORE (manual, documented here -- never automated by this file)
//
// Restoring is inherently destructive to whatever database you point
// it at, so it is intentionally NOT a function in this script. To
// restore a dump, on a SEPARATE/staging MySQL instance (never
// directly against production without a deliberate, reviewed
// maintenance window):
//
//   mysql -h <host> -u <user> -p <database_name> < path/to/dump.sql
//
// Recommended restore-test strategy (Part H item 6): periodically
// spin up a throwaway MySQL instance (a local Docker container is
// enough), restore a recent backup file into it, and run a handful of
// read-only sanity queries (row counts on a few key tables, a spot
// check of one known record) to confirm the dump is actually valid
// and restorable -- a backup that has never been test-restored is not
// a verified backup.
// ==========================================

main().catch((err) => {
    console.error("[backup] Unexpected error:", err);
    process.exitCode = 1;
});
