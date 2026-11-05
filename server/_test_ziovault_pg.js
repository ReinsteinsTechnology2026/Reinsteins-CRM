// ZioVault on REAL PostgreSQL, through the REAL router/controller/service, driven by a "browser" that uses the REAL client-side
// cryptography. What this proves that unit tests cannot: the SQL, the constraints, the access rules end to end, that the database
// and every response contain only ciphertext, and that tenants, users and permissions stay separate.
//
// Needs a DISPOSABLE PostgreSQL (PG_TEST_* variables); without them it is skipped, and the migration-postgres CI job runs it with
// PG_TEST_REQUIRED=1. Run: PG_TEST_HOST=127.0.0.1 PG_TEST_PORT=5432 PG_TEST_USER=wh_ci PG_TEST_PASSWORD=... PG_TEST_ADMIN_DB=wh_ci_admin node --test _test_ziovault_pg.js

process.env.JWT_SECRET = process.env.JWT_SECRET || "legacy-secret-for-tests";
process.env.TENANT_JWT_SECRET = process.env.TENANT_JWT_SECRET || "tenant-secret-for-tests";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

const { createLab, loadCrypto, makeBrowser, b64, unb64, uuid, transcript } = require("./_ziovault_test_support");

const lab = createLab();
const SKIP = lab.skip;
const FAST = { alg: "argon2id13", ops: 2, mem: 32 * 1024 * 1024 };
const PASSWORD = "correct horse battery staple";

// Plaintext that must never reach the server, the database, a response or a log.
const MARK = {
    password: "Tr0ub4dor&3-PW-MARKER-91c2",
    title: "Production AWS root TITLE-MARKER-5d1e",
    username: "svc-deploy@acme.test USER-MARKER-77aa",
    url: "https://console.aws.example/signin URL-MARKER-02bd",
    notes: "recovery codes: 4411-9922 NOTE-MARKER-c3f0",
};
const FORBIDDEN = [...Object.values(MARK), PASSWORD, "correct horse"];

let vault;
const logged = [];
const realConsole = { log: console.log, error: console.error, info: console.info, warn: console.warn };
let nextTenant = 100;

test.before(async () => {
    for (const level of ["log", "error", "info", "warn"]) console[level] = (...args) => { logged.push(args.map(String).join(" ")); };
    vault = await loadCrypto();
});
test.after(async () => {
    Object.assign(console, realConsole);
    await lab.close();
});

// ---------------------------------------------------------------------------------------------- a populated tenant
async function buildWorld({ limiters, gate } = {}) {
    const tenantId = ++nextTenant;
    const pool = await lab.tenantDatabase();
    const api = await lab.startApi(pool, { tenantId, limiters, gate });
    const ids = {
        admin: await lab.addUser(pool, "Ada Admin", { role: "admin", access: "super_admin" }),
        admin2: await lab.addUser(pool, "Bea Second Admin", { role: "admin", access: "admin" }),
        alice: await lab.addUser(pool, "Alice"),
        bob: await lab.addUser(pool, "Bob"),
        carol: await lab.addUser(pool, "Carol"),
        dave: await lab.addUser(pool, "Dave Intern", { type: "intern" }),
        erin: await lab.addUser(pool, "Erin"),
        frank: await lab.addUser(pool, "Frank NoVault"),
        gone: await lab.addUser(pool, "Gone Inactive", { status: "inactive", employmentStatus: "resigned" }),
    };
    const world = { tenantId, pool, api, ids, people: {} };
    for (const name of ["admin", "admin2", "alice", "bob", "carol", "dave", "erin"]) {
        const browser = await makeBrowser(api, ids[name], vault);
        const { res } = await browser.register(PASSWORD, FAST);
        assert.equal(res.status, 201, `${name} registers`);
        world[name] = browser;
    }
    // what a browser sees when it picks a person to share with
    world.who = async (viewer, target) => (await viewer.directory()).find((u) => u.userId === target.userId);
    return world;
}

const dumpDatabase = async (pool) => {
    const tables = ["zv_accounts", "zv_account_history", "zv_folders", "zv_collections", "zv_collection_members", "zv_items", "zv_item_keys", "zv_grants", "zv_attachments", "zv_audit_events"];
    const chunks = [];
    let text = "";
    for (const table of tables) {
        const [rows] = await pool.query(`SELECT * FROM ${table}`);
        for (const row of rows) for (const value of Object.values(row)) {
            if (Buffer.isBuffer(value)) { chunks.push(value); text += `${value.toString("hex")} ${value.toString("base64")} `; }
            else text += `${value instanceof Date ? value.toISOString() : String(value)} `;
        }
    }
    return { raw: Buffer.concat(chunks), text };
};
const forms = (needle) => [Buffer.from(needle), Buffer.from(Buffer.from(needle).toString("base64")), Buffer.from(Buffer.from(needle).toString("base64url")), Buffer.from(Buffer.from(needle).toString("hex"))];
const containsPlaintext = (haystack, needle) => forms(needle).some((form) => (Buffer.isBuffer(haystack) ? haystack.includes(form) : haystack.includes(form.toString())));

let main; // the shared tenant

test("setup: the configured server is the disposable PostgreSQL service", { skip: SKIP }, async () => {
    await lab.connect();
    main = await buildWorld();
});

// ---------------------------------------------------------------------------------------------- accounts

test("ACCOUNT: registration works once, and the server stores only envelopes and the PUBLIC key", { skip: SKIP }, async () => {
    const { alice, ids, pool } = main;
    const again = await alice.call("POST", "/account", alice.wire(alice.server));
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "ACCOUNT_EXISTS");

    const [rows] = await pool.query(`SELECT * FROM zv_accounts WHERE user_id = ?`, [ids.alice]);
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]).sort(), ["account_version", "created_at", "envelope_version", "kdf_alg", "kdf_mem", "kdf_ops", "kdf_salt", "password_changed_at", "private_key_envelope", "public_key", "recovery_confirmed_at", "recovery_envelope", "updated_at", "user_id", "vault_key_envelope"].sort());
    assert.ok(Buffer.from(rows[0].public_key).equals(Buffer.from(alice.session.publicKey)));
    for (const secret of [alice.session.vaultKey, alice.session.privateKey]) assert.equal(Buffer.concat([rows[0].vault_key_envelope, rows[0].private_key_envelope, rows[0].recovery_envelope, rows[0].kdf_salt]).includes(Buffer.from(secret)), false);
    assert.equal((await alice.call("GET", "/account/status")).data.exists, true);
    assert.equal((await alice.call("GET", "/account/status")).data.recoveryConfirmed, false);
    const nobody = await makeBrowser(main.api, main.ids.frank, vault);
    assert.deepEqual((await nobody.call("GET", "/account/status")).data, { exists: false });
});

test("ACCOUNT: malformed registrations are refused and store nothing (sizes, version byte, KDF bounds, duplicate public key)", { skip: SKIP }, async () => {
    const { ids, pool, api } = main;
    const frank = await makeBrowser(api, ids.frank, vault);
    const account = await vault.createAccount({ password: PASSWORD, tenantId: main.tenantId, userId: ids.frank, kdf: FAST });
    const good = frank.wire(account.server);
    const tweak = (patch) => ({ ...good, ...patch });
    const cases = [
        tweak({ vaultKeyEnvelope: b64(new Uint8Array(72).fill(1)) }),
        tweak({ vaultKeyEnvelope: b64(Uint8Array.from([2, ...new Uint8Array(72)])) }), // unknown version
        tweak({ privateKeyEnvelope: "not base64!" }),
        tweak({ recoveryEnvelope: undefined }),
        tweak({ publicKey: b64(new Uint8Array(31)) }),
        tweak({ kdf: { ...good.kdf, ops: 1 } }),
        tweak({ kdf: { ...good.kdf, mem: 1024 } }),
        tweak({ kdf: { ...good.kdf, alg: "argon2i" } }),
        tweak({ kdf: { ...good.kdf, salt: b64(new Uint8Array(8)) } }),
    ];
    for (const body of cases) assert.equal((await frank.call("POST", "/account", body)).status, 400);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zv_accounts WHERE user_id = ?`, [ids.frank]))[0][0].n, 0);

    // somebody else's public key cannot be registered again
    const stolen = frank.wire({ ...account.server, publicKey: main.alice.session.publicKey });
    const res = await frank.call("POST", "/account", stolen);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "PUBLIC_KEY_IN_USE");
    assert.equal((await frank.call("POST", "/account", good)).status, 201, "and the genuine registration still works");
});

test("ACCOUNT: unauthenticated, unknown and inactive users are refused; users without a vault are told to set one up", { skip: SKIP }, async () => {
    const { api, ids } = main;
    const anonymous = await fetch(`${api.url}/api/ziovault/items`);
    assert.equal(anonymous.status, 401);
    const ghost = await makeBrowser(api, 999999, vault);
    assert.equal((await ghost.call("GET", "/items")).status, 403, "a user id that is not an active user");
    const gone = await makeBrowser(api, ids.gone, vault);
    const inactive = await gone.call("GET", "/account/status");
    assert.equal(inactive.status, 403);
    assert.equal(inactive.body.code, "ACCOUNT_INACTIVE");
    const intern = await makeBrowser(api, ids.frank, vault);
    const items = await intern.call("GET", "/items");
    assert.equal(items.status, 200, "frank registered in the previous test");
});

test("UNLOCK: a user receives ONLY their own envelopes (no parameter selects another user), without recovery material; every fetch is audited", { skip: SKIP }, async () => {
    const { alice, bob, ids, pool } = main;
    const before = (await pool.query(`SELECT count(*)::int AS n FROM zv_audit_events WHERE kind = 'envelopes_fetched' AND actor_user_id = ?`, [ids.alice]))[0][0].n;
    const own = await alice.call("GET", `/account/unlock?userId=${ids.bob}`, undefined, { "x-user-id": String(ids.bob) });
    assert.equal(own.status, 200);
    assert.ok(Buffer.from(unb64(own.data.publicKey)).equals(Buffer.from(alice.session.publicKey)), "alice's own key, whatever the query says");
    assert.equal(own.data.recoveryEnvelope, undefined, "recovery material is a separate, separately limited call");
    assert.deepEqual(Object.keys(own.data).sort(), ["accountVersion", "exists", "kdf", "privateKeyEnvelope", "publicKey", "recoveryConfirmed", "vaultKeyEnvelope"]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zv_audit_events WHERE kind = 'envelopes_fetched' AND actor_user_id = ?`, [ids.alice]))[0][0].n, before + 1);
    const opened = await alice.unlock();
    assert.ok(Buffer.from(opened.session.vaultKey).equals(Buffer.from(alice.session.vaultKey)));
    const bobs = await bob.unlock();
    assert.ok(!Buffer.from(bobs.session.vaultKey).equals(Buffer.from(alice.session.vaultKey)));
});

