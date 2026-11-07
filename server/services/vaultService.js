const { createVaultStore } = require("./vaultStore");
const authz = require("./vaultAuthz");
const V = require("../utils/vaultValidation");
const { VaultError, notFound, forbidden, invalid, conflict } = require("../utils/vaultErrors");

// ==========================================
// ZIOVAULT -- application rules
//
// This service stores and serves CIPHERTEXT and key envelopes. It has no key, so it cannot decrypt, and nothing it returns is
// decrypted. What it DOES enforce, on every call and from the authenticated user id + the database clock only:
//   * the caller is an active user with a vault account,
//   * the caller's right to the item/collection (vaultAuthz.js), with expiry and revocation,
//   * shape, size and consistency of what is stored (a secret key envelope exists exactly when "reveal" is granted, ...),
//   * optimistic versions, so concurrent edits never silently overwrite each other.
// Whether an envelope really contains the right key cannot be checked here -- by design. A recipient finds out when decryption fails.
// ==========================================

const iso = (value) => (value ? new Date(value).toISOString() : null);
const num = (value) => (value === null || value === undefined ? null : Number(value));
const rightsLabel = (r) => ["reveal", "copy", "edit", "share"].filter((k) => r[k]).join(".") || "view";

function createVaultService({ pool, store = createVaultStore({ pool }) } = {}) {
    // ------------------------------------------------------------------ common
    async function actorOf(userId, { account = true, db = pool } = {}) {
        const user = authz.assertActiveUser(await store.getUser(db, userId));
        const acct = await store.getAccount(db, userId);
        if (account) authz.assertAccountExists(acct);
        return { user, account: acct };
    }

    async function assertFutureWithinLimit(db, isoValue, { max = V.LIMITS.MAX_GRANT_DAYS } = {}) {
        const [rows] = await db.query(`SELECT (?::timestamptz > now()) AS future, (?::timestamptz <= now() + (? || ' days')::interval) AS within`, [isoValue, isoValue, String(max)]);
        if (!rows[0].future) throw invalid("The expiry must be in the future.");
        if (!rows[0].within) throw invalid(`The expiry is too far away (at most ${max} days).`);
    }

    function sourcesFor(row, access, keyRows, memberKeyRow, { includeSecret }) {
        const mine = keyRows.filter((k) => Number(k.item_id) === Number(row.id));
        const pick = (type, purpose) => mine.find((k) => k.holder_type === type && k.purpose === purpose) || null;
        const out = [];
        const sender = (k) => (k && k.sender_user_id ? { userId: Number(k.sender_user_id), publicKey: V.encode(k.sender_public_key) } : null);

        if (access.paths.owner) {
            const meta = pick("owner", "meta");
            const secret = includeSecret ? pick("owner", "secret") : null;
            out.push({ source: "owner", keyVersion: row.key_version, meta: V.encode(meta?.wrapped_key), secret: V.encode(secret?.wrapped_key) });
        }
        if (access.paths.grant) {
            const meta = pick("user", "meta");
            const secret = includeSecret && row.g_reveal ? pick("user", "secret") : null;
            if (meta) out.push({ source: "box", keyVersion: meta.key_version, sender: sender(meta), meta: V.encode(meta.wrapped_key), secret: V.encode(secret?.wrapped_key) });
        }
        if (access.paths.collection && memberKeyRow) {
            const meta = pick("collection", "meta");
            const secret = includeSecret && row.m_reveal ? pick("collection", "secret") : null;
            if (meta) {
                out.push({
                    source: "collection",
                    keyVersion: meta.key_version,
                    meta: V.encode(meta.wrapped_key),
                    secret: V.encode(secret?.wrapped_key),
                    collection: {
                        uid: row.collection_uid,
                        keyVersion: memberKeyRow.key_version,
                        sender: sender(memberKeyRow),
                        wrappedMetaKey: V.encode(memberKeyRow.wrapped_meta_key),
                        wrappedSecretKey: includeSecret && row.m_reveal ? V.encode(memberKeyRow.wrapped_secret_key) : null,
                    },
                });
            }
        }
        return out;
    }

    function presentItem(row, access, sources) {
        return {
            uid: row.uid,
            ownership: row.owner_user_id ? "personal" : "company",
            collectionUid: row.collection_uid || null,
            kind: row.kind,
            meta: V.encode(row.meta_ciphertext),
            hasSecret: row.secret_ciphertext !== null && row.secret_ciphertext !== undefined,
            keyVersion: row.key_version,
            version: row.version,
            favorite: Boolean(row.is_owner) && Boolean(row.favorite),
            rotationIntervalDays: row.rotation_interval_days,
            rotationDueAt: iso(row.rotation_due_at),
            lastRotatedAt: iso(row.last_rotated_at),
            rotationRequired: Boolean(row.rotation_required),
            deletedAt: iso(row.deleted_at),
            createdAt: iso(row.created_at),
            updatedAt: iso(row.updated_at),
            via: access.via,
            expiresAt: iso(access.expiresAt),
            rights: access.rights,
            keys: sources,
        };
    }

    // ------------------------------------------------------------------ account
    async function accountStatus(userId) {
        await actorOf(userId, { account: false });
        const account = await store.getAccount(pool, userId);
        return account ? { exists: true, recoveryConfirmed: Boolean(account.recovery_confirmed_at), accountVersion: account.account_version } : { exists: false };
    }

    async function registerAccount(userId, body) {
        const kdf = V.kdfParams(body.kdf);
        const data = {
            kdf,
            vaultKeyEnvelope: V.wrappedKey(body.vaultKeyEnvelope, "vaultKeyEnvelope"),
            privateKeyEnvelope: V.wrappedKey(body.privateKeyEnvelope, "privateKeyEnvelope"),
            recoveryEnvelope: V.wrappedKey(body.recoveryEnvelope, "recoveryEnvelope"),
            publicKey: V.bytes(body.publicKey, "publicKey", { exact: 32 }),
        };
        return store.tx(async (db) => {
            authz.assertActiveUser(await store.getUser(db, userId));
            let inserted;
            try {
                inserted = await store.insertAccount(db, userId, data);
            } catch (error) {
                if (error.code === "23505") throw conflict("PUBLIC_KEY_IN_USE", "That key is already registered.");
                throw error;
            }
            if (!inserted) throw conflict("ACCOUNT_EXISTS", "A vault already exists for this user.");
            await store.audit(db, { kind: "account_created", actor: userId, subject: userId });
            return { accountVersion: inserted.account_version };
        });
    }

    function presentAccount(account, { withRecovery = false } = {}) {
        return {
            accountVersion: account.account_version,
            kdf: { alg: account.kdf_alg, ops: account.kdf_ops, mem: account.kdf_mem, salt: V.encode(account.kdf_salt) },
            vaultKeyEnvelope: V.encode(account.vault_key_envelope),
            privateKeyEnvelope: V.encode(account.private_key_envelope),
            publicKey: V.encode(account.public_key),
            recoveryConfirmed: Boolean(account.recovery_confirmed_at),
            ...(withRecovery ? { recoveryEnvelope: V.encode(account.recovery_envelope) } : {}),
        };
    }

    // The user's OWN envelopes. Anyone holding this user's CRM session can fetch them, so every fetch is audited and rate limited, and
    // the master password's strength (Argon2id) is what protects them -- see the threat model (G).
    async function unlockMaterial(userId) {
        await actorOf(userId, { account: false });
        const found = await store.getAccount(pool, userId);
        if (!found) return { exists: false };
        await store.audit(pool, { kind: "envelopes_fetched", actor: userId, subject: userId });
        return { exists: true, ...presentAccount(found) };
    }

    async function recoveryMaterial(userId) {
        await actorOf(userId, { account: false });
        const found = authz.assertAccountExists(await store.getAccount(pool, userId));
        await store.audit(pool, { kind: "recovery_envelope_fetched", actor: userId, subject: userId });
        return presentAccount(found, { withRecovery: true });
    }

    async function confirmRecovery(userId) {
        await actorOf(userId);
        await store.tx(async (db) => {
            await db.query(`UPDATE zv_accounts SET recovery_confirmed_at = COALESCE(recovery_confirmed_at, now()), updated_at = now() WHERE user_id = ?`, [userId]);
            await store.audit(db, { kind: "recovery_confirmed", actor: userId, subject: userId });
        });
        return { recoveryConfirmed: true };
    }

    // Password change and "recovered with the recovery secret" both end here: the client re-wrapped the SAME vault key under a new
    // password and sends only the new salt/params and the new envelope. The replaced envelope is kept in zv_account_history.
    async function replaceEnvelope(userId, body, reason = "password_changed") {
        const expected = V.positiveInteger(body.expectedAccountVersion, "expectedAccountVersion");
        const kdf = V.kdfParams(body.kdf);
        const vaultKeyEnvelope = V.wrappedKey(body.vaultKeyEnvelope, "vaultKeyEnvelope");
        const why = V.oneOf(body.reason || reason, ["password_changed", "recovery_used"], "reason");
        await actorOf(userId);
        return store.tx(async (db) => {
            const result = await store.replaceEnvelope(db, userId, expected, { kdf, vaultKeyEnvelope, reason: why });
            if (result.status === "stale") throw conflict("STALE_ACCOUNT", "Your vault changed in another window. Reload and try again.");
            if (result.status === "missing") throw authz.assertAccountExists(null);
            await store.audit(db, { kind: why, actor: userId, subject: userId });
            return { accountVersion: result.accountVersion };
        });
    }

    async function replaceRecoveryEnvelope(userId, body) {
        const expected = V.positiveInteger(body.expectedAccountVersion, "expectedAccountVersion");
        const recoveryEnvelope = V.wrappedKey(body.recoveryEnvelope, "recoveryEnvelope");
        await actorOf(userId);
        return store.tx(async (db) => {
            const row = (await db.query(
                `UPDATE zv_accounts SET recovery_envelope = ?, account_version = account_version + 1, recovery_confirmed_at = NULL, updated_at = now()
                 WHERE user_id = ? AND account_version = ? RETURNING account_version`,
                [recoveryEnvelope, userId, expected]
            ))[0][0];
            if (!row) throw conflict("STALE_ACCOUNT", "Your vault changed in another window. Reload and try again.");
            await store.audit(db, { kind: "recovery_rotated", actor: userId, subject: userId });
            return { accountVersion: row.account_version };
        });
    }

    async function envelopeHistory(userId) {
        await actorOf(userId);
        const list = await store.listEnvelopeHistory(pool, userId);
        return list.map((r) => ({ id: r.id, accountVersion: r.account_version, reason: r.reason, replacedAt: iso(r.replaced_at) }));
    }

    async function restoreEnvelope(userId, historyId, body) {
        const id = V.positiveInteger(historyId, "id");
        const expected = V.positiveInteger(body.expectedAccountVersion, "expectedAccountVersion");
        await actorOf(userId);
        return store.tx(async (db) => {
            const old = await store.getHistoryEntry(db, userId, id);
            if (!old) throw notFound();
            const result = await store.replaceEnvelope(db, userId, expected, {
                kdf: { ops: old.kdf_ops, mem: old.kdf_mem, salt: old.kdf_salt },
                vaultKeyEnvelope: old.vault_key_envelope,
                reason: "envelope_restored",
            });
            if (result.status === "stale") throw conflict("STALE_ACCOUNT", "Your vault changed in another window. Reload and try again.");
            await store.audit(db, { kind: "envelope_restored", actor: userId, subject: userId });
            return { accountVersion: result.accountVersion };
        });
    }

    // People one can share with: active colleagues who set up a vault. The server hands out their PUBLIC keys; the browser shows the
    // fingerprint so two people can compare it (the server could otherwise substitute a key at registration time).
    async function directory(userId) {
        await actorOf(userId);
        const list = await store.listDirectory(pool, userId);
        return list.map((u) => ({ userId: Number(u.id), name: u.full_name, employeeId: u.employee_id, employmentType: u.employment_type, publicKey: V.encode(u.public_key), registeredAt: iso(u.created_at) }));
    }

    // ------------------------------------------------------------------ items
    async function listItems(userId) {
        await actorOf(userId);
        const rows = await store.listItemsForUser(pool, userId);
        const keyRows = await store.itemKeysForUser(pool, rows.map((r) => r.id), userId);
        const memberKeys = await store.memberKeysForUser(pool, [...new Set(rows.filter((r) => r.collection_id).map((r) => r.collection_id))], userId);
        return rows.map((row) => {
            const access = authz.resolveItemRights(row);
            const memberKey = memberKeys.find((m) => Number(m.collection_id) === Number(row.collection_id));
            return presentItem(row, access, sourcesFor(row, access, keyRows, memberKey, { includeSecret: false }));
        });
    }

    async function listTrash(userId) {
        await actorOf(userId);
        const rows = await store.listDeletedItemsOf(pool, userId);
        const keyRows = await store.itemKeysForUser(pool, rows.map((r) => r.id), userId);
        return rows.map((row) => presentItem(row, authz.resolveItemRights(row), sourcesFor(row, authz.resolveItemRights(row), keyRows, null, { includeSecret: false })));
    }

    async function loadAccess(db, userId, uid, options = {}) {
        const row = await store.findItemForUser(db, userId, V.uuid(uid, "item"), options);
        if (!row) throw notFound();
        return { row, access: authz.resolveItemRights(row) };
    }

    async function getItem(userId, uid) {
        await actorOf(userId);
        const { row, access } = await loadAccess(pool, userId, uid);
        const keyRows = await store.itemKeysForUser(pool, [row.id], userId);
        const memberKeys = row.collection_id ? await store.memberKeysForUser(pool, [row.collection_id], userId) : [];
        return presentItem(row, access, sourcesFor(row, access, keyRows, memberKeys[0], { includeSecret: false }));
    }

    // The ONLY way a secret ciphertext and its key envelope leave the server. Requires the reveal right; recorded as server-observed.
    async function getSecret(userId, uid) {
        await actorOf(userId);
        const { row, access } = await loadAccess(pool, userId, uid);
        authz.requireRight(access, "reveal");
        if (row.secret_ciphertext === null || row.secret_ciphertext === undefined) throw notFound();
        const keyRows = await store.itemKeysForUser(pool, [row.id], userId);
        const memberKeys = row.collection_id ? await store.memberKeysForUser(pool, [row.collection_id], userId) : [];
        await store.audit(pool, { kind: "secret_delivered", actor: userId, subject: userId, itemUid: row.uid });
        return {
            uid: row.uid,
            version: row.version,
            keyVersion: row.key_version,
            secret: V.encode(row.secret_ciphertext),
            keys: sourcesFor(row, access, keyRows, memberKeys[0], { includeSecret: true }),
        };
    }

    // A browser reports that it displayed/copied a secret. Stored as REPORTED (a modified client can omit it): not proof of anything.
    async function reportAccess(userId, uid, kind) {
        const action = V.oneOf(kind, ["reveal", "copy"], "kind");
        await actorOf(userId);
        const { row, access } = await loadAccess(pool, userId, uid);
        authz.requireRight(access, action === "copy" ? "copy" : "reveal");
        await store.audit(pool, { kind: action === "copy" ? "copy_reported" : "reveal_reported", actor: userId, subject: userId, itemUid: row.uid });
        return { recorded: true };
    }

    function parseItemBody(body) {
        const kind = V.oneOf(body.kind || "login", V.LIMITS.ITEM_KINDS, "kind");
        const meta = V.aeadEnvelope(body.meta, "meta", { max: V.LIMITS.META_BYTES });
        const secret = body.secret === null || body.secret === undefined ? null : V.aeadEnvelope(body.secret, "secret", { max: V.LIMITS.SECRET_BYTES });
        const rotationIntervalDays = V.optionalDays(body.rotationIntervalDays, "rotationIntervalDays", V.LIMITS.MAX_ROTATION_INTERVAL_DAYS);
        return { kind, meta, secret, rotationIntervalDays };
    }

    async function createPersonalItem(userId, body) {
        const uid = V.uuid(body.uid, "uid");
        const parsed = parseItemBody(body);
        const keys = body.keys || {};
        const ownerMeta = V.wrappedKey(keys.meta, "keys.meta");
        const ownerSecret = parsed.secret ? V.wrappedKey(keys.secret, "keys.secret") : null;
        if (!parsed.secret && keys.secret) throw invalid("keys.secret is invalid.");
        await actorOf(userId);
        return store.tx(async (db) => {
            let item;
            try {
                item = await store.insertItem(db, { uid, ownerUserId: userId, collectionId: null, kind: parsed.kind, meta: parsed.meta, secret: parsed.secret, keyVersion: 1, rotationIntervalDays: parsed.rotationIntervalDays, createdBy: userId });
            } catch (error) {
                if (error.code === "23505") throw conflict("UID_IN_USE", "That id is already used.");
                throw error;
            }
            await store.insertItemKey(db, { itemId: item.id, holderType: "owner", holderUserId: userId, purpose: "meta", wrappedKey: ownerMeta, senderUserId: null, keyVersion: 1 });
            if (ownerSecret) await store.insertItemKey(db, { itemId: item.id, holderType: "owner", holderUserId: userId, purpose: "secret", wrappedKey: ownerSecret, senderUserId: null, keyVersion: 1 });
            await store.audit(db, { kind: "item_created", actor: userId, subject: userId, itemUid: uid, detail: "ownership=personal" });
            return { uid, version: item.version, keyVersion: 1 };
        });
    }

    async function createCompanyItem(userId, collectionUid, body) {
        await actorOf(userId);
        return store.tx(async (db) => {
            const collection = await store.getCollectionForUser(db, userId, V.uuid(collectionUid, "collection"));
            if (!collection || collection.archived_at) throw notFound();
            if (!collection.m_edit) throw forbidden(); // authorise first, then look at the payload
            const uid = V.uuid(body.uid, "uid");
            const parsed = parseItemBody(body);
            const keys = body.keys || {};
            const wrappedMeta = V.wrappedKey(keys.meta, "keys.meta");
            const wrappedSecret = parsed.secret ? V.wrappedKey(keys.secret, "keys.secret") : null;
            if (!parsed.secret && keys.secret) throw invalid("keys.secret is invalid.");
            let item;
            try {
                item = await store.insertItem(db, { uid, ownerUserId: null, collectionId: collection.id, kind: parsed.kind, meta: parsed.meta, secret: parsed.secret, keyVersion: 1, rotationIntervalDays: parsed.rotationIntervalDays, createdBy: userId });
            } catch (error) {
                if (error.code === "23505") throw conflict("UID_IN_USE", "That id is already used.");
                throw error;
            }
            await store.insertItemKey(db, { itemId: item.id, holderType: "collection", holderUserId: null, purpose: "meta", wrappedKey: wrappedMeta, senderUserId: null, keyVersion: 1 });
            if (wrappedSecret) await store.insertItemKey(db, { itemId: item.id, holderType: "collection", holderUserId: null, purpose: "secret", wrappedKey: wrappedSecret, senderUserId: null, keyVersion: 1 });
            await store.audit(db, { kind: "item_created", actor: userId, subject: userId, itemUid: uid, collectionUid: collection.uid, detail: "ownership=company" });
            return { uid, version: item.version, keyVersion: 1 };
        });
    }

    async function updateItem(userId, uid, body) {
        const expected = V.positiveInteger(body.expectedVersion, "expectedVersion");
        const patch = {};
        let touchesContent = false;
        if (body.meta !== undefined) { patch.meta_ciphertext = V.aeadEnvelope(body.meta, "meta", { max: V.LIMITS.META_BYTES }); touchesContent = true; }
        if (body.secret !== undefined) {
            patch.secret_ciphertext = body.secret === null ? null : V.aeadEnvelope(body.secret, "secret", { max: V.LIMITS.SECRET_BYTES });
            patch.last_rotated_at = new Date().toISOString();
            patch.reminder_sent_at = null;
            touchesContent = true;
        }
        if (body.kind !== undefined) { patch.kind = V.oneOf(body.kind, V.LIMITS.ITEM_KINDS, "kind"); touchesContent = true; }
        if (body.rotationIntervalDays !== undefined) patch.rotation_interval_days = V.optionalDays(body.rotationIntervalDays, "rotationIntervalDays", V.LIMITS.MAX_ROTATION_INTERVAL_DAYS);
        if (body.rotationDueAt !== undefined) patch.rotation_due_at = V.optionalTimestamp(body.rotationDueAt, "rotationDueAt");
        if (body.favorite !== undefined) patch.favorite = V.boolean(body.favorite, "favorite");
        if (Object.keys(patch).length === 0) throw invalid("Nothing to change.");
        await actorOf(userId);
        return store.tx(async (db) => {
            const { row, access } = await loadAccess(db, userId, uid, { forUpdate: true });
            if (touchesContent) authz.requireRight(access, "edit"); // editing a secret implies the right to reveal it (it is re-encrypted under the same key)
            if (patch.favorite !== undefined && !access.paths.owner) throw forbidden();
            if (patch.rotation_interval_days !== undefined || patch.rotation_due_at !== undefined) authz.requireOwnerOrManager(access);
            const version = await store.updateItem(db, row.id, expected, patch);
            if (version === null) throw conflict("STALE_VERSION", "This item was changed by someone else. Reload and try again.");
            if (touchesContent) await store.audit(db, { kind: "item_updated", actor: userId, subject: userId, itemUid: row.uid, collectionUid: row.collection_uid });
            else if (patch.rotation_interval_days !== undefined || patch.rotation_due_at !== undefined) await store.audit(db, { kind: "item_updated", actor: userId, subject: userId, itemUid: row.uid, collectionUid: row.collection_uid, detail: "rotation_schedule" });
            return { uid: row.uid, version };
        });
    }

    async function setDeleted(userId, uid, deleted) {
        await actorOf(userId);
        return store.tx(async (db) => {
            const { row, access } = await loadAccess(db, userId, uid, { includeDeleted: true, forUpdate: true });
            authz.requireOwnerOrManager(access);
            if (Boolean(row.deleted_at) === deleted) throw conflict("NO_CHANGE", deleted ? "Already deleted." : "Not deleted.");
            await store.setItemDeleted(db, row.id, deleted);
            await store.audit(db, { kind: deleted ? "item_deleted" : "item_restored", actor: userId, subject: userId, itemUid: row.uid, collectionUid: row.collection_uid });
            return { uid: row.uid, deleted };
        });
    }

    // Replace ALL key material of one item (after a revocation, or on demand): brand-new item keys, re-encrypted content, new wrappers for
    // every remaining holder. Shared by item rotation and collection rotation. The caller proves nothing cryptographically -- if it sends
    // the wrong wrappers, the holders simply cannot decrypt -- but the SET of holders must match what the database says exactly.
    async function applyItemRotation(db, row, payload, actorId, { holder }) {
        if (payload.keyVersion !== row.key_version + 1) throw conflict("STALE_KEY_VERSION", "The item's keys changed. Reload and try again.");
        const expiredIds = (await db.query(`SELECT id FROM zv_grants WHERE item_id = ? AND revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= now()`, [row.id]))[0].map((g) => g.id);
        if (expiredIds.length > 0) await store.revokeGrants(db, expiredIds, null, "expired");
        const grants = (await db.query(`SELECT recipient_user_id, can_reveal FROM zv_grants WHERE item_id = ? AND revoked_at IS NULL`, [row.id]))[0];

        const supplied = payload.recipients;
        const wanted = new Map(grants.map((g) => [Number(g.recipient_user_id), g]));
        if (supplied.length !== wanted.size || supplied.some((r) => !wanted.has(r.userId)) || new Set(supplied.map((r) => r.userId)).size !== supplied.length) {
            throw invalid("The recipients do not match the people who currently have access.", "RECIPIENTS_MISMATCH");
        }
        for (const r of supplied) {
            const grant = wanted.get(r.userId);
            if (grant.can_reveal !== Boolean(r.boxedSecretKey)) throw invalid("A recipient's keys do not match their rights.", "RECIPIENTS_MISMATCH");
        }
        if (Boolean(payload.secret) !== Boolean(payload.holderSecret)) throw invalid("The secret and its key must be given together.");
        // every attachment's file key is wrapped under the item's secret key: a new secret key means every one must be re-wrapped, or the file is lost
        const liveFiles = await store.attachmentsOfItem(db, row.id);
        if (payload.attachments.length !== liveFiles.length || payload.attachments.some((a) => !liveFiles.find((f) => f.uid === a.uid)) || new Set(payload.attachments.map((a) => a.uid)).size !== payload.attachments.length) {
            throw invalid("The attachments do not match the item's current attachments.", "ATTACHMENTS_MISMATCH");
        }
        for (const a of payload.attachments) await store.updateAttachmentKey(db, liveFiles.find((f) => f.uid === a.uid).id, a.wrappedFileKey);

        await db.query(`DELETE FROM zv_item_keys WHERE item_id = ?`, [row.id]);
        const kv = payload.keyVersion;
        if (holder.type === "owner") {
            await store.insertItemKey(db, { itemId: row.id, holderType: "owner", holderUserId: row.owner_user_id, purpose: "meta", wrappedKey: payload.holderMeta, senderUserId: null, keyVersion: kv });
            if (payload.holderSecret) await store.insertItemKey(db, { itemId: row.id, holderType: "owner", holderUserId: row.owner_user_id, purpose: "secret", wrappedKey: payload.holderSecret, senderUserId: null, keyVersion: kv });
        } else {
            await store.insertItemKey(db, { itemId: row.id, holderType: "collection", holderUserId: null, purpose: "meta", wrappedKey: payload.holderMeta, senderUserId: null, keyVersion: kv });
            if (payload.holderSecret) await store.insertItemKey(db, { itemId: row.id, holderType: "collection", holderUserId: null, purpose: "secret", wrappedKey: payload.holderSecret, senderUserId: null, keyVersion: kv });
        }
        for (const r of supplied) {
            await store.insertItemKey(db, { itemId: row.id, holderType: "user", holderUserId: r.userId, purpose: "meta", wrappedKey: r.boxedMetaKey, senderUserId: actorId, keyVersion: kv });
            if (r.boxedSecretKey) await store.insertItemKey(db, { itemId: row.id, holderType: "user", holderUserId: r.userId, purpose: "secret", wrappedKey: r.boxedSecretKey, senderUserId: actorId, keyVersion: kv });
        }
        const patch = { meta_ciphertext: payload.meta, secret_ciphertext: payload.secret, key_version: kv, rotation_required: false };
        const version = await store.updateItem(db, row.id, payload.expectedVersion, patch);
        if (version === null) throw conflict("STALE_VERSION", "This item was changed by someone else. Reload and try again.");
        await store.audit(db, { kind: "item_rotated", actor: actorId, subject: actorId, itemUid: row.uid, collectionUid: row.collection_uid, detail: `key_version=${kv}` });
        return version;
    }

    function parseRotation(input) {
        return {
            expectedVersion: V.positiveInteger(input.expectedVersion, "expectedVersion"),
            keyVersion: V.positiveInteger(input.keyVersion, "keyVersion"),
            meta: V.aeadEnvelope(input.meta, "meta", { max: V.LIMITS.META_BYTES }),
            secret: input.secret === null || input.secret === undefined ? null : V.aeadEnvelope(input.secret, "secret", { max: V.LIMITS.SECRET_BYTES }),
            holderMeta: V.wrappedKey(input.keys?.meta, "keys.meta"),
            holderSecret: input.secret ? V.wrappedKey(input.keys?.secret, "keys.secret") : null,
            attachments: (Array.isArray(input.attachments) ? input.attachments : []).map((a) => ({ uid: V.uuid(a.uid, "attachments.uid"), wrappedFileKey: V.wrappedKey(a.wrappedFileKey, "attachments.wrappedFileKey") })),
            recipients: (Array.isArray(input.recipients) ? input.recipients : []).map((r) => ({
                userId: V.positiveInteger(r.userId, "recipients.userId"),
                boxedMetaKey: V.boxedKey(r.boxedMetaKey, "recipients.boxedMetaKey"),
                boxedSecretKey: r.boxedSecretKey ? V.boxedKey(r.boxedSecretKey, "recipients.boxedSecretKey") : null,
            })),
        };
    }

    async function rotateItem(userId, uid, body) {
        await actorOf(userId);
        return store.tx(async (db) => {
            const { row, access } = await loadAccess(db, userId, uid, { forUpdate: true });
            authz.requireOwnerOrManager(access);
            authz.requireRight(access, "reveal");
            const payload = parseRotation(body);
            const version = await applyItemRotation(db, row, payload, userId, { holder: { type: row.owner_user_id ? "owner" : "collection" } });
            return { uid: row.uid, version, keyVersion: payload.keyVersion };
        });
    }

    // ------------------------------------------------------------------ collections
    function presentCollection(row, { withKeys = true } = {}) {
        const rights = { reveal: Boolean(row.m_reveal), copy: Boolean(row.m_copy), edit: Boolean(row.m_edit), share: Boolean(row.m_share), manage: Boolean(row.m_manager) };
        return {
            uid: row.uid,
            kind: row.kind,
            name: V.encode(row.name_ciphertext),
            keyVersion: row.key_version,
            rotationRequired: Boolean(row.rotation_required),
            createdAt: iso(row.created_at),
            rights,
            expiresAt: iso(row.m_expires),
            ...(withKeys
                ? {
                      keys: {
                          keyVersion: row.m_key_version,
                          sender: row.sender_user_id ? { userId: Number(row.sender_user_id), publicKey: V.encode(row.sender_public_key) } : null,
                          wrappedMetaKey: V.encode(row.wrapped_meta_key),
                          wrappedSecretKey: V.encode(row.wrapped_secret_key),
                      },
                  }
                : {}),
        };
    }

    async function createCollection(userId, body) {
        const { user } = await actorOf(userId);
        if (!authz.canCreateCollections(user)) throw forbidden("Only a company administrator can create a company collection.");
        const uid = V.uuid(body.uid, "uid");
        const kind = V.oneOf(body.kind || "general", V.LIMITS.COLLECTION_KINDS, "kind");
        const name = V.aeadEnvelope(body.name, "name", { max: V.LIMITS.NAME_BYTES });
        const wrappedMeta = V.boxedKey(body.keys?.meta, "keys.meta");
        const wrappedSecret = V.boxedKey(body.keys?.secret, "keys.secret");
        return store.tx(async (db) => {
            let created;
            try {
                created = await store.insertCollection(db, { uid, kind, name, createdBy: userId });
            } catch (error) {
                if (error.code === "23505") throw conflict("UID_IN_USE", "That id is already used.");
                throw error;
            }
            await store.insertMember(db, {
                collectionId: created.id, userId, rights: { reveal: true, copy: true, edit: true, share: true, manager: true },
                wrappedMetaKey: wrappedMeta, wrappedSecretKey: wrappedSecret, senderUserId: userId, keyVersion: 1, expiresAt: null, addedBy: userId,
            });
            await store.audit(db, { kind: "collection_created", actor: userId, subject: userId, collectionUid: uid });
            return { uid, keyVersion: 1 };
        });
    }

    // The name (and description) are inside one encrypted envelope made with the collection's meta key; the server only replaces the ciphertext.
    async function renameCollection(userId, collectionUid, body) {
        await actorOf(userId);
        return store.tx(async (db) => {
            const collection = await requireCollectionManager(db, userId, collectionUid); // authorise first, then look at the payload
            if (collection.archived_at) throw notFound();
            const name = V.aeadEnvelope(body.name, "name", { max: V.LIMITS.NAME_BYTES });
            if (!(await store.renameCollection(db, collection.id, name))) throw notFound();
            await store.audit(db, { kind: "collection_renamed", actor: userId, subject: userId, collectionUid: collection.uid });
            return { uid: collection.uid };
        });
    }

    // Archiving hides the collection and its items from everyone and stops new members and items. Nothing is deleted.
    async function archiveCollection(userId, collectionUid) {
        await actorOf(userId);
        return store.tx(async (db) => {
            const collection = await requireCollectionManager(db, userId, collectionUid);
            if (collection.archived_at) throw notFound();
            if (!(await store.archiveCollection(db, collection.id))) throw notFound();
            await store.audit(db, { kind: "collection_archived", actor: userId, subject: userId, collectionUid: collection.uid });
            return { uid: collection.uid };
        });
    }

    async function outgoingShares(userId) {
        await actorOf(userId);
        return (await store.listOutgoingGrants(pool, userId)).map((g) => ({
            grantId: g.id, itemUid: g.item_uid, recipientUserId: Number(g.recipient_user_id), name: g.full_name, employeeId: g.employee_id,
            rights: { reveal: g.can_reveal, copy: g.can_copy, edit: g.can_edit, share: g.can_share },
            expiresAt: iso(g.expires_at), expired: Boolean(g.expired), revokedAt: iso(g.revoked_at), createdAt: iso(g.created_at),
            status: g.revoked_at ? "revoked" : g.expired ? "expired" : "active",
        }));
    }

    async function listCollections(userId) {
        await actorOf(userId);
        return (await store.listCollectionsForUser(pool, userId)).map((row) => presentCollection(row));
    }

    async function requireCollectionManager(db, userId, uid) {
        const collection = await store.getCollectionForUser(db, userId, V.uuid(uid, "collection"));
        if (!collection) throw notFound();
        if (!collection.m_manager) throw forbidden();
        return collection;
    }

    async function getCollection(userId, uid) {
        await actorOf(userId);
        const collection = await store.getCollectionForUser(pool, userId, V.uuid(uid, "collection"));
        if (!collection) throw notFound();
        const out = presentCollection(collection);
        if (collection.m_manager) {
            out.members = (await store.listMembers(pool, collection.id)).map((m) => ({
                userId: Number(m.user_id), name: m.full_name, employeeId: m.employee_id, employmentType: m.employment_type,
                rights: { reveal: m.can_reveal, copy: m.can_copy, edit: m.can_edit, share: m.can_share, manage: m.is_manager }, expiresAt: iso(m.expires_at), addedAt: iso(m.created_at),
            }));
        }
        return out;
    }

    function parseMemberBody(body) {
        const rights = V.rights(body.rights);
        return {
            rights,
            wrappedMetaKey: V.boxedKey(body.wrappedMetaKey, "wrappedMetaKey"),
            wrappedSecretKey: rights.reveal ? V.boxedKey(body.wrappedSecretKey, "wrappedSecretKey") : null,
            expiresAt: V.expiresAt(body.expiresAt),
        };
    }

    async function addMember(userId, collectionUid, body) {
        await actorOf(userId);
        return store.tx(async (db) => {
            const collection = await requireCollectionManager(db, userId, collectionUid);
            const targetId = V.positiveInteger(body.userId, "userId");
            const parsed = parseMemberBody(body);
            if (!parsed.rights.reveal && body.wrappedSecretKey) throw invalid("wrappedSecretKey is invalid.");
            if (collection.archived_at) throw notFound();
            if (targetId === userId) throw invalid("You are already a member.");
            const target = await store.getActiveUserWithAccount(db, targetId);
            if (!target) throw invalid("That person is not available (they must be an active user with a ZioVault).", "RECIPIENT_UNAVAILABLE");
            if (parsed.expiresAt) await assertFutureWithinLimit(db, parsed.expiresAt);
            if (await store.getMember(db, collection.id, targetId)) throw conflict("ALREADY_MEMBER", "Already a member.");
            await store.insertMember(db, { collectionId: collection.id, userId: targetId, rights: parsed.rights, wrappedMetaKey: parsed.wrappedMetaKey, wrappedSecretKey: parsed.wrappedSecretKey, senderUserId: userId, keyVersion: collection.key_version, expiresAt: parsed.expiresAt, addedBy: userId });
            await store.audit(db, { kind: "collection_member_added", actor: userId, subject: targetId, collectionUid: collection.uid, detail: `rights=${rightsLabel(parsed.rights)}${parsed.rights.manager ? ".manager" : ""}` });
            return { userId: targetId };
        });
    }

    async function updateMember(userId, collectionUid, targetIdRaw, body) {
        const targetId = V.positiveInteger(targetIdRaw, "userId");
        await actorOf(userId);
        return store.tx(async (db) => {
            const collection = await requireCollectionManager(db, userId, collectionUid);
            const member = await store.getMember(db, collection.id, targetId);
            if (!member) throw notFound();
            const rights = body.rights === undefined ? { reveal: member.can_reveal, copy: member.can_copy, edit: member.can_edit, share: member.can_share, manager: member.is_manager } : V.rights(body.rights);
            const expiresAt = body.expiresAt === undefined ? (member.expires_at ? member.expires_at.toISOString() : null) : V.expiresAt(body.expiresAt);
            if (body.expiresAt !== undefined && expiresAt) await assertFutureWithinLimit(db, expiresAt);
            if (member.is_manager && !rights.manager && (await store.countManagers(db, collection.id)) <= 1) throw conflict("LAST_MANAGER", "A collection needs at least one manager.");
            let secretKey = member.wrapped_secret_key;
            let lostSecret = false;
            if (rights.reveal && !member.can_reveal) secretKey = V.boxedKey(body.wrappedSecretKey, "wrappedSecretKey"); // gaining reveal needs a NEW envelope
            if (!rights.reveal && member.can_reveal) { secretKey = null; lostSecret = true; } // the key they already saw cannot be taken back: rotate
            if (rights.reveal && member.can_reveal && body.wrappedSecretKey) throw invalid("wrappedSecretKey is invalid.");
            await db.query(
                `UPDATE zv_collection_members SET can_reveal = ?, can_copy = ?, can_edit = ?, can_share = ?, is_manager = ?, wrapped_secret_key = ?, expires_at = ?, updated_at = now() WHERE collection_id = ? AND user_id = ?`,
                [rights.reveal, rights.copy, rights.edit, rights.share, rights.manager, secretKey, expiresAt, collection.id, targetId]
            );
            if (lostSecret) await db.query(`UPDATE zv_collections SET rotation_required = TRUE, updated_at = now() WHERE id = ?`, [collection.id]);
            await store.audit(db, { kind: "collection_member_changed", actor: userId, subject: targetId, collectionUid: collection.uid, detail: `rights=${rightsLabel(rights)}${rights.manager ? ".manager" : ""}` });
            return { userId: targetId };
        });
    }

    async function removeMember(userId, collectionUid, targetIdRaw) {
        const targetId = V.positiveInteger(targetIdRaw, "userId");
        await actorOf(userId);
        return store.tx(async (db) => {
            const collectionRow = await store.getCollectionForUser(db, userId, V.uuid(collectionUid, "collection"));
            if (!collectionRow) throw notFound();
            const self = targetId === userId;
            if (!self && !collectionRow.m_manager) throw forbidden();
            const locked = await store.lockCollection(db, collectionRow.uid);
            const member = await store.getMember(db, locked.id, targetId);
            if (!member) throw notFound();
            if (member.is_manager && (await store.countManagers(db, locked.id)) <= 1) throw conflict("LAST_MANAGER", "A collection needs at least one manager.");
            await store.removeMembers(db, locked.id, [targetId], userId, "manual");
            return { userId: targetId, rotationRequired: true };
        });
    }

    // Rotate a collection: new collection keys, new keys for EVERY item in it (a removed member who knew the old keys also knew the item
    // keys), re-encrypted content, new wrappers for every remaining member and for every item share. Atomic: all or nothing.
    async function rotateCollection(userId, collectionUid, body) {
        await actorOf(userId);
        return store.tx(async (db) => {
            const manager = await requireCollectionManager(db, userId, collectionUid); // authorise first, then look at the payload
            const expectedKeyVersion = V.positiveInteger(body.expectedKeyVersion, "expectedKeyVersion");
            // the name (and description) are encrypted under the collection's meta key: new keys need a new envelope, or nobody could read it again
            const name = V.aeadEnvelope(body.name, "name", { max: V.LIMITS.NAME_BYTES });
            const members = (Array.isArray(body.members) ? body.members : []).map((m) => ({
                userId: V.positiveInteger(m.userId, "members.userId"),
                wrappedMetaKey: V.boxedKey(m.wrappedMetaKey, "members.wrappedMetaKey"),
                wrappedSecretKey: m.wrappedSecretKey ? V.boxedKey(m.wrappedSecretKey, "members.wrappedSecretKey") : null,
            }));
            const itemList = Array.isArray(body.items) ? body.items : [];
            if (itemList.length > V.LIMITS.MAX_ROTATION_BATCH_ITEMS) throw invalid("Too many items in one rotation.");
            const items = itemList.map((i) => ({ uid: V.uuid(i.uid, "items.uid"), ...parseRotation(i) }));
            const collection = await store.lockCollection(db, manager.uid);
            if (collection.key_version !== expectedKeyVersion) throw conflict("STALE_KEY_VERSION", "The collection's keys changed. Reload and try again.");

            const current = await store.membersOfCollection(db, collection.id);
            const currentIds = new Set(current.map((m) => Number(m.user_id)));
            if (members.length !== currentIds.size || members.some((m) => !currentIds.has(m.userId)) || new Set(members.map((m) => m.userId)).size !== members.length) {
                throw invalid("The members do not match the current membership.", "MEMBERS_MISMATCH");
            }
            const flags = new Map((await db.query(`SELECT user_id, can_reveal FROM zv_collection_members WHERE collection_id = ?`, [collection.id]))[0].map((m) => [Number(m.user_id), m.can_reveal]));
            for (const m of members) if (flags.get(m.userId) !== Boolean(m.wrappedSecretKey)) throw invalid("A member's keys do not match their rights.", "MEMBERS_MISMATCH");

            const live = await store.liveItemsOfCollection(db, collection.id);
            if (live.length !== items.length || items.some((i) => !live.find((l) => l.uid === i.uid)) || new Set(items.map((i) => i.uid)).size !== items.length) {
                throw invalid("The items do not match the collection's current items.", "ITEMS_MISMATCH");
            }

            const nextVersion = collection.key_version + 1;
            for (const m of members) {
                await db.query(
                    `UPDATE zv_collection_members SET wrapped_meta_key = ?, wrapped_secret_key = ?, sender_user_id = ?, key_version = ?, updated_at = now() WHERE collection_id = ? AND user_id = ?`,
                    [m.wrappedMetaKey, m.wrappedSecretKey, userId, nextVersion, collection.id, m.userId]
                );
            }
            for (const item of items) {
                const row = await store.findItemForUser(db, userId, item.uid, { forUpdate: true });
                if (!row) throw notFound();
                await applyItemRotation(db, row, { ...item, holderMeta: item.holderMeta, holderSecret: item.holderSecret }, userId, { holder: { type: "collection" } });
            }
            await db.query(`UPDATE zv_collections SET key_version = ?, name_ciphertext = ?, rotation_required = FALSE, updated_at = now() WHERE id = ?`, [nextVersion, name, collection.id]);
            await store.audit(db, { kind: "collection_rotated", actor: userId, subject: userId, collectionUid: collection.uid, detail: `key_version=${nextVersion}` });
            return { uid: collection.uid, keyVersion: nextVersion, items: items.length };
        });
    }

    // ------------------------------------------------------------------ grants (sharing a single item)
    async function requireSharer(db, userId, uid) {
        const { row, access } = await loadAccess(db, userId, uid, { forUpdate: true });
        authz.requireRight(access, "share");
        return { row, access };
    }

    function parseGrantBody(body, { requireMeta }) {
        const rights = V.rights(body.rights);
        if (rights.manager) throw invalid("rights is invalid.");
        const out = { rights, expiresAt: V.expiresAt(body.expiresAt) };
        out.boxedMetaKey = requireMeta || body.boxedMetaKey ? V.boxedKey(body.boxedMetaKey, "boxedMetaKey") : null;
        out.boxedSecretKey = body.boxedSecretKey ? V.boxedKey(body.boxedSecretKey, "boxedSecretKey") : null;
        return out;
    }

    async function boundExpiry(db, access, wantedExpiry) {
        // Access handed on can never outlive the access it comes from.
        if (access.via !== "owner" && access.expiresAt) {
            if (!wantedExpiry || new Date(wantedExpiry) > new Date(access.expiresAt)) throw invalid("The expiry cannot be later than your own access ends.");
        }
        if (wantedExpiry) await assertFutureWithinLimit(db, wantedExpiry);
    }

    async function createGrant(userId, uid, body) {
        await actorOf(userId);
        return store.tx(async (db) => {
            const { row, access } = await requireSharer(db, userId, uid); // authorise first, then look at the payload
            const recipientId = V.positiveInteger(body.recipientUserId, "recipientUserId");
            const parsed = parseGrantBody(body, { requireMeta: true });
            if (parsed.rights.reveal !== Boolean(parsed.boxedSecretKey)) throw invalid("The secret key is given exactly when the right to reveal is.", "KEY_RIGHT_MISMATCH");
            if (recipientId === userId || recipientId === num(row.owner_user_id)) throw invalid("You cannot share with yourself or the owner.");
            authz.assertGrantable(access, parsed.rights);
            const recipient = await store.getActiveUserWithAccount(db, recipientId);
            if (!recipient) throw invalid("That person is not available (they must be an active user with a ZioVault).", "RECIPIENT_UNAVAILABLE");
            await boundExpiry(db, access, parsed.expiresAt);
            if (await store.getActiveGrant(db, row.id, recipientId)) throw conflict("ALREADY_SHARED", "Already shared with this person; change the existing share instead.");
            const grant = await store.insertGrant(db, { itemId: row.id, recipientUserId: recipientId, rights: parsed.rights, expiresAt: parsed.expiresAt, grantedBy: userId, parentGrantId: access.grantId });
            await store.insertItemKey(db, { itemId: row.id, holderType: "user", holderUserId: recipientId, purpose: "meta", wrappedKey: parsed.boxedMetaKey, senderUserId: userId, keyVersion: row.key_version });
            if (parsed.boxedSecretKey) await store.insertItemKey(db, { itemId: row.id, holderType: "user", holderUserId: recipientId, purpose: "secret", wrappedKey: parsed.boxedSecretKey, senderUserId: userId, keyVersion: row.key_version });
            await store.audit(db, { kind: "item_shared", actor: userId, subject: recipientId, itemUid: row.uid, collectionUid: row.collection_uid, detail: `rights=${rightsLabel(parsed.rights)},expires=${parsed.expiresAt ? "yes" : "no"}` });
            return { grantId: grant.id, recipientUserId: recipientId };
        });
    }

    async function listGrants(userId, uid) {
        await actorOf(userId);
        const { row, access } = await loadAccess(pool, userId, uid);
        authz.requireRight(access, "share");
        return (await store.listGrants(pool, row.id)).map((g) => ({
            grantId: g.id, recipientUserId: Number(g.recipient_user_id), name: g.full_name, employeeId: g.employee_id,
            rights: { reveal: g.can_reveal, copy: g.can_copy, edit: g.can_edit, share: g.can_share }, expiresAt: iso(g.expires_at), expired: Boolean(g.expired), grantedBy: num(g.granted_by), createdAt: iso(g.created_at),
        }));
    }

    async function updateGrant(userId, uid, recipientIdRaw, body) {
        const recipientId = V.positiveInteger(recipientIdRaw, "recipientUserId");
        await actorOf(userId);
        return store.tx(async (db) => {
            const { row, access } = await requireSharer(db, userId, uid);
            const grant = await store.getActiveGrant(db, row.id, recipientId);
            if (!grant) throw notFound();
            if (!(access.paths.owner || access.rights.manage || num(grant.granted_by) === userId)) throw forbidden();
            const parsed = parseGrantBody({ ...body, rights: body.rights === undefined ? { reveal: grant.can_reveal, copy: grant.can_copy, edit: grant.can_edit, share: grant.can_share } : body.rights }, { requireMeta: false });
            const expiresAt = body.expiresAt === undefined ? (grant.expires_at ? grant.expires_at.toISOString() : null) : parsed.expiresAt;
            authz.assertGrantable(access, parsed.rights);
            if (body.expiresAt !== undefined) await boundExpiry(db, access, expiresAt);
            if (parsed.boxedMetaKey) throw invalid("boxedMetaKey is invalid.");

            const gainsReveal = parsed.rights.reveal && !grant.can_reveal;
            const losesReveal = !parsed.rights.reveal && grant.can_reveal;
            if (gainsReveal) {
                if (!parsed.boxedSecretKey) throw invalid("Giving the right to reveal needs the secret key for that person.", "KEY_RIGHT_MISMATCH");
                await store.insertItemKey(db, { itemId: row.id, holderType: "user", holderUserId: recipientId, purpose: "secret", wrappedKey: parsed.boxedSecretKey, senderUserId: userId, keyVersion: row.key_version });
            } else if (parsed.boxedSecretKey) {
                throw invalid("boxedSecretKey is invalid.", "KEY_RIGHT_MISMATCH");
            }
            if (losesReveal) {
                await store.deleteItemKeys(db, row.id, "user", recipientId, "secret");
                await db.query(`UPDATE zv_items SET rotation_required = TRUE WHERE id = ?`, [row.id]); // they already saw the secret key: rotate
            }
            await db.query(`UPDATE zv_grants SET can_reveal = ?, can_copy = ?, can_edit = ?, can_share = ?, expires_at = ?, updated_at = now() WHERE id = ?`, [parsed.rights.reveal, parsed.rights.copy, parsed.rights.edit, parsed.rights.share, expiresAt, grant.id]);

            // Re-shares made by this person can never exceed what they now hold.
            const stale = (await db.query(
                `SELECT g.id FROM zv_grants g WHERE g.parent_grant_id = ? AND g.revoked_at IS NULL
                   AND ((g.can_reveal AND NOT ?) OR (g.can_copy AND NOT ?) OR (g.can_edit AND NOT ?) OR (g.expires_at IS NULL AND ?::timestamptz IS NOT NULL) OR (g.expires_at > ?::timestamptz))`,
                [grant.id, parsed.rights.reveal, parsed.rights.copy, parsed.rights.edit, expiresAt, expiresAt]
            ))[0].map((g) => g.id);
            if (stale.length > 0) await store.revokeGrants(db, stale, userId, "parent_reduced");
            await store.audit(db, { kind: "share_changed", actor: userId, subject: recipientId, itemUid: row.uid, collectionUid: row.collection_uid, detail: `rights=${rightsLabel(parsed.rights)},expires=${expiresAt ? "yes" : "no"}` });
            return { grantId: grant.id };
        });
    }

    async function revokeGrant(userId, uid, recipientIdRaw) {
        const recipientId = V.positiveInteger(recipientIdRaw, "recipientUserId");
        await actorOf(userId);
        return store.tx(async (db) => {
            const { row, access } = await requireSharer(db, userId, uid);
            const grant = await store.getActiveGrant(db, row.id, recipientId);
            if (!grant) throw notFound();
            if (!(access.paths.owner || access.rights.manage || num(grant.granted_by) === userId)) throw forbidden();
            const revoked = await store.revokeGrants(db, [grant.id], userId, "manual");
            return { revoked, rotationRequired: Boolean(grant.can_reveal) };
        });
    }

    // ------------------------------------------------------------------ folders (personal; names are ciphertext)
    const presentFolder = (row) => ({ uid: row.uid, name: V.encode(row.name_ciphertext), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });

    async function listFolders(userId) {
        await actorOf(userId);
        return (await store.listFolders(pool, userId)).map(presentFolder);
    }

    async function createFolder(userId, body) {
        await actorOf(userId);
        return store.tx(async (db) => {
            if ((await store.countFolders(db, userId)) >= V.LIMITS.MAX_FOLDERS) throw conflict("TOO_MANY_FOLDERS", "That is the most folders one vault can have.");
            const uid = V.uuid(body.uid, "uid");
            const name = V.aeadEnvelope(body.name, "name", { max: V.LIMITS.NAME_BYTES });
            try {
                await store.insertFolder(db, { uid, ownerUserId: userId, name });
            } catch (error) {
                if (error.code === "23505") throw conflict("UID_IN_USE", "That id is already used.");
                throw error;
            }
            return { uid };
        });
    }

    async function renameFolder(userId, uid, body) {
        await actorOf(userId);
        const name = V.aeadEnvelope(body.name, "name", { max: V.LIMITS.NAME_BYTES });
        const row = await store.renameFolder(pool, userId, V.uuid(uid, "folder"), name);
        if (!row) throw notFound();
        return { uid: row.uid };
    }

    // Deleting a folder never touches an item: the folder id sits inside each item's ENCRYPTED details, and an item whose folder no
    // longer exists is simply shown as unfiled.
    async function deleteFolder(userId, uid) {
        await actorOf(userId);
        const row = await store.deleteFolder(pool, userId, V.uuid(uid, "folder"));
        if (!row) throw notFound();
        return { uid: row.uid };
    }

    // ------------------------------------------------------------------ attachments (the file arrives ALREADY ENCRYPTED; its key is wrapped under the item's secret key)
    // Whoever may reveal an item may open its files; whoever may edit it may add or remove them. Nothing here can read a file or its name.
    async function addAttachment(userId, itemUid, body) {
        await actorOf(userId);
        return store.tx(async (db) => {
            const { row, access } = await loadAccess(db, userId, itemUid, { forUpdate: true });
            authz.requireRight(access, "edit"); // authorise first, then look at the payload
            const uid = V.uuid(body.uid, "uid");
            const meta = V.aeadEnvelope(body.meta, "meta", { max: V.LIMITS.ATTACHMENT_META_BYTES });
            const wrappedFileKey = V.wrappedKey(body.wrappedFileKey, "wrappedFileKey");
            const content = V.bytes(body.content, "content", { min: V.LIMITS.ATTACHMENT_MIN_BYTES, max: V.LIMITS.ATTACHMENT_MAX_BYTES });
            const stats = await store.attachmentStats(db, row.id);
            if (stats.n >= V.LIMITS.MAX_ATTACHMENTS_PER_ITEM) throw invalid("This item already has the maximum number of attachments.", "ATTACHMENT_LIMIT");
            if (Number(stats.bytes) + content.length > V.LIMITS.MAX_ATTACHMENT_TOTAL_BYTES) throw invalid("This item would hold too much attachment data.", "ATTACHMENT_LIMIT");
            // a ceiling per person across all their uploads (default 1 GiB; ZIOVAULT_ATTACHMENT_QUOTA_BYTES overrides it)
            const quota = Number(process.env.ZIOVAULT_ATTACHMENT_QUOTA_BYTES) || V.LIMITS.MAX_ATTACHMENT_BYTES_PER_USER;
            if ((await store.attachmentBytesBy(db, userId)) + content.length > quota) throw invalid("You have reached your attachment storage limit. Delete files you no longer need.", "ATTACHMENT_QUOTA");
            let created;
            try {
                created = await store.insertAttachment(db, { uid, itemId: row.id, meta, wrappedFileKey, content, uploadedBy: userId });
            } catch (error) {
                if (error.code === "23505") throw conflict("UID_IN_USE", "That id is already used.");
                throw error;
            }
            await store.audit(db, { kind: "attachment_added", actor: userId, subject: userId, itemUid: row.uid, collectionUid: row.collection_uid });
            return { uid, size: content.length, createdAt: iso(created.created_at) };
        });
    }

    // Size and date for everyone who can see the item; the encrypted name and the wrapped file key only for people who may reveal it.
    async function listAttachments(userId, itemUid) {
        await actorOf(userId);
        let entries;
        if (itemUid) {
            const { row, access } = await loadAccess(pool, userId, itemUid);
            entries = [{ row, access }];
        } else {
            entries = (await store.listItemsForUser(pool, userId)).map((row) => ({ row, access: authz.resolveItemRights(row) }));
        }
        const attachments = await store.listAttachmentsForItems(pool, entries.map((e) => e.row.id));
        const mayReveal = new Map(entries.map((e) => [e.row.uid, Boolean(e.access.rights.reveal)]));
        return attachments.map((a) => ({
            uid: a.uid, itemUid: a.item_uid, size: Number(a.size), createdAt: iso(a.created_at),
            ...(mayReveal.get(a.item_uid) ? { meta: V.encode(a.meta_ciphertext), wrappedFileKey: V.encode(a.wrapped_file_key) } : {}),
        }));
    }

    async function downloadAttachment(userId, itemUid, attachmentUid) {
        await actorOf(userId);
        const { row, access } = await loadAccess(pool, userId, itemUid);
        authz.requireRight(access, "reveal");
        const attachment = await store.getAttachment(pool, row.id, V.uuid(attachmentUid, "attachment"));
        if (!attachment) throw notFound();
        await store.audit(pool, { kind: "attachment_delivered", actor: userId, subject: userId, itemUid: row.uid, collectionUid: row.collection_uid });
        return { uid: attachment.uid, itemUid: row.uid, meta: V.encode(attachment.meta_ciphertext), wrappedFileKey: V.encode(attachment.wrapped_file_key), content: V.encode(attachment.content), createdAt: iso(attachment.created_at) };
    }

    async function deleteAttachment(userId, itemUid, attachmentUid) {
        await actorOf(userId);
        return store.tx(async (db) => {
            const { row, access } = await loadAccess(db, userId, itemUid, { forUpdate: true });
            authz.requireRight(access, "edit");
            const removed = await store.deleteAttachment(db, row.id, V.uuid(attachmentUid, "attachment"));
            if (!removed) throw notFound();
            await store.audit(db, { kind: "attachment_deleted", actor: userId, subject: userId, itemUid: row.uid, collectionUid: row.collection_uid });
            return { uid: removed.uid };
        });
    }

    // ------------------------------------------------------------------ rotation: "I changed this password"
    async function completeRotation(userId, uid) {
        await actorOf(userId);
        return store.tx(async (db) => {
            const { row, access } = await loadAccess(db, userId, uid, { forUpdate: true });
            if (!(access.paths.owner || access.rights.manage || access.rights.edit)) throw forbidden();
            const done = await store.completeRotation(db, row.id);
            await store.audit(db, { kind: "rotation_completed", actor: userId, subject: userId, itemUid: row.uid, collectionUid: row.collection_uid });
            return { uid: row.uid, version: done.version };
        });
    }

    // Called by the scheduled maintenance pass (jobs/vaultMaintenance.js). Sees ids only -- never a title, a name or a secret.
    async function processRotationReminders({ repeatDays = 7, limit = 500 } = {}) {
        return store.tx(async (db) => {
            const due = await store.dueItemsForReminder(db, repeatDays, limit);
            const out = [];
            for (const item of due) {
                const recipients = await store.reminderRecipients(db, item);
                await store.markReminded(db, item.id);
                await store.audit(db, { kind: "rotation_reminded", itemUid: item.uid, collectionUid: item.collection_uid || null, detail: `recipients=${recipients.length}` });
                out.push({ itemUid: item.uid, collectionUid: item.collection_uid || null, userIds: recipients.map((r) => Number(r.id)) });
            }
            return out;
        });
    }

    // ------------------------------------------------------------------ company activity (collection managers only; no administrator bypass)
    const queryNumber = (value) => (value === undefined || value === null || value === "" ? undefined : Number(value));
    async function companyAudit(userId, query = {}) {
        await actorOf(userId);
        const managed = await store.managedCollections(pool, userId);
        if (managed.length === 0) throw forbidden("Only a collection manager can view company activity.");
        let uids = managed.map((c) => c.uid);
        let ids = managed.map((c) => Number(c.id));
        if (query.collectionUid) {
            const wanted = V.uuid(String(query.collectionUid), "collection");
            const found = managed.find((c) => c.uid === wanted);
            if (!found) throw notFound();
            uids = [wanted];
            ids = [Number(found.id)];
        }
        const limit = queryNumber(query.limit) === undefined ? 50 : Math.min(V.positiveInteger(queryNumber(query.limit), "limit"), V.LIMITS.AUDIT_PAGE_MAX);
        const kind = query.kind ? V.oneOf(String(query.kind), require("../schemas/ziovaultDdl").AUDIT_KINDS, "kind") : null;
        const actorUserId = queryNumber(query.userId) === undefined ? null : V.positiveInteger(queryNumber(query.userId), "userId");
        const from = query.from ? V.optionalTimestamp(String(query.from), "from") : null;
        const to = query.to ? V.optionalTimestamp(String(query.to), "to") : null;
        const beforeId = queryNumber(query.before) === undefined ? null : String(V.positiveInteger(queryNumber(query.before), "before"));
        const found = await store.companyAudit(pool, { collectionUids: uids, collectionIds: ids, actorUserId, kind, from, to, beforeId, limit });
        const more = found.length > limit;
        const page = more ? found.slice(0, limit) : found;
        return {
            events: page.map((e) => ({
                id: String(e.id), kind: e.kind, actorUserId: num(e.actor_user_id), actorName: e.actor_name || null, subjectUserId: num(e.subject_user_id), subjectName: e.subject_name || null,
                itemUid: e.item_uid || undefined, collectionUid: e.collection_uid || undefined, detail: e.detail, at: iso(e.created_at),
                evidence: e.kind === "secret_delivered" || e.kind === "attachment_delivered" ? "server_observed_delivery" : e.kind === "reveal_reported" || e.kind === "copy_reported" ? "client_reported" : "server_observed",
            })),
            nextBefore: more ? String(page[page.length - 1].id) : null,
        };
    }

    // ------------------------------------------------------------------ offboarding: end a person's COMPANY vault access (never touches personal vaults)
    // Deactivating an employee in the CRM already does this (and more) through a database trigger. This is the same revocation for an
    // administrator who wants it without deactivating the account -- one transaction, so a failure leaves nothing half done.
    async function offboardingPeople(userId) {
        const { user } = await actorOf(userId);
        if (!authz.canCreateCollections(user)) throw forbidden("Only a company administrator can manage vault access.");
        return (await store.accessHolders(pool)).map((u) => ({
            userId: Number(u.id), name: u.full_name, employeeId: u.employee_id, active: u.status === "active" && (!u.employment_status || u.employment_status === "active"),
            memberships: u.memberships, managed: u.managed, companyShares: u.company_shares, isYou: Number(u.id) === userId,
        }));
    }

    async function revokeCompanyAccess(userId, targetRaw, body) {
        const targetId = V.positiveInteger(targetRaw, "userId");
        const { user } = await actorOf(userId);
        if (!authz.canCreateCollections(user)) throw forbidden("Only a company administrator can manage vault access.");
        if (body.confirm !== true) throw invalid("Please confirm to continue.", "CONFIRMATION_REQUIRED");
        if (targetId === userId) throw invalid("You cannot remove your own vault access here.");
        return store.tx(async (db) => {
            if (!(await store.getUser(db, targetId))) throw notFound();
            const sole = await store.soleManagerCollections(db, targetId);
            if (sole.length > 0) throw conflict("SOLE_MANAGER", `This person is the only manager of ${sole.length} collection${sole.length === 1 ? "" : "s"}. Make someone else a manager first, so the collection is not left without one.`);
            const affected = (await store.membershipCollectionUids(db, targetId)).map((c) => c.uid);
            const grantIds = await store.companyGrantIdsOf(db, targetId);
            const removed = await store.removeMembers(db, null, [targetId], userId, "offboarding");
            const revoked = grantIds.length > 0 ? await store.revokeGrants(db, grantIds, userId, "offboarding") : 0;
            await store.audit(db, { kind: "vault_access_revoked", actor: userId, subject: targetId, detail: `members_removed=${removed},revoked_grants=${revoked}` });
            return { userId: targetId, membershipsRemoved: removed, sharesRevoked: revoked, collectionsNeedingRekey: affected };
        });
    }

    // ------------------------------------------------------------------ audit and maintenance
    async function auditTrail(userId, { itemUid, collectionUid } = {}) {
        await actorOf(userId);
        let list;
        if (itemUid) {
            const { row, access } = await loadAccess(pool, userId, itemUid, { includeDeleted: true });
            if (!(access.paths.owner || access.rights.manage || access.rights.share)) throw forbidden();
            list = await store.auditForItem(pool, row.uid);
        } else if (collectionUid) {
            const collection = await requireCollectionManager(pool, userId, collectionUid);
            list = await store.auditForCollection(pool, collection.uid);
        } else {
            list = await store.auditAboutUser(pool, userId);
        }
        return list.map((e) => ({
            id: String(e.id), kind: e.kind, actorUserId: num(e.actor_user_id), subjectUserId: num(e.subject_user_id), itemUid: e.item_uid || undefined, collectionUid: e.collection_uid || undefined, detail: e.detail, at: iso(e.created_at),
            // what this record proves (and does not): server-observed vs reported by a browser
            evidence: e.kind === "secret_delivered" ? "server_observed_delivery" : e.kind === "reveal_reported" || e.kind === "copy_reported" ? "client_reported" : "server_observed",
        }));
    }

    // Removes expired access (key envelopes included) and writes the audit trail. Never needed for correctness: every read re-checks the clock.
    async function sweepExpired() {
        return store.tx(async (db) => {
            const grantIds = await store.expiredGrantIds(db);
            const revoked = grantIds.length ? await store.revokeGrants(db, grantIds, null, "expired") : 0;
            let membersRemoved = 0;
            for (const group of await store.expiredMembers(db)) membersRemoved += await store.removeMembers(db, group.collection_id, group.users, null, "expired");
            return { grantsRevoked: revoked, membersRemoved };
        });
    }

    return {
        store,
        accountStatus, registerAccount, unlockMaterial, recoveryMaterial, confirmRecovery, replaceEnvelope, replaceRecoveryEnvelope, envelopeHistory, restoreEnvelope, directory,
        listItems, listTrash, getItem, getSecret, reportAccess, createPersonalItem, createCompanyItem, updateItem, setDeleted, rotateItem,
        createCollection, renameCollection, archiveCollection, outgoingShares, listCollections, getCollection, addMember, updateMember, removeMember, rotateCollection,
        createGrant, listGrants, updateGrant, revokeGrant,
        addAttachment, listAttachments, downloadAttachment, deleteAttachment, completeRotation, processRotationReminders, companyAudit, offboardingPeople, revokeCompanyAccess,
        listFolders, createFolder, renameFolder, deleteFolder,
        auditTrail, sweepExpired,
        deleteItem: (userId, uid) => setDeleted(userId, uid, true),
        restoreItem: (userId, uid) => setDeleted(userId, uid, false),
        VaultError,
    };
}

module.exports = { createVaultService };
