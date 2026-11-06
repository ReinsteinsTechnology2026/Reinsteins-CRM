// ZioVault Stage 4 -- company collections and secure sharing, driven through the REAL client session (key distribution and encryption in the
// client's own code) against the REAL router and PostgreSQL. What it proves: collections and shares work end to end for every permission
// combination, expiry and revocation take effect at once, outsiders/escalation/other tenants are refused, a recipient without a vault is
// handled, nothing but ciphertext and envelopes is ever sent or stored, and the audit trail records it.
//
// Needs the disposable PostgreSQL (PG_TEST_* variables); otherwise skipped (CI: migration-postgres job, PG_TEST_REQUIRED=1).
// Run: node --test _test_ziovault_company_pg.js

process.env.JWT_SECRET = process.env.JWT_SECRET || "legacy-secret-for-tests";
process.env.TENANT_JWT_SECRET = process.env.TENANT_JWT_SECRET || "tenant-secret-for-tests";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createLab } = require("./_ziovault_test_support");
const { load, joinVault, rawCall } = require("./_ziovault_session_support");

const lab = createLab();
const SKIP = lab.skip;
const PW = (name) => `correct horse battery staple ${name} lantern`;

const MARK = {
    collection: "COLLECTION-NAME-MARKER-4c1a",
    about: "COLLECTION-ABOUT-MARKER-77de",
    title: "Company router TITLE-MARKER-31bb",
    password: "Tr0ub4dor&3-COMPANY-PW-MARKER-9f20",
    notes: "COMPANY-NOTE-MARKER-0e8d",
};

let vault; let sessionModule; let apiModule;
const logged = [];
const realConsole = { log: console.log, error: console.error, info: console.info, warn: console.warn };
let tenantCounter = 600;

test.before(async () => {
    for (const level of ["log", "error", "info", "warn"]) console[level] = (...args) => { logged.push(args.map(String).join(" ")); };
    if (SKIP) return;
    await lab.connect();
    vault = await load("crypto/index.js");
    sessionModule = await load("vaultSession.js");
    apiModule = await load("vaultApi.js");
});
test.after(async () => {
    Object.assign(console, realConsole);
    await lab.close();
});

// ------------------------------------------------------------------------------------------------ harness
async function buildWorld() {
    const tenantId = ++tenantCounter;
    const pool = await lab.tenantDatabase();
    const server = await lab.startApi(pool, { tenantId });
    const ids = {
        ada: await lab.addUser(pool, "Ada Admin", { role: "admin", access: "super_admin" }),
        bob: await lab.addUser(pool, "Bob"),
        cy: await lab.addUser(pool, "Cy"),
        dee: await lab.addUser(pool, "Dee"),
        eve: await lab.addUser(pool, "Eve NoVault"),
    };
    const world = { tenantId, pool, server, ids, tabs: [] };
    world.join = async (name, role) => {
        const tab = await joinVault({ vault, sessionModule, apiModule, server, tenantId, userId: ids[name], role: role || (name === "ada" ? "admin" : "employee") }, PW(name));
        world.tabs.push(tab);
        return tab;
    };
    world.raw = (name, method, route, body) => rawCall(server, ids[name], method, route, body);
    return world;
}

const draftOf = (extra = {}) => ({
    kind: "login", title: MARK.title, url: "https://router.example", username: "root", password: MARK.password, notes: MARK.notes, folderUid: null, favorite: false, rotationIntervalDays: null,
    fields: [], ...extra,
});

const dbDump = async (pool) => {
    const out = [];
    for (const table of ["zv_accounts", "zv_account_history", "zv_folders", "zv_collections", "zv_collection_members", "zv_items", "zv_item_keys", "zv_grants", "zv_audit_events"]) {
        const [rows] = await pool.query(`SELECT * FROM ${table}`);
        out.push(JSON.stringify(rows, (_k, v) => (v && v.type === "Buffer" ? Buffer.from(v.data).toString("latin1") : v)));
        for (const row of rows) for (const value of Object.values(row)) if (Buffer.isBuffer(value)) out.push(value.toString("latin1"), value.toString("utf8"), value.toString("hex"));
    }
    return out.join("\n");
};
const assertNoPlaintext = (text, label, extra = []) => {
    for (const needle of [...Object.values(MARK), "correct horse", ...extra]) assert.ok(!text.includes(needle), `${label} contains plaintext: ${needle}`);
};
const refused = (promise, statuses) => assert.rejects(promise, (e) => e && e.name === "VaultApiError" && [].concat(statuses).includes(e.status));