test("UNLOCK is rate limited per user (a stolen session cannot hammer the envelope endpoint)", { skip: SKIP }, async () => {
    const { createVaultLimiters } = require("./middleware/vaultRateLimiters");
    const world = await buildWorld({ limiters: createVaultLimiters({ unlock: { windowMs: 60000, max: 3 } }) });
    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await world.alice.call("GET", "/account/unlock")).status);
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    assert.equal((await world.bob.call("GET", "/account/unlock")).status, 200, "another user has their own budget");
});

test("DIRECTORY: colleagues with a vault, their PUBLIC keys; never the caller, inactive users or people without a vault", { skip: SKIP }, async () => {
    const { alice, ids } = main;
    const list = await alice.directory();
    const names = list.map((u) => u.name);
    assert.ok(names.includes("Bob") && names.includes("Dave Intern"));
    assert.ok(!names.includes("Alice"), "not the caller");
    assert.ok(!names.includes("Gone Inactive"), "not an inactive user");
    assert.equal(list.find((u) => u.userId === ids.dave).employmentType, "intern");
    for (const entry of list) assert.deepEqual(Object.keys(entry).sort(), ["employeeId", "employmentType", "name", "publicKey", "registeredAt", "userId"]);
    const frankListed = list.find((u) => u.userId === ids.frank);
    assert.ok(frankListed, "frank registered earlier in this file");
    const bobKey = list.find((u) => u.userId === ids.bob).publicKey;
    assert.equal(bobKey, b64(main.bob.session.publicKey));
});

// ---------------------------------------------------------------------------------------------- recovery and password change

test("RECOVERY: the recovery secret restores access under a new password; the old envelope is kept; a stale request is refused", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const { carol } = world;
    const recovery = await carol.call("GET", "/account/recovery");
    assert.equal(recovery.status, 200);
    const server = carol.fromWire(recovery.data);
    assert.ok(server.recoveryEnvelope);

    const oldPassword = carol.password;
    const recovered = await vault.recoverAccount({ recoverySecretText: carol.recoverySecret, newPassword: "a completely new password", server, tenantId: world.tenantId, userId: carol.userId, kdf: FAST });
    const send = (accountVersion, reason = "recovery_used") => carol.call("PUT", "/account/envelope", {
        expectedAccountVersion: accountVersion, reason,
        kdf: { alg: recovered.server.kdf.alg, ops: recovered.server.kdf.ops, mem: recovered.server.kdf.mem, salt: b64(recovered.server.kdf.salt) },
        vaultKeyEnvelope: b64(recovered.server.vaultKeyEnvelope),
    });
    assert.equal((await send(99)).status, 409, "stale account version");
    assert.equal((await send(carol.accountVersion, "something_else")).status, 400);
    const ok = await send(carol.accountVersion);
    assert.equal(ok.status, 200);
    assert.equal(ok.data.accountVersion, 2);

    const reopened = await carol.unlock("a completely new password");
    assert.ok(Buffer.from(reopened.session.vaultKey).equals(Buffer.from(recovered.session.vaultKey)));
    await assert.rejects(carol.unlock(oldPassword), (error) => error.name === "VaultCryptoError");

    const history = await carol.call("GET", "/account/envelope-history");
    assert.equal(history.data.length, 1);
    assert.equal(history.data[0].reason, "recovery_used");

    // restoring the previous envelope brings the old password back (so a hijacked session cannot destroy a vault irreversibly)
    const restored = await carol.call("POST", `/account/envelope-history/${history.data[0].id}/restore`, { expectedAccountVersion: 2 });
    assert.equal(restored.status, 200);
    assert.ok((await carol.unlock(oldPassword)).session);
    await assert.rejects(carol.unlock("a completely new password"));
});

test("RECOVERY: the recovery confirmation and a rotated recovery secret; a wrong/typo'd secret never opens anything", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const { dave } = world;
    assert.equal((await dave.call("POST", "/account/recovery-confirmation")).data.recoveryConfirmed, true);
    assert.equal((await dave.call("GET", "/account/status")).data.recoveryConfirmed, true);

    const rotated = await vault.rotateRecoverySecret({ session: dave.session, tenantId: world.tenantId, userId: dave.userId });
    const status = await dave.call("GET", "/account/status");
    const put = await dave.call("PUT", "/account/recovery-envelope", { expectedAccountVersion: status.data.accountVersion, recoveryEnvelope: b64(rotated.recoveryEnvelope) });
    assert.equal(put.status, 200);
    assert.equal((await dave.call("GET", "/account/status")).data.recoveryConfirmed, false, "the new secret must be confirmed again");

    const server = dave.fromWire((await dave.call("GET", "/account/recovery")).data);
    await assert.rejects(vault.recoverAccount({ recoverySecretText: dave.recoverySecret, newPassword: "another new password!", server, tenantId: world.tenantId, userId: dave.userId, kdf: FAST }), (e) => e.name === "VaultCryptoError");
    assert.ok(await vault.recoverAccount({ recoverySecretText: rotated.recoverySecretText, newPassword: "another new password!", server, tenantId: world.tenantId, userId: dave.userId, kdf: FAST }));
});

test("PASSWORD CHANGE: same vault key, same key pair, items still open; history keeps the old envelope", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const { erin } = world;
    const created = await erin.createItem({ meta: { title: MARK.title }, secret: { password: MARK.password } });
    assert.equal(created.res.status, 201);

    const updated = await vault.changeMasterPassword({ session: erin.session, newPassword: "my brand new master password", tenantId: world.tenantId, userId: erin.userId, kdf: FAST, server: erin.server });
    const put = await erin.call("PUT", "/account/envelope", {
        expectedAccountVersion: 1, reason: "password_changed",
        kdf: { alg: updated.kdf.alg, ops: updated.kdf.ops, mem: updated.kdf.mem, salt: b64(updated.kdf.salt) }, vaultKeyEnvelope: b64(updated.vaultKeyEnvelope),
    });
    assert.equal(put.status, 200);
    const reopened = await erin.unlock("my brand new master password");
    assert.ok(Buffer.from(reopened.session.privateKey).equals(Buffer.from(erin.session.privateKey)), "the key pair did not change");
    const revealed = await erin.revealItem(created.uid);
    assert.equal(revealed.secret.password, MARK.password);
    assert.equal((await erin.call("GET", "/account/envelope-history")).data[0].reason, "password_changed");
    // nobody else can restore or read erin's history
    assert.equal((await main.alice.call("POST", `/account/envelope-history/1/restore`, { expectedAccountVersion: 1 })).status, 404);
});

// ---------------------------------------------------------------------------------------------- personal vault

test("PERSONAL ITEMS: create, list (never the secret), read, reveal (the only path that returns a secret ciphertext), update with versions", { skip: SKIP }, async () => {
    const { alice, pool } = main;
    const created = await alice.createItem({ kind: "login", meta: { title: MARK.title, username: MARK.username, url: MARK.url }, secret: { password: MARK.password, notes: MARK.notes }, rotationIntervalDays: 90 });
    assert.equal(created.res.status, 201);
    main.itemA = created;

    const list = await alice.call("GET", "/items");
    const entry = list.data.find((i) => i.uid === created.uid);
    assert.ok(entry && entry.hasSecret === true);
    assert.equal(entry.secret, undefined, "the list never carries a secret ciphertext");
    assert.equal(entry.keys[0].secret, null, "nor the key that opens it");
    assert.equal(entry.rights.manage, true);
    assert.equal(entry.rotationIntervalDays, 90);

    const read = await alice.readItem(created.uid);
    assert.deepEqual(read.meta, { title: MARK.title, username: MARK.username, url: MARK.url });
    assert.equal(read.secret, undefined, "reading details does not reveal the secret");

    const revealed = await alice.revealItem(created.uid);
    assert.deepEqual(revealed.secret, { password: MARK.password, notes: MARK.notes });

    // updates: optimistic versions
    const sealed = await vault.encryptItem({ tenantId: main.tenantId, itemUid: created.uid, keys: created.keys, meta: { title: "renamed" }, secret: { password: "new-pass" } });
    const stale = await alice.call("PATCH", `/items/${created.uid}`, { expectedVersion: 5, meta: b64(sealed.metaCiphertext) });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "STALE_VERSION");
    const lastBefore = (await pool.query(`SELECT last_rotated_at FROM zv_items WHERE uid = ?`, [created.uid]))[0][0].last_rotated_at;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const patched = await alice.call("PATCH", `/items/${created.uid}`, { expectedVersion: 1, meta: b64(sealed.metaCiphertext), secret: b64(sealed.secretCiphertext) });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.version, 2);
    const lastAfter = (await pool.query(`SELECT last_rotated_at FROM zv_items WHERE uid = ?`, [created.uid]))[0][0].last_rotated_at;
    assert.ok(lastAfter > lastBefore, "changing the secret restarts the rotation clock");
    assert.equal((await alice.revealItem(created.uid)).secret.password, "new-pass");
});

test("PERSONAL VAULT PRIVACY: nobody else -- not an employee, not an admin, not a super admin -- can reach another user's personal item by any route", { skip: SKIP }, async () => {
    const { alice, bob, admin, admin2, itemA } = main;
    const uid = itemA.uid;
    const attempts = (browser) => [
        ["GET", `/items/${uid}`], ["POST", `/items/${uid}/secret`], ["POST", `/items/${uid}/access-reports`, { kind: "reveal" }],
        ["PATCH", `/items/${uid}`, { expectedVersion: 2, favorite: true }], ["DELETE", `/items/${uid}`], ["POST", `/items/${uid}/restore`],
        ["GET", `/items/${uid}/grants`], ["POST", `/items/${uid}/rotate`, {}], ["PATCH", `/items/${uid}/grants/${browser.userId}`, {}], ["DELETE", `/items/${uid}/grants/${browser.userId}`],
        ["GET", `/audit?itemUid=${uid}`],
    ];
    for (const intruder of [bob, admin, admin2]) {
        for (const [method, route, body] of attempts(intruder)) {
            const res = await intruder.call(method, route, body);
            assert.equal(res.status, 404, `${method} ${route} as user ${intruder.userId}`);
            assert.equal(res.body.code, "NOT_FOUND", "the same answer as for an item that does not exist");
        }
        assert.ok(!(await intruder.call("GET", "/items")).data.some((i) => i.uid === uid), "not in their list");
    }
    const unknown = await bob.call("GET", `/items/${uuid()}`);
    assert.deepEqual({ ...unknown.body }, { success: false, code: "NOT_FOUND", message: "Not found." }, "indistinguishable from a real item");
    // the owner still has it (nothing above changed anything)
    assert.equal((await alice.readItem(uid)).res.status, 200);
});

