import { getSodium } from "./sodium.js";
import { VaultCryptoError } from "./aead.js";
import { deriveSubkey, KDF_CONTEXTS } from "./kdf.js";

// ==========================================
// ZIOVAULT -- recovery secret
//
// 256 random bits (libsodium CSPRNG), shown to the user ONCE as 14 groups of 4 Crockford Base32 characters:
// 52 characters of secret (260 bits, the last 4 padding bits are zero) + 4 characters of checksum
// (first 20 bits of BLAKE2b-128 over the secret) so a mistyped character is caught before any decryption.
// The recovery key-encryption key is derived from the 32 bytes (no stretching needed: it is not a human-chosen password).
// ==========================================

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I, L, O, U
const SECRET_BYTES = 32;

function encodeBase32(bytes, chars) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.slice(0, chars);
}

function decodeBase32(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function checksum(secretBytes) {
  const sodium = await getSodium();
  return encodeBase32(sodium.crypto_generichash(16, secretBytes), 4);
}

export async function generateRecoverySecret() {
  const sodium = await getSodium();
  const bytes = sodium.randombytes_buf(SECRET_BYTES);
  const body = encodeBase32(bytes, 52);
  const text = `${body}${await checksum(bytes)}`.match(/.{4}/g).join("-");
  return { bytes, text };
}

// "abcd-..." typed by a person -> the 32 secret bytes. Tolerates case, spaces, dashes and the usual O/0, I/L/1 mix-ups.
export async function parseRecoverySecret(text) {
  const cleaned = String(text || "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (cleaned.length !== 56) throw new VaultCryptoError("The recovery key is not complete.");
  const bytes = decodeBase32(cleaned.slice(0, 52));
  if (!bytes || bytes.length < SECRET_BYTES) throw new VaultCryptoError("The recovery key contains invalid characters.");
  const secret = bytes.slice(0, SECRET_BYTES);
  if (encodeBase32(secret, 52) !== cleaned.slice(0, 52)) throw new VaultCryptoError("The recovery key is not valid.");
  if ((await checksum(secret)) !== cleaned.slice(52)) throw new VaultCryptoError("The recovery key has a typing mistake.");
  return secret;
}

export async function recoveryKekFromSecret(secretBytes) {
  return deriveSubkey(secretBytes, KDF_CONTEXTS.recovery);
}
