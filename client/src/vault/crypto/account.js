import { getSodium } from "./sodium.js";
import { VaultCryptoError, randomKey, unwrapKey, wrapKey } from "./aead.js";
import { equalBytes } from "./aad.js";
import { DEFAULT_KDF, KDF_CONTEXTS, SALT_BYTES, checkMasterPassword, deriveMasterKey, deriveSubkey, validateKdfParams } from "./kdf.js";
import { generateKeyPair, publicKeyFromPrivate } from "./boxes.js";
import { generateRecoverySecret, parseRecoverySecret, recoveryKekFromSecret } from "./recoverySecret.js";

// ==========================================
// ZIOVAULT -- the vault account: setup, unlock, change password, recovery
//
//   master password --Argon2id--> masterKey --KDF--> KEK
//   vaultKey (random) --AEAD(KEK)--------> vaultKeyEnvelope        \
//   X25519 private key --AEAD(vaultKey)--> privateKeyEnvelope       |  these, plus the salt/params and the PUBLIC key, are
//   vaultKey --AEAD(recoveryKek)---------> recoveryEnvelope        /   the ONLY things the server ever receives
//
// `tenantId` ("legacy" or the company id from the verified session) and `userId` are bound into every envelope's AAD.
// Nothing here talks to the network: callers upload `server` and keep `session` in memory only.
// ==========================================

// The identifiers bound into every account envelope: tenant, user, and the envelope format generation.
export const accountAadIds = (tenantId, userId) => [tenantId, userId, "1"];
const aadFor = (_unused, tenantId, userId) => accountAadIds(tenantId, userId);

function assertContext(tenantId, userId) {
  if (tenantId === undefined || tenantId === null || String(tenantId) === "") throw new VaultCryptoError("A tenant is required");
  if (userId === undefined || userId === null || String(userId) === "") throw new VaultCryptoError("A user is required");
}

async function build({ vaultKey, keyPair, kek, recoverySecretBytes, tenantId, userId }) {
  const recoveryKek = await recoveryKekFromSecret(recoverySecretBytes);
  const ids = aadFor(null, tenantId, userId);
  return {
    vaultKeyEnvelope: await wrapKey(kek, vaultKey, "vault-key", ids),
    privateKeyEnvelope: await wrapKey(vaultKey, keyPair.privateKey, "private-key", ids),
    recoveryEnvelope: await wrapKey(recoveryKek, vaultKey, "recovery-vault-key", ids),
    publicKey: keyPair.publicKey,
  };
}

export async function createAccount({ password, tenantId, userId, kdf = DEFAULT_KDF }) {
  assertContext(tenantId, userId);
  const policy = checkMasterPassword(password);
  if (!policy.ok) throw new VaultCryptoError(policy.reason);
  validateKdfParams(kdf);
  const sodium = await getSodium();

  const salt = sodium.randombytes_buf(SALT_BYTES);
  const masterKey = await deriveMasterKey(password, salt, kdf);
  const kek = await deriveSubkey(masterKey, KDF_CONTEXTS.kek);
  sodium.memzero(masterKey);

  const vaultKey = await randomKey();
  const keyPair = await generateKeyPair();
  const recovery = await generateRecoverySecret();
  const envelopes = await build({ vaultKey, keyPair, kek, recoverySecretBytes: recovery.bytes, tenantId, userId });
  sodium.memzero(kek);

  return {
    server: { kdf: { alg: kdf.alg, ops: kdf.ops, mem: kdf.mem, salt }, ...envelopes },
    session: { vaultKey, publicKey: keyPair.publicKey, privateKey: keyPair.privateKey },
    recoverySecretText: recovery.text,
  };
}

async function openWithVaultKey({ vaultKey, server, tenantId, userId }) {
  const ids = aadFor(null, tenantId, userId);
  const privateKey = await unwrapKey(vaultKey, server.privateKeyEnvelope, "private-key", ids);
  // The public key the server holds MUST belong to this private key; otherwise the server swapped it.
  const derived = await publicKeyFromPrivate(privateKey);
  if (!equalBytes(derived, server.publicKey)) throw new VaultCryptoError("The stored public key does not match this vault");
  return { vaultKey, privateKey, publicKey: derived };
}

