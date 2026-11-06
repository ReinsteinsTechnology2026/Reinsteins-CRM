import { VaultApiError, serverMaterialFromWire } from "./vaultApi.js";
import { toB64, fromB64 } from "./encoding.js";
import { draftToPayloads, parseMeta, parseSecret, payloadsToDraft, InvalidItemError, LIMITS as ITEM_LIMITS } from "./itemModel.js";
import { analyzeVault, estimateStrength, THRESHOLDS } from "./health.js";
import { createCompanyActions } from "./vaultCompany.js";

// ==========================================
// ZIOVAULT -- the personal-vault session (everything the user interface does goes through here)
//
// WHAT THIS HOLDS, AND WHERE
//   * The vault key and private key live ONLY in this object's private variables while unlocked: never in a snapshot, never in
//     React state, never in browser storage, a URL or a log. lock() overwrites them.
//   * Decrypted details (title, username, ...) are cached in memory while unlocked so search is instant and local; decrypted
//     SECRETS are fetched on demand (reveal / edit / health scan) and kept in memory only until lock.
//   * The only things that are ever persisted by this module: non-secret preferences (numbers) via `prefsStore`, and -- when the
//     vault locks while an item is being edited -- that draft SEALED under the vault key (ciphertext) via `draftStorage`.
//   * All encryption/decryption is the Stage 1 `vault` module. The server only ever receives ciphertext and envelopes (vaultApi.js).
//
// There is no fallback of any kind: if a crypto step fails, the operation fails and says so.
// ==========================================

export const PREFS_DEFAULTS = Object.freeze({ autoLockMinutes: 5, clipboardClearSeconds: 30, oldPasswordDays: THRESHOLDS.defaultOldDays });
export const PREF_LIMITS = Object.freeze({ autoLockMinutes: [0, 240], clipboardClearSeconds: [0, 300], oldPasswordDays: [30, 1825] });
export const AUTO_LOCK_CHOICES = Object.freeze([1, 5, 15, 30, 60]);
const MIN_MASTER_BITS = 45;
const UNLOCK_FREE_ATTEMPTS = 3;
const HEALTH_CONCURRENCY = 3;
const DRAFT_KEY = (tenantId, userId) => `ziovault:draft:${tenantId}:${userId}`;

export class VaultUserError extends Error {
  constructor(message, code = "USER_ERROR") {
    super(message);
    this.name = "VaultUserError";
    this.code = code;
  }
}

export function sanitizePrefs(input) {
  const out = { ...PREFS_DEFAULTS };
  for (const [key, [min, max]] of Object.entries(PREF_LIMITS)) {
    const value = input && input[key];
    if (Number.isInteger(value) && value >= min && value <= max) out[key] = value;
  }
  return out;
}

const uuid = () => globalThis.crypto.randomUUID();

