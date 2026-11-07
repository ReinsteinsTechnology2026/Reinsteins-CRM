import { getSodium } from "./sodium.js";
import { VaultCryptoError, randomKey, encryptJson, decryptJson, wrapKey, unwrapKey } from "./aead.js";
import { buildAad } from "./aad.js";

// ==========================================
// ZIOVAULT -- encrypted attachments
//
// The browser encrypts the file BEFORE it is uploaded; the server only ever stores the ciphertext.
//   fileKey  : 32 random bytes per attachment, wrapped under the item's secretKey (so exactly the people who may reveal the
//              item may open its files, and revoking/rotating the item rotates what protects them)
//   content  : crypto_secretstream_xchacha20poly1305 in 64 KiB frames, the final frame carries TAG_FINAL.
//              Layout: [ header (24) | frame ... ]; a frame is (<=64 KiB of plaintext + 17 bytes).
//              Truncation, reordering, duplication, or appended data all fail.
//   metadata : name / type / size are encrypted separately (AEAD under the fileKey).
// The AAD of every frame binds tenant, item and attachment ids.
// ==========================================

export const FRAME_BYTES = 64 * 1024;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // enforced again by the server
const ABYTES = 17; // crypto_secretstream_xchacha20poly1305_ABYTES
const HEADER_BYTES = 24;

const ids = (tenantId, itemUid, attachmentUid) => [tenantId, itemUid, attachmentUid];

export async function newAttachmentKey() {
  return randomKey();
}

export const wrapAttachmentKey = ({ itemSecretKey, fileKey, tenantId, itemUid, attachmentUid }) =>
  wrapKey(itemSecretKey, fileKey, "attachment-key", ids(tenantId, itemUid, attachmentUid));

export const unwrapAttachmentKey = ({ itemSecretKey, wrappedFileKey, tenantId, itemUid, attachmentUid }) =>
  unwrapKey(itemSecretKey, wrappedFileKey, "attachment-key", ids(tenantId, itemUid, attachmentUid));

export const encryptAttachmentMeta = ({ fileKey, meta, tenantId, itemUid, attachmentUid }) =>
  encryptJson(fileKey, meta, "attachment-meta", ids(tenantId, itemUid, attachmentUid));

export const decryptAttachmentMeta = ({ fileKey, metaCiphertext, tenantId, itemUid, attachmentUid }) =>
  decryptJson(fileKey, metaCiphertext, "attachment-meta", ids(tenantId, itemUid, attachmentUid));

export async function encryptAttachmentContent({ fileKey, bytes, tenantId, itemUid, attachmentUid }) {
  const sodium = await getSodium();
  if (!(bytes instanceof Uint8Array)) throw new VaultCryptoError("Invalid file");
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new VaultCryptoError("The file is too large");
  const ad = buildAad("attachment-content", ids(tenantId, itemUid, attachmentUid));
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(fileKey);
  const frames = Math.max(1, Math.ceil(bytes.length / FRAME_BYTES));
  const out = new Uint8Array(HEADER_BYTES + bytes.length + frames * ABYTES);
  out.set(header, 0);
  let offset = HEADER_BYTES;
  for (let index = 0; index < frames; index += 1) {
    const chunk = bytes.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES);
    const last = index === frames - 1;
    const tag = last ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    const sealed = sodium.crypto_secretstream_xchacha20poly1305_push(state, chunk, ad, tag);
    out.set(sealed, offset);
    offset += sealed.length;
  }
  return out;
}

export async function decryptAttachmentContent({ fileKey, ciphertext, tenantId, itemUid, attachmentUid }) {
  const sodium = await getSodium();
  if (!(ciphertext instanceof Uint8Array) || ciphertext.length < HEADER_BYTES + ABYTES) throw new VaultCryptoError();
  const ad = buildAad("attachment-content", ids(tenantId, itemUid, attachmentUid));
  let state;
  try {
    state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(ciphertext.subarray(0, HEADER_BYTES), fileKey);
  } catch {
    throw new VaultCryptoError();
  }
  const parts = [];
  let total = 0;
  let offset = HEADER_BYTES;
  let sawFinal = false;
  while (offset < ciphertext.length) {
    if (sawFinal) throw new VaultCryptoError(); // data after the final frame
    const end = Math.min(offset + FRAME_BYTES + ABYTES, ciphertext.length);
    let result;
    try {
      result = sodium.crypto_secretstream_xchacha20poly1305_pull(state, ciphertext.subarray(offset, end), ad);
    } catch {
      throw new VaultCryptoError();
    }
    if (!result) throw new VaultCryptoError();
    parts.push(result.message);
    total += result.message.length;
    sawFinal = result.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
    offset = end;
  }
  if (!sawFinal) throw new VaultCryptoError(); // truncated
  const out = new Uint8Array(total);
  let position = 0;
  for (const part of parts) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}