export async function unlockAccount({ password, server, tenantId, userId }) {
  assertContext(tenantId, userId);
  const sodium = await getSodium();
  validateKdfParams(server.kdf);
  const masterKey = await deriveMasterKey(password, server.kdf.salt, server.kdf);
  const kek = await deriveSubkey(masterKey, KDF_CONTEXTS.kek);
  sodium.memzero(masterKey);
  try {
    const vaultKey = await unwrapKey(kek, server.vaultKeyEnvelope, "vault-key", aadFor(null, tenantId, userId));
    return await openWithVaultKey({ vaultKey, server, tenantId, userId });
  } finally {
    sodium.memzero(kek);
  }
}

// Re-wrap the SAME vault key under a new master password. No item is re-encrypted. Returns the new server material.
export async function changeMasterPassword({ session, newPassword, tenantId, userId, kdf = DEFAULT_KDF, server }) {
  assertContext(tenantId, userId);
  const policy = checkMasterPassword(newPassword);
  if (!policy.ok) throw new VaultCryptoError(policy.reason);
  validateKdfParams(kdf);
  const sodium = await getSodium();
  const salt = sodium.randombytes_buf(SALT_BYTES);
  const masterKey = await deriveMasterKey(newPassword, salt, kdf);
  const kek = await deriveSubkey(masterKey, KDF_CONTEXTS.kek);
  sodium.memzero(masterKey);
  const vaultKeyEnvelope = await wrapKey(kek, session.vaultKey, "vault-key", aadFor(null, tenantId, userId));
  sodium.memzero(kek);
  return { kdf: { alg: kdf.alg, ops: kdf.ops, mem: kdf.mem, salt }, vaultKeyEnvelope, privateKeyEnvelope: server.privateKeyEnvelope, recoveryEnvelope: server.recoveryEnvelope, publicKey: server.publicKey };
}

// Forgotten master password: the recovery secret opens the recovery envelope; the vault key is re-wrapped under a NEW password.
// The recovery envelope itself is kept (the same recovery secret keeps working) unless the caller rotates it.
export async function recoverAccount({ recoverySecretText, newPassword, server, tenantId, userId, kdf = DEFAULT_KDF }) {
  assertContext(tenantId, userId);
  const policy = checkMasterPassword(newPassword);
  if (!policy.ok) throw new VaultCryptoError(policy.reason);
  const sodium = await getSodium();
  const secretBytes = await parseRecoverySecret(recoverySecretText);
  const recoveryKek = await recoveryKekFromSecret(secretBytes);
  const vaultKey = await unwrapKey(recoveryKek, server.recoveryEnvelope, "recovery-vault-key", aadFor(null, tenantId, userId));
  const session = await openWithVaultKey({ vaultKey, server, tenantId, userId });
  sodium.memzero(recoveryKek);
  const updated = await changeMasterPassword({ session, newPassword, tenantId, userId, kdf, server });
  return { server: updated, session };
}

// Optional: issue a NEW recovery secret (the old one stops working once the server stores the returned envelope).
export async function rotateRecoverySecret({ session, tenantId, userId }) {
  assertContext(tenantId, userId);
  const recovery = await generateRecoverySecret();
  const recoveryKek = await recoveryKekFromSecret(recovery.bytes);
  const recoveryEnvelope = await wrapKey(recoveryKek, session.vaultKey, "recovery-vault-key", aadFor(null, tenantId, userId));
  return { recoveryEnvelope, recoverySecretText: recovery.text };
}

export function lockSession(session) {
  // Best-effort: overwrite key bytes. (JavaScript cannot guarantee that no other copy exists; see the architecture document.)
  for (const key of [session?.vaultKey, session?.privateKey]) if (key instanceof Uint8Array) key.fill(0);
}
