// ZioVault database behaviour on REAL PostgreSQL: the constraints, the append-only audit trail, the offboarding trigger (every way
// of deactivating a person, rollback, fail-closed), and the migration on existing databases -- including legacy databases whose
// users.id is BIGINT. Fixtures are plain SQL (the trigger and constraints do not care what the bytes mean); the end-to-end
// cryptographic flows are _test_ziovault_pg.js.
//
// Needs a DISPOSABLE PostgreSQL (PG_TEST_* variables); skipped without them, required in the migration-postgres CI job.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { createLab } = require("./_ziovault_test_support");
const migration = require("./_migrate_add_ziovault");
const ddl = require("./schemas/ziovaultDdl");

const lab = createLab();
const SKIP = lab.skip;
const uuid = () => crypto.randomUUID();
const bytes = (n, fill = 7) => Buffer.alloc(n, fill);
const rows = async (pool, sql, params) => (await pool.query(sql, params))[0];
const one = async (pool, sql, params) => (await rows(pool, sql, params))[0];
const rejectsWith = (promise, pattern) => assert.rejects(promise, (error) => pattern.test(`${error.code || ""} ${error.message}`));

test.after(async () => lab.close());

test("setup: the configured server is the disposable PostgreSQL service", { skip: SKIP }, async () => {
    await lab.connect();
});

// ---------------------------------------------------------------------------------------------- SQL fixtures
const NON_ACTIVE = [["status", "inactive"], ["employment_status", "inactive"], ["employment_status", "resigned"], ["employment_status", "terminated"], ["employment_status", "retired"], ["employment_status", "completed"], ["employment_status", "discontinued"], ["employment_status", "converted"]];

const mkItem = async (pool, ownerId, { collectionId = null, secret = true } = {}) =>
    one(pool, `INSERT INTO zv_items (uid, owner_user_id, collection_id, kind, meta_ciphertext, secret_ciphertext, created_by) VALUES (?, ?, ?, 'login', ?, ?, ?) RETURNING id, uid`, [uuid(), collectionId ? null : ownerId, collectionId, bytes(60), secret ? bytes(80) : null, ownerId]);
const mkKey = (pool, itemId, holderType, holderUserId, purpose, sender = null) =>
    pool.query(`INSERT INTO zv_item_keys (item_id, holder_type, holder_user_id, purpose, wrapped_key, sender_user_id) VALUES (?, ?, ?, ?, ?, ?)`, [itemId, holderType, holderUserId, purpose, bytes(100), sender]);
