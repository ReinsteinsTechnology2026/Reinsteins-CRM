const { createCompatPool } = require("./pgCompat");
const { AsyncLocalStorage } = require("async_hooks");
require("dotenv").config();

// ==========================================
// TENANT-AWARE DATABASE ACCESS
// PostgreSQL version
// ==========================================

const legacyPool = createCompatPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: 10,
});

// Required by node-postgres: an idle client that hits a background
// error (lost network, DB restart, an admin/FORCE-terminated
// connection elsewhere) emits 'error' on the pool. With no listener,
// Node treats that as an uncaught exception and crashes the whole
// process -- for every tenant, not just the one connection that
// failed. Log and continue; the pool recovers the connection itself.
legacyPool.on("error", (err) => {
  console.error("legacyPool (reinsteins): unexpected idle client error:", err.message);
});

const LEGACY_COMPANY_SLUG = "reinsteins";

const tenantDbContext = new AsyncLocalStorage();

function currentPool() {
  const store = tenantDbContext.getStore();
  return (store && store.tenantPool) || legacyPool;
}

// context: { tenantPool, companySlug }
function runWithTenantContext(context, fn) {
  return tenantDbContext.run(context, fn);
}

function getCurrentCompanySlug() {
  const store = tenantDbContext.getStore();
  return (store && store.companySlug) || LEGACY_COMPANY_SLUG;
}

const SPECIAL_PROPS = {
  __runWithTenantContext: runWithTenantContext,
  __getCurrentCompanySlug: getCurrentCompanySlug,
  __legacyPool: legacyPool,
  __LEGACY_COMPANY_SLUG: LEGACY_COMPANY_SLUG,
};

const dbProxy = new Proxy(legacyPool, {
  get(_target, prop) {
    if (Object.prototype.hasOwnProperty.call(SPECIAL_PROPS, prop)) {
      return SPECIAL_PROPS[prop];
    }

    const active = currentPool();
    const value = active[prop];

    return typeof value === "function"
      ? value.bind(active)
      : value;
  },
});

module.exports = dbProxy;
