// Detects that this tab is running an OLDER build than the one currently deployed.
//
// Why this exists: index.html is served with Last-Modified and no Cache-Control,
// so a browser may keep reusing a stale copy after a deploy. That copy points at the
// previous (fingerprinted) bundle, so the whole tab -- login page, post-login
// navigation, dashboard -- keeps rendering the OLD UI until the user presses refresh,
// which is the one action that revalidates index.html. The proper fix is the
// Cache-Control header on index.html (see server/deploy/frontend-cache-headers.nginx.example);
// this is the safety net that works without it.
//
// Each build embeds an id (__BUILD_ID__, see vite.config.js) and publishes the same id in
// /version.json. When the live id differs from the id compiled into the running bundle,
// the tab reloads ONCE: a reload revalidates index.html, and sessionStorage (the login
// session) survives it. Anything unexpected (offline, 404, HTML instead of JSON, a dev
// server) means "do nothing": this can never block or loop the app.

/* global __BUILD_ID__ */
export const BUILD_ID = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

const VERSION_URL = "/version.json";
const GUARD_KEY = "wh_build_reload_attempt";

// The id of the build that is deployed right now, or null if it cannot be determined.
// no-store + a unique query keep the browser and any CDN from answering this one
// request from a cache -- it is a few bytes and is only sent at startup and login.
export async function fetchDeployedBuildId(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`${VERSION_URL}?t=${Date.now()}`, {
      cache: "no-store",
      // a slow or hung check must never hold up startup or login
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined,
    });
    if (!response || !response.ok) return null;

    const data = await response.json();
    return data && typeof data.buildId === "string" && data.buildId ? data.buildId : null;
  } catch {
    return null;
  }
}

function readGuard(storage) {
  try {
    return storage.getItem(GUARD_KEY);
  } catch {
    return null;
  }
}

function writeGuard(storage, value) {
  try {
    if (value === null) storage.removeItem(GUARD_KEY);
    else storage.setItem(GUARD_KEY, value);
  } catch {
    // storage unavailable: the reload below is still limited by the in-memory flag
  }
}

let reloadRequested = false;

// Reloads the page when `deployedId` is newer than this bundle. Returns true if it did.
// Loop protection: a given deployed id triggers at most one reload per browser. If the
// page still comes back stale after that (an intermediate cache), it is left alone.
// localStorage, not sessionStorage: the 401 handler clears sessionStorage.
export function reloadForNewBuild(
  deployedId,
  { currentId = BUILD_ID, storage = globalThis.localStorage, reload = () => globalThis.location.reload() } = {}
) {
  if (currentId === "dev" || !deployedId) return false;

  if (deployedId === currentId) {
    if (readGuard(storage) !== null) writeGuard(storage, null);
    return false;
  }

  if (reloadRequested || readGuard(storage) === deployedId) return false;

  reloadRequested = true;
  writeGuard(storage, deployedId);
  reload();
  return true;
}

// Startup / login convenience: check, then reload if this tab is stale.
export async function reloadIfStaleBuild(options = {}) {
  const { fetchImpl, ...reloadOptions } = options;
  if ((reloadOptions.currentId ?? BUILD_ID) === "dev") return false;

  return reloadForNewBuild(await fetchDeployedBuildId(fetchImpl), reloadOptions);
}

// Test hook: the in-memory flag is per page load.
export function _resetBuildVersionState() {
  reloadRequested = false;
}