export function createVaultSession({
  api,
  vault, // the Stage 1 module (client/src/vault/crypto/index.js)
  getIdentity, // async () => { tenantId, userId }  (from the verified CRM session)
  kdf, // KDF parameters used when creating or changing a master password (default: the production parameters)
  prefsStore = { load: () => ({}), save: () => {} },
  draftStorage = null, // { getItem, setItem, removeItem } for the sealed draft; null = drafts are not kept
  channel = null, // { post(message), onMessage(handler), close() } to coordinate tabs
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let identity = null;
  let session = null; // { vaultKey, privateKey, publicKey }
  let account = null; // { accountVersion, recoveryConfirmed }
  let deadline = 0;
  let lockTimer = null;
  let failures = 0;
  let retryAt = 0;
  let draftProvider = null;
  let healthRun = 0;
  const secrets = new Map(); // uid -> parsed secret (memory only, until lock)
  const collectionKeys = new Map(); // collection uid -> { keys, keyVersion } (memory only, until lock)
  const listeners = new Set();

  let state = {
    status: "idle", error: null, lockReason: null, retryAfterMs: 0,
    recoverySecret: null, recoveryConfirmed: true, canCreateCollections: false, items: [], trash: [], folders: [], collections: [], companyItems: [], sharedItems: [], outgoing: [],
    prefs: sanitizePrefs(prefsStore.load()), health: null, draftAvailable: false, busy: false,
  };

  const snapshot = () => state;
  const set = (patch) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  // ---------------------------------------------------------------- errors a person can read (never a secret, never a key)
  const describe = (error) => {
    if (error instanceof VaultUserError) return error.message;
    if (error instanceof VaultApiError) return error.message;
    if (error instanceof InvalidItemError) return error.message;
    if (error && error.name === "VaultCryptoError") return error.message && error.message !== "Decryption failed" ? error.message : "That did not work: the password is incorrect or the data is damaged.";
    return "Something went wrong. Nothing was saved.";
  };

  // A request answered "not signed in": the CRM session is over, so the vault locks at once.
  const guard = async (work) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof VaultApiError && error.code === "SESSION_EXPIRED") await lock("expired");
      throw error;
    }
  };

  const scope = () => ({ tenantId: identity.tenantId, userId: identity.userId });
  // tabs only coordinate with tabs of the SAME person in the SAME company
  const scopeKey = () => (identity ? `${identity.tenantId}:${identity.userId}` : "");

  // ---------------------------------------------------------------- locking
  const scheduleLock = () => {
    if (lockTimer) clearTimer(lockTimer);
    lockTimer = null;
    const minutes = state.prefs.autoLockMinutes;
    if (!session || minutes <= 0) return;
    deadline = now() + minutes * 60000;
    const arm = (delay) => {
      lockTimer = setTimer(async () => {
        const remaining = deadline - now();
        if (remaining > 50) return arm(remaining);
        await lock("inactivity");
        return undefined;
      }, delay);
    };
    arm(minutes * 60000);
  };

  // The user did something: push the inactivity deadline out. (Cheap: it only moves a number; the timer re-arms itself.)
  const touch = () => {
    if (!session) return;
    const minutes = state.prefs.autoLockMinutes;
    if (minutes > 0) deadline = now() + minutes * 60000;
  };

  async function sealPendingDraft() {
    if (!session || !draftStorage || !draftProvider || !identity) return;
    try {
      const draft = draftProvider();
      if (!draft) return;
      const envelope = await vault.sealDraft({ ...scope(), vaultKey: session.vaultKey, draft });
      draftStorage.setItem(DRAFT_KEY(identity.tenantId, identity.userId), toB64(envelope));
    } catch {
      // a draft that cannot be sealed is dropped rather than stored in the clear
    }
  }

  async function lock(reason = "manual", { broadcast = true } = {}) {
    const wasOpen = Boolean(session) || state.status === "setup-recovery";
    healthRun += 1;
    if (lockTimer) clearTimer(lockTimer);
    lockTimer = null;
    if (session) {
      await sealPendingDraft(); // before the keys are wiped
      vault.lockSession(session);
    }
    session = null;
    secrets.clear();
    companyActions.reset();
    draftProvider = null;
    if (wasOpen && broadcast && channel && ["manual", "logout", "password-changed", "expired"].includes(reason)) channel.post({ type: "lock", reason, scope: scopeKey() });
    if (state.status === "no-account") return;
    set({
      status: identity ? "locked" : "idle", lockReason: wasOpen ? reason : state.lockReason, error: null, recoverySecret: null,
      items: [], trash: [], folders: [], collections: [], companyItems: [], sharedItems: [], outgoing: [], health: null, busy: false,
      draftAvailable: Boolean(draftStorage && identity && draftStorage.getItem(DRAFT_KEY(identity.tenantId, identity.userId))),
    });
  }

  if (channel) {
    channel.onMessage((message) => {
      if (message && message.type === "lock" && message.scope === scopeKey() && (session || state.status === "setup-recovery")) {
        lock(message.reason === "manual" ? "other-tab" : message.reason, { broadcast: false });
      }
    });
  }

  // ---------------------------------------------------------------- loading what is stored (decrypts only the DETAILS)
  // The item's keys, opened from whichever way this person holds them: as owner (vault key), from a share (box from the sharer), or through
  // a company collection (collection keys, themselves a box from whoever added this person). Missing keys stay null: that is the permission.
  async function keysFor(item, secretResponse = null) {
    const idBase = { ...scope(), itemUid: item.uid, keyVersion: item.keyVersion };
    const out = { metaKey: null, secretKey: null };
    const sources = [...item.keys, ...(secretResponse ? secretResponse.keys : [])];
    const opened = [];
    for (const source of sources) {
      let got = null;
      if (source.source === "owner") {
        got = await vault.unwrapItemKeysForOwner({ ...idBase, ownerUserId: identity.userId, vaultKey: session.vaultKey, wrappedMetaKey: source.meta ? fromB64(source.meta) : null, wrappedSecretKey: source.secret ? fromB64(source.secret) : null });
      } else if (source.source === "box") {
        got = await vault.openItemKeysFromSender({ ...idBase, recipientUserId: identity.userId, senderPublicKey: fromB64(source.sender.publicKey), recipientPrivateKey: session.privateKey, boxedMetaKey: source.meta ? fromB64(source.meta) : null, boxedSecretKey: source.secret ? fromB64(source.secret) : null });
      } else if (source.source === "collection") {
        const c = source.collection;
        const collection = await vault.openCollectionKeys({ tenantId: identity.tenantId, collectionUid: c.uid, keyVersion: c.keyVersion, memberUserId: identity.userId, senderPublicKey: fromB64(c.sender.publicKey), recipientPrivateKey: session.privateKey, wrappedMetaKey: fromB64(c.wrappedMetaKey), wrappedSecretKey: c.wrappedSecretKey ? fromB64(c.wrappedSecretKey) : null });
        got = await vault.unwrapItemKeysFromCollection({ tenantId: identity.tenantId, collectionUid: c.uid, itemUid: item.uid, itemKeyVersion: item.keyVersion, collectionKeys: collection, wrapped: { meta: source.meta ? fromB64(source.meta) : null, secret: source.secret ? fromB64(source.secret) : null } });
        wipeKeys(collection);
      }
      if (got) {
        opened.push(got);
        out.metaKey ||= got.metaKey;
        out.secretKey ||= got.secretKey;
      }
    }
    return out;
  }

  const wipeKeys = (keys) => {
    for (const key of [keys && keys.metaKey, keys && keys.secretKey]) if (key) vault.lockSession({ vaultKey: key });
  };

  async function viewOf(item) {
    const base = {
      uid: item.uid, kind: item.kind, favorite: item.favorite, version: item.version, keyVersion: item.keyVersion, hasSecret: item.hasSecret,
      createdAt: item.createdAt, updatedAt: item.updatedAt, lastRotatedAt: item.lastRotatedAt, rotationIntervalDays: item.rotationIntervalDays, deletedAt: item.deletedAt,
      canCopy: Boolean(item.rights && item.rights.copy), corrupt: false,
      ownership: item.ownership, via: item.via, rights: item.rights, expiresAt: item.expiresAt, collectionUid: item.collectionUid,
      sharedBy: (item.keys.find((key) => key.source === "box") || {}).sender ? item.keys.find((key) => key.source === "box").sender.userId : null,
      rotationRequired: Boolean(item.rotationRequired),
    };
    try {
      const keys = await keysFor(item);
      if (!keys.metaKey) throw new Error("no details key");
      const meta = parseMeta(await vault.decryptItemMeta({ ...scope(), itemUid: item.uid, keyVersion: item.keyVersion, metaKey: keys.metaKey, metaCiphertext: fromB64(item.meta) }));
      wipeKeys(keys);
      return { ...base, ...meta };
    } catch {
      // an item that does not authenticate or does not match the schema is shown as unreadable; it never breaks the list
      return { ...base, title: "Unreadable item", url: "", username: "", folderUid: null, fields: [], corrupt: true };
    }
  }

  async function loadFolders() {
    const list = await api.listFolders();
    const folders = [];
    for (const folder of list) {
      try {
        const name = await vault.decryptFolderName({ ...scope(), folderUid: folder.uid, vaultKey: session.vaultKey, envelope: fromB64(folder.name) });
        folders.push({ uid: folder.uid, name: typeof name === "string" ? name.slice(0, ITEM_LIMITS.FOLDER_NAME) : "Folder", corrupt: false });
      } catch {
        folders.push({ uid: folder.uid, name: "Unreadable folder", corrupt: true });
      }
    }
    return folders;
  }

  async function reload() {
    const [items, folders] = await guard(() => Promise.all([api.listItems(), loadFolders()]));
    const personal = [];
    const companyList = [];
    const shared = [];
    for (const item of items) {
      const view = await viewOf(item);
      if (item.via === "owner") personal.push(view);
      else if (item.via === "collection") companyList.push(view);
      else shared.push(view);
    }
    const collections = await companyActions.loadCollections();
    const counted = collections.map((c) => ({ ...c, itemCount: companyList.filter((i) => i.collectionUid === c.uid).length }));
    set({ items: personal, companyItems: companyList, sharedItems: shared, collections: counted, folders });
    return personal;
  }

  async function loadTrash() {
    const list = await guard(() => api.listTrash());
    const views = [];
    for (const item of list) views.push(await viewOf(item));
    set({ trash: views });
    return views;
  }

  // ---------------------------------------------------------------- account: setup, recovery key, unlock
  async function init() {
    set({ status: "loading", error: null });
    try {
      identity = await getIdentity();
      const status = await api.accountStatus();
      account = status.exists ? { accountVersion: status.accountVersion, recoveryConfirmed: status.recoveryConfirmed } : null;
      // only a company administrator can open a new collection (the server enforces it; this just decides whether to offer the button)
      set({
        canCreateCollections: identity.role === "admin",
        status: status.exists ? "locked" : "no-account", recoveryConfirmed: status.exists ? status.recoveryConfirmed : true,
        draftAvailable: Boolean(draftStorage && draftStorage.getItem(DRAFT_KEY(identity.tenantId, identity.userId))),
      });
    } catch (error) {
      set({ status: "idle", error: describe(error) });
      if (error instanceof VaultApiError && error.code === "FEATURE_NOT_ENABLED") set({ status: "disabled" });
    }
    return state.status;
  }

  function checkNewPassword(password, confirmation) {
    const policy = vault.checkMasterPassword(password);
    if (!policy.ok) throw new VaultUserError(policy.reason);
    if (confirmation !== undefined && confirmation !== password) throw new VaultUserError("The two passwords do not match.");
    const strength = estimateStrength(password);
    if (strength.bits < MIN_MASTER_BITS) throw new VaultUserError("That master password is too easy to guess. Use a longer password or a passphrase of several random words.");
  }

  async function setup(password, confirmation) {
    set({ busy: true, error: null });
    try {
      checkNewPassword(password, confirmation);
      await new Promise((resolve) => setTimer(resolve, 20)); // let the "working" state paint before the CPU-heavy key derivation
      const created = await vault.createAccount({ password, ...scope(), ...(kdf ? { kdf } : {}) });
      const result = await guard(() => api.register(created.server));
      session = created.session;
      account = { accountVersion: result.accountVersion, recoveryConfirmed: false };
      set({ status: "setup-recovery", recoverySecret: created.recoverySecretText, recoveryConfirmed: false, busy: false, lockReason: null });
      scheduleLock();
    } catch (error) {
      const exists = error instanceof VaultApiError && error.code === "ACCOUNT_EXISTS";
      set({ busy: false, error: exists ? "A vault already exists for your account. Unlock it instead." : describe(error), status: exists ? "locked" : state.status });
    }
    return state.status;
  }

  // The user proves they kept the recovery key by typing it back; only then is the vault considered set up.
  async function confirmRecovery(typedBack) {
    set({ busy: true, error: null });
    try {
      if (!state.recoverySecret) throw new VaultUserError("There is no recovery key to confirm.");
      const typed = await vault.parseRecoverySecret(typedBack);
      const shown = await vault.parseRecoverySecret(state.recoverySecret);
      if (!vault.equalBytes(typed, shown)) throw new VaultUserError("That does not match the recovery key shown. Check it and try again.");
      await guard(() => api.confirmRecovery());
      account = { ...account, recoveryConfirmed: true };
      await reload();
      set({ recoverySecret: null, recoveryConfirmed: true, status: "unlocked" });
      scheduleLock();
      set({ busy: false });
    } catch (error) {
      set({ busy: false, error: error && error.name === "VaultCryptoError" ? "That recovery key is not valid. Check it and try again." : describe(error) });
    }
    return state.status;
  }

  // A new recovery key (the old one stops working). Shown once, confirmed again.
  async function regenerateRecovery() {
    set({ busy: true, error: null });
    try {
      if (!session) throw new VaultUserError("Unlock your vault first.");
      const fresh = await vault.rotateRecoverySecret({ session, ...scope() });
      const result = await guard(() => api.replaceRecoveryEnvelope({ expectedAccountVersion: account.accountVersion, recoveryEnvelope: fresh.recoveryEnvelope }));
      account = { accountVersion: result.accountVersion, recoveryConfirmed: false };
      set({ status: "setup-recovery", recoverySecret: fresh.recoverySecretText, recoveryConfirmed: false, busy: false });
    } catch (error) {
      set({ busy: false, error: describe(error) });
    }
    return state.status;
  }

  async function unlock(password) {
    if (now() < retryAt) {
      const wait = retryAt - now();
      set({ retryAfterMs: wait, error: `Too many incorrect attempts. Wait ${Math.ceil(wait / 1000)} seconds and try again.` });
      return state.status;
    }
    set({ busy: true, error: null, retryAfterMs: 0 });
    try {
      if (typeof password !== "string" || password.length === 0) throw new VaultUserError("Enter your master password.");
      const material = await guard(() => api.unlockMaterial());
      if (!material.exists) {
        set({ status: "no-account", busy: false });
        return state.status;
      }
      const server = serverMaterialFromWire(material);
      await new Promise((resolve) => setTimer(resolve, 20));
      let opened;
      try {
        opened = await vault.unlockAccount({ password, server, ...scope() });
      } catch (error) {
        if (!(error && error.name === "VaultCryptoError")) throw error;
        failures += 1;
        retryAt = failures >= UNLOCK_FREE_ATTEMPTS ? now() + Math.min(30000, 1000 * 2 ** (failures - UNLOCK_FREE_ATTEMPTS)) : 0;
        set({ busy: false, error: "Incorrect master password.", retryAfterMs: Math.max(0, retryAt - now()) });
        return state.status;
      }
      failures = 0;
      retryAt = 0;
      session = opened;
      account = { accountVersion: material.accountVersion, recoveryConfirmed: material.recoveryConfirmed };
      await reload(); // the list is ready before the screen opens (no flash of an empty vault)
      set({ status: "unlocked", lockReason: null, recoveryConfirmed: material.recoveryConfirmed });
      scheduleLock();
      set({ busy: false });
    } catch (error) {
      if (session) vault.lockSession(session);
      session = null;
      set({ busy: false, error: describe(error), status: state.status === "unlocked" ? "locked" : state.status });
    }
    return state.status;
  }

  async function changePassword(currentPassword, newPassword, confirmation) {
    set({ busy: true, error: null });
    try {
      if (!session) throw new VaultUserError("Unlock your vault first.");
      checkNewPassword(newPassword, confirmation);
      const material = await guard(() => api.unlockMaterial());
      const server = serverMaterialFromWire(material);
      await vault.unlockAccount({ password: currentPassword, server, ...scope() }); // proves the CURRENT password, locally
      const recovery = await guard(() => api.recoveryMaterial());
      const full = serverMaterialFromWire(recovery);
      const updated = await vault.changeMasterPassword({ session, newPassword, ...scope(), ...(kdf ? { kdf } : {}), server: full });
      const result = await guard(() => api.replaceEnvelope({ expectedAccountVersion: recovery.accountVersion, kdf: updated.kdf, vaultKeyEnvelope: updated.vaultKeyEnvelope, reason: "password_changed" }));
      account = { ...account, accountVersion: result.accountVersion };
      if (channel) channel.post({ type: "lock", reason: "password-changed", scope: scopeKey() }); // other tabs must unlock with the new password
      set({ busy: false });
      return true;
    } catch (error) {
      set({ busy: false, error: error && error.name === "VaultCryptoError" ? "Your current master password is incorrect." : describe(error) });
      return false;
    }
  }

  // Locked and forgot the master password: the recovery key opens the vault and a NEW master password is set.
  async function recover(recoverySecretText, newPassword, confirmation) {
    set({ busy: true, error: null });
    try {
      checkNewPassword(newPassword, confirmation);
      const material = await guard(() => api.recoveryMaterial());
      const server = serverMaterialFromWire(material);
      const recovered = await vault.recoverAccount({ recoverySecretText, newPassword, server, ...scope(), ...(kdf ? { kdf } : {}) });
      const result = await guard(() => api.replaceEnvelope({ expectedAccountVersion: material.accountVersion, kdf: recovered.server.kdf, vaultKeyEnvelope: recovered.server.vaultKeyEnvelope, reason: "recovery_used" }));
      session = recovered.session;
      account = { accountVersion: result.accountVersion, recoveryConfirmed: material.recoveryConfirmed };
      failures = 0;
      retryAt = 0;
      await reload();
      set({ status: "unlocked", lockReason: null, recoveryConfirmed: material.recoveryConfirmed });
      scheduleLock();
      set({ busy: false });
      return true;
    } catch (error) {
      set({ busy: false, error: error && error.name === "VaultCryptoError" ? "That recovery key does not open this vault." : describe(error) });
      return false;
    }
  }

  // ---------------------------------------------------------------- items
  const requireOpen = () => {
    if (!session) throw new VaultUserError("The vault is locked.", "LOCKED");
    touch();
  };

  async function sealParts(uid, keyVersion, keys, payloads) {
    return vault.encryptItem({ ...scope(), itemUid: uid, keyVersion, keys, meta: payloads.meta, secret: payloads.secret });
  }

  async function createItem(draft) {
    requireOpen();
    const payloads = draftToPayloads(draft);
    const uid = uuid();
    const keys = await vault.newItemKeys();
    const sealed = await sealParts(uid, 1, keys, payloads);
    const wrapped = await vault.wrapItemKeysForOwner({ ...scope(), itemUid: uid, keyVersion: 1, ownerUserId: identity.userId, vaultKey: session.vaultKey, keys });
    await guard(() => api.createItem({ uid, kind: payloads.kind, meta: sealed.metaCiphertext, secret: sealed.secretCiphertext, keys: { meta: wrapped.wrappedMetaKey, secret: wrapped.wrappedSecretKey }, rotationIntervalDays: draft.rotationIntervalDays }));
    if (draft.favorite) await guard(() => api.updateItem(uid, { expectedVersion: 1, favorite: true }));
    secrets.delete(uid); // a later reveal goes to the server, so every reveal leaves a server-side delivery record
    await reload();
    return uid;
  }

  // The item's keys, freshly unwrapped (and its current version), for an edit. The secret key requires fetching the secret envelope.
  async function openForEdit(uid, { withSecret }) {
    const item = await guard(() => api.getItem(uid));
    const secretResponse = withSecret ? await guard(() => api.getSecret(uid)) : null;
    const keys = await keysFor(item, secretResponse);
    if (!keys.metaKey) throw new VaultUserError("You do not have access to this item.", "FORBIDDEN");
    return { item, keys, secretResponse };
  }

  async function readSecretFrom(uid, item, keys, secretResponse) {
    const parsed = parseSecret(await vault.decryptItemSecret({ ...scope(), itemUid: uid, keyVersion: item.keyVersion, secretKey: keys.secretKey, secretCiphertext: fromB64(secretResponse.secret) }));
    secrets.set(uid, parsed);
    return parsed;
  }

  // The secret of one item, decrypted (cached in memory until lock). Recorded server-side as a delivery; the report that it was shown is
  // best-effort and advisory.
  async function revealItem(uid, { report = true } = {}) {
    requireOpen();
    if (secrets.has(uid)) {
      if (report) api.reportAccess(uid, "reveal").catch(() => {});
      return secrets.get(uid);
    }
    const { item, keys, secretResponse } = await openForEdit(uid, { withSecret: true });
    const parsed = await readSecretFrom(uid, item, keys, secretResponse);
    if (report) api.reportAccess(uid, "reveal").catch(() => {});
    return parsed;
  }

  function noteCopy(uid) {
    return api.reportAccess(uid, "copy").catch(() => {});
  }

  async function loadForEditing(uid) {
    requireOpen();
    const { item, keys, secretResponse } = await openForEdit(uid, { withSecret: true });
    const meta = parseMeta(await vault.decryptItemMeta({ ...scope(), itemUid: uid, keyVersion: item.keyVersion, metaKey: keys.metaKey, metaCiphertext: fromB64(item.meta) }));
    const secret = await readSecretFrom(uid, item, keys, secretResponse);
    return { draft: payloadsToDraft(item, meta, secret), version: item.version };
  }

  async function updateItem(uid, draft, expectedVersion) {
    requireOpen();
    const payloads = draftToPayloads(draft);
    const { item, keys } = await openForEdit(uid, { withSecret: true });
    if (expectedVersion !== undefined && item.version !== expectedVersion) throw new VaultApiError(409, "STALE_VERSION", "This item was changed elsewhere since you opened it. Your edits are still here: copy anything you need, then reopen the item.");
    const sealed = await sealParts(uid, item.keyVersion, keys, payloads);
    // favorite belongs to the owner; the reminder interval to an owner or manager: other editors send neither (the server would refuse)
    const mine = item.via === "owner";
    const manages = mine || (item.rights && item.rights.manage);
    await guard(() => api.updateItem(uid, { expectedVersion: item.version, meta: sealed.metaCiphertext, secret: sealed.secretCiphertext, kind: payloads.kind, rotationIntervalDays: manages && draft.rotationIntervalDays !== undefined ? draft.rotationIntervalDays : undefined, favorite: mine ? Boolean(draft.favorite) : undefined }));
    secrets.delete(uid);
    await reload();
  }

  // Changes the DETAILS only (folder, ...) without ever fetching the secret.
  async function updateDetails(uid, change) {
    requireOpen();
    const { item, keys } = await openForEdit(uid, { withSecret: false });
    const meta = parseMeta(await vault.decryptItemMeta({ ...scope(), itemUid: uid, keyVersion: item.keyVersion, metaKey: keys.metaKey, metaCiphertext: fromB64(item.meta) }));
    const next = { v: 1, ...meta, ...change };
    const sealed = await vault.encryptItem({ ...scope(), itemUid: uid, keyVersion: item.keyVersion, keys, meta: next });
    await guard(() => api.updateItem(uid, { expectedVersion: item.version, meta: sealed.metaCiphertext }));
    await reload();
  }

  const moveToFolder = (uid, folderUid) => updateDetails(uid, { folderUid: folderUid || null });

  async function setFavorite(uid, favorite) {
    requireOpen();
    const item = await guard(() => api.getItem(uid));
    await guard(() => api.updateItem(uid, { expectedVersion: item.version, favorite }));
    await reload();
  }

  async function deleteItem(uid) {
    requireOpen();
    await guard(() => api.deleteItem(uid));
    secrets.delete(uid);
    await reload();
    await loadTrash();
  }

  async function restoreItem(uid) {
    requireOpen();
    await guard(() => api.restoreItem(uid));
    await reload();
    await loadTrash();
  }

  // ---------------------------------------------------------------- folders
  const cleanFolderName = (name) => {
    const text = String(name || "").trim();
    if (!text) throw new VaultUserError("Give the folder a name.");
    if (text.length > ITEM_LIMITS.FOLDER_NAME) throw new VaultUserError(`Keep the folder name under ${ITEM_LIMITS.FOLDER_NAME} characters.`);
    return text;
  };

  async function createFolder(name) {
    requireOpen();
    const text = cleanFolderName(name);
    const uid = uuid();
    const envelope = await vault.encryptFolderName({ ...scope(), folderUid: uid, vaultKey: session.vaultKey, name: text });
    await guard(() => api.createFolder({ uid, name: envelope }));
    set({ folders: await loadFolders() });
    return uid;
  }

  async function renameFolder(uid, name) {
    requireOpen();
    const envelope = await vault.encryptFolderName({ ...scope(), folderUid: uid, vaultKey: session.vaultKey, name: cleanFolderName(name) });
    await guard(() => api.renameFolder(uid, envelope));
    set({ folders: await loadFolders() });
  }

  async function deleteFolder(uid) {
    requireOpen();
    await guard(() => api.deleteFolder(uid));
    set({ folders: await loadFolders() });
  }

  // ---------------------------------------------------------------- preferences (numbers only)
  function setPrefs(patch) {
    // a value that is not allowed is ignored (the current setting stays), never replaced by a default
    const valid = {};
    for (const [key, [min, max]] of Object.entries(PREF_LIMITS)) if (patch && Number.isInteger(patch[key]) && patch[key] >= min && patch[key] <= max) valid[key] = patch[key];
    const prefs = sanitizePrefs({ ...state.prefs, ...valid });
    prefsStore.save(prefs);
    set({ prefs });
    scheduleLock();
  }

  // ---------------------------------------------------------------- unsaved edits survive an automatic lock, as ciphertext
  const setDraftProvider = (provider) => {
    draftProvider = provider;
  };

  async function restoreDraft() {
    if (!session || !draftStorage) return null;
    const stored = draftStorage.getItem(DRAFT_KEY(identity.tenantId, identity.userId));
    if (!stored) return null;
    draftStorage.removeItem(DRAFT_KEY(identity.tenantId, identity.userId));
    set({ draftAvailable: false });
    try {
      return await vault.openDraft({ ...scope(), vaultKey: session.vaultKey, envelope: fromB64(stored) });
    } catch {
      return null; // damaged or from another vault: discarded
    }
  }

  function discardDraft() {
    if (draftStorage && identity) draftStorage.removeItem(DRAFT_KEY(identity.tenantId, identity.userId));
    set({ draftAvailable: false });
  }

  // ---------------------------------------------------------------- password health (local; passwords are used in memory and never copied into the report)
  async function runHealth() {
    requireOpen();
    const run = (healthRun += 1);
    const eligible = state.items.filter((item) => !item.corrupt && item.hasSecret && item.kind !== "secure_note");
    set({ health: { running: true, progress: { done: 0, total: eligible.length }, report: null } });
    const entries = [];
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < eligible.length && run === healthRun && session) {
        const item = eligible[next];
        next += 1;
        try {
          const secret = await revealItem(item.uid, { report: false });
          entries.push({ uid: item.uid, title: item.title, kind: item.kind, username: item.username, password: secret.password, lastRotatedAt: item.lastRotatedAt });
        } catch {
          // an unreadable item is simply not part of the analysis
        }
        done += 1;
        if (run === healthRun) set({ health: { running: true, progress: { done, total: eligible.length }, report: null } });
      }
    };
    await Promise.all(Array.from({ length: HEALTH_CONCURRENCY }, worker));
    if (run !== healthRun || !session) return null; // locked meanwhile: nothing is kept
    const report = analyzeVault(entries, { now: now(), oldDays: state.prefs.oldPasswordDays });
    entries.length = 0;
    set({ health: { running: false, progress: { done: eligible.length, total: eligible.length }, report, checkedAt: new Date(now()).toISOString() } });
    return report;
  }

  // ---------------------------------------------------------------- the CRM sign-in changed or ended underneath the vault
  function watchAuth(fingerprint, intervalMs = 2000, { setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
    const initial = fingerprint();
    const handle = setIntervalFn(() => {
      if (session && fingerprint() !== initial) lock("logout");
    }, intervalMs);
    return () => clearIntervalFn(handle);
  }

  function dispose() {
    if (lockTimer) clearTimer(lockTimer);
    if (session) vault.lockSession(session);
    session = null;
    secrets.clear();
    listeners.clear();
    if (channel) channel.close();
  }

  const companyActions = createCompanyActions({
    api, vault, scope: () => scope(), uuid, collectionKeys, guard: (work) => guard(work), requireOpen: () => requireOpen(), reload: () => reload(),
    getSession: () => session, getState: () => state, set: (patch) => set(patch), openForEdit: (uid, options) => openForEdit(uid, options), wipeKeys: (keys) => wipeKeys(keys),
    userError: (message, code) => new VaultUserError(message, code),
  });

  return {
    ...companyActions,
    snapshot, subscribe, init, setup, confirmRecovery, regenerateRecovery, unlock, lock, touch, changePassword, recover,
    createItem, loadForEditing, updateItem, updateDetails, moveToFolder, setFavorite, deleteItem, restoreItem, loadTrash, revealItem, noteCopy, reload,
    createFolder, renameFolder, deleteFolder, setPrefs, setDraftProvider, restoreDraft, discardDraft, runHealth, watchAuth, dispose,
    describe,
    get isUnlocked() {
      return Boolean(session);
    },
  };
}