// ------------------------------------------------------------------------------------------------ collections
test("COLLECTIONS: an administrator creates one, name and description are encrypted, an employee cannot, members see it with their own keys", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ada = await world.join("ada");
    const bob = await world.join("bob");
    const eve = world.ids.eve;
    assert.equal(ada.session.snapshot().canCreateCollections, true);
    assert.equal(bob.session.snapshot().canCreateCollections, false);

    await assert.rejects(ada.session.createCollection({ name: "   " }), (e) => e.name === "VaultUserError");
    await assert.rejects(ada.session.createCollection({ name: "x".repeat(101) }), (e) => e.name === "VaultUserError");
    await assert.rejects(ada.session.createCollection({ name: "ok", kind: "weird" }), (e) => e.name === "VaultUserError");

    const uid = await ada.session.createCollection({ name: MARK.collection, description: MARK.about, kind: "department" });
    const seen = ada.session.snapshot().collections.find((c) => c.uid === uid);
    assert.equal(seen.name, MARK.collection); assert.equal(seen.description, MARK.about); assert.equal(seen.kind, "department");
    assert.equal(seen.rights.manage, true); assert.equal(seen.itemCount, 0);

    // an employee is refused by the server (the button is only a courtesy), and nothing is created
    await refused(bob.session.createCollection({ name: "Bob's own" }), 403);
    assert.equal((await world.pool.query("SELECT count(*)::int AS n FROM zv_collections"))[0][0].n, 1);

    // adding someone who has no vault: said clearly, and no request is made
    const before = ada.record.requests.length;
    await assert.rejects(ada.session.addMember(uid, { userId: eve, rights: {} }), (e) => e.code === "RECIPIENT_NO_VAULT");
    assert.ok(!ada.record.requests.slice(before).some((r) => r.method === "post" && /\/members/.test(r.route)));
    // directly (a modified client): the server refuses too
    const direct = await world.raw("ada", "POST", `/collections/${uid}/members`, { userId: eve, rights: {}, wrappedMetaKey: Buffer.alloc(100, 1).toString("base64url") });
    assert.equal(direct.status, 400); assert.equal(direct.body.code, "RECIPIENT_UNAVAILABLE");

    await ada.session.addMember(uid, { userId: world.ids.bob, rights: {} });
    await bob.session.reload();
    const bobsView = bob.session.snapshot().collections.find((c) => c.uid === uid);
    assert.equal(bobsView.name, MARK.collection, "the member decrypts the name with the key that was wrapped for them");
    assert.equal(bobsView.description, MARK.about);
    assert.deepEqual({ ...bobsView.rights }, { reveal: false, copy: false, edit: false, share: false, manage: false });
    assert.deepEqual((await bob.session.collectionDetail(uid)).members, [], "only a manager is told who the members are");

    assertNoPlaintext(ada.sent() + bob.sent(), "request bodies");
    assertNoPlaintext(await dbDump(world.pool), "database");
});

