// ==========================================
// TENANT DATABASE NAME VALIDATION / GENERATION (Phase 2C)
//
// The ONLY place in the codebase that decides what a tenant database
// is allowed to be named. Nothing outside this file should build a
// database identifier string for use in DDL.
//
// NAMING CONVENTION: tenant_<slug>
//   e.g. company_slug "arckenets"  -> database "tenant_arckenets"
//        company_slug "reinsteins" -> database "tenant_reinsteins"
//
// Chosen over a bare "<slug>_db" convention for two reasons:
//   1. A single common prefix ("tenant_") makes every tenant database
//      trivially identifiable at a glance in `SHOW DATABASES`, in
//      backup tooling, and when granting DB-level MySQL permissions
//      by wildcard -- versus "_db" which is a generic suffix lots of
//      unrelated databases could also happen to use.
//   2. It reads unambiguously as "this is a tenant of the platform",
//      independent of whatever the company's own slug looks like.
//
// A company's `company_slug` (groworgs_platform_db.companies) is
// itself already validated elsewhere on creation; this module treats
// it as untrusted input regardless and re-validates from scratch.
// ==========================================

// Slug rules: lowercase letters/digits/underscore, must start with a
// letter, 2-40 chars. Deliberately stricter than "anything MySQL
// would accept" -- this is a whitelist, not an escaping strategy.
const SLUG_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

const TENANT_DB_PREFIX = "tenant_";

// MySQL's hard identifier length limit is 64 characters.
const MYSQL_MAX_IDENTIFIER_LENGTH = 64;

// Full tenant database name pattern -- what a name must look like to
// ever be treated as "provisionable" or "droppable" by this system.
const TENANT_DB_NAME_PATTERN = /^tenant_[a-z][a-z0-9_]{1,39}$/;

// Separate, narrower pattern for THROWAWAY TEST databases only (used
// by the Phase 2C provisioning test, never by real tenant
// provisioning). Kept distinct from TENANT_DB_NAME_PATTERN so a test
// database can never be mistaken for -- or accidentally treated with
// the same trust as -- a real tenant database, and vice versa.
const TEST_DB_NAME_PATTERN = /^groworgs_provision_test(_[a-z0-9_]{1,40})?$/;

// Database names this system must never create, overwrite, or drop,
// under any circumstances, regardless of what any caller requests.
const PROTECTED_DB_NAMES = new Set([
    "reinsteins_workhub",
    "reinsteins_db",
    "groworgs_platform_db",
    "mysql",
    "information_schema",
    "performance_schema",
    "sys",
]);

function isValidSlug(slug) {
    return typeof slug === "string" && SLUG_PATTERN.test(slug);
}

// Server-side name generation -- the ONLY supported way to turn a
// company slug into a database name. A caller (route/controller)
// should never accept a raw database name typed by a user; it should
// accept a company slug and call this function.
function buildTenantDbName(slug) {
    if (!isValidSlug(slug)) {
        throw new Error(
            `Invalid company slug "${slug}". Slugs must be lowercase, start ` +
            `with a letter, contain only letters/digits/underscore, and be ` +
            `2-40 characters long.`
        );
    }

    const dbName = `${TENANT_DB_PREFIX}${slug}`;

    if (dbName.length > MYSQL_MAX_IDENTIFIER_LENGTH) {
        throw new Error(
            `Generated database name "${dbName}" exceeds MySQL's ` +
            `${MYSQL_MAX_IDENTIFIER_LENGTH}-character identifier limit.`
        );
    }

    return dbName;
}

// Strict re-validation of a database name string before it is ever
// interpolated into DDL (CREATE DATABASE / USE / DROP DATABASE).
// mysql2 cannot parameterize database identifiers the way it
// parameterizes values, so this whitelist check is the only thing
// standing between untrusted-ish input and a DDL statement.
function isValidTenantDbName(name) {
    if (typeof name !== "string") return false;
    if (name.length > MYSQL_MAX_IDENTIFIER_LENGTH) return false;
    if (!TENANT_DB_NAME_PATTERN.test(name)) return false;
    if (PROTECTED_DB_NAMES.has(name.toLowerCase())) return false;
    return true;
}

function isProtectedDbName(name) {
    return typeof name === "string" && PROTECTED_DB_NAMES.has(name.toLowerCase());
}

// A throwaway test database name -- deliberately NEVER accepted by
// isValidTenantDbName, and only ever used by the Phase 2C
// provisioning self-test.
function isValidTestDbName(name) {
    if (typeof name !== "string") return false;
    if (name.length > MYSQL_MAX_IDENTIFIER_LENGTH) return false;
    if (!TEST_DB_NAME_PATTERN.test(name)) return false;
    if (PROTECTED_DB_NAMES.has(name.toLowerCase())) return false;
    return true;
}

module.exports = {
    TENANT_DB_PREFIX,
    TENANT_DB_NAME_PATTERN,
    TEST_DB_NAME_PATTERN,
    PROTECTED_DB_NAMES,
    isValidSlug,
    buildTenantDbName,
    isValidTenantDbName,
    isValidTestDbName,
    isProtectedDbName,
};
