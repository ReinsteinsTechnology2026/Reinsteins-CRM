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

// ROOM SCOPE -- which DATABASE a Socket.IO room belongs to.
//
// The company slug alone is NOT enough: the legacy Reinsteins database and the registered tenant
// company "reinsteins" (tenant_reinsteins) both resolve to the slug "reinsteins", yet they are two
// different databases with independent id sequences. Room names built from the slug would be shared
// across them (legacy sheet 5 and tenant sheet 5, legacy user 3 and tenant user 3 ...), so live
// updates and notifications could cross databases.
//
// The scope is therefore the legacy marker for the legacy database and the company slug for a
// registered tenant. A real slug matches ^[a-z][a-z0-9_]{1,39}$, so it can never equal the marker
// (which contains a hyphen) and no tenant can ever be given the legacy scope.
const LEGACY_ROOM_SCOPE = "legacy-db";

function roomScopeOf(context) {
  if (!context) return LEGACY_ROOM_SCOPE;
  if (context.tenantPool === legacyPool) return LEGACY_ROOM_SCOPE;
  if (!context.tenantPool && (!context.companySlug || context.companySlug === LEGACY_COMPANY_SLUG)) {
    return LEGACY_ROOM_SCOPE;
  }
  if (typeof context.companySlug !== "string" || !context.companySlug) {
    // never fall back to a shared name: a context that is neither legacy nor a named tenant is a bug
    throw new Error("Cannot build a socket room scope: the tenant context has no company slug");
  }
  return context.companySlug;
}

function getCurrentRoomScope() {
  return roomScopeOf(tenantDbContext.getStore());
}

const SPECIAL_PROPS = {
  __runWithTenantContext: runWithTenantContext,
  __getCurrentCompanySlug: getCurrentCompanySlug,
  __legacyPool: legacyPool,
  __LEGACY_COMPANY_SLUG: LEGACY_COMPANY_SLUG,
  __LEGACY_ROOM_SCOPE: LEGACY_ROOM_SCOPE,
  __roomScopeOf: roomScopeOf,
  __getCurrentRoomScope: getCurrentRoomScope,
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