test("COMPANY ITEMS: each member's rights decide what they can see, reveal, copy, edit, delete and add; the server enforces them on direct requests", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ada = await world.join("ada");
    const bob = await world.join("bob"); // viewer
    const cy = await world.join("cy"); // reveal only
    const dee = await world.join("dee"); // editor (reveal + copy + edit)
    const uid = await ada.session.createCollection({ name: "Network", description: "Routers" });
    await ada.session.addMember(uid, { userId: world.ids.bob, rights: {} });
    await ada.session.addMember(uid, { userId: world.ids.cy, rights: { reveal: true } });
    await ada.session.addMember(uid, { userId: world.ids.dee, rights: { reveal: true, copy: true, edit: true } });
    const itemUid = await ada.session.createCompanyItem(uid, draftOf());
    for (const tab of [ada, bob, cy, dee]) await tab.session.reload();

    for (const tab of [ada, bob, cy, dee]) {
        const view = tab.session.snapshot().companyItems.find((i) => i.uid === itemUid);
        assert.equal(view.title, MARK.title, "every member can see the item's details");
        assert.equal(view.ownership, "company"); assert.equal(view.via, "collection");
        assert.equal(tab.session.snapshot().collections[0].itemCount, 1);
    }
    assert.ok(!JSON.stringify(bob.session.snapshot()).includes(MARK.password), "no password in a viewer's state");

    // viewer: details only
    await refused(bob.session.revealItem(itemUid), 403);
    assert.equal((await world.raw("bob", "POST", `/items/${itemUid}/secret`)).status, 403);
    // reveal only: can reveal, cannot copy (server refuses the copy report), cannot edit
    assert.equal((await cy.session.revealItem(itemUid)).password, MARK.password);
    assert.equal(cy.session.snapshot().companyItems[0].rights.copy, false);
    assert.equal((await world.raw("cy", "POST", `/items/${itemUid}/access-reports`, { kind: "copy" })).status, 403);
    await refused(cy.session.updateItem(itemUid, { ...draftOf(), title: "cy was here" }), 403);
    // editor: can edit; the change is visible to everyone; cannot delete or manage members
    const loaded = await dee.session.loadForEditing(itemUid);
    await dee.session.updateItem(itemUid, { ...loaded.draft, title: "Edited by Dee", password: "N3w-Company-Pass-77!" }, loaded.version);
    await ada.session.reload();
    assert.equal(ada.session.snapshot().companyItems[0].title, "Edited by Dee");
    assert.equal((await ada.session.revealItem(itemUid)).password, "N3w-Company-Pass-77!");
    await refused(dee.session.deleteItem(itemUid), 403);
    await refused(dee.session.addMember(uid, { userId: world.ids.bob, rights: {} }), [403, 409]);
    assert.equal((await world.raw("dee", "DELETE", `/items/${itemUid}`)).status, 403);
    // editor can add an item; a viewer cannot (and the client does not even try: it holds no key to wrap it with)
    const second = await dee.session.createCompanyItem(uid, draftOf({ title: "Second" }));
    await assert.rejects(bob.session.createCompanyItem(uid, draftOf({ title: "nope" })), (e) => e.name === "VaultUserError");
    assert.equal((await world.raw("bob", "POST", `/collections/${uid}/items`, { uid: "00000000-0000-4000-8000-0000000000aa" })).status, 403, "and the server refuses a hand-made request");
    // the manager can delete
    await ada.session.deleteItem(second);
    await bob.session.reload();
    assert.ok(!bob.session.snapshot().companyItems.some((i) => i.uid === second));

    const kinds = (await world.pool.query("SELECT kind FROM zv_audit_events ORDER BY id"))[0].map((r) => r.kind);
    for (const kind of ["collection_created", "collection_member_added", "item_created", "item_updated", "item_deleted", "secret_delivered"]) assert.ok(kinds.includes(kind), `audit has ${kind}`);
    assertNoPlaintext([ada, bob, cy, dee].map((t) => t.sent()).join("\n"), "request bodies", ["N3w-Company-Pass-77!", "Edited by Dee"]);
    assertNoPlaintext(await dbDump(world.pool), "database", ["N3w-Company-Pass-77!", "Edited by Dee"]);
});

