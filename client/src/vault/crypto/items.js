import { randomKey, encryptJson, decryptJson, wrapKey, unwrapKey } from "./aead.js";
import { sealKeyForRecipient, openKeyFromSender } from "./boxes.js";

// ==========================================
// ZIOVAULT -- item encryption
//
// An item has TWO random keys, on purpose:
//   metaKey   -> the details one may see without the secret (title, URL, username, folder, ...)
//   secretKey -> the secret (password, notes, API key, custom secret fields)
// so "may see the username" and "may reveal the password" are different keys, not just different UI flags.
//
// Both are random per item (never derived from anything), and are stored only WRAPPED:
//   personal item   : wrapped under the owner's vault key (AEAD)
//   shared with you : wrapped to your public key by the sharer (authenticated box)
//   collection item : wrapped under the collection's keys (AEAD)
//
// Identity binding: tenantId + itemUid + keyVersion go into every AAD. `keyVersion` rises on every key rotation, so a
// ciphertext from before a rotation cannot be presented as current.
// ==========================================

export async function newItemKeys() {
  return { metaKey: await randomKey(), secretKey: await randomKey() };
}

export async function encryptItem({ tenantId, itemUid, keyVersion = 1, keys, meta, secret }) {
  const ids = [tenantId, itemUid, keyVersion];
  return {
    metaCiphertext: await encryptJson(keys.metaKey, meta, "item-meta", ids),
    secretCiphertext: secret === undefined ? null : await encryptJson(keys.secretKey, secret, "item-secret", ids),
  };
}

export const decryptItemMeta = ({ tenantId, itemUid, keyVersion = 1, metaKey, metaCiphertext }) =>
  decryptJson(metaKey, metaCiphertext, "item-meta", [tenantId, itemUid, keyVersion]);

export const decryptItemSecret = ({ tenantId, itemUid, keyVersion = 1, secretKey, secretCiphertext }) =>
  decryptJson(secretKey, secretCiphertext, "item-secret", [tenantId, itemUid, keyVersion]);

// ---- wrapping for the owner (personal vault)

export async function wrapItemKeysForOwner({ tenantId, itemUid, keyVersion = 1, ownerUserId, vaultKey, keys }) {
  const ids = [tenantId, itemUid, keyVersion, ownerUserId];
  return {
    wrappedMetaKey: await wrapKey(vaultKey, keys.metaKey, "item-meta-key", ids),
    wrappedSecretKey: await wrapKey(vaultKey, keys.secretKey, "item-secret-key", ids),
  };
}

export async function unwrapItemKeysForOwner({ tenantId, itemUid, keyVersion = 1, ownerUserId, vaultKey, wrappedMetaKey, wrappedSecretKey }) {
  const ids = [tenantId, itemUid, keyVersion, ownerUserId];
  return {
    metaKey: wrappedMetaKey ? await unwrapKey(vaultKey, wrappedMetaKey, "item-meta-key", ids) : null,
    secretKey: wrappedSecretKey ? await unwrapKey(vaultKey, wrappedSecretKey, "item-secret-key", ids) : null,
  };
}

// ---- wrapping for another person (sharing). `include` decides which keys leave: a viewer gets the meta key only.

export async function wrapItemKeysForRecipient({ tenantId, itemUid, keyVersion = 1, recipientUserId, recipientPublicKey, senderPrivateKey, keys, include = { meta: true, secret: false } }) {
  const ids = [tenantId, itemUid, keyVersion, recipientUserId];
  const out = { boxedMetaKey: null, boxedSecretKey: null };
  if (include.meta) out.boxedMetaKey = await sealKeyForRecipient({ key: keys.metaKey, purpose: "box-item-meta-key", ids, recipientPublicKey, senderPrivateKey });
  if (include.secret) out.boxedSecretKey = await sealKeyForRecipient({ key: keys.secretKey, purpose: "box-item-secret-key", ids, recipientPublicKey, senderPrivateKey });
  return out;
}

export async function openItemKeysFromSender({ tenantId, itemUid, keyVersion = 1, recipientUserId, senderPublicKey, recipientPrivateKey, boxedMetaKey, boxedSecretKey }) {
  const ids = [tenantId, itemUid, keyVersion, recipientUserId];
  return {
    metaKey: boxedMetaKey ? await openKeyFromSender({ envelope: boxedMetaKey, purpose: "box-item-meta-key", ids, senderPublicKey, recipientPrivateKey }) : null,
    secretKey: boxedSecretKey ? await openKeyFromSender({ envelope: boxedSecretKey, purpose: "box-item-secret-key", ids, senderPublicKey, recipientPrivateKey }) : null,
  };
}

// Rotation (after a revocation, or on demand): brand-new keys, everything re-encrypted, a higher keyVersion.
export async function rotateItem({ tenantId, itemUid, keyVersion, meta, secret }) {
  const keys = await newItemKeys();
  const next = keyVersion + 1;
  return { keys, keyVersion: next, ...(await encryptItem({ tenantId, itemUid, keyVersion: next, keys, meta, secret })) };
}
