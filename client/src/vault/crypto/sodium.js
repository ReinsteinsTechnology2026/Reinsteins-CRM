import sodium from "libsodium-wrappers-sumo";

// ==========================================
// ZIOVAULT -- libsodium loader
//
// All ZioVault cryptography is libsodium (libsodium-wrappers-sumo, pinned exactly in package.json). Nothing in this
// folder implements a primitive; it only composes the ones libsodium provides, as documented in
// server/ZIOVAULT_ARCHITECTURE.md section 2. If libsodium cannot load, every function rejects: there is NO fallback to
// another implementation and none to the server (a vault never silently downgrades).
// ==========================================

let loading = null;

export function getSodium() {
  if (!loading) loading = sodium.ready.then(() => sodium);
  return loading;
}

export const SODIUM_VERSION_REQUIRED = "1.0.";

export async function assertSodium() {
  const s = await getSodium();
  if (!String(s.sodium_version_string()).startsWith(SODIUM_VERSION_REQUIRED)) {
    throw new Error("Unsupported libsodium build");
  }
  return s;
}
