const { createCompatPool } = require("./pgCompat");
require("dotenv").config();

const { isValidTenantDbName } = require("../utils/tenantDbName");

const tenantPoolCache = new Map();

function getTenantPool(tenantDbName) {
  if (!isValidTenantDbName(tenantDbName)) {
    throw new Error(
      `Refusing to connect: "${tenantDbName}" is not a valid tenant database name.`
    );
  }

  if (tenantPoolCache.has(tenantDbName)) {
    return tenantPoolCache.get(tenantDbName);
  }

  const pool = createCompatPool({
    host: process.env.PLATFORM_DB_HOST,
    port: process.env.PLATFORM_DB_PORT,
    user: process.env.PLATFORM_DB_USER,
    password: process.env.PLATFORM_DB_PASSWORD,
    database: tenantDbName,
    max: 5,
  });

  // Required by node-postgres: an idle client that hits a background
  // error (lost network, DB restart, an admin/FORCE-terminated
  // connection elsewhere -- e.g. a tenant database being dropped)
  // emits 'error' on the pool. With no listener, Node treats that as
  // an uncaught exception and crashes the whole process -- every
  // tenant's traffic, not just this one database's. Log and
  // continue; the pool recovers the connection itself.
  pool.on("error", (err) => {
    console.error(`tenantPool (${tenantDbName}): unexpected idle client error:`, err.message);
  });

  tenantPoolCache.set(tenantDbName, pool);

  return pool;
}

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

async function closeAllTenantPools() {
  const pools = Array.from(tenantPoolCache.values());
  tenantPoolCache.clear();

  await Promise.all(
    pools.map((pool) => pool.end().catch(() => {}))
  );
}

module.exports = {
  getTenantPool,
  getTenantPoolForCompany,
  closeAllTenantPools,
};