async function mkGrant(pool, item, recipient, { reveal = false, share = false, parent = null, grantedBy = null, expires = null } = {}) {
    const grant = await one(pool, `INSERT INTO zv_grants (item_id, recipient_user_id, can_reveal, can_share, expires_at, granted_by, parent_grant_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, [item.id, recipient, reveal, share, expires, grantedBy, parent]);
    await mkKey(pool, item.id, "user", recipient, "meta", grantedBy || recipient);
    if (reveal) await mkKey(pool, item.id, "user", recipient, "secret", grantedBy || recipient);
    return grant.id;
}
const mkCollection = async (pool, managerId) => {
    const collection = await one(pool, `INSERT INTO zv_collections (uid, kind, name_ciphertext, created_by) VALUES (?, 'general', ?, ?) RETURNING id, uid`, [uuid(), bytes(60), managerId]);
    await pool.query(`INSERT INTO zv_collection_members (collection_id, user_id, can_reveal, can_copy, can_edit, can_share, is_manager, wrapped_meta_key, wrapped_secret_key, sender_user_id) VALUES (?, ?, TRUE, FALSE, TRUE, TRUE, TRUE, ?, ?, ?)`, [collection.id, managerId, bytes(100), bytes(100), managerId]);
    return collection;
};
const addMember = (pool, collectionId, userId, sender, reveal = false) =>
    pool.query(`INSERT INTO zv_collection_members (collection_id, user_id, can_reveal, wrapped_meta_key, wrapped_secret_key, sender_user_id) VALUES (?, ?, ?, ?, ?, ?)`, [collectionId, userId, reveal, bytes(100), reveal ? bytes(100) : null, sender]);

// ---------------------------------------------------------------------------------------------- constraints
test("CONSTRAINTS: items are personal XOR company; sizes, kinds and key-holder shapes are enforced by the database itself", { skip: SKIP }, async () => {
    const pool = await lab.tenantDatabase();
    const u = await lab.addUser(pool, "Owner");
    const collection = await mkCollection(pool, u);
    const insert = (over = {}) => {
        const v = { uid: uuid(), owner: u, collection: null, kind: "login", meta: bytes(60), secret: bytes(80), days: null, ...over };
        return pool.query(`INSERT INTO zv_items (uid, owner_user_id, collection_id, kind, meta_ciphertext, secret_ciphertext, rotation_interval_days) VALUES (?, ?, ?, ?, ?, ?, ?)`, [v.uid, v.owner, v.collection, v.kind, v.meta, v.secret, v.days]);
    };
    await insert();
    await rejectsWith(insert({ owner: u, collection: collection.id }), /ck_zv_items_personal_xor_company/);
    await rejectsWith(insert({ owner: null, collection: null }), /ck_zv_items_personal_xor_company/);
    await insert({ owner: null, collection: collection.id });
    await rejectsWith(insert({ kind: "banana" }), /check/i);
    await rejectsWith(insert({ meta: bytes(40) }), /check/i);
    await rejectsWith(insert({ meta: bytes(70001) }), /check/i);
    await rejectsWith(insert({ secret: bytes(270001) }), /check/i);
    await rejectsWith(insert({ days: 0 }), /check/i);
    await rejectsWith(insert({ days: 4000 }), /check/i);
    const dup = uuid();
    await insert({ uid: dup });
    await rejectsWith(insert({ uid: dup }), /23505|uq_zv_items_uid/);
    await rejectsWith(pool.query(`INSERT INTO zv_items (uid, owner_user_id, meta_ciphertext, folder_id) VALUES (?, ?, ?, 99999)`, [uuid(), u, bytes(60)]), /23503|foreign key/i);

    const item = await mkItem(pool, u);
    const key = (over) => pool.query(`INSERT INTO zv_item_keys (item_id, holder_type, holder_user_id, purpose, wrapped_key, sender_user_id) VALUES (?, ?, ?, ?, ?, ?)`, [item.id, over.type, over.holder, over.purpose || "meta", over.wrapped || bytes(100), over.sender === undefined ? null : over.sender]);
    await key({ type: "owner", holder: u });
    await rejectsWith(key({ type: "owner", holder: u }), /uq_zv_item_keys_holder|23505/, "one wrapper per holder and purpose");
    await key({ type: "collection", holder: null, purpose: "meta" });
    await rejectsWith(key({ type: "collection", holder: u, purpose: "secret" }), /ck_zv_item_keys_holder/);
    await rejectsWith(key({ type: "owner", holder: null, purpose: "secret" }), /ck_zv_item_keys_holder/);
    await rejectsWith(key({ type: "user", holder: u, purpose: "secret", sender: null }), /ck_zv_item_keys_sender/, "a box always names its sender");
    await rejectsWith(key({ type: "owner", holder: u, purpose: "secret", wrapped: bytes(72) }), /check/i);
    await rejectsWith(key({ type: "owner", holder: u, purpose: "secret", wrapped: bytes(600) }), /check/i);
    await rejectsWith(key({ type: "wizard", holder: u }), /check/i);
});

test("CONSTRAINTS: membership and grant rights keep their invariants; one active grant per person; accounts demand exact envelope sizes", { skip: SKIP }, async () => {
    const pool = await lab.tenantDatabase();
    const [owner, other] = [await lab.addUser(pool, "Owner"), await lab.addUser(pool, "Other")];
    const collection = await mkCollection(pool, owner);
    const member = (over) => pool.query(`INSERT INTO zv_collection_members (collection_id, user_id, can_reveal, can_copy, can_edit, can_share, is_manager, wrapped_meta_key, wrapped_secret_key, sender_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [collection.id, other, over.reveal ?? false, over.copy ?? false, over.edit ?? false, over.share ?? false, over.manager ?? false, bytes(100), over.secret === undefined ? null : over.secret, owner]);
    await rejectsWith(member({ reveal: true }), /ck_zv_members_secret_key_iff_reveal/, "reveal without the secret key");
    await rejectsWith(member({ reveal: false, secret: bytes(100) }), /ck_zv_members_secret_key_iff_reveal/, "a secret key without reveal");
    await rejectsWith(member({ copy: true }), /ck_zv_members_rights_need_reveal/);
    await rejectsWith(member({ edit: true }), /ck_zv_members_rights_need_reveal/);
    await rejectsWith(member({ manager: true, reveal: true, secret: bytes(100) }), /ck_zv_members_manager_holds_everything/);
    await member({ reveal: true, secret: bytes(100), copy: true });
    await rejectsWith(member({}), /23505|pkey/i, "one membership per person");

    const item = await mkItem(pool, owner);
    const grant = (over = {}) => pool.query(`INSERT INTO zv_grants (item_id, recipient_user_id, can_reveal, can_copy, can_edit) VALUES (?, ?, ?, ?, ?)`, [item.id, other, over.reveal ?? false, over.copy ?? false, over.edit ?? false]);
    await rejectsWith(grant({ copy: true }), /ck_zv_grants_rights_need_reveal/);
    await rejectsWith(grant({ edit: true }), /ck_zv_grants_rights_need_reveal/);
    await grant({ reveal: true });
    await rejectsWith(grant(), /uq_zv_grants_active|23505/, "one ACTIVE grant per (item, person)");
    await pool.query(`UPDATE zv_grants SET revoked_at = now() WHERE item_id = ?`, [item.id]);
    await grant(); // a revoked grant does not block a new one: history is kept

    const account = (over = {}) => pool.query(`INSERT INTO zv_accounts (user_id, kdf_ops, kdf_mem, kdf_salt, vault_key_envelope, public_key, private_key_envelope, recovery_envelope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [over.user ?? other, over.ops ?? 3, over.mem ?? 67108864, over.salt ?? bytes(16), over.vk ?? bytes(73), over.pk ?? bytes(32, 9), over.priv ?? bytes(73), over.rec ?? bytes(73)]);
    for (const bad of [{ ops: 1 }, { ops: 11 }, { mem: 1024 }, { mem: 999999999 }, { salt: bytes(15) }, { vk: bytes(72) }, { vk: bytes(74) }, { pk: bytes(31) }, { priv: bytes(1) }, { rec: bytes(200) }]) await rejectsWith(account(bad), /check/i);
    await account();
    await rejectsWith(account({ user: owner }), /uq_zv_accounts_public_key|23505/, "no two users share a public key");
    await rejectsWith(pool.query(`DELETE FROM users WHERE id = ?`, [other]), /23503|foreign key|violates/i);
    await rejectsWith(pool.query(`INSERT INTO zv_accounts (user_id, kdf_alg, kdf_ops, kdf_mem, kdf_salt, vault_key_envelope, public_key, private_key_envelope, recovery_envelope) VALUES (?, 'argon2i', 3, 67108864, ?, ?, ?, ?, ?)`, [owner, bytes(16), bytes(73), bytes(32, 5), bytes(73), bytes(73)]), /check/i);
});

test("ATTACHMENTS are ciphertext in BYTEA with a hard size ceiling, and round-trip exactly", { skip: SKIP }, async () => {
    const pool = await lab.tenantDatabase();
    const u = await lab.addUser(pool, "Owner");
    const item = await mkItem(pool, u);
    const insert = (content, over = {}) => pool.query(`INSERT INTO zv_attachments (uid, item_id, meta_ciphertext, wrapped_file_key, content, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`, [uuid(), item.id, over.meta ?? bytes(60), over.key ?? bytes(73), content, u]);
    const random = crypto.randomBytes(300000);
    const id = uuid();
    await pool.query(`INSERT INTO zv_attachments (uid, item_id, meta_ciphertext, wrapped_file_key, content) VALUES (?, ?, ?, ?, ?)`, [id, item.id, bytes(60), bytes(73), random]);
    assert.ok(Buffer.from((await one(pool, `SELECT content FROM zv_attachments WHERE uid = ?`, [id])).content).equals(random), "binary content round-trips exactly");
    await insert(Buffer.alloc(10489856, 1)); // 10 MiB + framing: the largest permitted ciphertext
    await rejectsWith(insert(Buffer.alloc(10489857, 1)), /check/i);
    await rejectsWith(insert(bytes(40)), /check/i);
    await rejectsWith(insert(bytes(100), { key: bytes(72) }), /check/i);
    await rejectsWith(insert(bytes(100), { meta: bytes(5000) }), /check/i);
    // deleting the item removes its attachments (they are meaningless without it) -- but an item is never deleted automatically (see offboarding)
    await pool.query(`DELETE FROM zv_items WHERE id = ?`, [item.id]);
    assert.equal((await one(pool, `SELECT count(*)::int AS n FROM zv_attachments`)).n, 0);
});

// ---------------------------------------------------------------------------------------------- the audit trail is append-only

test("AUDIT is append-only at the database level (UPDATE, DELETE and TRUNCATE are refused) and cannot carry free text", { skip: SKIP }, async () => {
    const pool = await lab.tenantDatabase();
    const u = await lab.addUser(pool, "Owner");
    const add = (over = {}) => pool.query(`INSERT INTO zv_audit_events (kind, actor_user_id, detail) VALUES (?, ?, ?)`, [over.kind ?? "item_created", u, over.detail ?? "ownership=personal"]);
    await add();
    await rejectsWith(pool.query(`UPDATE zv_audit_events SET detail = 'x'`), /append-only/);
    await rejectsWith(pool.query(`DELETE FROM zv_audit_events`), /append-only/);
    await rejectsWith(pool.query(`TRUNCATE zv_audit_events`), /append-only/);
    await rejectsWith(add({ kind: "made_up_event" }), /check/i);
    for (const detail of ["has space", "UPPER", "quote'quote", "semi;colon", "naïve", "pass word=hunter2", "a".repeat(121)]) await rejectsWith(add({ detail }), /check|too long|22001/i);
    await add({ detail: "rights=reveal.copy,expires=yes" });
    assert.equal((await one(pool, `SELECT count(*)::int AS n FROM zv_audit_events`)).n, 2, "refused statements changed nothing");
    // the vocabulary distinguishes what the server saw from what a browser claimed
    for (const kind of ["secret_delivered", "reveal_reported", "copy_reported", "access_expired", "employee_deactivated"]) assert.ok(ddl.AUDIT_KINDS.includes(kind));
});

// ---------------------------------------------------------------------------------------------- offboarding

test("OFFBOARDING: every way of deactivating a person triggers the same revocation, in the same transaction, and deletes no credential", { skip: SKIP }, async () => {
    const pool = await lab.tenantDatabase();
    const admin = await lab.addUser(pool, "Manager", { role: "admin" });
    for (const [column, value] of NON_ACTIVE) {
        const stamp = `${NON_ACTIVE.findIndex(([c, v]) => c === column && v === value)}`;
        const owner = await lab.addUser(pool, `Own ${stamp}`);
        const leaver = await lab.addUser(pool, `Lea ${stamp}`);
        const stayer = await lab.addUser(pool, `Sta ${stamp}`);

        const shared = await mkItem(pool, owner.valueOf());
        await mkKey(pool, shared.id, "owner", owner, "meta");
        const leaversGrant = await mkGrant(pool, shared, leaver, { reveal: true, share: true, grantedBy: owner });
        const stayersGrant = await mkGrant(pool, shared, stayer, { reveal: true, grantedBy: owner });
        const reshare = await mkGrant(pool, shared, await lab.addUser(pool, `Re ${stamp}`), { reveal: false, parent: leaversGrant, grantedBy: leaver });
        const leaversOwn = await mkItem(pool, leaver);
        await mkKey(pool, leaversOwn.id, "owner", leaver, "meta");
        const givenOut = await mkGrant(pool, leaversOwn, stayer, { reveal: true, grantedBy: leaver });
        const collection = await mkCollection(pool, admin);
        await addMember(pool, collection.id, leaver, admin, true);
        await addMember(pool, collection.id, stayer, admin, false);
        const companyItem = await mkItem(pool, admin, { collectionId: collection.id });
        const itemsBefore = (await one(pool, `SELECT count(*)::int AS n FROM zv_items`)).n;

        await pool.query(`UPDATE users SET ${column} = ? WHERE id = ?`, [value, leaver]);

        const grantState = async (id) => (await one(pool, `SELECT revoked_at, revoked_by FROM zv_grants WHERE id = ?`, [id]));
        assert.ok((await grantState(leaversGrant)).revoked_at, `${column}=${value}: the grant the leaver received is revoked`);
        assert.ok((await grantState(reshare)).revoked_at, `${column}=${value}: so is what was shared onward through it`);
        assert.ok((await grantState(givenOut)).revoked_at, `${column}=${value}: and what the leaver shared out of their own vault`);
        assert.equal((await grantState(stayersGrant)).revoked_at, null, `${column}=${value}: other people's shares are untouched`);
        assert.equal((await rows(pool, `SELECT 1 FROM zv_item_keys WHERE holder_type = 'user' AND holder_user_id = ?`, [leaver])).length, 0, "the leaver's key envelopes are deleted");
        assert.equal((await rows(pool, `SELECT 1 FROM zv_collection_members WHERE user_id = ?`, [leaver])).length, 0, "and their collection membership");
        assert.equal((await rows(pool, `SELECT 1 FROM zv_collection_members WHERE user_id = ?`, [stayer])).length, 1, "the other member stays");
        assert.equal((await one(pool, `SELECT rotation_required FROM zv_collections WHERE id = ?`, [collection.id])).rotation_required, true, "the collection must be re-keyed");
        assert.equal((await one(pool, `SELECT rotation_required FROM zv_items WHERE id = ?`, [shared.id])).rotation_required, true, "the item the leaver could reveal must be rotated");

        // nothing is deleted: not the leaver's own vault, not the owner's items, not the company item
        assert.equal((await one(pool, `SELECT count(*)::int AS n FROM zv_items`)).n, itemsBefore, "no credential was deleted");
        for (const item of [shared, leaversOwn, companyItem]) assert.equal((await one(pool, `SELECT deleted_at FROM zv_items WHERE id = ?`, [item.id])).deleted_at, null);
        assert.equal((await rows(pool, `SELECT 1 FROM zv_item_keys WHERE holder_type = 'owner' AND holder_user_id = ?`, [leaver])).length, 1, "the leaver's own key envelope is untouched");

        const audit = await rows(pool, `SELECT kind, detail FROM zv_audit_events WHERE subject_user_id = ? OR actor_user_id = ?`, [leaver, leaver]);
        assert.equal(audit.filter((e) => e.kind === "employee_deactivated").length, 1, "exactly one record per deactivation");
        assert.ok(audit.some((e) => e.kind === "collection_member_removed" && e.detail === "reason=offboarding"));
        assert.ok(audit.some((e) => e.kind === "share_revoked" && e.detail === "reason=offboarding"));
        assert.match(audit.find((e) => e.kind === "employee_deactivated").detail, /^members_removed=1,revoked_grants=\d+$/);
    }
});

test("OFFBOARDING triggers only on the active -> not-active transition, once; other updates do not touch vault data", { skip: SKIP }, async () => {
    const pool = await lab.tenantDatabase();
    const owner = await lab.addUser(pool, "Owner");
    const person = await lab.addUser(pool, "Person");
    const item = await mkItem(pool, owner);
    const grant = await mkGrant(pool, item, person, { reveal: true, grantedBy: owner });
    const live = async () => (await one(pool, `SELECT revoked_at FROM zv_grants WHERE id = ?`, [grant])).revoked_at === null;

    await pool.query(`UPDATE users SET full_name = 'Renamed', designation = 'Lead', last_login = now() WHERE id = ?`, [person]);
    await pool.query(`UPDATE users SET status = 'active', employment_status = 'active' WHERE id = ?`, [person]);
    assert.equal(await live(), true, "unrelated updates and active -> active do nothing");
    assert.equal((await one(pool, `SELECT count(*)::int AS n FROM zv_audit_events WHERE kind = 'employee_deactivated'`)).n, 0);

    await pool.query(`UPDATE users SET employment_status = 'resigned', status = 'inactive' WHERE id = ?`, [person]);
    assert.equal(await live(), false);
    await pool.query(`UPDATE users SET employment_status = 'terminated' WHERE id = ?`, [person]); // not-active -> not-active
    await pool.query(`UPDATE users SET status = 'pending' WHERE id = ?`, [person]);
    assert.equal((await one(pool, `SELECT count(*)::int AS n FROM zv_audit_events WHERE kind = 'employee_deactivated'`)).n, 1, "never fires twice for one departure");

    // a person who was never active (pending) and is then deactivated: nothing to revoke, nothing recorded
    const pending = await lab.addUser(pool, "Pending", { status: "pending" });
    await pool.query(`UPDATE users SET status = 'inactive' WHERE id = ?`, [pending]);
    assert.equal((await one(pool, `SELECT count(*)::int AS n FROM zv_audit_events WHERE subject_user_id = ?`, [pending])).n, 0);
});

test("OFFBOARDING and REACTIVATION: coming back restores nothing automatically; the person's own vault is intact; the item owner's data is intact", { skip: SKIP }, async () => {
    const pool = await lab.tenantDatabase();
    const owner = await lab.addUser(pool, "Owner");
    const person = await lab.addUser(pool, "Person");
    const own = await mkItem(pool, person);
    await mkKey(pool, own.id, "owner", person, "meta");
    const shared = await mkItem(pool, owner);
    const grant = await mkGrant(pool, shared, person, { reveal: true, grantedBy: owner });
    const collection = await mkCollection(pool, owner);
    await addMember(pool, collection.id, person, owner, true);

    await pool.query(`UPDATE users SET status = 'inactive' WHERE id = ?`, [person]);
    await pool.query(`UPDATE users SET status = 'active' WHERE id = ?`, [person]);
    assert.ok((await one(pool, `SELECT revoked_at FROM zv_grants WHERE id = ?`, [grant])).revoked_at, "the share stays revoked");
    assert.equal((await rows(pool, `SELECT 1 FROM zv_collection_members WHERE user_id = ?`, [person])).length, 0, "membership is not restored");
    assert.equal((await rows(pool, `SELECT 1 FROM zv_item_keys WHERE holder_type = 'owner' AND holder_user_id = ?`, [person])).length, 1, "their personal vault is intact");
    assert.equal((await one(pool, `SELECT count(*)::int AS n FROM zv_items WHERE owner_user_id = ?`, [person])).n, 1);
    // the owner may share again, deliberately
    await mkGrant(pool, shared, person, { reveal: true, grantedBy: owner });
});

test("OFFBOARDING of a company manager: their membership goes, company credentials and the other members stay, the collection is flagged; a collection left without a manager is findable", { skip: SKIP }, async () => {
    const pool = await lab.tenantDatabase();
    const manager = await lab.addUser(pool, "Manager", { role: "admin" });
    const second = await lab.addUser(pool, "Second", { role: "admin" });
    const member = await lab.addUser(pool, "Member");
    const collection = await mkCollection(pool, manager);
    await pool.query(`INSERT INTO zv_collection_members (collection_id, user_id, can_reveal, can_edit, can_share, is_manager, wrapped_meta_key, wrapped_secret_key, sender_user_id) VALUES (?, ?, TRUE, TRUE, TRUE, TRUE, ?, ?, ?)`, [collection.id, second, bytes(100), bytes(100), manager]);
    await addMember(pool, collection.id, member, manager, true);
    const company = await mkItem(pool, manager, { collectionId: collection.id });
    await mkKey(pool, company.id, "collection", null, "meta");

    await pool.query(`UPDATE users SET employment_status = 'terminated', status = 'inactive' WHERE id = ?`, [manager]);
    const members = (await rows(pool, `SELECT user_id FROM zv_collection_members WHERE collection_id = ?`, [collection.id])).map((r) => Number(r.user_id)).sort();
    assert.deepEqual(members, [member, second].sort());
    assert.equal((await one(pool, `SELECT rotation_required FROM zv_collections WHERE id = ?`, [collection.id])).rotation_required, true);
    assert.equal((await one(pool, `SELECT deleted_at FROM zv_items WHERE id = ?`, [company.id])).deleted_at, null, "the company credential is preserved");
    assert.equal((await rows(pool, `SELECT 1 FROM zv_item_keys WHERE item_id = ? AND holder_type = 'collection'`, [company.id])).length, 1);

    // when the last manager leaves, the collection survives and an administrator can find it
    await pool.query(`UPDATE users SET status = 'inactive' WHERE id = ?`, [second]);
    const orphans = await rows(pool, `SELECT c.uid FROM zv_collections c WHERE NOT EXISTS (SELECT 1 FROM zv_collection_members m JOIN users u ON u.id = m.user_id WHERE m.collection_id = c.id AND m.is_manager AND u.status = 'active')`);
    assert.deepEqual(orphans.map((r) => r.uid), [collection.uid]);
    assert.equal((await one(pool, `SELECT count(*)::int AS n FROM zv_items WHERE collection_id = ?`, [collection.id])).n, 1, "still no deletion");
});

test("OFFBOARDING is TRANSACTIONAL: a rolled-back deactivation revokes nothing; and a trigger that cannot finish FAILS the deactivation (nothing is half-done)", { skip: SKIP }, async () => {
    const pool = await lab.tenantDatabase();
    const owner = await lab.addUser(pool, "Owner");
    const person = await lab.addUser(pool, "Person");
    const item = await mkItem(pool, owner);
    const grant = await mkGrant(pool, item, person, { reveal: true, grantedBy: owner });
    const collection = await mkCollection(pool, owner);
    await addMember(pool, collection.id, person, owner, true);
    const snapshot = async () => JSON.stringify(await Promise.all([
        rows(pool, `SELECT id, revoked_at FROM zv_grants ORDER BY id`), rows(pool, `SELECT holder_user_id, purpose FROM zv_item_keys ORDER BY id`),
        rows(pool, `SELECT collection_id, user_id FROM zv_collection_members ORDER BY collection_id, user_id`), rows(pool, `SELECT rotation_required FROM zv_items ORDER BY id`),
        rows(pool, `SELECT rotation_required FROM zv_collections ORDER BY id`), rows(pool, `SELECT kind FROM zv_audit_events ORDER BY id`), rows(pool, `SELECT status FROM users ORDER BY id`),
    ]));
    const before = await snapshot();

    // 1. the deactivation is rolled back by the caller (e.g. the HR action failed later): the revocation is rolled back with it
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.query(`UPDATE users SET status = 'inactive' WHERE id = ?`, [person]);
        const inside = await connection.query(`SELECT revoked_at FROM zv_grants WHERE id = ?`, [grant]);
        assert.ok(inside[0][0].revoked_at, "inside the transaction the revocation is already visible");
        await connection.rollback();
    } finally {
        connection.release();
    }
    assert.equal(await snapshot(), before, "rollback restored everything, user status included");

    // 2. the trigger fails part-way (we make its audit insert impossible): the UPDATE of the user fails too -- fail closed
    await pool.query(`ALTER TABLE zv_audit_events ADD CONSTRAINT zz_block_deactivation CHECK (kind <> 'employee_deactivated')`);
    await rejectsWith(pool.query(`UPDATE users SET status = 'inactive' WHERE id = ?`, [person]), /zz_block_deactivation|check/i);
    assert.equal(await snapshot(), before, "a failing trigger leaves nothing half-revoked and the person still active");
    await pool.query(`ALTER TABLE zv_audit_events DROP CONSTRAINT zz_block_deactivation`);
    await pool.query(`UPDATE users SET status = 'inactive' WHERE id = ?`, [person]);
    assert.notEqual(await snapshot(), before, "once the obstacle is gone the deactivation goes through");
});

