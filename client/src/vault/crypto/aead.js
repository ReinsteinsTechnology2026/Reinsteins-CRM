import { getSodium } from "./sodium.js";
import { buildAad, fromUtf8, utf8 } from "./aad.js";

// ==========================================
// ZIOVAULT -- authenticated symmetric encryption
//
// XChaCha20-Poly1305-IETF (libsodium). Envelope layout:  [ version (1) | nonce (24) | ciphertext + 16-byte tag ]
//  * the 24-byte nonce is fresh random for EVERY call (192 bits: random nonces are safe at this size);
//  * the AAD (aad.js) is authenticated, not stored: the opener must rebuild it from what it knows, so a ciphertext that
//    belongs somewhere else fails;
//  * any failure (wrong key, wrong AAD, truncated or modified bytes, unknown version) throws one generic error that
//    reveals nothing about which check failed. There is no fallback path.
// ==========================================

export const ENVELOPE_VERSION = 1;
export const KEY_BYTES = 32;
export const NONCE_BYTES = 24;
export const TAG_BYTES = 16;
export const MIN_ENVELOPE_BYTES = 1 + NONCE_BYTES + TAG_BYTES;

export class VaultCryptoError extends Error {
  constructor(message = "Decryption failed") {
    super(message);
    this.name = "VaultCryptoError";
  }
}

function assertKey(key) {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) throw new VaultCryptoError("Invalid key");
}

export async function randomKey() {
  const sodium = await getSodium();
  return sodium.randombytes_buf(KEY_BYTES);
}

export async function randomBytes(length) {
  const sodium = await getSodium();
  return sodium.randombytes_buf(length);
}

export async function encryptBytes(key, plaintext, aad) {
  const sodium = await getSodium();
  assertKey(key);
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const sealed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key);
  const out = new Uint8Array(1 + NONCE_BYTES + sealed.length);
  out[0] = ENVELOPE_VERSION;
  out.set(nonce, 1);
  out.set(sealed, 1 + NONCE_BYTES);
  return out;
}

export async function decryptBytes(key, envelope, aad) {
  const sodium = await getSodium();
  assertKey(key);
  if (!(envelope instanceof Uint8Array) || envelope.length < MIN_ENVELOPE_BYTES || envelope[0] !== ENVELOPE_VERSION) {
    throw new VaultCryptoError();
  }
  const nonce = envelope.slice(1, 1 + NONCE_BYTES);
  const sealed = envelope.slice(1 + NONCE_BYTES);
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, sealed, aad, nonce, key);
  } catch {
    throw new VaultCryptoError();
  }
}

// Convenience: seal/open a JSON document under (purpose, ids).
export async function encryptJson(key, value, purpose, ids) {
  return encryptBytes(key, utf8(JSON.stringify(value)), buildAad(purpose, ids));
}

export async function decryptJson(key, envelope, purpose, ids) {
  const bytes = await decryptBytes(key, envelope, buildAad(purpose, ids));
  try {
    return JSON.parse(fromUtf8(bytes));
  } catch {
    throw new VaultCryptoError();
  }
}

// Wrap / unwrap a 32-byte key under another key (same AEAD, key material as the plaintext).
export async function wrapKey(wrappingKey, keyToWrap, purpose, ids) {
  assertKey(keyToWrap);
  return encryptBytes(wrappingKey, keyToWrap, buildAad(purpose, ids));
}

export async function unwrapKey(wrappingKey, envelope, purpose, ids) {
  const key = await decryptBytes(wrappingKey, envelope, buildAad(purpose, ids));
  assertKey(key);
  return key;
}