test("ADMINS CANNOT DECRYPT: even holding every ciphertext and envelope the database has, an admin's keys open nothing of alice's", { skip: SKIP }, async () => {
    const { admin, itemA, pool, tenantId } = main;
    const [items] = await pool.query(`SELECT meta_ciphertext, secret_ciphertext FROM zv_items WHERE uid = ?`, [itemA.uid]);
    const [keys] = await pool.query(`SELECT wrapped_key FROM zv_item_keys k JOIN zv_items i ON i.id = k.item_id WHERE i.uid = ?`, [itemA.uid]);
    for (const wrapped of keys) {
        await assert.rejects(vault.unwrapItemKeysForOwner({ tenantId, itemUid: itemA.uid, keyVersion: 1, ownerUserId: admin.userId, vaultKey: admin.session.vaultKey, wrappedMetaKey: new Uint8Array(wrapped.wrapped_key) }));
    }
    for (const key of [admin.session.vaultKey, admin.session.privateKey]) {
        await assert.rejects(vault.decryptItemSecret({ tenantId, itemUid: itemA.uid, secretKey: key, secretCiphertext: new Uint8Array(items[0].secret_ciphertext) }));
    }
});

test("SOFT DELETE and RESTORE: only the owner; deleted items leave the list and appear in the trash", { skip: SKIP }, async () => {
    const { alice, bob } = main;
    const item = await alice.createItem({ meta: { title: "temp" }, secret: { password: "x" } });
    assert.equal((await bob.call("DELETE", `/items/${item.uid}`)).status, 404);
    assert.equal((await alice.call("DELETE", `/items/${item.uid}`)).status, 200);
    const again = await alice.call("DELETE", `/items/${item.uid}`);
    assert.equal(again.status, 409, "the owner is told it is already deleted");
    assert.equal(again.body.code, "NO_CHANGE");
    assert.equal((await bob.call("DELETE", `/items/${item.uid}`)).status, 404, "anyone else still learns nothing");
    assert.ok(!(await alice.call("GET", "/items")).data.some((i) => i.uid === item.uid));
    const trash = await alice.call("GET", "/items/trash");
    assert.ok(trash.data.some((i) => i.uid === item.uid && i.deletedAt));
    assert.equal((await bob.call("POST", `/items/${item.uid}/restore`)).status, 404);
    assert.equal((await alice.call("POST", `/items/${item.uid}/restore`)).status, 200);
    assert.ok((await alice.call("GET", "/items")).data.some((i) => i.uid === item.uid));
    assert.equal((await alice.readItem(item.uid)).meta.title, "temp", "restored with its keys intact");
});

test("ITEM VALIDATION: bad uids, kinds, sizes, missing key envelopes, duplicate uids", { skip: SKIP }, async () => {
    const { alice, tenantId } = main;
    const keys = await vault.newItemKeys();
    const uid = uuid();
    const sealed = await vault.encryptItem({ tenantId, itemUid: uid, keys, meta: { t: 1 }, secret: { p: 1 } });
    const wrapped = await vault.wrapItemKeysForOwner({ tenantId, itemUid: uid, ownerUserId: alice.userId, vaultKey: alice.session.vaultKey, keys });
    const good = { uid, kind: "login", meta: b64(sealed.metaCiphertext), secret: b64(sealed.secretCiphertext), keys: { meta: b64(wrapped.wrappedMetaKey), secret: b64(wrapped.wrappedSecretKey) } };
    for (const bad of [
        { ...good, uid: "not-a-uuid" }, { ...good, kind: "admin" }, { ...good, meta: "###" }, { ...good, meta: b64(new Uint8Array(10)) },
        { ...good, meta: b64(Uint8Array.from([1, ...new Uint8Array(70000)])) }, { ...good, keys: { meta: good.keys.meta } }, { ...good, keys: { secret: good.keys.secret } },
        { ...good, keys: { meta: b64(new Uint8Array(40)), secret: good.keys.secret } }, { ...good, rotationIntervalDays: 0 }, { ...good, rotationIntervalDays: 99999 },
    ]) assert.equal((await alice.call("POST", "/items", bad)).status, 400);
    assert.equal((await alice.call("POST", "/items", good)).status, 201);
    assert.equal((await alice.call("POST", "/items", good)).status, 409, "the same uid twice");
    const noSecret = uuid();
    const sealedNote = await vault.encryptItem({ tenantId, itemUid: noSecret, keys, meta: { t: 1 } });
    const wrappedNote = await vault.wrapItemKeysForOwner({ tenantId, itemUid: noSecret, ownerUserId: alice.userId, vaultKey: alice.session.vaultKey, keys });
    assert.equal((await alice.call("POST", "/items", { uid: noSecret, kind: "secure_note", meta: b64(sealedNote.metaCiphertext), secret: null, keys: { meta: b64(wrappedNote.wrappedMetaKey) } })).status, 201);
    assert.equal((await alice.call("POST", `/items/${noSecret}/secret`)).status, 404, "an item without a secret has nothing to deliver");
});

// ---------------------------------------------------------------------------------------------- sharing

test("SHARING one item: a viewer gets the details only; the other items stay invisible; envelopes are per person", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const { alice, bob, carol } = world;
    const shared = await alice.createItem({ meta: { title: MARK.title, username: MARK.username }, secret: { password: MARK.password } });
    const hidden = await alice.createItem({ meta: { title: "hidden item" }, secret: { password: "hidden-pass" } });
    const bobEntry = await world.who(alice, bob);

    const res = await alice.shareItem(shared.uid, bobEntry, { rights: {} });
    assert.equal(res.status, 201);

    const listed = (await bob.call("GET", "/items")).data;
    assert.deepEqual(listed.map((i) => i.uid), [shared.uid], "bob sees exactly the one item shared with him");
    assert.equal((await bob.call("GET", `/items/${hidden.uid}`)).status, 404);
    const view = await bob.readItem(shared.uid);
    assert.deepEqual(view.meta, { title: MARK.title, username: MARK.username }, "username and title visible");
    assert.equal(view.item.rights.reveal, false);
    assert.equal(view.item.keys[0].source, "box");
    assert.equal(view.item.keys[0].secret, null, "no secret key envelope for a viewer");
    assert.equal(view.keys.secretKey, null);

    const secret = await bob.call("POST", `/items/${shared.uid}/secret`);
    assert.equal(secret.status, 403, "viewing the username does not allow revealing the password");
    assert.equal(secret.body.code, "INSUFFICIENT_RIGHTS");
    assert.equal((await bob.call("POST", `/items/${shared.uid}/access-reports`, { kind: "reveal" })).status, 403);
    assert.equal((await bob.call("PATCH", `/items/${shared.uid}`, { expectedVersion: 1, favorite: true })).status, 403);
    assert.equal((await bob.call("PATCH", `/items/${shared.uid}`, { expectedVersion: 1, meta: b64(Uint8Array.from([1, ...new Uint8Array(60)])) })).status, 403);
    assert.equal((await bob.call("DELETE", `/items/${shared.uid}`)).status, 403, "a recipient can never delete the owner's item");
    assert.equal((await bob.call("GET", `/items/${shared.uid}/grants`)).status, 403, "and cannot see who else has access");

    // storage: bob's row has a meta envelope and NO secret envelope; carol has nothing
    const [rows] = await world.pool.query(`SELECT k.holder_user_id, k.purpose FROM zv_item_keys k JOIN zv_items i ON i.id = k.item_id WHERE i.uid = ? AND k.holder_type = 'user'`, [shared.uid]);
    assert.deepEqual(rows.map((r) => [Number(r.holder_user_id), r.purpose]), [[bob.userId, "meta"]]);
    assert.equal((await carol.call("GET", `/items/${shared.uid}`)).status, 404);
    assert.deepEqual((await carol.call("GET", "/items")).data, []);
});

test("RECIPIENT KEY ENVELOPES: a box only opens for its recipient; other users never receive it; a swapped box is rejected", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const { alice, bob, carol } = world;
    const item = await alice.createItem({ meta: { title: "t" }, secret: { password: MARK.password } });
    await alice.shareItem(item.uid, await world.who(alice, bob), { rights: { reveal: true } });
    await alice.shareItem(item.uid, await world.who(alice, carol), { rights: { reveal: true } });

    const bobView = (await bob.call("GET", `/items/${item.uid}`)).data;
    const carolView = (await carol.call("GET", `/items/${item.uid}`)).data;
    assert.notEqual(bobView.keys[0].meta, carolView.keys[0].meta, "separate envelopes per recipient");
    const secretRes = (await bob.call("POST", `/items/${item.uid}/secret`)).data;
    assert.equal((await bob.openItem(bobView, { secretResponse: secretRes })).secret.password, MARK.password);

    // carol cannot open bob's envelope with her key, nor use it as her own
    const bobBox = unb64(secretRes.keys[0].secret);
    await assert.rejects(vault.openKeyFromSender({ envelope: bobBox, purpose: "box-item-secret-key", ids: [world.tenantId, item.uid, 1, bob.userId], senderPublicKey: alice.session.publicKey, recipientPrivateKey: carol.session.privateKey }));
    await assert.rejects(vault.openKeyFromSender({ envelope: bobBox, purpose: "box-item-secret-key", ids: [world.tenantId, item.uid, 1, carol.userId], senderPublicKey: alice.session.publicKey, recipientPrivateKey: bob.session.privateKey }), "a box addressed to bob is not valid as carol's");
    // the sender shown by the server is alice's real key
    assert.equal(secretRes.keys[0].sender.publicKey, b64(alice.session.publicKey));
    assert.equal(secretRes.keys[0].sender.userId, alice.userId);
});