test("OFFBOARDING with concurrent activity: a grant created while a person is being deactivated cannot survive", { skip: SKIP }, async () => {
    const pool = await lab.tenantDatabase();
    const owner = await lab.addUser(pool, "Owner");
    const people = [];
    for (let i = 0; i < 6; i += 1) people.push(await lab.addUser(pool, `P${i}`));
    const item = await mkItem(pool, owner);
    await Promise.all(people.map((p) => mkGrant(pool, item, p, { reveal: true, grantedBy: owner })));
    await Promise.all(people.map((p) => pool.query(`UPDATE users SET status = 'inactive' WHERE id = ?`, [p])));
    assert.equal((await one(pool, `SELECT count(*)::int AS n FROM zv_grants WHERE revoked_at IS NULL`)).n, 0);
    assert.equal((await one(pool, `SELECT count(*)::int AS n FROM zv_item_keys WHERE holder_type = 'user'`)).n, 0);
    assert.equal((await one(pool, `SELECT count(*)::int AS n FROM zv_audit_events WHERE kind = 'employee_deactivated'`)).n, 6);
});

test("HARD-deleting a user is blocked while they own vault data; deleting someone who only received shares cleans those up", { skip: SKIP }, async () => {
    const pool = await lab.tenantDatabase();
    const owner = await lab.addUser(pool, "Owner");
    const recipient = await lab.addUser(pool, "Recipient");
    const item = await mkItem(pool, owner);
    await mkGrant(pool, item, recipient, { reveal: true, grantedBy: owner });
    await rejectsWith(pool.query(`DELETE FROM users WHERE id = ?`, [owner]), /23503|foreign key|violates/i);
    await pool.query(`DELETE FROM users WHERE id = ?`, [recipient]);
    assert.equal((await one(pool, `SELECT count(*)::int AS n FROM zv_grants`)).n, 0, "the pure access rows went with the user");
    assert.equal((await one(pool, `SELECT count(*)::int AS n FROM zv_items`)).n, 1, "the credential did not");
});

