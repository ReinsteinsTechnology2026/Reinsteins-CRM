import { randomKey, encryptJson, decryptJson, wrapKey, unwrapKey } from "./aead.js";
import { sealKeyForRecipient, openKeyFromSender } from "./boxes.js";

// ==========================================
// ZIOVAULT -- company collections
//
// A collection has two random keys, mirroring an item (see items.js): metaKey (see the names/details of its items) and secretKey
// (reveal their secrets). They are wrapped to each MEMBER with an authenticated public-key box, so only a member who holds them can
// add another member -- there is no administrator key. An item inside a collection keeps its own two keys, wrapped (AEAD) under the
// collection's keys. Leaving/removal means ROTATION: new collection keys, new item keys, everything re-encrypted (rotateItem in
// items.js produces the new item material; the manager's browser re-wraps it all in one request).
// ==========================================

export async function newCollectionKeys() {
  return { metaKey: await randomKey(), secretKey: await randomKey() };
}

export const encryptCollectionName = ({ tenantId, collectionUid, key, name }) => encryptJson(key, { name }, "collection-name", [tenantId, collectionUid]);

export const decryptCollectionName = async ({ tenantId, collectionUid, key, envelope }) => (await decryptJson(key, envelope, "collection-name", [tenantId, collectionUid])).name;

// Give one member the collection keys. `include.secret = false` makes a "can see item details, cannot reveal secrets" member.
export async function sealCollectionKeysForMember({ tenantId, collectionUid, keyVersion = 1, memberUserId, memberPublicKey, senderPrivateKey, keys, include = { meta: true, secret: false } }) {
  const ids = [tenantId, collectionUid, keyVersion, memberUserId];
  return {
    wrappedMetaKey: include.meta ? await sealKeyForRecipient({ key: keys.metaKey, purpose: "box-collection-meta-key", ids, recipientPublicKey: memberPublicKey, senderPrivateKey }) : null,
    wrappedSecretKey: include.secret ? await sealKeyForRecipient({ key: keys.secretKey, purpose: "box-collection-secret-key", ids, recipientPublicKey: memberPublicKey, senderPrivateKey }) : null,
  };
}

export async function openCollectionKeys({ tenantId, collectionUid, keyVersion = 1, memberUserId, senderPublicKey, recipientPrivateKey, wrappedMetaKey, wrappedSecretKey }) {
  const ids = [tenantId, collectionUid, keyVersion, memberUserId];
  return {
    metaKey: wrappedMetaKey ? await openKeyFromSender({ envelope: wrappedMetaKey, purpose: "box-collection-meta-key", ids, senderPublicKey, recipientPrivateKey }) : null,
    secretKey: wrappedSecretKey ? await openKeyFromSender({ envelope: wrappedSecretKey, purpose: "box-collection-secret-key", ids, senderPublicKey, recipientPrivateKey }) : null,
  };
}

// An item's keys, wrapped under the collection's keys (what the server stores as the item's "collection" key rows).
export async function wrapItemKeysForCollection({ tenantId, collectionUid, itemUid, itemKeyVersion = 1, collectionKeys, itemKeys }) {
  const ids = [tenantId, collectionUid, itemUid, itemKeyVersion];
  return {
    meta: await wrapKey(collectionKeys.metaKey, itemKeys.metaKey, "collection-item-meta-key", ids),
    secret: itemKeys.secretKey ? await wrapKey(collectionKeys.secretKey, itemKeys.secretKey, "collection-item-secret-key", ids) : null,
  };
}

export async function unwrapItemKeysFromCollection({ tenantId, collectionUid, itemUid, itemKeyVersion = 1, collectionKeys, wrapped }) {
  const ids = [tenantId, collectionUid, itemUid, itemKeyVersion];
  return {
    metaKey: wrapped.meta && collectionKeys.metaKey ? await unwrapKey(collectionKeys.metaKey, wrapped.meta, "collection-item-meta-key", ids) : null,
    secretKey: wrapped.secret && collectionKeys.secretKey ? await unwrapKey(collectionKeys.secretKey, wrapped.secret, "collection-item-secret-key", ids) : null,
  };
}