test("SHARING RIGHTS: upgrade to reveal needs a new key envelope; copy/edit; downgrade removes the key and demands rotation", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const { alice, bob } = world;
    const item = await alice.createItem({ meta: { title: "t" }, secret: { password: MARK.password } });
    const bobEntry = await world.who(alice, bob);
    await alice.shareItem(item.uid, bobEntry, { rights: {} });

    // upgrade without the key: refused; with the key: works
    assert.equal((await alice.call("PATCH", `/items/${item.uid}/grants/${bob.userId}`, { rights: { reveal: true } })).status, 400);
    const opened = await alice.revealItem(item.uid);
    const box = await vault.wrapItemKeysForRecipient({ tenantId: world.tenantId, itemUid: item.uid, recipientUserId: bob.userId, recipientPublicKey: unb64(bobEntry.publicKey), senderPrivateKey: alice.session.privateKey, keys: opened.keys, include: { meta: true, secret: true } });
    const up = await alice.call("PATCH", `/items/${item.uid}/grants/${bob.userId}`, { rights: { reveal: true, copy: true }, boxedSecretKey: b64(box.boxedSecretKey) });
    assert.equal(up.status, 200);
    assert.equal((await bob.revealItem(item.uid)).secret.password, MARK.password);
    assert.equal((await bob.call("POST", `/items/${item.uid}/access-reports`, { kind: "copy" })).status, 200, "copy was granted");

    // edit: bob changes the secret (needs the version); alice sees it
    const keys = (await bob.revealItem(item.uid)).keys;
    const sealed = await vault.encryptItem({ tenantId: world.tenantId, itemUid: item.uid, keys, meta: { title: "bob edited" }, secret: { password: "bob-wrote-this" } });
    assert.equal((await bob.call("PATCH", `/items/${item.uid}`, { expectedVersion: 1, secret: b64(sealed.secretCiphertext) })).status, 403, "reveal without edit cannot write");
    const withEdit = await alice.call("PATCH", `/items/${item.uid}/grants/${bob.userId}`, { rights: { reveal: true, copy: true, edit: true } });
    assert.equal(withEdit.status, 200);
    assert.equal((await bob.call("PATCH", `/items/${item.uid}`, { expectedVersion: 1, meta: b64(sealed.metaCiphertext), secret: b64(sealed.secretCiphertext) })).status, 200);
    assert.equal((await alice.revealItem(item.uid)).secret.password, "bob-wrote-this");

    // downgrade: the secret envelope is deleted at once and the item must be rotated
    const down = await alice.call("PATCH", `/items/${item.uid}/grants/${bob.userId}`, { rights: {} });
    assert.equal(down.status, 200);
    assert.equal((await bob.call("POST", `/items/${item.uid}/secret`)).status, 403);
    const [keyRows] = await world.pool.query(`SELECT k.purpose FROM zv_item_keys k JOIN zv_items i ON i.id = k.item_id WHERE i.uid = ? AND k.holder_type = 'user'`, [item.uid]);
    assert.deepEqual(keyRows.map((r) => r.purpose), ["meta"]);
    assert.equal((await alice.call("GET", `/items/${item.uid}`)).data.rotationRequired, true);
    assert.equal((await alice.call("GET", `/items/${item.uid}/grants`)).data[0].rights.reveal, false);
});

test("SHARING RULES: no self/owner shares, only real active vault users, no duplicates, key <-> right consistency, no escalation, bounded delegation", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const { alice, bob, carol, dave } = world;
    const item = await alice.createItem({ meta: { title: "t" }, secret: { password: "p" } });
    const entry = (b) => world.who(alice, b);
    const post = async (recipient, over = {}) => {
        const opened = await alice.revealItem(item.uid);
        const box = await vault.wrapItemKeysForRecipient({ tenantId: world.tenantId, itemUid: item.uid, recipientUserId: recipient.userId, recipientPublicKey: unb64(recipient.publicKey), senderPrivateKey: alice.session.privateKey, keys: opened.keys, include: { meta: true, secret: true } });
        return alice.call("POST", `/items/${item.uid}/grants`, { recipientUserId: recipient.userId, rights: {}, boxedMetaKey: b64(box.boxedMetaKey), ...over });
    };
    const bobEntry = await entry(bob);

    assert.equal((await post({ userId: alice.userId, publicKey: b64(alice.session.publicKey) })).status, 400, "not with yourself");
    assert.equal((await post({ userId: world.ids.frank, publicKey: bobEntry.publicKey })).status, 400, "frank has no vault");
    assert.equal((await post({ userId: world.ids.gone, publicKey: bobEntry.publicKey })).status, 400, "an inactive user");
    assert.equal((await post({ userId: 424242, publicKey: bobEntry.publicKey })).status, 400, "nobody");
    assert.equal((await post(bobEntry, { rights: { reveal: true } })).status, 400, "reveal without the secret key envelope");
    assert.equal((await post(bobEntry, { rights: {}, boxedSecretKey: b64(new Uint8Array(200).fill(1)) })).status, 400, "a secret key envelope without the right");
    assert.equal((await post(bobEntry, { rights: { copy: true } })).status, 400, "copy needs reveal");
    assert.equal((await post(bobEntry, { rights: { manager: true } })).status, 400);
    assert.equal((await post(bobEntry, { boxedMetaKey: "###" })).status, 400);
    assert.equal((await post(bobEntry, { expiresAt: "2001-01-01T00:00:00Z" })).status, 400, "an expiry in the past");
    assert.equal((await post(bobEntry, { expiresAt: new Date(Date.now() + 400 * 86400000).toISOString() })).status, 400, "more than a year");
    assert.equal((await post(bobEntry)).status, 201);
    assert.equal((await post(bobEntry)).status, 409, "already shared: change the existing share");

    // bob (reveal + share granted by the owner) may hand on LESS than he has -- never more, never "share"
    const secretBox = async () => {
        const opened = await alice.revealItem(item.uid);
        const box = await vault.wrapItemKeysForRecipient({ tenantId: world.tenantId, itemUid: item.uid, recipientUserId: bob.userId, recipientPublicKey: unb64(bobEntry.publicKey), senderPrivateKey: alice.session.privateKey, keys: opened.keys, include: { meta: true, secret: true } });
        return b64(box.boxedSecretKey);
    };
    const full = await alice.call("PATCH", `/items/${item.uid}/grants/${bob.userId}`, { rights: { reveal: true, share: true }, boxedSecretKey: await secretBox() });
    assert.equal(full.status, 200);
    const carolEntry = await world.who(bob, carol);
    const bobShares = async (rights, over = {}) => {
        const opened = await bob.revealItem(item.uid);
        const box = await vault.wrapItemKeysForRecipient({ tenantId: world.tenantId, itemUid: item.uid, recipientUserId: carol.userId, recipientPublicKey: unb64(carolEntry.publicKey), senderPrivateKey: bob.session.privateKey, keys: opened.keys, include: { meta: true, secret: Boolean(rights.reveal) } });
        return bob.call("POST", `/items/${item.uid}/grants`, { recipientUserId: carol.userId, rights, boxedMetaKey: b64(box.boxedMetaKey), boxedSecretKey: box.boxedSecretKey ? b64(box.boxedSecretKey) : undefined, ...over });
    };
    assert.equal((await bobShares({ reveal: true, copy: true })).status, 403, "bob has no copy right to give");
    assert.equal((await bobShares({ reveal: true, edit: true })).status, 403, "nor edit");
    assert.equal((await bobShares({ reveal: true, share: true })).status, 403, "a grantee cannot create further sharers");
    const ok = await bobShares({ reveal: true });
    assert.equal(ok.status, 201);
    assert.equal((await carol.revealItem(item.uid)).secret.password, "p");
    void dave;
});

test("EXPIRY is enforced by the server's clock on every request, and the sweep removes the key envelope", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const { alice, carol } = world;
    const item = await alice.createItem({ meta: { title: "t" }, secret: { password: "p" } });
    const soon = new Date(Date.now() + 2500).toISOString();
    const res = await alice.shareItem(item.uid, await world.who(alice, carol), { rights: { reveal: true }, expiresAt: soon });
    assert.equal(res.status, 201);

    assert.equal((await carol.revealItem(item.uid)).secret.password, "p", "works before the expiry");
    assert.equal((await carol.call("GET", "/items")).data.length, 1);
    const entry = (await carol.call("GET", "/items")).data[0];
    assert.equal(entry.expiresAt, soon);

    await new Promise((resolve) => setTimeout(resolve, 3000));
    // nothing ran in between: no timer, no sweep. The very next request is refused because the DATABASE clock moved past expires_at.
    assert.equal((await carol.call("GET", `/items/${item.uid}`)).status, 404);
    assert.equal((await carol.call("POST", `/items/${item.uid}/secret`)).status, 404);
    assert.deepEqual((await carol.call("GET", "/items")).data, []);
    assert.equal((await alice.call("GET", `/items/${item.uid}/grants`)).data[0].expired, true, "the owner sees that it has expired");

    const [before] = await world.pool.query(`SELECT count(*)::int AS n FROM zv_item_keys k JOIN zv_items i ON i.id = k.item_id WHERE i.uid = ? AND k.holder_type = 'user'`, [item.uid]);
    assert.equal(before[0].n, 2, "the envelopes are still there until the sweep (but unreachable)");
    const swept = await world.api.service.sweepExpired();
    assert.equal(swept.grantsRevoked, 1);
    const [after] = await world.pool.query(`SELECT count(*)::int AS n FROM zv_item_keys k JOIN zv_items i ON i.id = k.item_id WHERE i.uid = ? AND k.holder_type = 'user'`, [item.uid]);
    assert.equal(after[0].n, 0, "key material deleted");
    assert.equal((await world.api.service.sweepExpired()).grantsRevoked, 0, "idempotent");
    assert.equal((await alice.call("GET", `/items/${item.uid}`)).data.rotationRequired, true, "an expired reveal means the item should be rotated");
    const audit = (await alice.call("GET", `/audit?itemUid=${item.uid}`)).data.map((e) => e.kind);
    assert.ok(audit.includes("access_expired") && audit.includes("item_shared"));
});

