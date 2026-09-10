const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const provisioningPool = require("../config/provisioningDb");
const {
    buildTenantDbName,
    isValidTenantDbName,
    isValidTestDbName,
    isProtectedDbName,
} = require("../utils/tenantDbName");

// ==========================================
// TENANT PROVISIONING SERVICE (Phase 2C)
//
// Generic, repeatable mechanism for creating a new, EMPTY tenant
// database with the full tenant schema applied. Does not read or
// write the existing tenant database (reinsteins_workhub) at
// provisioning time -- it applies a pre-generated, reviewed SQL
// snapshot (schemas/tenantSchema.postgresql.sql, produced by
// _generate_tenant_schema.js) instead of introspecting the live
// source DB on every call. See that script's header comment for why.
//
// Not wired to any route yet, and not connected to company creation.
// This phase only proves the mechanism works, tested against a
// clearly-named throwaway database -- never against reinsteins_db or
// reinsteins_workhub.
// ==========================================

const SCHEMA_FILE_PATH = path.join(__dirname, "..", "schemas", "tenantSchema.postgresql.sql");

const TENANT_DB_CHARSET = "utf8mb4";
const TENANT_DB_COLLATION = "utf8mb4_unicode_ci";

const provisioningConnectionConfig = () => ({
    host: process.env.PLATFORM_DB_HOST,
    port: process.env.PLATFORM_DB_PORT,
    user: process.env.PLATFORM_DB_USER,
    password: process.env.PLATFORM_DB_PASSWORD,
    multipleStatements: false,
});

// ------------------------------------------
// Schema file loading
// ------------------------------------------