test("MEMBERSHIP: gaining or losing reveal changes the keys, expiry and removal end access at once, rotation is flagged, the last manager stays", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ada = await world.join("ada");
    const bob = await world.join("bob");
    const cy = await world.join("cy");
    const uid = await ada.session.createCollection({ name: "Vendors" });
    const itemUid = await ada.session.createCompanyItem(uid, draftOf());
    await ada.session.addMember(uid, { userId: world.ids.bob, rights: {} });
    await bob.session.reload();
    await refused(bob.session.revealItem(itemUid), 403);

    // gaining reveal needs a NEW key envelope for the secret key: the client makes it, the server stores it
    await ada.session.updateMember(uid, world.ids.bob, { rights: { reveal: true } });
    const [granted] = await world.pool.query("SELECT wrapped_secret_key FROM zv_collection_members WHERE user_id = ?", [world.ids.bob]);
    assert.ok(granted[0].wrapped_secret_key, "the secret-key envelope now exists");
    await bob.session.reload();
    assert.equal((await bob.session.revealItem(itemUid)).password, MARK.password);
    // losing it deletes the envelope and flags rotation (they have seen the key)
    await ada.session.updateMember(uid, world.ids.bob, { rights: {} });
    const [taken] = await world.pool.query("SELECT wrapped_secret_key FROM zv_collection_members WHERE user_id = ?", [world.ids.bob]);
    assert.equal(taken[0].wrapped_secret_key, null);
    assert.equal((await ada.session.collectionDetail(uid)).rotationRequired, true);
    await bob.session.lock("manual"); await bob.session.unlock(bob.password);
    await refused(bob.session.revealItem(itemUid), 403);

    // the members list (for a manager) shows rights and expiry
    const detail = await ada.session.collectionDetail(uid);
    assert.deepEqual(detail.members.map((m) => m.name).sort(), ["Ada Admin", "Bob"]);

    // temporary membership: ends by the database clock
    await ada.session.addMember(uid, { userId: world.ids.cy, rights: { reveal: true }, expiresAt: new Date(Date.now() + 86400000).toISOString() });
    await cy.session.reload();
    assert.equal(cy.session.snapshot().collections.length, 1);
    await world.pool.query("UPDATE zv_collection_members SET expires_at = now() - interval '1 minute' WHERE user_id = ?", [world.ids.cy]);
    await cy.session.reload();
    assert.equal(cy.session.snapshot().collections.length, 0); assert.equal(cy.session.snapshot().companyItems.length, 0);
    assert.equal((await world.raw("cy", "GET", `/items/${itemUid}`)).status, 404);
    await assert.rejects(ada.session.addMember(uid, { userId: world.ids.cy, rights: {}, expiresAt: new Date(Date.now() - 1000).toISOString() }), (e) => e.status === 400);

    // removal: effective at once, and the response says the keys should be rotated
    const removed = await ada.session.removeMember(uid, world.ids.bob);
    assert.equal(removed.rotationRequired, true);
    await bob.session.reload();
    assert.equal(bob.session.snapshot().collections.length, 0);
    assert.equal((await world.raw("bob", "GET", `/items/${itemUid}`)).status, 404);
    await ada.session.reload();
    assert.equal(ada.session.snapshot().collections[0].rotationRequired, true, "the screens can warn that the keys should be rotated");
    await refused(ada.session.removeMember(uid, world.ids.ada), 409);
    await refused(ada.session.updateMember(uid, world.ids.ada, { rights: { reveal: true, edit: true, share: true } }), 409);
});

test("COLLECTION RENAME and ARCHIVE through the client: name and description stay encrypted; an archived collection vanishes for its members", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ada = await world.join("ada");
    const bob = await world.join("bob");
    const uid = await ada.session.createCollection({ name: "Old", description: "before" });
    await ada.session.addMember(uid, { userId: world.ids.bob, rights: {} });
    const itemUid = await ada.session.createCompanyItem(uid, draftOf());
    await bob.session.reload();
    await refused(bob.session.renameCollection(uid, { name: "Hijack" }), 403);
    await ada.session.renameCollection(uid, { name: MARK.collection, description: MARK.about });
    await bob.session.reload();
    const view = bob.session.snapshot().collections[0];
    assert.equal(view.name, MARK.collection); assert.equal(view.description, MARK.about);
    assertNoPlaintext(await dbDump(world.pool), "database");
    await assert.rejects(ada.session.renameCollection(uid, { name: "" }), (e) => e.name === "VaultUserError");

    await refused(bob.session.archiveCollection(uid), 403);
    await ada.session.archiveCollection(uid);
    await bob.session.reload();
    assert.equal(bob.session.snapshot().collections.length, 0); assert.equal(bob.session.snapshot().companyItems.length, 0);
    assert.equal((await world.raw("bob", "GET", `/items/${itemUid}`)).status, 404);
    assert.equal((await world.pool.query("SELECT count(*)::int AS n FROM zv_items WHERE uid = ?", [itemUid]))[0][0].n, 1, "archiving deletes nothing");
});

