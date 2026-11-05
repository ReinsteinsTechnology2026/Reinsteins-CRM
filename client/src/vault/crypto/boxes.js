import { getSodium } from "./sodium.js";
import { VaultCryptoError, NONCE_BYTES, ENVELOPE_VERSION } from "./aead.js";
import { FORMAT, PURPOSES, equalBytes, frameFields, unframeFields, utf8 } from "./aad.js";

// ==========================================
// ZIOVAULT -- sharing a key with another person (authenticated public-key encryption)
//
// crypto_box_easy = X25519 key agreement + XSalsa20-Poly1305. Unlike an anonymous "sealed box" it is AUTHENTICATED: it only
// opens with the SENDER's public key, so a recipient knows which key wrapped the secret (and a stranger cannot forge one).
// crypto_box has no associated-data input, so the context is placed INSIDE the plaintext and checked after decryption:
//     plaintext = frame( "ziovault/v1", purpose, ...ids ) || key (32 bytes)
// A box produced for one purpose/item/tenant therefore cannot be opened as another.
//
// Envelope layout: [ version (1) | nonce (24) | box ]
// ==========================================

const PURPOSE_SET = new Set(PURPOSES);

export async function generateKeyPair() {
  const sodium = await getSodium();
  const pair = sodium.crypto_box_keypair();
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

export async function publicKeyFromPrivate(privateKey) {
  const sodium = await getSodium();
  return sodium.crypto_scalarmult_base(privateKey);
}

export async function sealKeyForRecipient({ key, purpose, ids, recipientPublicKey, senderPrivateKey }) {
  const sodium = await getSodium();
  if (!PURPOSE_SET.has(purpose)) throw new Error(`Unknown ZioVault purpose: ${purpose}`);
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new VaultCryptoError("Invalid key");
  const header = frameFields([FORMAT, purpose, ...ids.map(String)]);
  const plaintext = new Uint8Array(header.length + key.length);
  plaintext.set(header, 0);
  plaintext.set(key, header.length);
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const box = sodium.crypto_box_easy(plaintext, nonce, recipientPublicKey, senderPrivateKey);
  sodium.memzero(plaintext);
  const out = new Uint8Array(1 + NONCE_BYTES + box.length);
  out[0] = ENVELOPE_VERSION;
  out.set(nonce, 1);
  out.set(box, 1 + NONCE_BYTES);
  return out;
}

export async function openKeyFromSender({ envelope, purpose, ids, senderPublicKey, recipientPrivateKey }) {
  const sodium = await getSodium();
  if (!(envelope instanceof Uint8Array) || envelope.length < 1 + NONCE_BYTES + 16 || envelope[0] !== ENVELOPE_VERSION) {
    throw new VaultCryptoError();
  }
  const nonce = envelope.slice(1, 1 + NONCE_BYTES);
  let plaintext;
  try {
    plaintext = sodium.crypto_box_open_easy(envelope.slice(1 + NONCE_BYTES), nonce, senderPublicKey, recipientPrivateKey);
  } catch {
    throw new VaultCryptoError();
  }
  try {
    const expected = [FORMAT, purpose, ...ids.map(String)];
    const { fields, rest } = unframeFields(plaintext, expected.length);
    const matches = fields.every((field, index) => equalBytes(field, utf8(expected[index])));
    if (!matches || rest.length !== 32) throw new VaultCryptoError();
    return rest;
  } catch {
    throw new VaultCryptoError();
  } finally {
    sodium.memzero(plaintext);
  }
}