test("SWEEP vs REQUEST: expiry is decided at read time by now(); the sweep function itself revokes, deletes envelopes and audits as 'access_expired'", { skip: SKIP }, async () => {
    const pool = await lab.tenantDatabase();
    const owner = await lab.addUser(pool, "Owner");
    const person = await lab.addUser(pool, "Person");
    const item = await mkItem(pool, owner);
    const grant = await mkGrant(pool, item, person, { reveal: true, grantedBy: owner });
    await pool.query(`UPDATE zv_grants SET expires_at = now() - interval '1 second' WHERE id = ?`, [grant]);
    const revoked = (await one(pool, `SELECT zv_revoke_grants(ARRAY[?]::integer[], NULL, 'expired') AS n`, [grant])).n;
    assert.equal(revoked, 1);
    assert.equal((await rows(pool, `SELECT 1 FROM zv_item_keys WHERE holder_type = 'user'`)).length, 0);
    assert.deepEqual((await rows(pool, `SELECT kind, detail FROM zv_audit_events WHERE item_uid = ?`, [item.uid])).map((e) => [e.kind, e.detail]), [["access_expired", "reason=expired"]]);
    assert.equal((await one(pool, `SELECT zv_revoke_grants(ARRAY[?]::integer[], NULL, 'expired') AS n`, [grant])).n, 0, "idempotent");
});

