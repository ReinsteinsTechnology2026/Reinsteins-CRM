// ==========================================
// ZIOVAULT -- data access (PostgreSQL). Ciphertext, wrapped keys and access-control metadata ONLY.
//
// Nothing here can decrypt anything: there is no key on the server. Every access check that depends on time uses the DATABASE
// clock (now()), never a value from the request or from the browser. `pool` is the tenant-aware pool (config/db) in production
// and a pool for a disposable database in tests.
// ==========================================

const ACTIVE_USER = `u.status = 'active' AND COALESCE(u.employment_status, 'active') = 'active'`;

function createVaultStore({ pool }) {
    const rows = async (db, sql, params = []) => (await db.query(sql, params))[0];
    const one = async (db, sql, params = []) => (await rows(db, sql, params))[0] || null;

    async function tx(work) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const result = await work(connection);
            await connection.commit();
            return result;
        } catch (error) {
            try {
                await connection.rollback();
            } catch (_rollbackError) {
                // the original error is the one that matters
            }
            throw error;
        } finally {
            connection.release();
        }
    }

    // ------------------------------------------------------------------ users
    const getUser = (db, id) =>
        one(db, `SELECT u.id, u.full_name, u.employee_id, u.role, u.system_access, u.status, u.employment_status, u.employment_type FROM users u WHERE u.id = ? LIMIT 1`, [id]);

    const getActiveUserWithAccount = (db, id) =>
        one(
            db,
            `SELECT u.id, u.full_name, u.employee_id, u.employment_type, a.public_key
             FROM users u JOIN zv_accounts a ON a.user_id = u.id WHERE u.id = ? AND ${ACTIVE_USER} LIMIT 1`,
            [id]
        );

    const listDirectory = (db, exceptUserId) =>
        rows(
            db,
            `SELECT u.id, u.full_name, u.employee_id, u.employment_type, a.public_key, a.created_at
             FROM zv_accounts a JOIN users u ON u.id = a.user_id
             WHERE ${ACTIVE_USER} AND u.id <> ? ORDER BY u.full_name LIMIT 2000`,
            [exceptUserId]
        );

    // ------------------------------------------------------------------ audit (append-only; fixed vocabulary, never a secret)
    const audit = (db, { kind, actor = null, subject = null, itemUid = null, collectionUid = null, detail = "" }) =>
        db.query(
            `INSERT INTO zv_audit_events (kind, actor_user_id, subject_user_id, item_uid, collection_uid, detail) VALUES (?, ?, ?, ?, ?, ?)`,
            [kind, actor, subject, itemUid, collectionUid, detail]
        );

    // ------------------------------------------------------------------ account
    const getAccount = (db, userId) => one(db, `SELECT * FROM zv_accounts WHERE user_id = ?`, [userId]);

    async function insertAccount(db, userId, a) {
        return one(
            db,
            `INSERT INTO zv_accounts (user_id, kdf_alg, kdf_ops, kdf_mem, kdf_salt, vault_key_envelope, public_key, private_key_envelope, recovery_envelope)
             VALUES (?, 'argon2id13', ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id) DO NOTHING RETURNING user_id, account_version`,
            [userId, a.kdf.ops, a.kdf.mem, a.kdf.salt, a.vaultKeyEnvelope, a.publicKey, a.privateKeyEnvelope, a.recoveryEnvelope]
        );
    }

    // Replace the vault-key envelope (password change / recovery). The envelope being replaced is kept in zv_account_history, so a
    // stolen session cannot silently destroy a vault. Optimistic: refuses if the account changed since the caller read it.
    async function replaceEnvelope(db, userId, expectedVersion, { kdf, vaultKeyEnvelope, reason }) {
        const current = await one(db, `SELECT * FROM zv_accounts WHERE user_id = ? FOR UPDATE`, [userId]);
        if (!current) return { status: "missing" };
        if (current.account_version !== expectedVersion) return { status: "stale" };
        await db.query(
            `INSERT INTO zv_account_history (user_id, account_version, kdf_ops, kdf_mem, kdf_salt, vault_key_envelope, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [userId, current.account_version, current.kdf_ops, current.kdf_mem, current.kdf_salt, current.vault_key_envelope, reason]
        );
        const updated = await one(
            db,
            `UPDATE zv_accounts SET kdf_ops = ?, kdf_mem = ?, kdf_salt = ?, vault_key_envelope = ?, account_version = account_version + 1,
                    password_changed_at = now(), updated_at = now()
             WHERE user_id = ? RETURNING account_version`,
            [kdf.ops, kdf.mem, kdf.salt, vaultKeyEnvelope, userId]
        );
        return { status: "ok", accountVersion: updated.account_version };
    }

    const listEnvelopeHistory = (db, userId) =>
        rows(db, `SELECT id, account_version, reason, replaced_at FROM zv_account_history WHERE user_id = ? ORDER BY id DESC LIMIT 20`, [userId]);

    const getHistoryEntry = (db, userId, id) => one(db, `SELECT * FROM zv_account_history WHERE user_id = ? AND id = ?`, [userId, id]);

    // ------------------------------------------------------------------ item access resolution (every path, expiry by DB clock)
    const ITEM_SELECT = `
        i.id, i.uid, i.owner_user_id, i.collection_id, i.kind, i.meta_ciphertext, i.secret_ciphertext, i.key_version, i.version,
        i.favorite, i.rotation_interval_days, i.last_rotated_at, i.rotation_required, i.deleted_at, i.created_at, i.updated_at,
        c.uid AS collection_uid, c.key_version AS collection_key_version, c.archived_at AS collection_archived_at,
        (i.owner_user_id = ?) AS is_owner,
        m.user_id AS m_user, m.can_reveal AS m_reveal, m.can_copy AS m_copy, m.can_edit AS m_edit, m.can_share AS m_share,
        m.is_manager AS m_manager, m.expires_at AS m_expires,
        g.id AS g_id, g.can_reveal AS g_reveal, g.can_copy AS g_copy, g.can_edit AS g_edit, g.can_share AS g_share,
        g.expires_at AS g_expires, g.parent_grant_id AS g_parent`;
    const ITEM_FROM = `
        FROM zv_items i
        LEFT JOIN zv_collections c ON c.id = i.collection_id
        LEFT JOIN zv_collection_members m ON m.collection_id = i.collection_id AND m.user_id = ? AND (m.expires_at IS NULL OR m.expires_at > now())
        LEFT JOIN zv_grants g ON g.item_id = i.id AND g.recipient_user_id = ? AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())`;

    async function findItemForUser(db, userId, uid, { includeDeleted = false, forUpdate = false } = {}) {
        const row = await one(
            db,
            `SELECT ${ITEM_SELECT} ${ITEM_FROM}
             WHERE i.uid = ? ${includeDeleted ? "" : "AND i.deleted_at IS NULL"}
               AND (i.owner_user_id = ? OR m.user_id IS NOT NULL OR g.id IS NOT NULL)
             ${forUpdate ? "FOR UPDATE OF i" : ""}`,
            [userId, userId, userId, uid, userId]
        );
        return row;
    }

    const listItemsForUser = (db, userId) =>
        rows(
            db,
            `SELECT ${ITEM_SELECT} ${ITEM_FROM}
             WHERE i.deleted_at IS NULL AND (i.owner_user_id = ? OR m.user_id IS NOT NULL OR g.id IS NOT NULL)
             ORDER BY i.updated_at DESC LIMIT 5000`,
            [userId, userId, userId, userId]
        );

    const listDeletedItemsOf = (db, userId) =>
        rows(
            db,
            `SELECT ${ITEM_SELECT} ${ITEM_FROM} WHERE i.deleted_at IS NOT NULL AND i.owner_user_id = ? ORDER BY i.deleted_at DESC LIMIT 1000`,
            [userId, userId, userId, userId]
        );

    // All key wrappers that could be relevant to this user for these items. The caller keeps only the ones its access path allows.
    const itemKeysForUser = (db, itemIds, userId) =>
        itemIds.length === 0
            ? []
            : rows(
                  db,
                  `SELECT k.item_id, k.holder_type, k.purpose, k.wrapped_key, k.sender_user_id, k.key_version, a.public_key AS sender_public_key
                   FROM zv_item_keys k LEFT JOIN zv_accounts a ON a.user_id = k.sender_user_id
                   WHERE k.item_id = ANY(?) AND ((k.holder_type IN ('owner', 'user') AND k.holder_user_id = ?) OR k.holder_type = 'collection')`,
                  [itemIds, userId]
              );

    const memberKeysForUser = (db, collectionIds, userId) =>
        collectionIds.length === 0
            ? []
            : rows(
                  db,
                  `SELECT m.collection_id, m.wrapped_meta_key, m.wrapped_secret_key, m.sender_user_id, m.key_version, a.public_key AS sender_public_key
                   FROM zv_collection_members m LEFT JOIN zv_accounts a ON a.user_id = m.sender_user_id
                   WHERE m.collection_id = ANY(?) AND m.user_id = ? AND (m.expires_at IS NULL OR m.expires_at > now())`,
                  [collectionIds, userId]
              );

    // ------------------------------------------------------------------ item writes
    async function insertItem(db, a) {
        return one(
            db,
            `INSERT INTO zv_items (uid, owner_user_id, collection_id, kind, meta_ciphertext, secret_ciphertext, key_version, rotation_interval_days, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, uid, version, key_version`,
            [a.uid, a.ownerUserId, a.collectionId, a.kind, a.meta, a.secret, a.keyVersion, a.rotationIntervalDays, a.createdBy]
        );
    }

    const insertItemKey = (db, a) =>
        db.query(
            `INSERT INTO zv_item_keys (item_id, holder_type, holder_user_id, purpose, wrapped_key, sender_user_id, key_version) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [a.itemId, a.holderType, a.holderUserId, a.purpose, a.wrappedKey, a.senderUserId, a.keyVersion]
        );

    const deleteItemKeys = (db, itemId, holderType, holderUserId, purpose) =>
        db.query(
            `DELETE FROM zv_item_keys WHERE item_id = ? AND holder_type = ? AND COALESCE(holder_user_id, 0) = ? ${purpose ? "AND purpose = ?" : ""}`,
            purpose ? [itemId, holderType, holderUserId || 0, purpose] : [itemId, holderType, holderUserId || 0]
        );

    // optimistic update; returns the new version or null when the version no longer matches
    async function updateItem(db, itemId, expectedVersion, patch) {
        const sets = ["version = version + 1", "updated_at = now()"];
        const params = [];
        for (const [column, value] of Object.entries(patch)) {
            sets.push(`${column} = ?`);
            params.push(value);
        }
        params.push(itemId, expectedVersion);
        const row = await one(db, `UPDATE zv_items SET ${sets.join(", ")} WHERE id = ? AND version = ? RETURNING version`, params);
        return row ? row.version : null;
    }

    const setItemDeleted = (db, itemId, deleted) =>
        one(db, `UPDATE zv_items SET deleted_at = ${deleted ? "now()" : "NULL"}, updated_at = now() WHERE id = ? RETURNING id`, [itemId]);

    // ------------------------------------------------------------------ collections
    const getCollectionForUser = (db, userId, uid) =>
        one(
            db,
            `SELECT c.id, c.uid, c.kind, c.name_ciphertext, c.key_version, c.rotation_required, c.created_at, c.updated_at, c.archived_at,
                    m.user_id AS m_user, m.can_reveal AS m_reveal, m.can_copy AS m_copy, m.can_edit AS m_edit, m.can_share AS m_share,
                    m.is_manager AS m_manager, m.expires_at AS m_expires, m.wrapped_meta_key, m.wrapped_secret_key, m.sender_user_id, m.key_version AS m_key_version,
                    a.public_key AS sender_public_key
             FROM zv_collections c
             JOIN zv_collection_members m ON m.collection_id = c.id AND m.user_id = ? AND (m.expires_at IS NULL OR m.expires_at > now())
             LEFT JOIN zv_accounts a ON a.user_id = m.sender_user_id
             WHERE c.uid = ?`,
            [userId, uid]
        );

    const listCollectionsForUser = (db, userId) =>
        rows(
            db,
            `SELECT c.id, c.uid, c.kind, c.name_ciphertext, c.key_version, c.rotation_required, c.created_at, c.updated_at, c.archived_at,
                    m.can_reveal AS m_reveal, m.can_copy AS m_copy, m.can_edit AS m_edit, m.can_share AS m_share, m.is_manager AS m_manager,
                    m.expires_at AS m_expires, m.wrapped_meta_key, m.wrapped_secret_key, m.sender_user_id, m.key_version AS m_key_version,
                    a.public_key AS sender_public_key
             FROM zv_collections c
             JOIN zv_collection_members m ON m.collection_id = c.id AND m.user_id = ? AND (m.expires_at IS NULL OR m.expires_at > now())
             LEFT JOIN zv_accounts a ON a.user_id = m.sender_user_id
             WHERE c.archived_at IS NULL ORDER BY c.created_at`,
            [userId]
        );

    const insertCollection = (db, a) =>
        one(db, `INSERT INTO zv_collections (uid, kind, name_ciphertext, created_by) VALUES (?, ?, ?, ?) RETURNING id, uid, key_version`, [a.uid, a.kind, a.name, a.createdBy]);

    const insertMember = (db, a) =>
        db.query(
            `INSERT INTO zv_collection_members (collection_id, user_id, can_reveal, can_copy, can_edit, can_share, is_manager, wrapped_meta_key, wrapped_secret_key,
                                                sender_user_id, key_version, expires_at, added_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [a.collectionId, a.userId, a.rights.reveal, a.rights.copy, a.rights.edit, a.rights.share, a.rights.manager, a.wrappedMetaKey, a.wrappedSecretKey,
             a.senderUserId, a.keyVersion, a.expiresAt, a.addedBy]
        );

    const listMembers = (db, collectionId) =>
        rows(
            db,
            `SELECT m.user_id, u.full_name, u.employee_id, u.employment_type, m.can_reveal, m.can_copy, m.can_edit, m.can_share, m.is_manager, m.expires_at, m.created_at
             FROM zv_collection_members m JOIN users u ON u.id = m.user_id WHERE m.collection_id = ? ORDER BY u.full_name`,
            [collectionId]
        );

    const getMember = (db, collectionId, userId) =>
        one(db, `SELECT * FROM zv_collection_members WHERE collection_id = ? AND user_id = ? FOR UPDATE`, [collectionId, userId]);

    const countManagers = (db, collectionId) =>
        one(db, `SELECT count(*)::int AS n FROM zv_collection_members WHERE collection_id = ? AND is_manager AND (expires_at IS NULL OR expires_at > now())`, [collectionId]).then((r) => r.n);

    const removeMembers = (db, collectionId, userIds, actor, reason) =>
        one(db, `SELECT zv_remove_collection_members(?, ?::bigint[], ?, ?) AS removed`, [collectionId, userIds, actor, reason]).then((r) => r.removed);

    const lockCollection = (db, uid) => one(db, `SELECT id, uid, key_version, rotation_required FROM zv_collections WHERE uid = ? FOR UPDATE`, [uid]);

    const liveItemsOfCollection = (db, collectionId) =>
        rows(db, `SELECT id, uid, version FROM zv_items WHERE collection_id = ? AND deleted_at IS NULL FOR UPDATE`, [collectionId]);

    const membersOfCollection = (db, collectionId) => rows(db, `SELECT user_id FROM zv_collection_members WHERE collection_id = ? FOR UPDATE`, [collectionId]);

    // ------------------------------------------------------------------ grants
    const getActiveGrant = (db, itemId, recipientUserId) =>
        one(
            db,
            `SELECT * FROM zv_grants WHERE item_id = ? AND recipient_user_id = ? AND revoked_at IS NULL FOR UPDATE`,
            [itemId, recipientUserId]
        );

    const insertGrant = (db, a) =>
        one(
            db,
            `INSERT INTO zv_grants (item_id, recipient_user_id, can_reveal, can_copy, can_edit, can_share, expires_at, granted_by, parent_grant_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            [a.itemId, a.recipientUserId, a.rights.reveal, a.rights.copy, a.rights.edit, a.rights.share, a.expiresAt, a.grantedBy, a.parentGrantId]
        );

    const listGrants = (db, itemId) =>
        rows(
            db,
            `SELECT g.id, g.recipient_user_id, u.full_name, u.employee_id, g.can_reveal, g.can_copy, g.can_edit, g.can_share, g.expires_at, g.granted_by, g.created_at,
                    (g.expires_at IS NOT NULL AND g.expires_at <= now()) AS expired
             FROM zv_grants g JOIN users u ON u.id = g.recipient_user_id WHERE g.item_id = ? AND g.revoked_at IS NULL ORDER BY g.created_at`,
            [itemId]
        );

    const revokeGrants = (db, seedIds, actor, reason) =>
        one(db, `SELECT zv_revoke_grants(?::integer[], ?, ?) AS revoked`, [seedIds, actor, reason]).then((r) => r.revoked);

    // ------------------------------------------------------------------ folders (the name is ciphertext; membership lives inside the encrypted item details)
    const listFolders = (db, userId) => rows(db, `SELECT uid, name_ciphertext, created_at, updated_at FROM zv_folders WHERE owner_user_id = ? ORDER BY id`, [userId]);
    const countFolders = (db, userId) => one(db, `SELECT count(*)::int AS n FROM zv_folders WHERE owner_user_id = ?`, [userId]).then((r) => r.n);
    const insertFolder = (db, a) => one(db, `INSERT INTO zv_folders (uid, owner_user_id, name_ciphertext) VALUES (?, ?, ?) RETURNING uid`, [a.uid, a.ownerUserId, a.name]);
    const renameFolder = (db, userId, uid, name) => one(db, `UPDATE zv_folders SET name_ciphertext = ?, updated_at = now() WHERE uid = ? AND owner_user_id = ? RETURNING uid`, [name, uid, userId]);
    const deleteFolder = (db, userId, uid) => one(db, `DELETE FROM zv_folders WHERE uid = ? AND owner_user_id = ? RETURNING uid`, [uid, userId]);

    // ------------------------------------------------------------------ audit reads
    const auditForItem = (db, itemUid) =>
        rows(db, `SELECT id, kind, actor_user_id, subject_user_id, detail, created_at FROM zv_audit_events WHERE item_uid = ? ORDER BY id DESC LIMIT 500`, [itemUid]);
    const auditForCollection = (db, collectionUid) =>
        rows(db, `SELECT id, kind, actor_user_id, subject_user_id, detail, created_at FROM zv_audit_events WHERE collection_uid = ? ORDER BY id DESC LIMIT 500`, [collectionUid]);
    const auditAboutUser = (db, userId) =>
        rows(db, `SELECT id, kind, actor_user_id, subject_user_id, item_uid, collection_uid, detail, created_at FROM zv_audit_events WHERE actor_user_id = ? OR subject_user_id = ? ORDER BY id DESC LIMIT 500`, [userId, userId]);

    // ------------------------------------------------------------------ expiry sweep (correctness never depends on it: every read re-checks the clock)
    const expiredGrantIds = (db) => rows(db, `SELECT id FROM zv_grants WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= now() LIMIT 5000`).then((r) => r.map((x) => x.id));
    const expiredMembers = (db) =>
        rows(db, `SELECT collection_id, array_agg(user_id) AS users FROM zv_collection_members WHERE expires_at IS NOT NULL AND expires_at <= now() GROUP BY collection_id`);

    return {
        tx, getUser, getActiveUserWithAccount, listDirectory, audit,
        getAccount, insertAccount, replaceEnvelope, listEnvelopeHistory, getHistoryEntry,
        findItemForUser, listItemsForUser, listDeletedItemsOf, itemKeysForUser, memberKeysForUser,
        insertItem, insertItemKey, deleteItemKeys, updateItem, setItemDeleted,
        getCollectionForUser, listCollectionsForUser, insertCollection, insertMember, listMembers, getMember, countManagers, removeMembers,
        lockCollection, liveItemsOfCollection, membersOfCollection,
        getActiveGrant, insertGrant, listGrants, revokeGrants,
        listFolders, countFolders, insertFolder, renameFolder, deleteFolder,
        auditForItem, auditForCollection, auditAboutUser,
        expiredGrantIds, expiredMembers,
        query: (sql, params) => pool.query(sql, params),
    };
}

module.exports = { createVaultStore };