// ------------------------------------------------------------------------------------------------ sharing one item
const COMBOS = [];
for (const reveal of [false, true]) for (const copy of [false, true]) for (const edit of [false, true]) for (const share of [false, true]) {
    if ((copy || edit) && !reveal) continue; // not a valid right (the server refuses it too)
    COMBOS.push({ reveal, copy, edit, share });
}

test("SHARING one item: every valid permission combination is enforced for the recipient (client and server), and only that item is shared", { skip: SKIP }, async () => {
    assert.equal(COMBOS.length, 10);
    const world = await buildWorld();
    const ada = await world.join("ada");
    const bob = await world.join("bob");
    const dee = await world.join("dee");
    const items = [];
    for (const [index, combo] of COMBOS.entries()) {
        const uid = await ada.session.createItem(draftOf({ title: `Shared ${index}`, password: `${MARK.password}-${index}` }));
        await ada.session.shareItem(uid, { recipientUserId: world.ids.bob, rights: combo });
        items.push({ uid, combo, index });
    }
    const hidden = await ada.session.createItem(draftOf({ title: "Never shared", password: "private-never-shared-pw" }));
    await bob.session.reload();
    const snap = bob.session.snapshot();
    assert.equal(snap.items.length, 0, "the recipient's own vault is untouched");
    assert.ok(!snap.sharedItems.some((i) => i.uid === hidden) && (await world.raw("bob", "GET", `/items/${hidden}`)).status === 404, "an unshared item of the same owner stays invisible");
    assert.equal(snap.sharedItems.length, 10);

    for (const { uid, combo, index } of items) {
        const view = snap.sharedItems.find((i) => i.uid === uid);
        assert.equal(view.title, `Shared ${index}`, "details are always visible");
        assert.equal(view.via, "grant");
        assert.deepEqual({ reveal: view.rights.reveal, copy: view.rights.copy, edit: view.rights.edit, share: view.rights.share }, combo, "the rights the server reports are the rights that were given");
        // reveal
        if (combo.reveal) assert.equal((await bob.session.revealItem(uid)).password, `${MARK.password}-${index}`);
        else { await refused(bob.session.revealItem(uid), 403); assert.equal((await world.raw("bob", "POST", `/items/${uid}/secret`)).status, 403); }
        // copy (the server only accepts the report of a copy from someone allowed to copy)
        assert.equal((await world.raw("bob", "POST", `/items/${uid}/access-reports`, { kind: "copy" })).status, combo.copy ? 200 : 403, `copy ${JSON.stringify(combo)}`);
        // edit
        if (combo.edit) {
            const loaded = await bob.session.loadForEditing(uid);
            await bob.session.updateItem(uid, { ...loaded.draft, title: `Edited ${index}` }, loaded.version);
        } else if (combo.reveal) {
            const loaded = await bob.session.loadForEditing(uid);
            await refused(bob.session.updateItem(uid, { ...loaded.draft, title: "nope" }, loaded.version), 403);
        } else {
            await refused(bob.session.loadForEditing(uid), 403);
        }
        // delete is never part of a share
        assert.equal((await world.raw("bob", "DELETE", `/items/${uid}`)).status, 403);
        // manage access: details-only to a third person always possible with the share right; never more than held; never the share right itself
        const toDee = bob.session.shareItem(uid, { recipientUserId: world.ids.dee, rights: {} });
        if (combo.share) {
            await toDee;
            await bob.session.revokeGrant(uid, world.ids.dee);
        } else {
            await refused(toDee, 403);
        }
        if (combo.share) await refused(bob.session.shareItem(uid, { recipientUserId: world.ids.dee, rights: { share: true } }), 403);
        if (combo.share && !combo.reveal) await refused(bob.session.shareItem(uid, { recipientUserId: world.ids.dee, rights: { reveal: true } }), 403);
        // keys that were never given are not in the database for the recipient
        const [keys] = await world.pool.query(
            "SELECT k.purpose FROM zv_item_keys k JOIN zv_items i ON i.id = k.item_id WHERE i.uid = ? AND k.holder_type = 'user' AND k.holder_user_id = ?", [uid, world.ids.bob]
        );
        assert.deepEqual(keys.map((k) => k.purpose).sort(), combo.reveal ? ["meta", "secret"] : ["meta"], `recipient key envelopes ${JSON.stringify(combo)}`);
    }
    assertNoPlaintext([ada, bob, dee].map((t) => t.sent()).join("\n"), "request bodies", [`${MARK.password}-3`, "private-never-shared-pw"]);
    assertNoPlaintext(await dbDump(world.pool), "database", [`${MARK.password}-3`, "private-never-shared-pw"]);
});