function loadSchemaStatements() {
    if (!fs.existsSync(SCHEMA_FILE_PATH)) {
        throw new Error(
            `Canonical tenant schema file not found at ${SCHEMA_FILE_PATH}. ` +
            `Run "node _generate_tenant_schema.js" first.`
        );
    }

    const raw = fs.readFileSync(SCHEMA_FILE_PATH, "utf8");

    // Strip comment lines, then split into individual statements.
    // Every statement in this file (SET FOREIGN_KEY_CHECKS / CREATE
    // TABLE) is generated, not hand-written, and none of them
    // contain a literal ";" inside a string/identifier, so a plain
    // split on ";" is safe here.
    const withoutComments = raw
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");

    return withoutComments
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

function extractTableNamesFromSchema() {
    return extractTableNamesFromStatements([fs.readFileSync(SCHEMA_FILE_PATH, "utf8")]);
}

function extractTableNamesFromStatements(statements) {
    const names = [];
    const re = /CREATE TABLE\s+"?([a-zA-Z0-9_]+)"?/g;
    for (const statement of statements) {
        let match;
        while ((match = re.exec(statement)) !== null) {
            names.push(match[1]);
        }
    }
    return names.sort();
}

// ------------------------------------------
// Existence / safety checks
// ------------------------------------------

async function databaseExists(databaseName) {
    const result = await provisioningPool.query(
        `SELECT datname FROM pg_database WHERE datname = $1`,
        [databaseName]
    );

    return result.rows.length > 0;
}

// ------------------------------------------
// Provisioning
// ------------------------------------------

/**
 * Create a brand-new tenant database and apply the full tenant
 * schema to it. Never touches an existing database of any kind.
 *
 * @param {{databaseName: string, _schemaStatementsForTesting?: string[]}} params
 *   databaseName MUST already have been produced by
 *   buildTenantDbName(slug) (or otherwise pass isValidTenantDbName)
 *   -- this function does not accept a raw slug and does not derive
 *   a name itself, so the caller's intent to create exactly this
 *   database is explicit.
 *
 *   _schemaStatementsForTesting is FOR THE PHASE 2C ROLLBACK TEST
 *   ONLY -- when provided, it replaces the statements normally read
 *   from schemas/tenantSchema.postgresql.sql, so the failure/rollback path can
 *   be exercised with a deliberately broken statement without ever
 *   modifying the real schema file. Never pass this in real
 *   provisioning code.
 */
async function provisionTenantDatabase({ databaseName, _schemaStatementsForTesting }) {
    if (!isValidTenantDbName(databaseName)) {
        return {
            success: false,
            code: "INVALID_NAME",
            error: `"${databaseName}" is not a valid tenant database name.`,
        };
    }

    if (await databaseExists(databaseName)) {
        return {
            success: false,
            code: "ALREADY_EXISTS",
            error: "Tenant database already exists.",
            databaseName,
        };
    }

    let statements;
    let expectedTables;
    try {
        statements = _schemaStatementsForTesting || loadSchemaStatements();
        expectedTables = _schemaStatementsForTesting
            ? extractTableNamesFromStatements(_schemaStatementsForTesting)
            : extractTableNamesFromSchema();
    } catch (error) {
        return { success: false, code: "SCHEMA_FILE_ERROR", error: error.message };
    }

    // Step 1: create the database itself. Only past this point is
    // rollback (dropping it again on failure) ever considered, and
    // only because we know for certain THIS call just created it.
    await provisioningPool.query(
    `CREATE DATABASE "${databaseName}"`
    );

    let tenantConn;
    try {
    tenantConn = new Client({
        host: process.env.PLATFORM_DB_HOST,
        port: process.env.PLATFORM_DB_PORT,
        user: process.env.PLATFORM_DB_USER,
        password: process.env.PLATFORM_DB_PASSWORD,
        database: databaseName,
    });
    await tenantConn.connect();

        // Table creation order doesn't matter with FK checks off --
        // required anyway, since the tenant schema has genuine
        // circular references (e.g. users.department_id ->
        // departments.id, departments.department_head_id -> users.id).

        for (const statement of statements) {
            await tenantConn.query(statement);
        }

        await tenantConn.end();
        tenantConn = null;

    } catch (error) {
        if (tenantConn) {
            try { await tenantConn.end(); } catch (_) { /* already broken */ }
        }

        // Rollback: only ever drops a database that (a) THIS call
        // created a moment ago, (b) passes strict name validation,
        // and (c) is not a protected name. Never a pre-existing
        // database under any circumstances.
        await rollbackFailedProvision(databaseName);

        return {
            success: false,
            code: "SCHEMA_APPLY_FAILED",
            error: error.message,
            rolledBack: true,
            databaseName,
        };
    }

    // Verify: table set actually created matches the schema file's
    // table set exactly.
    const verification = await verifyTenantDatabase(databaseName, expectedTables);

    if (!verification.matches) {
        await rollbackFailedProvision(databaseName);
        return {
            success: false,
            code: "VERIFICATION_FAILED",
            error: "Newly created tenant database did not match the expected schema.",
            details: verification,
            rolledBack: true,
            databaseName,
        };
    }

    return {
        success: true,
        databaseName,
        tableCount: verification.actualTableCount,
        tables: verification.actualTables,
    };
}

async function rollbackFailedProvision(databaseName) {
    // Defense in depth: re-check every safety condition again here,
    // independent of whatever the caller already checked, since this
    // function is the one actually issuing DROP DATABASE.
    if (!isValidTenantDbName(databaseName)) return;
    if (isProtectedDbName(databaseName)) return;
    if (databaseName === process.env.DB_NAME) return;
    if (databaseName === process.env.PLATFORM_DB_NAME) return;

    try {
        await provisioningPool.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } catch (_) {
        // Best-effort cleanup -- the failure is already being
        // reported to the caller either way.
    }
}

async function verifyTenantDatabase(databaseName, expectedTables) {
    const tenantConn = new Client({
        host: process.env.PLATFORM_DB_HOST,
        port: process.env.PLATFORM_DB_PORT,
        user: process.env.PLATFORM_DB_USER,
        password: process.env.PLATFORM_DB_PASSWORD,
        database: databaseName,
    });

    try {
        await tenantConn.connect();

        const result = await tenantConn.query(
            `SELECT table_name
             FROM information_schema.tables
             WHERE table_schema = 'public'
             ORDER BY table_name`
        );

        const actualTables = result.rows.map((r) => r.table_name);

        const missing = expectedTables.filter((t) => !actualTables.includes(t));
        const unexpected = actualTables.filter((t) => !expectedTables.includes(t));
        return {
            matches: missing.length === 0 && unexpected.length === 0,
            expectedTableCount: expectedTables.length,
            actualTableCount: actualTables.length,
            actualTables,
            missing,
            unexpected,
    };
    } finally {
        await tenantConn.end();
    }
}


// ------------------------------------------
// Cross-database structural comparison
// (used by the Phase 2C provisioning test to compare the temporary
// database against the live source schema -- entirely read-only
// against both databases)
// ------------------------------------------

async function getTableNames(databaseName) {
    const tenantConn = new Client({
        host: process.env.PLATFORM_DB_HOST,
        port: process.env.PLATFORM_DB_PORT,
        user: process.env.PLATFORM_DB_USER,
        password: process.env.PLATFORM_DB_PASSWORD,
        database: databaseName,
    });

    try {
        await tenantConn.connect();

        const result = await tenantConn.query(
            `SELECT table_name
             FROM information_schema.tables
             WHERE table_schema = 'public'
             AND table_type = 'BASE TABLE'
             ORDER BY table_name`
        );

        return result.rows.map((r) => r.table_name).sort();
    } finally {
        await tenantConn.end();
    }
}

async function getForeignKeyCount(databaseName) {
    const tenantConn = new Client({
        host: process.env.PLATFORM_DB_HOST,
        port: process.env.PLATFORM_DB_PORT,
        user: process.env.PLATFORM_DB_USER,
        password: process.env.PLATFORM_DB_PASSWORD,
        database: databaseName,
    });

    try {
        await tenantConn.connect();

        const result = await tenantConn.query(
            `SELECT COUNT(*) AS c
             FROM information_schema.table_constraints
             WHERE constraint_schema = 'public'
             AND constraint_type = 'FOREIGN KEY'`
        );

        return Number(result.rows[0].c);
    } finally {
        await tenantConn.end();
    }
}

async function getIndexCount(databaseName) {
    const tenantConn = new Client({
        host: process.env.PLATFORM_DB_HOST,
        port: process.env.PLATFORM_DB_PORT,
        user: process.env.PLATFORM_DB_USER,
        password: process.env.PLATFORM_DB_PASSWORD,
        database: databaseName,
    });

    try {
        await tenantConn.connect();

        const result = await tenantConn.query(
            `SELECT COUNT(*) AS c
             FROM pg_indexes
             WHERE schemaname = 'public'`
        );

        return Number(result.rows[0].c);
    } finally {
        await tenantConn.end();
    }
}

async function getRowCounts(databaseName) {
    const tenantConn = new Client({
        host: process.env.PLATFORM_DB_HOST,
        port: process.env.PLATFORM_DB_PORT,
        user: process.env.PLATFORM_DB_USER,
        password: process.env.PLATFORM_DB_PASSWORD,
        database: databaseName,
    });

    try {
        await tenantConn.connect();

        const tables = await getTableNames(databaseName);
        const counts = {};

        for (const table of tables) {
            const safeTableName = table.replace(/"/g, '""');

            const result = await tenantConn.query(
                `SELECT COUNT(*) AS c FROM public."${safeTableName}"`
            );

            counts[table] = Number(result.rows[0].c);
        }

        return counts;
    } finally {
        await tenantConn.end();
    }
}
async function compareTenantSchema(sourceDbName, targetDbName) {
    const [sourceTables, targetTables, sourceFkCount, targetFkCount, sourceIdxCount, targetIdxCount] =
        await Promise.all([
            getTableNames(sourceDbName),
            getTableNames(targetDbName),
            getForeignKeyCount(sourceDbName),
            getForeignKeyCount(targetDbName),
            getIndexCount(sourceDbName),
            getIndexCount(targetDbName),
        ]);

    return {
        tableNamesMatch: JSON.stringify(sourceTables) === JSON.stringify(targetTables),
        sourceTableCount: sourceTables.length,
        targetTableCount: targetTables.length,
        missingInTarget: sourceTables.filter((t) => !targetTables.includes(t)),
        unexpectedInTarget: targetTables.filter((t) => !sourceTables.includes(t)),
        sourceForeignKeyCount: sourceFkCount,
        targetForeignKeyCount: targetFkCount,
        foreignKeysMatch: sourceFkCount === targetFkCount,
        sourceIndexCount: sourceIdxCount,
        targetIndexCount: targetIdxCount,
        indexesMatch: sourceIdxCount === targetIdxCount,
    };
}

// ------------------------------------------
// Explicit, caller-invoked database teardown
//
// Deliberately separate from rollbackFailedProvision (which only
// ever fires automatically on a failure THIS SAME call just caused).
// This is for a caller that deliberately wants to drop a database it
// knows it created -- the Phase 2C throwaway provisioning test uses
// this to remove its own temporary database once verification has
// passed.
//
// Guarded so it can NEVER be pointed at a protected database or at
// either database this app is actually configured to use right now
// (DB_NAME / PLATFORM_DB_NAME), regardless of what pattern the name
// otherwise matches. Only names that would themselves have been
// legal to CREATE through this service (a real tenant_* name, or the
// dedicated groworgs_provision_test* throwaway pattern) are accepted
// at all -- there is no generic "drop any name" path.
// ------------------------------------------

async function dropProvisionedDatabase(databaseName) {
    const knownSafePattern = isValidTenantDbName(databaseName) || isValidTestDbName(databaseName);

    if (!knownSafePattern) {
        throw new Error(
            `Refusing to drop "${databaseName}": does not match a known safe ` +
            `naming pattern (tenant_* or groworgs_provision_test*).`
        );
    }
    if (isProtectedDbName(databaseName)) {
        throw new Error(`Refusing to drop "${databaseName}": protected database name.`);
    }
    if (databaseName === process.env.DB_NAME || databaseName === process.env.PLATFORM_DB_NAME) {
        throw new Error(`Refusing to drop "${databaseName}": matches a live configured database.`);
    }

    const exists = await databaseExists(databaseName);
    if (!exists) {
        return { dropped: false, reason: "did not exist" };
    }

    await provisioningPool.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    return { dropped: true };
}

module.exports = {
    buildTenantDbName,
    provisionTenantDatabase,
    databaseExists,
    verifyTenantDatabase,
    compareTenantSchema,
    getRowCounts,
    dropProvisionedDatabase,
};
