const mysql = require("mysql2/promise");
require("dotenv").config();

const { isValidTenantDbName } = require("../utils/tenantDbName");

// ==========================================
// TENANT CONNECTION MANAGER (Phase 2E)
//
// The ONLY place in the codebase that opens a connection to a
// dynamically-named tenant database. Every caller must go through
// getTenantPoolForCompany(company) (preferred) or getTenantPool(name)
// -- there is no other sanctioned way to obtain a tenant connection.
//
// Credentials: uses the PLATFORM_DB_* credentials (same reasoning as
// config/provisioningDb.js from Phase 2C) -- reaching into a tenant
// database on the platform's behalf is a platform-level
// administrative action, not something that should require the
// existing Reinsteins-specific DB_* credentials (config/db.js) to
// know about other tenants at all. This file never imports
// config/db.js.
//
// Pool cache: one small pool per tenant database name, cached in a
// module-level Map so repeated calls for the same company reuse the
// same pool instead of opening a fresh one every time. No eviction
// is implemented yet -- at this phase's call volume (Platform Owner
// creating a company's first admin, an infrequent administrative
// action) an unbounded-but-small map is not a real resource concern.
// Revisit with an LRU/TTL cap when a later phase wires this into
// something high-frequency like per-request tenant login resolution.
// ==========================================

const tenantPoolCache = new Map();

function getTenantPool(tenantDbName) {

    if (!isValidTenantDbName(tenantDbName)) {
        throw new Error(`Refusing to connect: "${tenantDbName}" is not a valid tenant database name.`);
    }

    if (tenantPoolCache.has(tenantDbName)) {
        return tenantPoolCache.get(tenantDbName);
    }

    const pool = mysql.createPool({
        host: process.env.PLATFORM_DB_HOST,
        port: process.env.PLATFORM_DB_PORT,
        user: process.env.PLATFORM_DB_USER,
        password: process.env.PLATFORM_DB_PASSWORD,
        database: tenantDbName,
        waitForConnections: true,
        connectionLimit: 5,
        queueLimit: 0,
    });

    tenantPoolCache.set(tenantDbName, pool);

    return pool;
}

// Preferred entry point -- takes an already-fetched company row
// (from groworgs_platform_db.companies) and re-validates everything
// needed before ever opening a connection: the company must be
// active and must have a tenant_db_name that independently passes
// the same strict validation used everywhere else in the tenant
// naming system. A frontend/body-supplied database name never flows
// into this call -- the name always comes from the platform
// database's own companies row, looked up by companyId.
function getTenantPoolForCompany(company) {

    if (!company) {
        const error = new Error("Company not found.");
        error.code = "COMPANY_NOT_FOUND";
        throw error;
    }

    if (company.status !== "active") {
        const error = new Error("Company is not active.");
        error.code = "COMPANY_NOT_ACTIVE";
        throw error;
    }

    if (!company.tenant_db_name) {
        const error = new Error("Company has no tenant database assigned yet.");
        error.code = "COMPANY_NO_TENANT_DB";
        throw error;
    }

    if (!isValidTenantDbName(company.tenant_db_name)) {
        const error = new Error("Company's tenant_db_name failed validation.");
        error.code = "COMPANY_TENANT_DB_INVALID";
        throw error;
    }

    return getTenantPool(company.tenant_db_name);
}

// Test/script-only helper -- closes every cached pool so a
// short-lived Node process (a test script) can exit cleanly instead
// of hanging on open pool connections. Never called from request-
// handling code.
async function closeAllTenantPools() {
    const pools = Array.from(tenantPoolCache.values());
    tenantPoolCache.clear();
    await Promise.all(pools.map((pool) => pool.end().catch(() => {})));
}

module.exports = {
    getTenantPool,
    getTenantPoolForCompany,
    closeAllTenantPools,
};