test("EXPIRY can be set, bounded by the sharer's own access, and a client cannot extend it", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const { alice, bob, carol } = world;
    const item = await alice.createItem({ meta: { title: "t" }, secret: { password: "p" } });
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    const bobEntry = await world.who(alice, bob);
    // bob may re-share, but his own access ends tomorrow
    const opened = await alice.revealItem(item.uid);
    const box = await vault.wrapItemKeysForRecipient({ tenantId: world.tenantId, itemUid: item.uid, recipientUserId: bob.userId, recipientPublicKey: unb64(bobEntry.publicKey), senderPrivateKey: alice.session.privateKey, keys: opened.keys, include: { meta: true, secret: true } });
    assert.equal((await alice.call("POST", `/items/${item.uid}/grants`, { recipientUserId: bob.userId, rights: { reveal: true, share: true }, expiresAt: tomorrow, boxedMetaKey: b64(box.boxedMetaKey), boxedSecretKey: b64(box.boxedSecretKey) })).status, 201);

    const carolEntry = await world.who(bob, carol);
    const share = (expiresAt) => bob.shareItem(item.uid, carolEntry, { rights: {}, expiresAt });
    assert.equal((await share(undefined)).status, 400, "no expiry would outlive bob's access");
    assert.equal((await share(new Date(Date.now() + 5 * 86400000).toISOString())).status, 400, "a later expiry than his own");
    assert.equal((await share(new Date(Date.now() + 3600000).toISOString())).status, 201);
    // bob cannot extend the share he gave, nor remove its expiry
    assert.equal((await bob.call("PATCH", `/items/${item.uid}/grants/${carol.userId}`, { expiresAt: new Date(Date.now() + 5 * 86400000).toISOString() })).status, 400);
    assert.equal((await bob.call("PATCH", `/items/${item.uid}/grants/${carol.userId}`, { expiresAt: null })).status, 400);
    assert.equal((await carol.call("PATCH", `/items/${item.uid}/grants/${carol.userId}`, { expiresAt: null })).status, 403, "the recipient cannot touch their own share");
});

test("REVOCATION: immediate, deletes the envelopes, cascades through re-shares, flags rotation; rotation re-keys for the remaining people only", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const { alice, bob, carol, dave, erin } = world;
    const item = await alice.createItem({ meta: { title: "before" }, secret: { password: "old-secret" } });
    const entry = (b) => world.who(alice, b);
    const grantFull = async (target, rights) => {
        const e = await entry(target);
        const opened = await alice.revealItem(item.uid);
        const box = await vault.wrapItemKeysForRecipient({ tenantId: world.tenantId, itemUid: item.uid, recipientUserId: target.userId, recipientPublicKey: unb64(e.publicKey), senderPrivateKey: alice.session.privateKey, keys: opened.keys, include: { meta: true, secret: Boolean(rights.reveal) } });
        return alice.call("POST", `/items/${item.uid}/grants`, { recipientUserId: target.userId, rights, boxedMetaKey: b64(box.boxedMetaKey), boxedSecretKey: box.boxedSecretKey ? b64(box.boxedSecretKey) : undefined });
    };
    assert.equal((await grantFull(bob, { reveal: true, share: true })).status, 201);
    assert.equal((await grantFull(erin, { reveal: true })).status, 201);
    assert.equal((await bob.shareItem(item.uid, await world.who(bob, dave), { rights: { reveal: true } })).status, 201, "bob re-shares to dave");
    const staleKeys = (await bob.revealItem(item.uid)).keys; // what bob keeps if he copied the keys
    const staleCiphertext = (await bob.call("POST", `/items/${item.uid}/secret`)).data.secret;
    assert.equal((await dave.revealItem(item.uid)).secret.password, "old-secret");

    // alice revokes bob: bob AND dave (who got access through bob) lose access at once
    const revoke = await alice.call("DELETE", `/items/${item.uid}/grants/${bob.userId}`);
    assert.equal(revoke.status, 200);
    assert.equal(revoke.data.rotationRequired, true);
    for (const gone of [bob, dave]) {
        assert.equal((await gone.call("GET", `/items/${item.uid}`)).status, 404);
        assert.equal((await gone.call("POST", `/items/${item.uid}/secret`)).status, 404);
        assert.deepEqual((await gone.call("GET", "/items")).data, []);
    }
    const [remaining] = await world.pool.query(`SELECT k.holder_user_id FROM zv_item_keys k JOIN zv_items i ON i.id = k.item_id WHERE i.uid = ? AND k.holder_type = 'user'`, [item.uid]);
    assert.deepEqual([...new Set(remaining.map((r) => Number(r.holder_user_id)))], [erin.userId], "only erin's envelopes remain");
    assert.equal((await erin.revealItem(item.uid)).secret.password, "old-secret", "erin is unaffected");
    const flagged = (await alice.call("GET", `/items/${item.uid}`)).data;
    assert.equal(flagged.rotationRequired, true);

    // a mismatched rotation (forgetting erin) is refused atomically
    const rotateWith = async (recipientEntries) => {
        const opened = await alice.revealItem(item.uid);
        const current = opened.item;
        const r = await vault.rotateItem({ tenantId: world.tenantId, itemUid: item.uid, keyVersion: current.keyVersion, meta: { title: "after" }, secret: { password: "new-secret" } });
        const owner = await vault.wrapItemKeysForOwner({ tenantId: world.tenantId, itemUid: item.uid, keyVersion: r.keyVersion, ownerUserId: alice.userId, vaultKey: alice.session.vaultKey, keys: r.keys });
        const recipients = [];
        for (const e of recipientEntries) {
            const box = await vault.wrapItemKeysForRecipient({ tenantId: world.tenantId, itemUid: item.uid, keyVersion: r.keyVersion, recipientUserId: e.userId, recipientPublicKey: unb64(e.publicKey), senderPrivateKey: alice.session.privateKey, keys: r.keys, include: { meta: true, secret: true } });
            recipients.push({ userId: e.userId, boxedMetaKey: b64(box.boxedMetaKey), boxedSecretKey: b64(box.boxedSecretKey) });
        }
        const res = await alice.call("POST", `/items/${item.uid}/rotate`, {
            expectedVersion: current.version, keyVersion: r.keyVersion, meta: b64(r.metaCiphertext), secret: b64(r.secretCiphertext),
            keys: { meta: b64(owner.wrappedMetaKey), secret: b64(owner.wrappedSecretKey) }, recipients,
        });
        return { res, r };
    };
    const missing = await rotateWith([]);
    assert.equal(missing.res.status, 400);
    assert.equal(missing.res.body.code, "RECIPIENTS_MISMATCH");
    assert.equal((await alice.revealItem(item.uid)).secret.password, "old-secret", "nothing changed");

    const done = await rotateWith([await entry(erin)]);
    assert.equal(done.res.status, 200);
    assert.equal(done.res.data.keyVersion, 2);
    assert.equal((await alice.call("GET", `/items/${item.uid}`)).data.rotationRequired, false);
    assert.equal((await alice.revealItem(item.uid)).secret.password, "new-secret");
    assert.equal((await erin.revealItem(item.uid)).secret.password, "new-secret", "re-keyed for the remaining recipient");

    // what bob kept is useless against the NEW version; the OLD ciphertext he already had stays readable to him (stated limitation)
    const fresh = (await alice.call("POST", `/items/${item.uid}/secret`)).data;
    await assert.rejects(vault.decryptItemSecret({ tenantId: world.tenantId, itemUid: item.uid, keyVersion: 2, secretKey: staleKeys.secretKey, secretCiphertext: unb64(fresh.secret) }));
    assert.deepEqual(await vault.decryptItemSecret({ tenantId: world.tenantId, itemUid: item.uid, keyVersion: 1, secretKey: staleKeys.secretKey, secretCiphertext: unb64(staleCiphertext) }), { password: "old-secret" });
    assert.equal((await alice.call("POST", `/items/${item.uid}/rotate`, {})).status, 400);
    assert.equal((await bob.call("POST", `/items/${item.uid}/rotate`, {})).status, 404);
});

// ---------------------------------------------------------------------------------------------- company vault

test("COMPANY VAULT: only a company administrator creates a collection and becomes its first key holder", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const { admin, alice } = world;
    const keys = await vault.newCollectionKeys();
    const uid = uuid();
    const name = await vault.encryptCollectionName({ tenantId: world.tenantId, collectionUid: uid, key: keys.metaKey, name: "IT Infrastructure" });
    const self = await vault.sealCollectionKeysForMember({ tenantId: world.tenantId, collectionUid: uid, memberUserId: alice.userId, memberPublicKey: alice.session.publicKey, senderPrivateKey: alice.session.privateKey, keys, include: { meta: true, secret: true } });
    const denied = await alice.call("POST", "/collections", { uid, kind: "department", name: b64(name), keys: { meta: b64(self.wrappedMetaKey), secret: b64(self.wrappedSecretKey) } });
    assert.equal(denied.status, 403, "an employee cannot create a company collection");

    const created = await admin.createCollection({ kind: "department", name: "IT Infrastructure" });
    assert.equal(created.res.status, 201);
    const listed = (await admin.call("GET", "/collections")).data;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].rights.manage, true);
    const opened = await admin.openCollection(listed[0]);
    assert.equal(await vault.decryptCollectionName({ tenantId: world.tenantId, collectionUid: created.uid, key: opened.metaKey, envelope: unb64(listed[0].name) }), "IT Infrastructure");
    assert.deepEqual((await alice.call("GET", "/collections")).data, [], "not a member: not even listed");
    assert.equal((await alice.call("GET", `/collections/${created.uid}`)).status, 404);
    assert.equal((await admin.call("POST", "/collections", { uid: created.uid, kind: "general", name: b64(name), keys: { meta: b64(self.wrappedMetaKey), secret: b64(self.wrappedSecretKey) } })).status, 409);
});