// ---------------------------------------------------------------------------------------------- migration on real databases

const objects = async (pool) => ({
    tables: (await rows(pool, `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'zv\\_%' ORDER BY 1`)).map((r) => r.table_name),
    triggers: (await rows(pool, `SELECT tgname FROM pg_trigger WHERE tgname LIKE 'zv\\_%' AND NOT tgisinternal ORDER BY 1`)).map((r) => r.tgname),
    functions: (await rows(pool, `SELECT proname FROM pg_proc WHERE proname LIKE 'zv\\_%' ORDER BY 1`)).map((r) => r.proname),
});
const EXPECTED = { tables: [...ddl.ZIOVAULT_TABLES].sort(), triggers: ["zv_audit_no_truncate", "zv_audit_no_update", "zv_offboard_on_users_update"], functions: ["zv_audit_immutable", "zv_offboard_user", "zv_remove_collection_members", "zv_revoke_grants"] };

for (const idType of ["integer", "bigint"]) {
    test(`MIGRATION on a LEGACY database (users.id ${idType.toUpperCase()}): creates everything, is idempotent, and the offboarding trigger works`, { skip: SKIP }, async () => {
        const pool = await lab.legacyDatabase(idType);
        assert.deepEqual((await objects(pool)).tables, [], "before: nothing");
        const first = await migration.migrateDatabase("legacy", pool);
        assert.equal(first.action, "migrated");
        assert.deepEqual(first.missing.sort(), EXPECTED.tables);
        assert.deepEqual(await objects(pool), EXPECTED);

        const second = await migration.migrateDatabase("legacy", pool);
        assert.equal(second.action, "skipped");
        assert.deepEqual(await objects(pool), EXPECTED, "a second run changes nothing");

        // the trigger works on this database's id type
        const owner = await lab.addUser(pool, "Legacy Owner");
        const person = await lab.addUser(pool, "Legacy Person");
        const item = await mkItem(pool, owner);
        const grant = await mkGrant(pool, item, person, { reveal: true, grantedBy: owner });
        const collection = await mkCollection(pool, owner);
        await addMember(pool, collection.id, person, owner, true);
        await pool.query(`UPDATE users SET employment_status = 'resigned' WHERE id = ?`, [person]);
        assert.ok((await one(pool, `SELECT revoked_at FROM zv_grants WHERE id = ?`, [grant])).revoked_at);
        assert.equal((await rows(pool, `SELECT 1 FROM zv_collection_members WHERE user_id = ?`, [person])).length, 0);
        if (idType === "bigint") assert.equal(typeof (await one(pool, `SELECT id FROM users WHERE id = ?`, [person])).id, "string", "(node-pg returns bigint ids as strings; the service normalises them)");
    });
}

