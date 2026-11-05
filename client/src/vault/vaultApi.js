import { toB64, fromB64 } from "./encoding.js";

// ==========================================
// ZIOVAULT -- the HTTP contract with /api/ziovault (Stage 2)
//
// A thin wrapper: it turns bytes into base64url on the way out and back on the way in, and turns every failure into one
// VaultApiError with a stable `code`. It never sees a key or a plaintext (callers pass ciphertext and envelopes only) and never logs.
// `http` is the CRM's axios instance in the app (it adds the sign-in token) and a stand-in in tests.
// ==========================================

export class VaultApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "VaultApiError";
    this.status = status;
    this.code = code;
  }
}

function mapError(error) {
  const response = error && error.response;
  if (!response) return new VaultApiError(0, "NETWORK", "Could not reach the server. Check your connection and try again.");
  const body = response.data || {};
  if (response.status === 401) return new VaultApiError(401, "SESSION_EXPIRED", "Your session has expired. Please sign in again.");
  if (response.status === 403 && body.code === "FEATURE_NOT_ENABLED") return new VaultApiError(403, "FEATURE_NOT_ENABLED", "ZioVault is not enabled for your organization.");
  if (response.status === 429) return new VaultApiError(429, "RATE_LIMITED", "Too many attempts. Please wait a moment and try again.");
  return new VaultApiError(response.status, body.code || "ERROR", typeof body.message === "string" ? body.message : "The request could not be completed.");
}

export const kdfToWire = (kdf) => ({ alg: kdf.alg, ops: kdf.ops, mem: kdf.mem, salt: toB64(kdf.salt) });

export function serverMaterialToWire(server) {
  return {
    kdf: kdfToWire(server.kdf),
    vaultKeyEnvelope: toB64(server.vaultKeyEnvelope),
    privateKeyEnvelope: toB64(server.privateKeyEnvelope),
    publicKey: toB64(server.publicKey),
    recoveryEnvelope: toB64(server.recoveryEnvelope),
  };
}

export function serverMaterialFromWire(data) {
  return {
    kdf: { alg: data.kdf.alg, ops: data.kdf.ops, mem: data.kdf.mem, salt: fromB64(data.kdf.salt) },
    vaultKeyEnvelope: fromB64(data.vaultKeyEnvelope),
    privateKeyEnvelope: fromB64(data.privateKeyEnvelope),
    publicKey: fromB64(data.publicKey),
    ...(data.recoveryEnvelope ? { recoveryEnvelope: fromB64(data.recoveryEnvelope) } : {}),
  };
}

export function createVaultApi(http) {
  const call = async (method, path, body) => {
    try {
      const response = method === "get" || method === "delete" ? await http[method](`/ziovault${path}`) : await http[method](`/ziovault${path}`, body);
      return response.data && response.data.data;
    } catch (error) {
      throw mapError(error);
    }
  };

  return {
    accountStatus: () => call("get", "/account/status"),
    register: (server) => call("post", "/account", serverMaterialToWire(server)),
    unlockMaterial: () => call("get", "/account/unlock"),
    recoveryMaterial: () => call("get", "/account/recovery"),
    confirmRecovery: () => call("post", "/account/recovery-confirmation"),
    replaceEnvelope: ({ expectedAccountVersion, kdf, vaultKeyEnvelope, reason }) => call("put", "/account/envelope", { expectedAccountVersion, reason, kdf: kdfToWire(kdf), vaultKeyEnvelope: toB64(vaultKeyEnvelope) }),
    replaceRecoveryEnvelope: ({ expectedAccountVersion, recoveryEnvelope }) => call("put", "/account/recovery-envelope", { expectedAccountVersion, recoveryEnvelope: toB64(recoveryEnvelope) }),

    listFolders: () => call("get", "/folders"),
    createFolder: ({ uid, name }) => call("post", "/folders", { uid, name: toB64(name) }),
    renameFolder: (uid, name) => call("patch", `/folders/${uid}`, { name: toB64(name) }),
    deleteFolder: (uid) => call("delete", `/folders/${uid}`),

    listItems: () => call("get", "/items"),
    listTrash: () => call("get", "/items/trash"),
    getItem: (uid) => call("get", `/items/${uid}`),
    getSecret: (uid) => call("post", `/items/${uid}/secret`),
    reportAccess: (uid, kind) => call("post", `/items/${uid}/access-reports`, { kind }),
    createItem: ({ uid, kind, meta, secret, keys, rotationIntervalDays }) =>
      call("post", "/items", { uid, kind, meta: toB64(meta), secret: secret ? toB64(secret) : null, keys: { meta: toB64(keys.meta), secret: keys.secret ? toB64(keys.secret) : undefined }, rotationIntervalDays: rotationIntervalDays ?? undefined }),
    updateItem: (uid, { expectedVersion, meta, secret, kind, favorite, rotationIntervalDays }) =>
      call("patch", `/items/${uid}`, {
        expectedVersion,
        ...(meta ? { meta: toB64(meta) } : {}),
        ...(secret ? { secret: toB64(secret) } : {}),
        ...(kind ? { kind } : {}),
        ...(favorite !== undefined ? { favorite } : {}),
        ...(rotationIntervalDays !== undefined ? { rotationIntervalDays } : {}),
      }),
    deleteItem: (uid) => call("delete", `/items/${uid}`),
    restoreItem: (uid) => call("post", `/items/${uid}/restore`),
  };
}