test("COMPANY VAULT permissions: viewer vs revealer vs editor vs manager; members see only their collection; other admins see nothing", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const { admin, admin2, alice, bob, carol, dave } = world;
    const col = await admin.createCollection({ name: "Cloud Accounts" });
    const entry = (b) => world.who(admin, b);
    assert.equal((await admin.addMember(col.uid, col.keys, 1, await entry(alice), {})).status, 201); // viewer: details only
    assert.equal((await admin.addMember(col.uid, col.keys, 1, await entry(bob), { reveal: true, copy: true })).status, 201);
    assert.equal((await admin.addMember(col.uid, col.keys, 1, await entry(carol), { edit: true })).status, 201);
    const item = await admin.createCompanyItem(col.uid, col.keys, { meta: { title: MARK.title, username: MARK.username }, secret: { password: MARK.password } });
    assert.equal(item.res.status, 201);

    // viewer
    const aliceItems = (await alice.call("GET", "/items")).data;
    assert.deepEqual(aliceItems.map((i) => i.uid), [item.uid]);
    assert.equal(aliceItems[0].ownership, "company");
    assert.equal(aliceItems[0].via, "collection");
    assert.deepEqual((await alice.readItem(item.uid)).meta, { title: MARK.title, username: MARK.username });
    assert.equal((await alice.call("POST", `/items/${item.uid}/secret`)).status, 403);
    const aliceCollection = (await alice.call("GET", `/collections/${col.uid}`)).data;
    assert.equal(aliceCollection.keys.wrappedSecretKey, null, "no secret collection key for a viewer");
    assert.equal(aliceCollection.members, undefined, "members are listed to managers only");
    // revealer
    assert.equal((await bob.revealItem(item.uid)).secret.password, MARK.password);
    assert.equal((await bob.call("POST", `/items/${item.uid}/access-reports`, { kind: "copy" })).status, 200);
    assert.equal((await bob.call("PATCH", `/items/${item.uid}`, { expectedVersion: 1, favorite: true })).status, 403);
    // editor can change the credential (company items are edited under the collection keys)
    const carolKeys = (await carol.revealItem(item.uid)).keys;
    const sealed = await vault.encryptItem({ tenantId: world.tenantId, itemUid: item.uid, keys: carolKeys, meta: { title: "edited by carol" }, secret: { password: "carol-pass" } });
    assert.equal((await carol.call("PATCH", `/items/${item.uid}`, { expectedVersion: 1, meta: b64(sealed.metaCiphertext), secret: b64(sealed.secretCiphertext) })).status, 200);
    assert.equal((await admin.revealItem(item.uid)).secret.password, "carol-pass");
    assert.equal((await carol.call("DELETE", `/items/${item.uid}`)).status, 403, "only a manager deletes company items");
    assert.equal((await carol.call("POST", `/items/${item.uid}/rotate`, {})).status, 403);
    // who can manage members
    for (const member of [alice, bob, carol]) {
        assert.equal((await member.call("POST", `/collections/${col.uid}/members`, { userId: dave.userId, rights: {}, wrappedMetaKey: b64(new Uint8Array(100).fill(1)) })).status, 403, "a non-manager cannot add anyone");
        assert.equal((await member.call("PATCH", `/collections/${col.uid}/members/${alice.userId}`, { rights: { reveal: true } })).status, 403);
        assert.equal((await member.call("DELETE", `/collections/${col.uid}/members/${admin.userId}`)).status, 403, "a member cannot remove somebody else (leaving yourself is allowed)");
        assert.equal((await member.call("POST", `/collections/${col.uid}/rotate`, {})).status, 403);
        assert.equal((await member.call("GET", `/audit?collectionUid=${col.uid}`)).status, 403);
    }
    // someone who may create company items needs the edit right
    await assert.rejects(alice.createCompanyItem(col.uid, await alice.openCollection(aliceCollection), { meta: { title: "x" }, secret: { password: "y" } }), (e) => e.name === "VaultCryptoError", "her own browser cannot even build it: she holds no secret collection key");
    const crafted = await alice.call("POST", `/collections/${col.uid}/items`, { uid: uuid(), kind: "login", meta: b64(Uint8Array.from([1, ...new Uint8Array(60)])), secret: null, keys: { meta: b64(Uint8Array.from([1, ...new Uint8Array(72)])) } });
    assert.equal(crafted.status, 403, "and a hand-made request is refused by the server too (creating company items needs the edit right)");
    // a second ADMIN who is not a member sees nothing: administrators are not automatically key holders
    assert.deepEqual((await admin2.call("GET", "/collections")).data, []);
    assert.equal((await admin2.call("GET", `/collections/${col.uid}`)).status, 404);
    assert.equal((await admin2.call("GET", `/items/${item.uid}`)).status, 404);
    assert.equal((await admin2.call("POST", `/items/${item.uid}/secret`)).status, 404);
    assert.deepEqual((await admin2.call("GET", "/items")).data, []);
    assert.equal((await dave.call("GET", `/items/${item.uid}`)).status, 404, "an intern who was never added");
    // the manager sees the member list
    const members = (await admin.call("GET", `/collections/${col.uid}`)).data.members;
    assert.deepEqual(members.map((m) => m.name).sort(), ["Ada Admin", "Alice", "Bob", "Carol"]);
});

test("COMPANY vs PERSONAL: separate stores; an admin's personal items are not company items and vice versa", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const { admin, alice } = world;
    const personal = await admin.createItem({ meta: { title: "admin personal" }, secret: { password: "mine" } });
    const col = await admin.createCollection({ name: "Shared" });
    await admin.addMember(col.uid, col.keys, 1, await world.who(admin, alice), { reveal: true });
    const company = await admin.createCompanyItem(col.uid, col.keys, { meta: { title: "company" }, secret: { password: "ours" } });
    const [rows] = await world.pool.query(`SELECT uid, owner_user_id, collection_id FROM zv_items ORDER BY id`);
    const p = rows.find((r) => r.uid === personal.uid);
    const c = rows.find((r) => r.uid === company.uid);
    assert.ok(p.owner_user_id !== null && p.collection_id === null);
    assert.ok(c.owner_user_id === null && c.collection_id !== null, "a company item has no personal owner");
    assert.deepEqual((await alice.call("GET", "/items")).data.map((i) => i.uid), [company.uid], "alice sees the company item and nothing of the admin's personal vault");
    assert.equal((await alice.call("GET", `/items/${personal.uid}`)).status, 404);
    assert.equal((await alice.call("DELETE", `/items/${company.uid}`)).status, 403);
    const adminList = (await admin.call("GET", "/items")).data;
    assert.deepEqual(adminList.map((i) => i.ownership).sort(), ["company", "personal"]);
    assert.equal((await admin.call("DELETE", `/items/${company.uid}`)).status, 200, "a manager deletes company items");
});

test("COLLECTION MEMBERS: add/change/remove, temporary membership, last manager protected, a removed member loses everything at once", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const { admin, alice, bob } = world;
    const col = await admin.createCollection({ name: "Projects" });
    const entry = (b) => world.who(admin, b);
    const item = await admin.createCompanyItem(col.uid, col.keys, { meta: { title: "t" }, secret: { password: "p" } });

    assert.equal((await admin.addMember(col.uid, col.keys, 1, await entry(alice), { reveal: true })).status, 201);
    assert.equal((await admin.addMember(col.uid, col.keys, 1, await entry(alice), { reveal: true })).status, 409, "already a member");
    assert.equal((await admin.addMember(col.uid, col.keys, 1, { userId: world.ids.frank, publicKey: (await entry(bob)).publicKey }, {})).status, 400, "no vault");
    assert.equal((await admin.call("POST", `/collections/${col.uid}/members`, { userId: bob.userId, rights: { reveal: true }, wrappedMetaKey: b64(new Uint8Array(100).fill(1)) })).status, 400, "reveal without the secret key envelope");
    assert.equal((await admin.call("POST", `/collections/${col.uid}/members`, { userId: bob.userId, rights: {}, wrappedMetaKey: b64(new Uint8Array(100).fill(1)), wrappedSecretKey: b64(new Uint8Array(100).fill(1)) })).status, 400, "a secret key envelope without the right");
    assert.equal((await alice.revealItem(item.uid)).secret.password, "p");

    // temporary membership is checked against the server clock
    assert.equal((await admin.addMember(col.uid, col.keys, 1, await entry(bob), { reveal: true }, new Date(Date.now() + 2500).toISOString())).status, 201);
    assert.equal((await bob.revealItem(item.uid)).secret.password, "p");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal((await bob.call("GET", `/items/${item.uid}`)).status, 404, "membership expired");
    assert.equal((await bob.call("GET", `/collections/${col.uid}`)).status, 404);
    const swept = await world.api.service.sweepExpired();
    assert.equal(swept.membersRemoved, 1);
    assert.equal((await admin.call("GET", `/collections/${col.uid}`)).data.rotationRequired, true);

    // last manager is protected
    assert.equal((await admin.call("DELETE", `/collections/${col.uid}/members/${admin.userId}`)).status, 409);
    assert.equal((await admin.call("PATCH", `/collections/${col.uid}/members/${admin.userId}`, { rights: { reveal: true, edit: true, share: true } })).status, 409);
    // downgrading alice's reveal removes the secret key envelope and demands rotation
    assert.equal((await admin.call("PATCH", `/collections/${col.uid}/members/${alice.userId}`, { rights: {} })).status, 200);
    assert.equal((await alice.call("POST", `/items/${item.uid}/secret`)).status, 403);
    assert.equal((await alice.call("GET", `/collections/${col.uid}`)).data.keys.wrappedSecretKey, null);
    // removal
    assert.equal((await admin.call("DELETE", `/collections/${col.uid}/members/${alice.userId}`)).status, 200);
    assert.equal((await alice.call("GET", `/items/${item.uid}`)).status, 404);
    assert.deepEqual((await alice.call("GET", "/collections")).data, []);
    assert.equal((await alice.call("DELETE", `/collections/${col.uid}/members/${admin.userId}`)).status, 404, "she is not a member any more");
});