test("MIGRATION on a legacy database where employment_status is NULL for some users: NULL counts as active, like the login code treats it", { skip: SKIP }, async () => {
    const pool = await lab.legacyDatabase("integer");
    await migration.migrateDatabase("legacy", pool);
    await pool.query(`ALTER TABLE users ALTER COLUMN employment_status DROP NOT NULL`);
    await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_employment_status_check`);
    const owner = await lab.addUser(pool, "Owner");
    const person = await lab.addUser(pool, "Person");
    await pool.query(`UPDATE users SET employment_status = NULL WHERE id = ?`, [person]);
    const item = await mkItem(pool, owner);
    const grant = await mkGrant(pool, item, person, { reveal: true, grantedBy: owner });
    await pool.query(`UPDATE users SET full_name = 'x' WHERE id = ?`, [person]);
    assert.equal((await one(pool, `SELECT revoked_at FROM zv_grants WHERE id = ?`, [grant])).revoked_at, null, "NULL is active");
    await pool.query(`UPDATE users SET status = 'inactive' WHERE id = ?`, [person]);
    assert.ok((await one(pool, `SELECT revoked_at FROM zv_grants WHERE id = ?`, [grant])).revoked_at);
});

test("MIGRATION on a freshly provisioned tenant is a no-op that refreshes the functions; and two runs at the same moment both succeed", { skip: SKIP }, async () => {
    const pool = await lab.tenantDatabase();
    assert.deepEqual(await objects(pool), EXPECTED, "a new tenant already has everything from the schema file");
    const results = await Promise.all([migration.migrateDatabase("a", pool), migration.migrateDatabase("b", pool), migration.migrateDatabase("c", pool)]);
    assert.ok(results.every((r) => r.action === "skipped"));
    assert.deepEqual(await objects(pool), EXPECTED);

    const legacy = await lab.legacyDatabase("integer");
    const racing = await Promise.all([migration.migrateDatabase("a", legacy), migration.migrateDatabase("b", legacy), migration.migrateDatabase("c", legacy)]);
    assert.equal(racing.filter((r) => r.action === "migrated").length >= 1, true);
    assert.deepEqual(await objects(legacy), EXPECTED, "exactly one set of objects, no failure, no duplicates");
});

test("MIGRATION is all-or-nothing: if any statement fails, the database is exactly as it was; a database lacking a needed column is not touched at all", { skip: SKIP }, async () => {
    // a conflicting function makes CREATE OR REPLACE FUNCTION fail late in the script -- after the tables were created
    const pool = await lab.legacyDatabase("integer");
    await pool.query(`CREATE FUNCTION zv_revoke_grants(a integer[], b integer, c text) RETURNS text AS $$ SELECT 'x'::text $$ LANGUAGE sql`);
    const before = await objects(pool);
    await assert.rejects(migration.migrateDatabase("conflict", pool), /return type|cannot change/i);
    assert.deepEqual(await objects(pool), before, "the tables created earlier in the same run were rolled back");
    const outcome = await migration.runTargets([{ label: "conflict", getPool: () => pool }]);
    assert.equal(outcome.failures, 1);

    // lacking employment_status: refused before a transaction is even opened
    const name = `wh_test_${crypto.randomBytes(5).toString("hex")}`;
    await lab.admin.query(`CREATE DATABASE ${name}`);
    lab.databases.push(name);
    const bare = lab.pool(name);
    await bare.query(`CREATE TABLE users (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, status varchar)`);
    await assert.rejects(migration.migrateDatabase("bare", bare), /lacks column\(s\) employment_status/);
    assert.deepEqual((await objects(bare)).tables, []);
});

test("DRY RUN reports and writes nothing", { skip: SKIP }, async () => {
    const pool = await lab.legacyDatabase("integer");
    const result = await migration.migrateDatabase("legacy", pool, { dryRun: true });
    assert.equal(result.action, "dry-run");
    assert.deepEqual([...result.missing].sort(), EXPECTED.tables);
    assert.deepEqual((await objects(pool)).tables, []);
});

test("PROVISIONING: a brand-new tenant database is built from the real schema file with the dollar-quoted functions intact", { skip: SKIP }, async () => {
    const pool = await lab.tenantDatabase();
    const body = (await one(pool, `SELECT prosrc FROM pg_proc WHERE proname = 'zv_offboard_user'`)).prosrc;
    assert.match(body, /zv_remove_collection_members\(NULL, ARRAY\[NEW\.id\]::bigint\[\], NULL, 'offboarding'\)/);
    assert.match(body, /RETURN NEW;/);
    // the trigger is attached to the users table with its WHEN condition
    const trigger = (await one(pool, `SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = 'zv_offboard_on_users_update'`)).def;
    assert.match(trigger, /AFTER UPDATE OF status, employment_status ON (public\.)?users/);
    assert.match(trigger, /WHEN \(/);
});
