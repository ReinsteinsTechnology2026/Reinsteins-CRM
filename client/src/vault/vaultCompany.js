import { fromB64 } from "./encoding.js";
import { draftToPayloads } from "./itemModel.js";

// ==========================================
// ZIOVAULT -- company collections and sharing, on top of the personal-vault session
//
// Same rules as the rest of the vault: every key is wrapped/opened in this tab with the Stage 1 crypto, the server receives only
// ciphertext and envelopes, and there is no administrator key. A collection's keys are held by its MEMBERS only (each wrapped to that
// member's public key); a person is added to a collection, or an item is shared, by a browser that already holds the keys, using the
// recipient's PUBLIC key from the directory. Anything the server would refuse (a right that does not exist) is also not offered by the
// screens, but the server is the one that decides.
// ==========================================

export const COLLECTION_LIMITS = Object.freeze({ NAME: 100, DESCRIPTION: 500 });
export const COLLECTION_KINDS = Object.freeze([
  { id: "general", label: "General" },
  { id: "department", label: "Department" },
  { id: "project", label: "Project" },
]);

// What a share or membership can contain (copy and edit need reveal; manage includes everything).
export function normalizeRights(input = {}, { allowManager = false } = {}) {
  const manager = allowManager && Boolean(input.manager);
  const edit = manager || Boolean(input.edit);
  const reveal = manager || edit || Boolean(input.reveal) || Boolean(input.copy);
  return { reveal, copy: reveal && Boolean(input.copy || manager), edit, share: manager || Boolean(input.share), ...(allowManager ? { manager } : {}) };
}

export function describeRights(rights = {}) {
  const parts = ["View details"];
  if (rights.reveal) parts.push("Reveal password");
  if (rights.copy) parts.push("Copy password");
  if (rights.edit) parts.push("Edit");
  if (rights.share || rights.manage || rights.manager) parts.push("Manage access");
  return parts;
}

