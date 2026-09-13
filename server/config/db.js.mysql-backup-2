const mysql = require("mysql2/promise");
const { AsyncLocalStorage } = require("async_hooks");
require("dotenv").config();

// ==========================================
// TENANT-AWARE DATABASE ACCESS
// (GrowOrgs Fast Completion Phase, Part 3/4)
//
// This is the single change that makes all ~47 existing files that
// `require("../config/db")` automatically tenant-aware, WITHOUT
// editing any of them. Investigation (grep across the whole server/
// tree) found every one of those files calls only pool.query(),
// pool.getConnection(), or pool.end() -- a small, well-defined
// surface this proxy fully supports.
//
// WHY THIS APPROACH (over converting every controller/service):
// 47 files import this module -- controllers, services, one-off
// migration/admin scripts, a cron job (jobs/notificationSweep.js),
// and inline routes in app.js itself. Editing all 47 by hand to
// accept and use a per-request tenant pool would be the single
// largest, highest-blast-radius change possible against a live
// production system, with no way to verify every call site short of
// exhaustively exercising the whole app. Node's AsyncLocalStorage
// lets every one of those files keep doing exactly what it already
// does (`pool.query(...)`) while the *pool it's actually talking to*
// is resolved per-request -- this is the "smallest safe abstraction
// strategy" called for, not a shortcut around it.
//
// HOW IT WORKS:
//   - `legacyPool` is the exact same pool this file has always
//     exported, unchanged, still pointed at DB_NAME
//     (reinsteins_workhub). Nothing about it is different.
//   - `tenantDbContext` is an AsyncLocalStorage instance. A request
//     handled by the NEW tenantProtect middleware (Phase 2F) runs
//     its entire downstream handler chain inside
//     `tenantDbContext.run({ tenantPool }, next)` -- so every
//     `pool.query()` call made anywhere during that request
//     transparently resolves to that request's own tenant's pool.
//   - A request that does NOT go through tenantProtect (every
//     existing Reinsteins request today, authenticated via the
//     original /api/auth/login + protect, plus every migration
//     script and the notification cron job) has no AsyncLocalStorage
//     store at all, so `currentPool()` falls back to `legacyPool` --
//     IDENTICAL to this file's behavior before this phase. Nothing
//     about the existing Reinsteins portal's data access changes.
//
// This is what makes the transition strategy in Part 3's report
// true: legacy login keeps working, unmodified, hitting
// reinsteins_workhub exactly as before; only the NEW tenant-JWT path
// is tenant-routed. See tenantAuthMiddleware.js for the `.run()` call
// site, and the Fast Completion Phase final report for why legacy
// login is treated as temporary rather than a permanent bypass.
//
// SOCKET.IO ISOLATION PHASE ADDITION: the context store now also
// carries `companySlug` (not just the pool), because Socket.IO room
// names must be tenant-namespaced (see utils/socketRooms.js) and the
// same ambient "what tenant am I currently operating as" lookup is
// needed by code that has no `req`/`socket` in scope at all --
// notificationService.js's createNotification(), for example, is
// called from both REST controllers and (indirectly) a cron job.
// __getCurrentCompanySlug() reads it straight from this same
// AsyncLocalStorage store, defaulting to "reinsteins" (the legacy
// tenant's real slug) exactly like currentPool() defaults to
// legacyPool -- the two defaults are deliberately the same tenant,
// so a legacy request/socket and its data/room-naming always agree.
// ==========================================

const legacyPool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
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

// Special properties are intercepted directly, independent of
// whichever pool is currently active -- they must resolve
// consistently regardless of AsyncLocalStorage state, unlike every
// other property (query/getConnection/etc.) which intentionally
// tracks the active pool.
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
    return typeof value === "function" ? value.bind(active) : value;
  },
});

module.exports = dbProxy;
