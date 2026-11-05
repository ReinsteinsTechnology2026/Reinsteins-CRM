import { getSodium } from "./sodium.js";
import { VaultCryptoError } from "./aead.js";
import { utf8 } from "./aad.js";

// ==========================================
// ZIOVAULT -- password stretching and key separation
//
// masterKey = Argon2id(master password, random 16-byte salt, ops, mem)   (libsodium crypto_pwhash, ALG_ARGON2ID13)
// subkey    = crypto_kdf_derive_from_key(key, id, 8-byte context)        (BLAKE2b based; distinct context per use)
//
// The KDF parameters are stored beside the envelope so they can be raised later. A client refuses parameters outside
// [MIN, MAX]: too low would make offline guessing cheap, too high is a denial-of-service on the browser tab.
// ==========================================

export const KDF_ALG = "argon2id13";
export const SALT_BYTES = 16;
export const KDF_LIMITS = Object.freeze({
  minOps: 2,
  maxOps: 10,
  minMem: 32 * 1024 * 1024, // bytes
  maxMem: 256 * 1024 * 1024,
});
export const DEFAULT_KDF = Object.freeze({ alg: KDF_ALG, ops: 3, mem: 64 * 1024 * 1024 });

export const MIN_PASSWORD_LENGTH = 12;

export const KDF_CONTEXTS = Object.freeze({
  kek: "ZVKEK001",
  recovery: "ZVREC001",
});

export function validateKdfParams(params) {
  const ok =
    params &&
    params.alg === KDF_ALG &&
    Number.isInteger(params.ops) &&
    Number.isInteger(params.mem) &&
    params.ops >= KDF_LIMITS.minOps &&
    params.ops <= KDF_LIMITS.maxOps &&
    params.mem >= KDF_LIMITS.minMem &&
    params.mem <= KDF_LIMITS.maxMem;
  if (!ok) throw new VaultCryptoError("Unsupported key-derivation parameters");
  return params;
}

export async function deriveMasterKey(password, salt, params = DEFAULT_KDF) {
  const sodium = await getSodium();
  validateKdfParams(params);
  if (typeof password !== "string" || password.length === 0) throw new VaultCryptoError("A password is required");
  if (!(salt instanceof Uint8Array) || salt.length !== SALT_BYTES) throw new VaultCryptoError("Invalid salt");
  return sodium.crypto_pwhash(32, utf8(password.normalize("NFKC")), salt, params.ops, params.mem, sodium.crypto_pwhash_ALG_ARGON2ID13);
}

export async function deriveSubkey(key, context, id = 1) {
  const sodium = await getSodium();
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new VaultCryptoError("Invalid key");
  if (typeof context !== "string" || context.length !== 8) throw new VaultCryptoError("Invalid KDF context");
  return sodium.crypto_kdf_derive_from_key(32, id, context, key);
}

// A master password must be long enough to be worth stretching. (A strength meter in the UI adds guidance; this is the floor.)
export function checkMasterPassword(password) {
  if (typeof password !== "string") return { ok: false, reason: "A master password is required." };
  const normalised = password.normalize("NFKC");
  if (normalised.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  if (new Set(normalised).size < 5) return { ok: false, reason: "Use a password with more variety." };
  return { ok: true };
}