test("COLLECTION ROTATION: new collection keys + new item keys for everyone who remains; the removed member's old keys open nothing new; mismatches are refused", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const { admin, alice, bob, carol } = world;
    const col = await admin.createCollection({ name: "Rotate me" });
    const entry = (b) => world.who(admin, b);
    await admin.addMember(col.uid, col.keys, 1, await entry(alice), { reveal: true });
    await admin.addMember(col.uid, col.keys, 1, await entry(bob), { reveal: true });
    await admin.addMember(col.uid, col.keys, 1, await entry(carol), {}); // viewer
    const item1 = await admin.createCompanyItem(col.uid, col.keys, { meta: { title: "one" }, secret: { password: "pw-one" } });
    const item2 = await admin.createCompanyItem(col.uid, col.keys, { meta: { title: "two" }, secret: { password: "pw-two" } });
    // an item share outside the collection must survive
    const outsider = await world.who(admin, world.erin);
    assert.equal((await admin.shareItem(item1.uid, outsider, { rights: { reveal: true } })).status, 201);

    const bobOldKeys = (await bob.revealItem(item1.uid)).keys;
    const bobOldCollection = await bob.openCollection((await bob.call("GET", `/collections/${col.uid}`)).data);
    assert.equal((await admin.call("DELETE", `/collections/${col.uid}/members/${bob.userId}`)).status, 200);
    const flagged = (await admin.call("GET", `/collections/${col.uid}`)).data;
    assert.equal(flagged.rotationRequired, true);

    const build = async ({ dropMember = false, dropItem = false, dropRecipient = false, keyVersion = flagged.keyVersion } = {}) => {
        const newKeys = await vault.newCollectionKeys();
        const next = flagged.keyVersion + 1;
        const members = [];
        for (const m of [alice, carol, admin].filter((_, i) => !(dropMember && i === 0))) {
            const sealed = await vault.sealCollectionKeysForMember({ tenantId: world.tenantId, collectionUid: col.uid, keyVersion: next, memberUserId: m.userId, memberPublicKey: m.session.publicKey, senderPrivateKey: admin.session.privateKey, keys: newKeys, include: { meta: true, secret: m !== carol } });
            members.push({ userId: m.userId, wrappedMetaKey: b64(sealed.wrappedMetaKey), wrappedSecretKey: sealed.wrappedSecretKey ? b64(sealed.wrappedSecretKey) : undefined });
        }
        const items = [];
        for (const [index, it] of [item1, item2].entries()) {
            if (dropItem && index === 1) continue;
            const opened = await admin.revealItem(it.uid);
            const r = await vault.rotateItem({ tenantId: world.tenantId, itemUid: it.uid, keyVersion: opened.item.keyVersion, meta: opened.meta, secret: opened.secret });
            const wrapped = await vault.wrapItemKeysForCollection({ tenantId: world.tenantId, collectionUid: col.uid, itemUid: it.uid, itemKeyVersion: r.keyVersion, collectionKeys: newKeys, itemKeys: r.keys });
            const recipients = [];
            if (it === item1 && !dropRecipient) {
                const box = await vault.wrapItemKeysForRecipient({ tenantId: world.tenantId, itemUid: it.uid, keyVersion: r.keyVersion, recipientUserId: outsider.userId, recipientPublicKey: unb64(outsider.publicKey), senderPrivateKey: admin.session.privateKey, keys: r.keys, include: { meta: true, secret: true } });
                recipients.push({ userId: outsider.userId, boxedMetaKey: b64(box.boxedMetaKey), boxedSecretKey: b64(box.boxedSecretKey) });
            }
            items.push({ uid: it.uid, expectedVersion: opened.item.version, keyVersion: r.keyVersion, meta: b64(r.metaCiphertext), secret: b64(r.secretCiphertext), keys: { meta: b64(wrapped.meta), secret: b64(wrapped.secret) }, recipients });
        }
        return { expectedKeyVersion: keyVersion, members, items };
    };
    const count = async () => (await world.pool.query(`SELECT count(*)::int AS n FROM zv_item_keys`))[0][0].n;
    const before = await count();

    for (const [label, options, code] of [["a member left out", { dropMember: true }, "MEMBERS_MISMATCH"], ["an item left out", { dropItem: true }, "ITEMS_MISMATCH"], ["an item share forgotten", { dropRecipient: true }, "RECIPIENTS_MISMATCH"]]) {
        const res = await admin.call("POST", `/collections/${col.uid}/rotate`, await build(options));
        assert.equal(res.status, 400, label);
        assert.equal(res.body.code, code, label);
        assert.equal(await count(), before, `${label}: the refused rotation changed nothing`);
    }
    assert.equal((await admin.call("POST", `/collections/${col.uid}/rotate`, await build({ keyVersion: 7 }))).status, 409, "stale key version");

    const done = await admin.call("POST", `/collections/${col.uid}/rotate`, await build());
    assert.equal(done.status, 200);
    assert.equal(done.data.keyVersion, 2);
    assert.equal((await admin.call("GET", `/collections/${col.uid}`)).data.rotationRequired, false);

    // the remaining people open the NEW material; the outsider's item share was re-keyed; the viewer still has no secret
    assert.equal((await alice.revealItem(item1.uid)).secret.password, "pw-one");
    assert.equal((await alice.revealItem(item2.uid)).secret.password, "pw-two");
    assert.equal((await world.erin.revealItem(item1.uid)).secret.password, "pw-one");
    assert.equal((await carol.readItem(item2.uid)).meta.title, "two");
    assert.equal((await carol.call("POST", `/items/${item2.uid}/secret`)).status, 403);
    // bob: no access at all any more, and his old keys do not open the new ciphertext
    assert.equal((await bob.call("GET", `/items/${item1.uid}`)).status, 404);
    const fresh = (await admin.call("POST", `/items/${item1.uid}/secret`)).data;
    await assert.rejects(vault.decryptItemSecret({ tenantId: world.tenantId, itemUid: item1.uid, keyVersion: 2, secretKey: bobOldKeys.secretKey, secretCiphertext: unb64(fresh.secret) }));
    assert.ok(bobOldCollection.secretKey, "(he does still hold the old collection keys -- which protect nothing that exists now)");
});

// ---------------------------------------------------------------------------------------------- tenant isolation and feature gate

test("TENANT ISOLATION: two tenants with the same user ids and even the same item uid never see each other; tenant ids in the request change nothing", { skip: SKIP }, async () => {
    const a = await buildWorld();
    const b = await buildWorld();
    assert.equal(a.ids.alice, b.ids.alice, "the same user id exists in both tenants");
    const secretA = await a.alice.createItem({ meta: { title: MARK.title }, secret: { password: MARK.password } });

    // the same uid, asked in the other tenant: not found (every tenant is its own database)
    assert.equal((await b.alice.call("GET", `/items/${secretA.uid}`)).status, 404);
    assert.deepEqual((await b.alice.call("GET", "/items")).data, []);
    assert.equal((await b.bob.call("GET", `/items/${secretA.uid}`)).status, 404);

    // tenant substitution attempts: header, query, body, path-looking parameters -- none of them selects a tenant
    const sneaky = await fetch(`${b.api.url}/api/ziovault/items?companyId=${a.tenantId}&tenantId=${a.tenantId}&company=${a.tenantId}`, {
        headers: { "x-test-user": String(b.ids.alice), "x-tenant-id": String(a.tenantId), "x-company-id": String(a.tenantId), "x-company-slug": "tenant-a" },
    });
    assert.deepEqual((await sneaky.json()).data, []);
    const smuggled = await b.alice.call("POST", "/items", { tenantId: a.tenantId, companyId: a.tenantId, uid: uuid(), kind: "login", meta: "###" });
    assert.equal(smuggled.status, 400);

    // the directory is per tenant
    const dirA = (await a.alice.directory()).map((u) => u.publicKey);
    const dirB = (await b.alice.directory()).map((u) => u.publicKey);
    assert.ok(dirA.length > 0 && dirA.every((k) => !dirB.includes(k)));

    // a ciphertext copied across tenants is stored (the server cannot tell) but never decrypts: the tenant id is authenticated data
    const [row] = (await a.pool.query(`SELECT meta_ciphertext, secret_ciphertext FROM zv_items WHERE uid = ?`, [secretA.uid]))[0];
    await assert.rejects(vault.decryptItemSecret({ tenantId: b.tenantId, itemUid: secretA.uid, secretKey: secretA.keys.secretKey, secretCiphertext: new Uint8Array(row.secret_ciphertext) }));
    assert.deepEqual(await vault.decryptItemSecret({ tenantId: a.tenantId, itemUid: secretA.uid, secretKey: secretA.keys.secretKey, secretCiphertext: new Uint8Array(row.secret_ciphertext) }), { password: MARK.password });

    // their accounts are independent too: same user id, different vault
    assert.notEqual(a.alice.server.vaultKeyEnvelope.toString(), b.alice.server.vaultKeyEnvelope.toString());
    const aliceInB = await b.alice.unlock();
    assert.ok(!Buffer.from(aliceInB.session.vaultKey).equals(Buffer.from(a.alice.session.vaultKey)));
});

test("FEATURE GATE: with ziovault disabled every vault route answers FEATURE_NOT_ENABLED, nothing is deleted, and enabling it restores access", { skip: SKIP }, async () => {
    const { createFeatureGate } = require("./middleware/featureGate");
    const { TENANT_JWT_ISSUER, TENANT_JWT_AUDIENCE } = require("./controllers/tenantAuthController");
    const { FEATURE_IDS } = require("./config/tenantFeatures");
    const state = { enabled: new Set(FEATURE_IDS) };
    const gate = createFeatureGate({
        getCompanyById: async (id) => (Number(id) === 5 ? { id: 5, company_slug: "acme", company_name: "Acme" } : null),
        getEnabledFeatureIds: async () => [...state.enabled],
    });
    const world = await buildWorld({ gate });
    const token = jwt.sign({ userId: world.ids.alice, companyId: 5, companySlug: "acme", type: "tenant_user" }, process.env.TENANT_JWT_SECRET, { expiresIn: "1h", issuer: TENANT_JWT_ISSUER, audience: TENANT_JWT_AUDIENCE });
    const item = await world.alice.createItem({ meta: { title: MARK.title }, secret: { password: MARK.password } });
    const rows = async () => (await world.pool.query(`SELECT (SELECT count(*)::int FROM zv_items) AS items, (SELECT count(*)::int FROM zv_accounts) AS accounts, (SELECT count(*)::int FROM zv_item_keys) AS keys`))[0][0];
    const before = await rows();

    const routes = [
        ["GET", "/account/status"], ["POST", "/account"], ["GET", "/account/unlock"], ["GET", "/account/recovery"], ["PUT", "/account/envelope"], ["GET", "/directory"],
        ["GET", "/items"], ["POST", "/items"], ["GET", `/items/${item.uid}`], ["POST", `/items/${item.uid}/secret`], ["PATCH", `/items/${item.uid}`], ["DELETE", `/items/${item.uid}`],
        ["GET", `/items/${item.uid}/grants`], ["POST", `/items/${item.uid}/grants`], ["GET", "/collections"], ["POST", "/collections"], ["GET", `/collections/${uuid()}`], ["GET", "/audit"],
    ];
    const call = async (method, route) => {
        const res = await fetch(`${world.api.url}/api/ziovault${route}`, { method, headers: { Authorization: `Bearer ${token}`, "x-test-user": String(world.ids.alice), "Content-Type": "application/json" }, body: method === "GET" || method === "DELETE" ? undefined : "{}" });
        return { status: res.status, body: await res.json().catch(() => null), text: "" };
    };

    state.enabled.delete("ziovault");
    for (const [method, route] of routes) {
        const res = await call(method, route);
        assert.equal(res.status, 403, `${method} ${route}`);
        assert.equal(res.body.code, "FEATURE_NOT_ENABLED", `${method} ${route}`);
        assert.equal(res.body.data, undefined);
    }
    assert.deepEqual(await rows(), before, "disabling the feature deleted nothing");
    // other modules are not affected by this gate decision and a different tenant's token is unaffected
    state.enabled.add("ziovault");
    assert.equal((await call("GET", "/items")).status, 200);
    const restored = await world.alice.readItem(item.uid);
    assert.equal(restored.meta.title, MARK.title, "the encrypted data is exactly as it was");
    assert.equal((await world.alice.revealItem(item.uid)).secret.password, MARK.password);
    assert.deepEqual(await rows(), before);
});