test("SHARING: expiry ends access by the server clock, revocation deletes the keys, changing permissions re-keys only what it must; 'Shared by me' tells the truth", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ada = await world.join("ada");
    const bob = await world.join("bob");
    const cy = await world.join("cy");
    const dee = await world.join("dee");
    const uid = await ada.session.createItem(draftOf());
    const ends = new Date(Date.now() + 2 * 86400000).toISOString();
    await ada.session.shareItem(uid, { recipientUserId: world.ids.bob, rights: { reveal: true, copy: true }, expiresAt: ends });
    await ada.session.shareItem(uid, { recipientUserId: world.ids.cy, rights: {} });
    await assert.rejects(ada.session.shareItem(uid, { recipientUserId: world.ids.cy, rights: {} }), (e) => e.status === 409 || e.code === "ALREADY_SHARED");
    await assert.rejects(ada.session.shareItem(uid, { recipientUserId: world.ids.dee, rights: {}, expiresAt: new Date(Date.now() - 1000).toISOString() }), (e) => e.status === 400);
    await bob.session.reload(); await cy.session.reload();
    const bobView = bob.session.snapshot().sharedItems[0];
    assert.equal(new Date(bobView.expiresAt).toISOString(), ends);
    assert.equal(bobView.sharedBy, world.ids.ada);

    const outgoing = await ada.session.loadOutgoing();
    assert.equal(outgoing.length, 2); assert.ok(outgoing.every((r) => r.title === MARK.title && r.status === "active"));
    assert.deepEqual(ada.session.snapshot().outgoing.map((r) => r.name).sort(), ["Bob", "Cy"]);

    // expiry: the recipient loses everything the moment the database clock passes it; nothing about the item is returned
    await world.pool.query("UPDATE zv_grants SET expires_at = now() - interval '1 minute' WHERE recipient_user_id = ?", [world.ids.bob]);
    const gone = await world.raw("bob", "GET", `/items/${uid}`);
    assert.equal(gone.status, 404);
    assert.ok(!/ciphertext|meta|secret/i.test(gone.text), "an expired share exposes no encrypted content");
    assert.equal((await world.raw("bob", "POST", `/items/${uid}/secret`)).status, 404);
    await bob.session.reload();
    assert.equal(bob.session.snapshot().sharedItems.length, 0);
    assert.equal((await ada.session.loadOutgoing()).find((r) => r.recipientUserId === world.ids.bob).status, "expired");

    // revocation: keys are deleted and the item is flagged for a password change when the secret was shared
    await ada.session.revokeGrant(uid, world.ids.cy);
    await cy.session.reload();
    assert.equal(cy.session.snapshot().sharedItems.length, 0);
    assert.equal((await world.pool.query("SELECT count(*)::int AS n FROM zv_item_keys WHERE holder_type = 'user' AND holder_user_id = ?", [world.ids.cy]))[0][0].n, 0, "the recipient's key envelopes are gone");
    assert.equal((await ada.session.loadOutgoing()).find((r) => r.recipientUserId === world.ids.cy).status, "revoked");
    await assert.rejects(ada.session.revokeGrant(uid, world.ids.cy), (e) => e.status === 404);

    // changing permissions: losing reveal deletes the secret-key envelope; gaining it again needs (and gets) a new one
    await ada.session.shareItem(uid, { recipientUserId: world.ids.dee, rights: { reveal: true } });
    await dee.session.reload();
    assert.equal((await dee.session.revealItem(uid)).password, MARK.password);
    await ada.session.updateGrant(uid, world.ids.dee, { rights: { reveal: false } });
    assert.equal((await world.pool.query("SELECT count(*)::int AS n FROM zv_item_keys WHERE holder_type = 'user' AND holder_user_id = ? AND purpose = 'secret'", [world.ids.dee]))[0][0].n, 0);
    await dee.session.lock("manual"); await dee.session.unlock(dee.password);
    await refused(dee.session.revealItem(uid), 403);
    await ada.session.updateGrant(uid, world.ids.dee, { rights: { reveal: true, copy: true, edit: true } });
    await dee.session.reload();
    assert.equal((await dee.session.revealItem(uid)).password, MARK.password);
    assert.equal(dee.session.snapshot().sharedItems[0].rights.edit, true);
    const listed = await ada.session.listGrants(uid);
    assert.deepEqual(listed.map((g) => g.name), ["Bob", "Dee"], "ended (revoked) shares are not listed; an expired one still is, flagged as expired, until it is removed");
    assert.equal(listed.find((g) => g.name === "Bob").expired, true);
    assert.equal(listed.find((g) => g.name === "Dee").expired, false);

    const kinds = (await world.pool.query("SELECT kind FROM zv_audit_events ORDER BY id"))[0].map((r) => r.kind);
    for (const kind of ["item_shared", "share_changed", "share_revoked"]) assert.ok(kinds.includes(kind), `audit has ${kind}`);
    assertNoPlaintext([ada, bob, cy, dee].map((t) => t.sent()).join("\n"), "request bodies");
});

