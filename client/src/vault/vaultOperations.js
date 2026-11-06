import { fromB64, toB64 } from "./encoding.js";
import { validateAttachment, sanitizeFileName } from "./attachmentModel.js";

// ==========================================
// ZIOVAULT -- attachments, rotation, company activity, offboarding and collection re-keying, on top of the vault session
//
// Same rules as everywhere: every key is made and opened in this tab with the Stage 1 crypto; the server receives ciphertext and
// envelopes; there is no administrator key. Errors are worded for people and never contain a key or a secret.
// ==========================================

const isNetworkError = (error) => Boolean(error) && error.code === "NETWORK";
const MAX_REKEY_BYTES = 15 * 1000 * 1000; // the server accepts 16 MB for this one request

export function createOperations(ctx) {
  const { api, vault, scope, guard, requireOpen, uuid, company, collectionKeys } = ctx;

  // ---------------------------------------------------------------- attachments
  // List an item's files. Size and date need no key. Names are encrypted under each file's own key, which is wrapped under the item's SECRET
  // key, so showing names means opening the item's keys (a recorded delivery, like Reveal): only when asked.
  async function listAttachments(itemUid, { withNames = false } = {}) {
    requireOpen();
    const list = await guard(() => api.listItemAttachments(itemUid));
    const plain = list.map((a) => ({ uid: a.uid, size: a.size, createdAt: a.createdAt, name: null, damaged: false }));
    if (!withNames || list.length === 0) return plain;
    const { keys } = await ctx.openForEdit(itemUid, { withSecret: true });
    try {
      const out = [];
      for (const a of list) {
        if (!a.meta || !keys.secretKey) { out.push({ uid: a.uid, size: a.size, createdAt: a.createdAt, name: null, damaged: false }); continue; }
        try {
          const fileKey = await vault.unwrapAttachmentKey({ itemSecretKey: keys.secretKey, wrappedFileKey: fromB64(a.wrappedFileKey), tenantId: scope().tenantId, itemUid, attachmentUid: a.uid });
          try {
            const meta = await vault.decryptAttachmentMeta({ fileKey, metaCiphertext: fromB64(a.meta), tenantId: scope().tenantId, itemUid, attachmentUid: a.uid });
            out.push({ uid: a.uid, size: a.size, createdAt: a.createdAt, name: sanitizeFileName(meta && meta.name), damaged: false });
          } finally {
            vault.lockSession({ vaultKey: fileKey });
          }
        } catch {
          out.push({ uid: a.uid, size: a.size, createdAt: a.createdAt, name: null, damaged: true });
        }
      }
      return out;
    } finally {
      ctx.wipeKeys(keys);
    }
  }

  // file: { name, type, bytes: Uint8Array }. Validated first, encrypted here, then sent as ciphertext only.
  async function uploadAttachment(itemUid, file) {
    requireOpen();
    const existing = await guard(() => api.listItemAttachments(itemUid));
    const { name } = validateAttachment({ name: file.name, size: file.bytes ? file.bytes.length : 0 }, { existingCount: existing.length, existingBytes: existing.reduce((n, a) => n + a.size, 0) });
    const { keys } = await ctx.openForEdit(itemUid, { withSecret: true });
    if (!keys.secretKey) {
      ctx.wipeKeys(keys);
      throw ctx.userError("You do not have permission to add files to this item.", "FORBIDDEN");
    }
    const attachmentUid = uuid();
    const fileKey = await vault.newAttachmentKey();
    const ids = { tenantId: scope().tenantId, itemUid, attachmentUid };
    try {
      const content = await vault.encryptAttachmentContent({ fileKey, bytes: file.bytes, ...ids });
      const meta = await vault.encryptAttachmentMeta({ fileKey, meta: { v: 1, name, type: String(file.type || "").slice(0, 100), size: file.bytes.length }, ...ids });
      const wrappedFileKey = await vault.wrapAttachmentKey({ itemSecretKey: keys.secretKey, fileKey, ...ids });
      try {
        await guard(() => api.addAttachment(itemUid, { uid: attachmentUid, meta, wrappedFileKey, content }));
      } catch (error) {
        if (!isNetworkError(error)) throw error;
        // the connection dropped: the file may or may not have arrived. Ask, rather than guess.
        const again = await api.listItemAttachments(itemUid).catch(() => null);
        if (again && again.some((a) => a.uid === attachmentUid)) return { uid: attachmentUid, name, size: file.bytes.length, recovered: true };
        throw ctx.userError("The upload was interrupted and nothing was saved. Check your connection and try again.", "UPLOAD_INTERRUPTED");
      }
      return { uid: attachmentUid, name, size: file.bytes.length };
    } finally {
      vault.lockSession({ vaultKey: fileKey });
      ctx.wipeKeys(keys);
    }
  }

  // -> { name, size, bytes }. A file that does not authenticate (changed, truncated, from somewhere else) is reported as damaged, not shown.
  async function downloadAttachment(itemUid, attachmentUid) {
    requireOpen();
    const data = await guard(() => api.downloadAttachment(itemUid, attachmentUid));
    const { keys } = await ctx.openForEdit(itemUid, { withSecret: true });
    const ids = { tenantId: scope().tenantId, itemUid, attachmentUid };
    let fileKey = null;
    try {
      if (!keys.secretKey) throw ctx.userError("You do not have permission to open this file.", "FORBIDDEN");
      fileKey = await vault.unwrapAttachmentKey({ itemSecretKey: keys.secretKey, wrappedFileKey: fromB64(data.wrappedFileKey), ...ids });
      const meta = await vault.decryptAttachmentMeta({ fileKey, metaCiphertext: fromB64(data.meta), ...ids });
      const bytes = await vault.decryptAttachmentContent({ fileKey, ciphertext: fromB64(data.content), ...ids });
      if (!meta || meta.size !== bytes.length) throw new Error("size mismatch");
      return { name: sanitizeFileName(meta.name), size: bytes.length, bytes };
    } catch (error) {
      if (error && error.name === "VaultUserError") throw error;
      throw ctx.userError("This file is damaged or has been changed, so it cannot be opened.", "ATTACHMENT_DAMAGED");
    } finally {
      if (fileKey) vault.lockSession({ vaultKey: fileKey });
      ctx.wipeKeys(keys);
    }
  }

  async function deleteAttachment(itemUid, attachmentUid) {
    requireOpen();
    await guard(() => api.deleteAttachment(itemUid, attachmentUid));
  }

  // Every attachment of every item this person can see (size and date only).
  async function loadAllAttachments() {
    requireOpen();
    const all = await guard(() => api.listAllAttachments());
    ctx.set({ attachments: all });
    return all;
  }

  // ---------------------------------------------------------------- rotation
  async function setRotationSchedule(uid, { intervalDays, dueAt }) {
    requireOpen();
    if (intervalDays !== undefined && intervalDays !== null && !(Number.isInteger(intervalDays) && intervalDays >= 1 && intervalDays <= 3650)) throw ctx.userError("Choose an interval between 1 and 3650 days.");
    if (dueAt !== undefined && dueAt !== null && Number.isNaN(Date.parse(dueAt))) throw ctx.userError("That due date is not valid.");
    const item = await guard(() => api.getItem(uid));
    await guard(() => api.updateItem(uid, { expectedVersion: item.version, rotationIntervalDays: intervalDays, rotationDueAt: dueAt === undefined || dueAt === null ? dueAt : new Date(dueAt).toISOString() }));
    await ctx.reload();
  }

  async function completeRotation(uid) {
    requireOpen();
    await guard(() => api.completeRotation(uid));
    await ctx.reload();
  }

  // ---------------------------------------------------------------- company activity (collection managers)
  async function loadAudit(filters = {}) {
    requireOpen();
    const data = await guard(() => api.companyAudit(filters));
    const state = ctx.getState();
    const titles = new Map([...state.companyItems, ...state.sharedItems, ...state.items].map((i) => [i.uid, i.title]));
    const collections = new Map(state.collections.map((c) => [c.uid, c.name]));
    return {
      nextBefore: data.nextBefore,
      events: data.events.map((e) => ({ ...e, itemTitle: e.itemUid ? titles.get(e.itemUid) || "An item" : null, collectionName: e.collectionUid ? collections.get(e.collectionUid) || "A collection" : null })),
    };
  }

  // ---------------------------------------------------------------- offboarding (administrators): end a person's company vault access
  async function loadOffboardingPeople() {
    requireOpen();
    return guard(() => api.offboardingPeople());
  }

  async function revokeCompanyAccess(userId) {
    requireOpen();
    const result = await guard(() => api.revokeCompanyAccess(userId));
    await ctx.reload();
    return result;
  }

  // ---------------------------------------------------------------- re-keying a collection
  // New collection keys, new keys for every item, everything re-wrapped for the people who remain, in ONE request: the server applies all of
  // it or none of it, so an interruption can never leave the collection half re-keyed. Before sending, every piece is checked here; after,
  // everything is opened again.
  async function rekeyCollection(uid, onProgress = () => {}) {
    requireOpen();
    const state = ctx.getState();
    const view = state.collections.find((c) => c.uid === uid);
    const held = collectionKeys.get(uid);
    if (!view || !view.rights.manage || !held || !held.keys.secretKey) throw ctx.userError("Only a manager of this collection can re-key it.", "FORBIDDEN");
    const items = state.companyItems.filter((i) => i.collectionUid === uid);
    const damaged = items.filter((i) => i.corrupt).length;
    if (damaged > 0) throw ctx.userError(`${damaged} item${damaged === 1 ? " in this collection is" : "s in this collection are"} damaged and cannot be re-encrypted, so re-keying was not started. Nothing was changed.`, "DAMAGED_ITEMS");

    onProgress({ stage: "Checking members", done: 0, total: items.length });
    const detail = await guard(() => api.getCollection(uid));
    const directory = await company.loadDirectory({ force: true });
    const people = new Map(directory.map((u) => [u.userId, u]));
    people.set(scope().userId, { userId: scope().userId, publicKey: toB64(ctx.getSession().publicKey) }); // the directory never lists the person asking: they are a member too
    const members = detail.members || [];
    const unknown = members.filter((m) => !people.has(m.userId));
    if (unknown.length > 0) throw ctx.userError("A member's public key could not be found, so re-keying was not started. Nothing was changed.", "MEMBER_KEY_MISSING");

    const session = ctx.getSession();
    const tenantId = scope().tenantId;
    const nextVersion = detail.keyVersion + 1;
    const newKeys = await vault.newCollectionKeys();
    const opened = [];
    try {
      const memberPayload = [];
      for (const m of members) {
        const sealed = await vault.sealCollectionKeysForMember({
          tenantId, collectionUid: uid, keyVersion: nextVersion, memberUserId: m.userId, memberPublicKey: fromB64(people.get(m.userId).publicKey),
          senderPrivateKey: session.privateKey, keys: newKeys, include: { meta: true, secret: Boolean(m.rights.reveal) },
        });
        memberPayload.push({ userId: m.userId, wrappedMetaKey: toB64(sealed.wrappedMetaKey), wrappedSecretKey: sealed.wrappedSecretKey ? toB64(sealed.wrappedSecretKey) : undefined });
      }

      const itemPayload = [];
      for (const [index, item] of items.entries()) {
        onProgress({ stage: "Re-encrypting items", done: index, total: items.length });
        const { item: row, keys: oldKeys, secretResponse } = await ctx.openForEdit(item.uid, { withSecret: true });
        opened.push(oldKeys);
        if (!oldKeys.secretKey) throw ctx.userError("You do not hold the keys for every item in this collection, so re-keying was not started. Nothing was changed.", "NO_KEY");
        const meta = await vault.decryptItemMeta({ tenantId, itemUid: item.uid, keyVersion: row.keyVersion, metaKey: oldKeys.metaKey, metaCiphertext: fromB64(row.meta) });
        const secret = secretResponse.secret ? await vault.decryptItemSecret({ tenantId, itemUid: item.uid, keyVersion: row.keyVersion, secretKey: oldKeys.secretKey, secretCiphertext: fromB64(secretResponse.secret) }) : undefined;
        const rotated = await vault.rotateItem({ tenantId, itemUid: item.uid, keyVersion: row.keyVersion, meta, secret });
        opened.push(rotated.keys);
        const wrapped = await vault.wrapItemKeysForCollection({ tenantId, collectionUid: uid, itemUid: item.uid, itemKeyVersion: rotated.keyVersion, collectionKeys: newKeys, itemKeys: rotated.keys });

        // check before sending: the new ciphertext opens with the new keys and holds exactly what the old one held
        const again = await vault.unwrapItemKeysFromCollection({ tenantId, collectionUid: uid, itemUid: item.uid, itemKeyVersion: rotated.keyVersion, collectionKeys: newKeys, wrapped });
        opened.push(again);
        const meta2 = await vault.decryptItemMeta({ tenantId, itemUid: item.uid, keyVersion: rotated.keyVersion, metaKey: again.metaKey, metaCiphertext: rotated.metaCiphertext });
        const secret2 = rotated.secretCiphertext ? await vault.decryptItemSecret({ tenantId, itemUid: item.uid, keyVersion: rotated.keyVersion, secretKey: again.secretKey, secretCiphertext: rotated.secretCiphertext }) : undefined;
        if (JSON.stringify(meta2) !== JSON.stringify(meta) || JSON.stringify(secret2) !== JSON.stringify(secret)) throw ctx.userError("A re-encrypted item did not match the original, so re-keying was stopped. Nothing was changed.", "VERIFY_FAILED");

        // shares of this one item must follow the new keys
        const grants = (await guard(() => api.listGrants(item.uid))).filter((g) => !g.expired);
        const recipients = [];
        for (const g of grants) {
          const entry = people.get(g.recipientUserId);
          if (!entry) throw ctx.userError("Someone this item is shared with has no public key, so re-keying was not started. Nothing was changed.", "MEMBER_KEY_MISSING");
          const box = await vault.wrapItemKeysForRecipient({
            tenantId, itemUid: item.uid, keyVersion: rotated.keyVersion, recipientUserId: g.recipientUserId, recipientPublicKey: fromB64(entry.publicKey),
            senderPrivateKey: session.privateKey, keys: rotated.keys, include: { meta: true, secret: Boolean(g.rights.reveal) },
          });
          recipients.push({ userId: g.recipientUserId, boxedMetaKey: toB64(box.boxedMetaKey), boxedSecretKey: box.boxedSecretKey ? toB64(box.boxedSecretKey) : undefined });
        }

        // each attachment's file key was wrapped under the OLD secret key: re-wrap it, or the file would be lost
        const files = await guard(() => api.listItemAttachments(item.uid));
        const attachments = [];
        for (const f of files) {
          const ids = { tenantId, itemUid: item.uid, attachmentUid: f.uid };
          const fileKey = await vault.unwrapAttachmentKey({ itemSecretKey: oldKeys.secretKey, wrappedFileKey: fromB64(f.wrappedFileKey), ...ids });
          const next = await vault.wrapAttachmentKey({ itemSecretKey: rotated.keys.secretKey, fileKey, ...ids });
          vault.lockSession({ vaultKey: fileKey });
          attachments.push({ uid: f.uid, wrappedFileKey: toB64(next) });
        }

        itemPayload.push({
          uid: item.uid, expectedVersion: row.version, keyVersion: rotated.keyVersion, meta: toB64(rotated.metaCiphertext), secret: rotated.secretCiphertext ? toB64(rotated.secretCiphertext) : null,
          keys: { meta: toB64(wrapped.meta), secret: wrapped.secret ? toB64(wrapped.secret) : undefined }, recipients, attachments,
        });
      }

      // the collection's own name and description were encrypted under the OLD meta key
      const nameEnvelope = await vault.encryptCollectionName({ tenantId, collectionUid: uid, key: newKeys.metaKey, name: view.name, description: view.description });
      const checked = await vault.decryptCollectionInfo({ tenantId, collectionUid: uid, key: newKeys.metaKey, envelope: nameEnvelope });
      if (checked.name !== view.name || checked.description !== view.description) throw ctx.userError("The collection's name could not be re-encrypted, so re-keying was stopped. Nothing was changed.", "VERIFY_FAILED");

      if (memberPayload.length !== members.length || itemPayload.length !== items.length) throw ctx.userError("Not every member and item was prepared, so re-keying was stopped. Nothing was changed.", "VERIFY_FAILED");
      const payload = { expectedKeyVersion: detail.keyVersion, name: toB64(nameEnvelope), members: memberPayload, items: itemPayload };
      // one request keeps it all-or-nothing, so it has a size limit: say so before sending rather than fail at the end
      if (JSON.stringify(payload).length > MAX_REKEY_BYTES) throw ctx.userError("This collection is too large to re-key in one step. Move some items to another collection and try again. Nothing was changed.", "TOO_LARGE");
      onProgress({ stage: "Saving", done: items.length, total: items.length });
      await guard(() => api.rotateCollection(uid, payload));
    } finally {
      for (const keys of opened) ctx.wipeKeys(keys);
      ctx.wipeKeys(newKeys);
    }

    // afterwards: open everything again with the new keys
    onProgress({ stage: "Verifying", done: items.length, total: items.length });
    await ctx.reload();
    const after = ctx.getState();
    const now = after.collections.find((c) => c.uid === uid);
    const broken = after.companyItems.filter((i) => i.collectionUid === uid && i.corrupt).length;
    if (!now || now.corrupt || now.keyVersion !== nextVersion || broken > 0) {
      throw ctx.userError("Re-keying finished, but some items could not be opened afterwards. Do not remove anyone yet and contact your administrator.", "VERIFY_FAILED");
    }
    return { keyVersion: nextVersion, items: items.length, members: members.length };
  }

  return {
    listAttachments, uploadAttachment, downloadAttachment, deleteAttachment, loadAllAttachments,
    setRotationSchedule, completeRotation, loadAudit, loadOffboardingPeople, revokeCompanyAccess, rekeyCollection,
  };
}