export function createCompanyActions(ctx) {
  const { api, vault, scope, guard, requireOpen, uuid, collectionKeys } = ctx;
  let directoryCache = null;

  const reset = () => {
    for (const entry of collectionKeys.values()) {
      if (entry.keys.metaKey) vault.lockSession({ vaultKey: entry.keys.metaKey });
      if (entry.keys.secretKey) vault.lockSession({ vaultKey: entry.keys.secretKey });
    }
    collectionKeys.clear();
    directoryCache = null;
  };

  const clean = (value, max, label, { required = false } = {}) => {
    const text = String(value || "").trim();
    if (required && !text) throw ctx.userError(`Give the ${label} a name.`);
    if (text.length > max) throw ctx.userError(`Keep the ${label} under ${max} characters.`);
    return text;
  };

  // ---------------------------------------------------------------- the people a vault item or collection can be shared with
  async function loadDirectory({ force = false } = {}) {
    requireOpen();
    if (!directoryCache || force) directoryCache = new Map((await guard(() => api.directory())).map((entry) => [entry.userId, entry]));
    return [...directoryCache.values()];
  }

  async function recipient(userId) {
    await loadDirectory();
    const entry = directoryCache.get(Number(userId));
    // Someone without a vault has no public key, so nothing can be encrypted for them: say so instead of failing obscurely.
    if (!entry) throw ctx.userError("That person has not set up their ZioVault yet. Ask them to open ZioVault once, then try again.", "RECIPIENT_NO_VAULT");
    return entry;
  }

  const nameOfUser = (userId) => (directoryCache && directoryCache.get(Number(userId))?.name) || null;

  // ---------------------------------------------------------------- collections
  async function openCollection(row) {
    const keys = row.keys;
    if (!keys || !keys.sender) throw new Error("collection keys missing");
    return vault.openCollectionKeys({
      tenantId: scope().tenantId, collectionUid: row.uid, keyVersion: keys.keyVersion, memberUserId: scope().userId,
      senderPublicKey: fromB64(keys.sender.publicKey), recipientPrivateKey: ctx.getSession().privateKey,
      wrappedMetaKey: fromB64(keys.wrappedMetaKey), wrappedSecretKey: keys.wrappedSecretKey ? fromB64(keys.wrappedSecretKey) : null,
    });
  }

  // The collections this person belongs to, with names/descriptions decrypted and the keys kept in memory only.
  async function loadCollections() {
    const rows = await guard(() => api.listCollections());
    const views = [];
    for (const row of rows) {
      const base = { uid: row.uid, kind: row.kind, keyVersion: row.keyVersion, rotationRequired: row.rotationRequired, rights: row.rights, expiresAt: row.expiresAt, createdAt: row.createdAt, corrupt: false };
      try {
        const keys = await openCollection(row);
        collectionKeys.set(row.uid, { keys, keyVersion: row.keyVersion });
        const info = await vault.decryptCollectionInfo({ tenantId: scope().tenantId, collectionUid: row.uid, key: keys.metaKey, envelope: fromB64(row.name) });
        views.push({ ...base, name: String(info.name || "").slice(0, COLLECTION_LIMITS.NAME) || "Collection", description: String(info.description || "").slice(0, COLLECTION_LIMITS.DESCRIPTION) });
      } catch {
        views.push({ ...base, name: "Unreadable collection", description: "", corrupt: true });
      }
    }
    return views;
  }

  const keysOfCollection = (uid) => {
    const entry = collectionKeys.get(uid);
    if (!entry) throw ctx.userError("That collection is not available.", "NOT_FOUND");
    return entry;
  };

  async function createCollection({ name, description = "", kind = "general" }) {
    requireOpen();
    const text = clean(name, COLLECTION_LIMITS.NAME, "collection", { required: true });
    const about = clean(description, COLLECTION_LIMITS.DESCRIPTION, "description");
    if (!COLLECTION_KINDS.some((k) => k.id === kind)) throw ctx.userError("Choose a collection type.");
    const uid = uuid();
    const keys = await vault.newCollectionKeys();
    try {
      const envelope = await vault.encryptCollectionName({ tenantId: scope().tenantId, collectionUid: uid, key: keys.metaKey, name: text, description: about });
      const session = ctx.getSession();
      const sealed = await vault.sealCollectionKeysForMember({
        tenantId: scope().tenantId, collectionUid: uid, keyVersion: 1, memberUserId: scope().userId, memberPublicKey: session.publicKey, senderPrivateKey: session.privateKey, keys, include: { meta: true, secret: true },
      });
      await guard(() => api.createCollection({ uid, kind, name: envelope, keys: { meta: sealed.wrappedMetaKey, secret: sealed.wrappedSecretKey } }));
    } finally {
      vault.lockSession({ vaultKey: keys.metaKey });
      vault.lockSession({ vaultKey: keys.secretKey });
    }
    await ctx.reload();
    return uid;
  }

  async function renameCollection(uid, { name, description = "" }) {
    requireOpen();
    const text = clean(name, COLLECTION_LIMITS.NAME, "collection", { required: true });
    const about = clean(description, COLLECTION_LIMITS.DESCRIPTION, "description");
    const { keys } = keysOfCollection(uid);
    const envelope = await vault.encryptCollectionName({ tenantId: scope().tenantId, collectionUid: uid, key: keys.metaKey, name: text, description: about });
    await guard(() => api.renameCollection(uid, envelope));
    await ctx.reload();
  }

  async function archiveCollection(uid) {
    requireOpen();
    await guard(() => api.archiveCollection(uid));
    await ctx.reload();
  }

  // Members (the server only lists them to a manager).
  async function collectionDetail(uid) {
    requireOpen();
    await loadDirectory().catch(() => []);
    const detail = await guard(() => api.getCollection(uid));
    return { members: detail.members || [], rotationRequired: detail.rotationRequired, rights: detail.rights };
  }

  async function sealForMember(uid, entry, rights) {
    const { keys, keyVersion } = keysOfCollection(uid);
    const wantsSecret = Boolean(rights.reveal);
    if (wantsSecret && !keys.secretKey) throw ctx.userError("You do not hold the keys needed to give that access.", "NO_KEY");
    return vault.sealCollectionKeysForMember({
      tenantId: scope().tenantId, collectionUid: uid, keyVersion, memberUserId: entry.userId, memberPublicKey: fromB64(entry.publicKey),
      senderPrivateKey: ctx.getSession().privateKey, keys, include: { meta: true, secret: wantsSecret },
    });
  }

  async function addMember(uid, { userId, rights, expiresAt = null }) {
    requireOpen();
    const entry = await recipient(userId);
    const wanted = normalizeRights(rights, { allowManager: true });
    const sealed = await sealForMember(uid, entry, wanted);
    await guard(() => api.addMember(uid, { userId: entry.userId, rights: wanted, expiresAt, wrappedMetaKey: sealed.wrappedMetaKey, wrappedSecretKey: sealed.wrappedSecretKey }));
    return entry.userId;
  }

  async function updateMember(uid, userId, { rights, expiresAt }) {
    requireOpen();
    const wanted = rights ? normalizeRights(rights, { allowManager: true }) : undefined;
    let wrappedSecretKey;
    if (wanted && wanted.reveal) {
      const detail = await guard(() => api.getCollection(uid));
      const current = (detail.members || []).find((m) => m.userId === Number(userId));
      if (current && !current.rights.reveal) wrappedSecretKey = (await sealForMember(uid, await recipient(userId), wanted)).wrappedSecretKey; // gaining reveal needs a NEW envelope
    }
    return guard(() => api.updateMember(uid, userId, { rights: wanted, expiresAt, wrappedSecretKey }));
  }

  async function removeMember(uid, userId) {
    requireOpen();
    return guard(() => api.removeMember(uid, userId));
  }

  async function createCompanyItem(collectionUid, draft) {
    requireOpen();
    const payloads = draftToPayloads({ ...draft, folderUid: null });
    const { keys: collection } = keysOfCollection(collectionUid);
    if (!collection.secretKey) throw ctx.userError("You do not have permission to add items to this collection.", "FORBIDDEN");
    const uid = uuid();
    const keys = await vault.newItemKeys();
    const sealed = await vault.encryptItem({ tenantId: scope().tenantId, itemUid: uid, keyVersion: 1, keys, meta: payloads.meta, secret: payloads.secret });
    const wrapped = await vault.wrapItemKeysForCollection({ tenantId: scope().tenantId, collectionUid, itemUid: uid, itemKeyVersion: 1, collectionKeys: collection, itemKeys: keys });
    await guard(() => api.createCompanyItem(collectionUid, { uid, kind: payloads.kind, meta: sealed.metaCiphertext, secret: sealed.secretCiphertext, keys: { meta: wrapped.meta, secret: wrapped.secret } }));
    vault.lockSession({ vaultKey: keys.metaKey });
    if (keys.secretKey) vault.lockSession({ vaultKey: keys.secretKey });
    await ctx.reload();
    return uid;
  }

  // ---------------------------------------------------------------- sharing one item
  async function shareItem(uid, { recipientUserId, rights, expiresAt = null }) {
    requireOpen();
    const entry = await recipient(recipientUserId);
    const wanted = normalizeRights(rights);
    // Only the keys that match the rights leave this tab: details-only means the SECRET KEY is never wrapped for that person.
    const { item, keys } = await ctx.openForEdit(uid, { withSecret: wanted.reveal });
    try {
      const boxes = await vault.wrapItemKeysForRecipient({
        tenantId: scope().tenantId, itemUid: uid, keyVersion: item.keyVersion, recipientUserId: entry.userId, recipientPublicKey: fromB64(entry.publicKey),
        senderPrivateKey: ctx.getSession().privateKey, keys, include: { meta: true, secret: wanted.reveal },
      });
      await guard(() => api.createGrant(uid, { recipientUserId: entry.userId, rights: wanted, expiresAt, boxedMetaKey: boxes.boxedMetaKey, boxedSecretKey: boxes.boxedSecretKey }));
    } finally {
      ctx.wipeKeys(keys);
    }
    return entry.userId;
  }

  const listGrants = async (uid) => {
    requireOpen();
    return guard(() => api.listGrants(uid));
  };

  async function updateGrant(uid, userId, { rights, expiresAt }) {
    requireOpen();
    const wanted = rights ? normalizeRights(rights) : undefined;
    let boxedSecretKey;
    if (wanted && wanted.reveal) {
      const current = (await guard(() => api.listGrants(uid))).find((g) => g.recipientUserId === Number(userId));
      if (current && !current.rights.reveal) {
        const entry = await recipient(userId);
        const { item, keys } = await ctx.openForEdit(uid, { withSecret: true });
        try {
          boxedSecretKey = (await vault.wrapItemKeysForRecipient({
            tenantId: scope().tenantId, itemUid: uid, keyVersion: item.keyVersion, recipientUserId: entry.userId, recipientPublicKey: fromB64(entry.publicKey),
            senderPrivateKey: ctx.getSession().privateKey, keys, include: { meta: false, secret: true },
          })).boxedSecretKey;
        } finally {
          ctx.wipeKeys(keys);
        }
      }
    }
    return guard(() => api.updateGrant(uid, userId, { rights: wanted, expiresAt, boxedSecretKey }));
  }

  const revokeGrant = async (uid, userId) => {
    requireOpen();
    return guard(() => api.revokeGrant(uid, userId));
  };

  // What this person has shared, joined (locally) with the titles of the items they can still open.
  async function loadOutgoing() {
    requireOpen();
    await loadDirectory().catch(() => []);
    const rows = await guard(() => api.outgoingShares());
    const titles = new Map([...ctx.getState().items, ...ctx.getState().companyItems, ...ctx.getState().sharedItems].map((i) => [i.uid, i.title]));
    const outgoing = rows.map((r) => ({ ...r, title: titles.get(r.itemUid) || "Item you can no longer open" }));
    ctx.set({ outgoing });
    return outgoing;
  }

  return {
    reset, loadCollections, nameOfUser, loadDirectory, createCollection, renameCollection, archiveCollection, collectionDetail, addMember, updateMember, removeMember,
    createCompanyItem, shareItem, listGrants, updateGrant, revokeGrant, loadOutgoing,
  };
}