test("AUTHORISATION: outsiders, escalation, recipients without a vault, deactivated people and other tenants are all refused", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ada = await world.join("ada");
    const bob = await world.join("bob");
    const dee = await world.join("dee");
    const uid = await ada.session.createItem(draftOf());
    const col = await ada.session.createCollection({ name: "Private ops" });
    const colItem = await ada.session.createCompanyItem(col, draftOf({ title: "In collection" }));

    // someone with no path to the item or collection: indistinguishable from "does not exist"
    for (const [method, route, body] of [
        ["GET", `/items/${uid}`], ["POST", `/items/${uid}/secret`], ["PATCH", `/items/${uid}`, { expectedVersion: 1, favorite: true }], ["DELETE", `/items/${uid}`], ["POST", `/items/${uid}/restore`],
        ["GET", `/items/${uid}/grants`], ["POST", `/items/${uid}/grants`, { recipientUserId: world.ids.bob, rights: {} }], ["PATCH", `/items/${uid}/grants/${world.ids.bob}`, { rights: {} }],
        ["DELETE", `/items/${uid}/grants/${world.ids.bob}`], ["GET", `/items/${colItem}`], ["POST", `/items/${colItem}/secret`], ["GET", `/collections/${col}`],
        ["PATCH", `/collections/${col}`, {}], ["POST", `/collections/${col}/archive`], ["POST", `/collections/${col}/items`, {}], ["POST", `/collections/${col}/members`, {}],
        ["PATCH", `/collections/${col}/members/${world.ids.ada}`, {}], ["DELETE", `/collections/${col}/members/${world.ids.ada}`], ["POST", `/collections/${col}/rotate`, {}],
    ]) {
        const res = await world.raw("dee", method, route, body);
        assert.equal(res.status, 404, `${method} ${route} -> ${res.status}`);
    }
    assert.equal((await world.raw("dee", "GET", `/audit?itemUid=${uid}`)).status < 500, true);
    assert.deepEqual((await world.raw("dee", "GET", "/shares/outgoing")).data, []);

    // a recipient without a vault: clear message from the client, refusal from the server
    await assert.rejects(ada.session.shareItem(uid, { recipientUserId: world.ids.eve, rights: {} }), (e) => e.code === "RECIPIENT_NO_VAULT");
    const direct = await world.raw("ada", "POST", `/items/${uid}/grants`, { recipientUserId: world.ids.eve, rights: {}, boxedMetaKey: Buffer.alloc(100, 1).toString("base64url") });
    assert.equal(direct.status, 400); assert.equal(direct.body.code, "RECIPIENT_UNAVAILABLE");
    await assert.rejects(ada.session.shareItem(uid, { recipientUserId: 999999, rights: {} }), (e) => e.code === "RECIPIENT_NO_VAULT");

    // a recipient cannot widen their own grant or share the item onwards beyond what they hold
    await ada.session.shareItem(uid, { recipientUserId: world.ids.bob, rights: { reveal: true, share: true } });
    await bob.session.reload();
    assert.equal((await world.raw("bob", "PATCH", `/items/${uid}/grants/${world.ids.bob}`, { rights: { reveal: true, copy: true, edit: true, share: true } })).status, 403, "nobody widens their own grant (only whoever gave it, an owner or a manager can change it)");
    await refused(bob.session.shareItem(uid, { recipientUserId: world.ids.dee, rights: { reveal: true, copy: true } }), 403);
    await refused(bob.session.shareItem(uid, { recipientUserId: world.ids.dee, rights: { share: true } }), 403);

    // a deactivated colleague loses every share at once (database-level offboarding), and cannot call the API
    await bob.session.shareItem(uid, { recipientUserId: world.ids.dee, rights: {} });
    await world.pool.query("UPDATE users SET status = 'inactive', employment_status = 'resigned' WHERE id = ?", [world.ids.bob]);
    assert.equal((await world.raw("bob", "GET", `/items/${uid}`)).status, 403);
    await dee.session.reload();
    assert.equal(dee.session.snapshot().sharedItems.length, 0, "shares made BY the deactivated person ended with theirs");
    assert.equal((await world.pool.query("SELECT count(*)::int AS n FROM zv_item_keys k JOIN zv_items i ON i.id = k.item_id WHERE i.uid = ? AND k.holder_type = 'user'", [uid]))[0][0].n, 0);
    assert.equal((await world.pool.query("SELECT count(*)::int AS n FROM zv_items WHERE uid = ?", [uid]))[0][0].n, 1, "no credential was deleted");

    // another tenant: its own database, so even identical ids and uids reach nothing
    const other = await buildWorld();
    const otherAda = await other.join("ada");
    assert.equal((await rawCall2(other, "ada", `/items/${uid}`)).status, 404);
    assert.equal((await rawCall2(other, "ada", `/collections/${col}`)).status, 404);
    assert.deepEqual(otherAda.session.snapshot().collections, []);
    assert.equal(otherAda.session.snapshot().items.length, 0);
});

