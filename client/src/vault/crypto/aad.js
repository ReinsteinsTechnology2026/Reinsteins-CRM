// ==========================================
// ZIOVAULT -- associated data (AAD) and payload framing
//
// Every authenticated-encryption call binds an AAD built here: a length-prefixed (4-byte big-endian) encoding of
// "ziovault/v1", the purpose label, and the identifiers the ciphertext belongs to (tenant, user, item, key version...).
// A ciphertext copied to another tenant, user, item or purpose therefore fails authentication.
// Length prefixes make the encoding unambiguous: ("ab","c") can never equal ("a","bc").
// ==========================================

export const FORMAT = "ziovault/v1";

// Every legal purpose. An unknown purpose is a programming error and is rejected, never encrypted under.
export const PURPOSES = Object.freeze([
  "vault-key",
  "private-key",
  "recovery-vault-key",
  "item-meta",
  "item-secret",
  "item-meta-key",
  "item-secret-key",
  "folder-name",
  "collection-name",
  "collection-meta-key",
  "collection-secret-key",
  "collection-item-meta-key",
  "collection-item-secret-key",
  "attachment-key",
  "attachment-meta",
  "attachment-content",
  "box-item-meta-key",
  "box-item-secret-key",
  "box-collection-meta-key",
  "box-collection-secret-key",
]);
const PURPOSE_SET = new Set(PURPOSES);

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(text) {
  return encoder.encode(String(text));
}
export function fromUtf8(bytes) {
  return decoder.decode(bytes);
}

function u32(length) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, length, false);
  return out;
}

// Concatenate fields with 4-byte length prefixes.
export function frameFields(fields) {
  const parts = [];
  let total = 0;
  for (const field of fields) {
    const bytes = field instanceof Uint8Array ? field : utf8(field);
    parts.push(u32(bytes.length), bytes);
    total += 4 + bytes.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// Inverse of frameFields for exactly `count` fields; returns { fields: Uint8Array[], rest: Uint8Array }.
export function unframeFields(bytes, count) {
  const fields = [];
  let offset = 0;
  for (let i = 0; i < count; i += 1) {
    if (offset + 4 > bytes.length) throw new Error("Malformed ZioVault payload");
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
    offset += 4;
    if (length > bytes.length - offset) throw new Error("Malformed ZioVault payload");
    fields.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  return { fields, rest: bytes.slice(offset) };
}

function identifier(value) {
  const text = String(value);
  if (text.length === 0) throw new Error("ZioVault identifier must not be empty");
  return text;
}

export function buildAad(purpose, ids = []) {
  if (!PURPOSE_SET.has(purpose)) throw new Error(`Unknown ZioVault purpose: ${purpose}`);
  return frameFields([FORMAT, purpose, ...ids.map(identifier)]);
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}