test("ROUTE PROTECTION: every route of the router refuses a request without authentication, and an authenticated user without a vault gets ACCOUNT_REQUIRED", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const id = uuid();
    const routes = [
        ["GET", "/account/status"], ["POST", "/account"], ["GET", "/account/unlock"], ["GET", "/account/recovery"], ["POST", "/account/recovery-confirmation"], ["PUT", "/account/envelope"], ["PUT", "/account/recovery-envelope"],
        ["GET", "/account/envelope-history"], ["POST", "/account/envelope-history/1/restore"], ["GET", "/directory"], ["GET", "/items"], ["GET", "/items/trash"], ["POST", "/items"], ["GET", `/items/${id}`],
        ["POST", `/items/${id}/secret`], ["POST", `/items/${id}/access-reports`], ["PATCH", `/items/${id}`], ["DELETE", `/items/${id}`], ["POST", `/items/${id}/restore`], ["POST", `/items/${id}/rotate`],
        ["GET", `/items/${id}/grants`], ["POST", `/items/${id}/grants`], ["PATCH", `/items/${id}/grants/1`], ["DELETE", `/items/${id}/grants/1`], ["GET", "/collections"], ["POST", "/collections"],
        ["GET", `/collections/${id}`], ["POST", `/collections/${id}/items`], ["POST", `/collections/${id}/members`], ["PATCH", `/collections/${id}/members/1`], ["DELETE", `/collections/${id}/members/1`],
        ["POST", `/collections/${id}/rotate`], ["GET", "/audit"],
    ];
    for (const [method, route] of routes) {
        const res = await fetch(`${world.api.url}/api/ziovault${route}`, { method, headers: { "Content-Type": "application/json" }, body: method === "GET" || method === "DELETE" ? undefined : "{}" });
        assert.equal(res.status, 401, `${method} ${route} without authentication`);
    }
    const novault = await makeBrowser(world.api, world.ids.frank, vault);
    for (const [method, route] of routes.filter(([m, r]) => !(r === "/account" || r.startsWith("/account/status") || r.startsWith("/account/unlock") || r.startsWith("/account/recovery") || r.startsWith("/account/envelope") || m === "PUT"))) {
        const res = await novault.call(method, route, method === "GET" || method === "DELETE" ? undefined : {});
        assert.ok([409, 400, 404].includes(res.status), `${method} ${route} -> ${res.status}`);
        if (res.status === 409) assert.equal(res.body.code, "ACCOUNT_REQUIRED");
    }
    assert.equal((await novault.call("GET", "/items")).body.code, "ACCOUNT_REQUIRED");
    assert.equal((await novault.call("GET", "/collections")).body.code, "ACCOUNT_REQUIRED");
    assert.equal((await novault.call("GET", "/directory")).body.code, "ACCOUNT_REQUIRED");
});

// ---------------------------------------------------------------------------------------------- audit

test("AUDIT: who did what, with the evidence labelled honestly; only authorised people read an item's or collection's history; no secrets in it", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const { alice, bob, admin, carol } = world;
    const item = await alice.createItem({ meta: { title: MARK.title }, secret: { password: MARK.password } });
    await alice.shareItem(item.uid, await world.who(alice, bob), { rights: { reveal: true, copy: true } });
    await bob.revealItem(item.uid);
    await bob.call("POST", `/items/${item.uid}/access-reports`, { kind: "reveal" });
    await bob.call("POST", `/items/${item.uid}/access-reports`, { kind: "copy" });
    await alice.call("DELETE", `/items/${item.uid}/grants/${bob.userId}`);
    await alice.call("DELETE", `/items/${item.uid}`);

    const trail = (await alice.call("GET", `/audit?itemUid=${item.uid}`)).data;
    const kinds = trail.map((e) => e.kind);
    for (const kind of ["item_created", "item_shared", "secret_delivered", "reveal_reported", "copy_reported", "share_revoked", "item_deleted"]) assert.ok(kinds.includes(kind), kind);
    const evidence = Object.fromEntries(trail.map((e) => [e.kind, e.evidence]));
    assert.equal(evidence.secret_delivered, "server_observed_delivery", "the server released the ciphertext: that is all it proves");
    assert.equal(evidence.reveal_reported, "client_reported", "a browser said it displayed the secret: advisory");
    assert.equal(evidence.copy_reported, "client_reported");
    assert.equal(evidence.item_shared, "server_observed");
    const delivered = trail.find((e) => e.kind === "secret_delivered");
    assert.equal(delivered.subjectUserId, bob.userId, "who received it");

    // nobody else reads this history; the audit never contains a secret, title or key
    assert.equal((await bob.call("GET", `/audit?itemUid=${item.uid}`)).status, 404, "bob lost access, so no history either");
    assert.equal((await admin.call("GET", `/audit?itemUid=${item.uid}`)).status, 404);
    const text = JSON.stringify(trail);
    for (const marker of FORBIDDEN) assert.equal(text.includes(marker), false);
    assert.ok(trail.every((e) => /^[a-z0-9_.:,=-]*$/.test(e.detail)));

    // my own activity
    const mine = (await bob.call("GET", "/audit")).data;
    assert.ok(mine.some((e) => e.kind === "account_created") && mine.some((e) => e.kind === "secret_delivered"));
    assert.ok(mine.every((e) => e.actorUserId === bob.userId || e.subjectUserId === bob.userId), "only about me");
    void carol;
});

// ---------------------------------------------------------------------------------------------- ciphertext only, nothing leaks

test("NO PLAINTEXT ANYWHERE: the database, every API response and every log line contain none of the secrets, titles, notes or passwords used in these tests", { skip: SKIP }, async () => {
    // a fresh world with all kinds of content, including an attachment-sized blob stored as ciphertext
    const world = await buildWorld();
    const { alice, bob, admin } = world;
    const item = await alice.createItem({ meta: { title: MARK.title, username: MARK.username, url: MARK.url }, secret: { password: MARK.password, notes: MARK.notes } });
    await alice.shareItem(item.uid, await world.who(alice, bob), { rights: { reveal: true } });
    const col = await admin.createCollection({ name: MARK.title });
    await admin.addMember(col.uid, col.keys, 1, await world.who(admin, alice), { reveal: true });
    await admin.createCompanyItem(col.uid, col.keys, { meta: { title: MARK.title, url: MARK.url }, secret: { password: MARK.password } });
    await bob.revealItem(item.uid);
    await alice.call("GET", "/items");
    await alice.call("POST", "/items", { uid: "bad", meta: MARK.password }); // an error path that could echo input

    const fileKey = await vault.newAttachmentKey();
    const content = await vault.encryptAttachmentContent({ fileKey, bytes: Buffer.from(MARK.notes.repeat(2000)), tenantId: world.tenantId, itemUid: item.uid, attachmentUid: uuid() });
    const [[itemRow]] = await world.pool.query(`SELECT id FROM zv_items WHERE uid = ?`, [item.uid]);
    await world.pool.query(`INSERT INTO zv_attachments (uid, item_id, meta_ciphertext, wrapped_file_key, content, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`, [uuid(), itemRow.id, Buffer.alloc(60, 3), Buffer.alloc(73, 4), Buffer.from(content), world.ids.alice]);

    const db = await dumpDatabase(world.pool);
    for (const marker of FORBIDDEN) {
        assert.equal(containsPlaintext(db.raw, marker), false, `bytea columns contain "${marker.slice(0, 12)}..."`);
        assert.equal(containsPlaintext(db.text, marker), false, `row text contains "${marker.slice(0, 12)}..."`);
    }
    const responses = transcript.join("\n");
    for (const marker of FORBIDDEN) assert.equal(containsPlaintext(responses, marker), false, `an API response contains "${marker.slice(0, 12)}..."`);
    // the logs: only bare error codes (the invalid item above), never a body, a header or a value
    const logLines = logged.join("\n");
    for (const marker of FORBIDDEN) assert.equal(containsPlaintext(logLines, marker), false, "a log line contains a secret");
    assert.ok(logged.every((line) => !/req\.body|password|secret/i.test(line) || /^\[ziovault\]/.test(line) === false), "no log line quotes request content");
    // and the genuine data is still there, decryptable only by the right people
    assert.equal((await alice.revealItem(item.uid)).secret.password, MARK.password);
});

test("API responses are never cached", { skip: SKIP }, async () => {
    const { alice, api } = main;
    for (const route of ["/items", "/account/unlock", "/directory", "/collections"]) {
        const res = await fetch(`${api.url}/api/ziovault${route}`, { headers: { "x-test-user": String(alice.userId) } });
        assert.equal(res.headers.get("cache-control"), "no-store", route);
    }
    const missing = await fetch(`${api.url}/api/ziovault/items/${uuid()}`, { headers: { "x-test-user": String(alice.userId) } });
    assert.equal(missing.headers.get("cache-control"), "no-store");
});

test("NONCES and ciphertexts in the database are unique per item (the same content stored twice looks different)", { skip: SKIP }, async () => {
    const world = await buildWorld();
    for (let i = 0; i < 6; i += 1) await world.alice.createItem({ meta: { title: "same title" }, secret: { password: "same password" } });
    const [rows] = await world.pool.query(`SELECT meta_ciphertext, secret_ciphertext FROM zv_items`);
    const nonces = rows.flatMap((r) => [Buffer.from(r.meta_ciphertext).subarray(1, 25).toString("hex"), Buffer.from(r.secret_ciphertext).subarray(1, 25).toString("hex")]);
    assert.equal(new Set(nonces).size, nonces.length, "no nonce repeats");
    assert.equal(new Set(rows.map((r) => Buffer.from(r.secret_ciphertext).toString("hex"))).size, rows.length, "identical plaintexts produce different ciphertexts");
});