const rawCall2 = (world, name, route) => world.raw(name, "GET", route);

test("NOTHING SECRET LEAKS: no request body, database row, audit record, console line or browser storage holds a password, note, name or master password", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ada = await world.join("ada");
    const bob = await world.join("bob");
    const uid = await ada.session.createCollection({ name: MARK.collection, description: MARK.about });
    await ada.session.addMember(uid, { userId: world.ids.bob, rights: { reveal: true, copy: true, edit: true } });
    const itemUid = await ada.session.createCompanyItem(uid, draftOf());
    const own = await ada.session.createItem(draftOf({ title: "Mine " + MARK.title }));
    await ada.session.shareItem(own, { recipientUserId: world.ids.bob, rights: { reveal: true } });
    await bob.session.reload();
    await bob.session.revealItem(itemUid);
    await bob.session.revealItem(own);
    await ada.session.loadOutgoing();
    const wire = ada.sent() + bob.sent();
    assertNoPlaintext(wire, "request bodies", ["Mine " + MARK.title]);
    assertNoPlaintext(await dbDump(world.pool), "database", ["Mine " + MARK.title]);
    const [audit] = await world.pool.query("SELECT * FROM zv_audit_events");
    assertNoPlaintext(JSON.stringify(audit), "audit trail", ["Mine " + MARK.title]);
    assertNoPlaintext(logged.join("\n"), "console output");
    assertNoPlaintext([...ada.storage.map.entries(), ...bob.storage.map.entries(), ...ada.drafts.map.entries(), ...bob.drafts.map.entries()].flat().join("\n"), "browser storage");
    for (const tab of [ada, bob]) {
        await tab.session.lock("manual");
        const state = JSON.stringify(tab.session.snapshot());
        assertNoPlaintext(state, "state after lock", ["Mine " + MARK.title]);
        const s = tab.session.snapshot();
        assert.deepEqual([s.items.length, s.companyItems.length, s.sharedItems.length, s.collections.length, s.outgoing.length], [0, 0, 0, 0, 0], "locking wipes company and shared state too");
    }
});
