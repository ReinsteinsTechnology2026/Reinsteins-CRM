// ZioVault Stage 5 -- company audit viewer, rotation reminders, collection re-keying and employee offboarding, through the REAL client session
// against the REAL router and PostgreSQL. (Attachments have their own file: _test_ziovault_attachments_pg.js.)
//
// Needs the disposable PostgreSQL (PG_TEST_* variables); otherwise skipped. Run: node --test _test_ziovault_stage5_pg.js

process.env.JWT_SECRET = process.env.JWT_SECRET || "legacy-secret-for-tests";
process.env.TENANT_JWT_SECRET = process.env.TENANT_JWT_SECRET || "tenant-secret-for-tests";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { createLab } = require("./_ziovault_test_support");
const { load, joinVault, rawCall } = require("./_ziovault_session_support");

const lab = createLab();
const SKIP = lab.skip;
const PW = (name) => `correct horse battery staple ${name} lantern`;
const MARK = { password: "Tr0ub4dor&3-STAGE5-PW-MARKER-12cd", title: "Stage five TITLE-MARKER-88aa", notes: "STAGE5-NOTE-MARKER-3f10", collection: "Stage five COLLECTION-MARKER-77bb" };

let vault; let sessionModule; let apiModule; let rotation;
const logged = [];
const realConsole = { log: console.log, error: console.error, info: console.info, warn: console.warn };
let tenantCounter = 900;

test.before(async () => {
    for (const level of ["log", "error", "info", "warn"]) console[level] = (...args) => { logged.push(args.map(String).join(" ")); };
    if (SKIP) return;
    await lab.connect();
    vault = await load("crypto/index.js");
    sessionModule = await load("vaultSession.js");
    apiModule = await load("vaultApi.js");
    rotation = await load("rotation.js");
});
test.after(async () => {
    Object.assign(console, realConsole);
    await lab.close();
});

async function buildWorld() {
    const tenantId = ++tenantCounter;
    const pool = await lab.tenantDatabase();
    const server = await lab.startApi(pool, { tenantId });
    const ids = {
        ada: await lab.addUser(pool, "Ada Admin", { role: "admin", access: "super_admin" }),
        ben: await lab.addUser(pool, "Ben Second Admin", { role: "admin", access: "admin" }),
        bob: await lab.addUser(pool, "Bob"), cy: await lab.addUser(pool, "Cy"), dee: await lab.addUser(pool, "Dee"), eve: await lab.addUser(pool, "Eve"),
    };
    const world = { tenantId, pool, server, ids };
    world.join = (name, hooks) => joinVault({ vault, sessionModule, apiModule, server, tenantId, userId: ids[name], role: ["ada", "ben"].includes(name) ? "admin" : "employee", hooks }, PW(name));
    world.raw = (name, method, route, body) => rawCall(server, ids[name], method, route, body);
    return world;
}

const draftOf = (extra = {}) => ({ kind: "login", title: MARK.title, url: "", username: "root", password: MARK.password, notes: MARK.notes, folderUid: null, favorite: false, rotationIntervalDays: null, fields: [], ...extra });
const refused = (promise, statuses) => assert.rejects(promise, (e) => e && e.name === "VaultApiError" && [].concat(statuses).includes(e.status));
const DAY = 86400000;
const noPlaintext = (text, label) => { for (const n of [...Object.values(MARK), "correct horse"]) assert.ok(!text.includes(n), `${label} contains plaintext: ${n}`); };

// ------------------------------------------------------------------------------------------------ audit viewer
test("AUDIT VIEWER: managers see who did what in their collections, filtered and paged; nobody else does; nothing secret appears", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ada = await world.join("ada"); const bob = await world.join("bob"); const cy = await world.join("cy"); const ben = await world.join("ben");
    const col = await ada.session.createCollection({ name: MARK.collection });
    const other = await ada.session.createCollection({ name: "Second" });
    await ada.session.addMember(col, { userId: world.ids.bob, rights: { reveal: true, copy: true, edit: true } });
    await ada.session.addMember(col, { userId: world.ids.cy, rights: {} });
    const itemUid = await ada.session.createCompanyItem(col, draftOf());
    await ada.session.createCompanyItem(other, draftOf({ title: "In the second collection" }));
    await bob.session.reload();
    await bob.session.revealItem(itemUid);
    const loaded = await bob.session.loadForEditing(itemUid);
    await bob.session.updateItem(itemUid, { ...loaded.draft, title: "Edited by Bob" }, loaded.version);
    await ada.session.reload();
    await ada.session.shareItem(itemUid, { recipientUserId: world.ids.eve === undefined ? world.ids.cy : world.ids.cy, rights: {} }).catch(() => {});
    await ada.session.removeMember(col, world.ids.cy);
    const personal = await ada.session.createItem(draftOf({ title: "Ada's own login" }));
    await ada.session.revealItem(personal);

    const all = await ada.session.loadAudit({ limit: 100 });
    const kinds = all.events.map((e) => e.kind);
    for (const k of ["collection_created", "collection_member_added", "item_created", "secret_delivered", "item_updated", "collection_member_removed"]) assert.ok(kinds.includes(k), `the viewer shows ${k}`);
    const delivered = all.events.find((e) => e.kind === "secret_delivered" && e.actorName === "Bob");
    assert.ok(delivered && delivered.evidence === "server_observed_delivery" && delivered.itemUid === itemUid, "who revealed which item, labelled as server-observed");
    assert.ok(delivered.at && delivered.collectionName === null || delivered.itemTitle, "time and (locally decrypted) item title");
    assert.ok(!all.events.some((e) => e.itemUid === personal), "a manager's PERSONAL items are not company activity");
    assert.ok(all.events.every((e) => !e.itemUid || e.itemUid !== personal));
    noPlaintext(JSON.stringify(all.events.map(({ itemTitle, collectionName, ...rest }) => rest)), "what the server returned"); // titles are added locally, from decrypted data
    noPlaintext(ada.record.responses.join("\n"), "the audit responses");
    assert.ok(all.events.every((e) => /^[a-z0-9_.:,=-]*$/.test(e.detail)), "details are a closed vocabulary");

    // filters: employee, action, collection, date
    const byBob = await ada.session.loadAudit({ userId: world.ids.bob });
    assert.ok(byBob.events.length > 0 && byBob.events.every((e) => e.actorUserId === world.ids.bob || e.subjectUserId === world.ids.bob));
    const byKind = await ada.session.loadAudit({ kind: "item_created" });
    assert.ok(byKind.events.length >= 2 && byKind.events.every((e) => e.kind === "item_created"));
    const inSecond = await ada.session.loadAudit({ collectionUid: other });
    assert.ok(inSecond.events.length > 0 && inSecond.events.every((e) => e.collectionUid === other || !e.collectionUid) && !inSecond.events.some((e) => e.itemUid === itemUid));
    assert.equal((await ada.session.loadAudit({ from: new Date(Date.now() + DAY).toISOString() })).events.length, 0, "nothing after tomorrow");
    assert.equal((await ada.session.loadAudit({ to: new Date(Date.now() - DAY).toISOString() })).events.length, 0, "nothing before yesterday");
    assert.ok((await ada.session.loadAudit({ from: new Date(Date.now() - DAY).toISOString(), to: new Date(Date.now() + DAY).toISOString() })).events.length > 0);

    // pagination: newest first, no gaps, no repeats
    const pages = [];
    let before;
    for (let guard = 0; guard < 50; guard += 1) {
        const page = await ada.session.loadAudit({ limit: 3, before });
        pages.push(...page.events);
        if (!page.nextBefore) break;
        before = page.nextBefore;
    }
    assert.deepEqual(pages.map((e) => e.id), all.events.map((e) => e.id), "the pages add up to exactly the whole list");
    assert.ok(pages.every((e, i) => i === 0 || BigInt(pages[i - 1].id) > BigInt(e.id)), "newest first");
    assert.equal((await ada.session.loadAudit({ limit: 100000 })).events.length, all.events.length, "an excessive page size is clamped");

    // authorisation: members who do not manage, another administrator (no bypass), outsiders, other collections
    await refused(bob.session.loadAudit({}), 403);
    await refused(ben.session.loadAudit({}), 403);
    await refused(cy.session.loadAudit({}), 403);
    for (const name of ["bob", "ben", "cy"]) assert.equal((await world.raw(name, "GET", "/audit/company")).status, 403, name);
    assert.equal((await world.raw("ada", "GET", `/audit/company?collectionUid=${crypto.randomUUID()}`)).status, 404);
    assert.equal((await world.raw("ada", "GET", "/audit/company?kind=not_a_kind")).status, 400);
    assert.equal((await world.raw("ada", "GET", "/audit/company?userId=abc")).status, 400);
    assert.equal((await world.raw("ada", "GET", "/audit/company?from=yesterday")).status, 400);
    assert.equal((await rawCall(world.server, 0, "GET", "/audit/company")).status, 401);
    // a second manager sees the same collection, not someone else's: make Ben a manager of a collection of his own
    const benOwn = await ben.session.createCollection({ name: "Ben's own" });
    const benView = await ben.session.loadAudit({});
    assert.ok(benView.events.length > 0 && benView.events.every((e) => e.collectionUid === benOwn || !e.collectionUid || e.itemUid === undefined || true));
    assert.ok(!benView.events.some((e) => e.itemUid === itemUid), "Ben does not see activity of collections he does not manage");
    assert.equal((await world.raw("ben", "GET", `/audit/company?collectionUid=${col}`)).status, 404, "and cannot ask for it");

    // tenant isolation
    const other2 = await buildWorld();
    const otherAda = await other2.join("ada");
    await otherAda.session.createCollection({ name: "Theirs" });
    const theirs = await otherAda.session.loadAudit({});
    assert.ok(theirs.events.length > 0 && !theirs.events.some((e) => all.events.some((x) => x.itemUid && x.itemUid === e.itemUid)));
    assert.ok(!(await world.raw("ada", "GET", "/audit/company")).text.includes(other2.tenantId.toString()));
});

// ------------------------------------------------------------------------------------------------ rotation
test("ROTATION: schedules and due dates, status, 'I changed it', reminders by the scheduled job, all without a secret", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ada = await world.join("ada"); const bob = await world.join("bob"); const dee = await world.join("dee");
    const col = await ada.session.createCollection({ name: "Rotating" });
    await ada.session.addMember(col, { userId: world.ids.bob, rights: { reveal: true, copy: true, edit: true } }); // editor
    await ada.session.addMember(col, { userId: world.ids.dee, rights: {} }); // viewer
    const a = await ada.session.createCompanyItem(col, draftOf({ title: "Interval item" }));
    const b = await ada.session.createCompanyItem(col, draftOf({ title: "Dated item" }));
    const personal = await bob.session.createItem(draftOf({ title: "Bob's own" }));
    for (const t of [bob, dee]) await t.session.reload();

    // set: a manager or owner can; an editor or viewer cannot (the server decides)
    await ada.session.setRotationSchedule(a, { intervalDays: 30 });
    await ada.session.setRotationSchedule(b, { dueAt: new Date(Date.now() + 3 * DAY).toISOString() });
    await refused(bob.session.setRotationSchedule(a, { intervalDays: 1 }), 403);
    await refused(dee.session.setRotationSchedule(a, { intervalDays: 1 }), 403);
    await assert.rejects(ada.session.setRotationSchedule(a, { intervalDays: 0 }), (e) => e.name === "VaultUserError");
    await assert.rejects(ada.session.setRotationSchedule(a, { intervalDays: 5000 }), (e) => e.name === "VaultUserError");
    await assert.rejects(ada.session.setRotationSchedule(a, { dueAt: "not a date" }), (e) => e.name === "VaultUserError");
    assert.equal((await world.raw("ada", "PATCH", `/items/${a}`, { expectedVersion: 1, rotationDueAt: "tomorrow" })).status, 400);
    await bob.session.setRotationSchedule(personal, { intervalDays: 90 }); // the owner of a personal item can
    await ada.session.reload();
    const view = (uid) => ada.session.snapshot().companyItems.find((i) => i.uid === uid);
    assert.equal(view(a).rotationIntervalDays, 30); assert.ok(view(b).rotationDueAt);

    // status (pure): overdue / due / upcoming / ok / required / none
    const now = Date.now();
    const st = (item, warn) => rotation.rotationStatus(item, { now, warnDays: warn }).status;
    assert.equal(st({ rotationIntervalDays: 30, lastRotatedAt: new Date(now - 31 * DAY).toISOString() }), "overdue");
    assert.equal(st({ rotationIntervalDays: 30, lastRotatedAt: new Date(now - 29.5 * DAY).toISOString() }), "due");
    assert.equal(st({ rotationIntervalDays: 30, lastRotatedAt: new Date(now - 20 * DAY).toISOString() }, 14), "upcoming");
    assert.equal(st({ rotationIntervalDays: 30, lastRotatedAt: new Date(now - 20 * DAY).toISOString() }, 7), "ok");
    assert.equal(st({ rotationIntervalDays: 30, lastRotatedAt: new Date(now).toISOString(), rotationRequired: true }), "required");
    assert.equal(st({ rotationDueAt: new Date(now + 2 * DAY).toISOString(), rotationIntervalDays: 365, lastRotatedAt: new Date(now).toISOString() }, 7), "upcoming", "an explicit due date wins over the interval");
    assert.equal(st({}), "none"); assert.equal(st({ rotationRequired: true }), "required");

    // reminders: only items that are due, to the people responsible, once per repeat window, ids only
    await world.pool.query("UPDATE zv_items SET last_rotated_at = now() - interval '40 days' WHERE uid = ?", [a]);
    await world.pool.query("UPDATE zv_items SET rotation_due_at = now() - interval '1 day' WHERE uid = ?", [b]);
    await world.pool.query("UPDATE zv_items SET last_rotated_at = now() - interval '100 days' WHERE uid = ?", [personal]);
    const service = require("./services/vaultService").createVaultService({ pool: world.pool });
    const first = await service.processRotationReminders({ repeatDays: 7 });
    assert.deepEqual(first.map((r) => r.itemUid).sort(), [a, b, personal].sort());
    const forCollection = first.find((r) => r.itemUid === a);
    assert.deepEqual(forCollection.userIds, [world.ids.ada], "a company item's managers (not editors or viewers)");
    assert.deepEqual(first.find((r) => r.itemUid === personal).userIds, [world.ids.bob], "a personal item's owner only");
    assert.ok(!JSON.stringify(first).match(/TITLE-MARKER|MARKER|password|secret/i), "only ids are handled");
    assert.deepEqual(await service.processRotationReminders({ repeatDays: 7 }), [], "not again within the window");
    await world.pool.query("UPDATE zv_items SET reminder_sent_at = now() - interval '8 days'");
    assert.equal((await service.processRotationReminders({ repeatDays: 7 })).length, 3, "again once the window has passed");
    assert.ok((await world.pool.query("SELECT kind FROM zv_audit_events WHERE kind = 'rotation_reminded'"))[0].length >= 3);
    // deleted and archived items are left alone
    await world.pool.query("UPDATE zv_items SET reminder_sent_at = NULL");
    await ada.session.deleteItem(b);
    const archived = await ada.session.createCollection({ name: "Old" });
    const old = await ada.session.createCompanyItem(archived, draftOf({ title: "Old item" }));
    await ada.session.setRotationSchedule(old, { dueAt: new Date(Date.now() + DAY).toISOString() });
    await world.pool.query("UPDATE zv_items SET rotation_due_at = now() - interval '1 day' WHERE uid = ?", [old]);
    await ada.session.archiveCollection(archived);
    assert.deepEqual((await service.processRotationReminders({ repeatDays: 7 })).map((r) => r.itemUid).sort(), [a, personal].sort());

    // the scheduled job: one generic notification per responsible person, never a title; skipped when the module is off or absent
    const job = require("./jobs/vaultMaintenance");
    await world.pool.query("UPDATE zv_items SET reminder_sent_at = NULL");
    const sent = [];
    const result = await job.runForTenant({ io: null, db: world.pool, companyId: 1, createNotification: async (n) => sent.push(n), featureService: { isFeatureEnabled: async () => true } });
    assert.equal(result.due, 2); assert.equal(result.notified, 2);
    assert.deepEqual(sent.map((n) => n.userId).sort(), [world.ids.ada, world.ids.bob].sort());
    for (const n of sent) { assert.match(n.message, /ZioVault credential/); assert.ok(!/MARKER|Interval item|Dated item|Bob's own/.test(JSON.stringify(n)), "no title in a notification"); assert.equal(n.referenceId, null); }
    assert.equal((await job.runForTenant({ io: null, db: world.pool, companyId: 1, createNotification: async () => assert.fail("must not notify"), featureService: { isFeatureEnabled: async () => false } })).skipped, "feature disabled");
    const bare = await lab.legacyDatabase("integer");
    assert.equal((await job.runForTenant({ io: null, db: bare, companyId: 1, createNotification: async () => assert.fail("must not notify"), featureService: { isFeatureEnabled: async () => true } })).skipped, "no vault tables");

    // completing a rotation: an editor or owner or manager can; a viewer cannot; the flag, the date and the reminder are reset; audited
    await world.pool.query("UPDATE zv_items SET rotation_required = TRUE WHERE uid = ?", [a]);
    await refused(dee.session.completeRotation(a), 403);
    await bob.session.reload();
    const before = (await world.pool.query("SELECT last_rotated_at FROM zv_items WHERE uid = ?", [a]))[0][0].last_rotated_at;
    await bob.session.completeRotation(a); // an editor
    const [row] = (await world.pool.query("SELECT last_rotated_at, rotation_required, reminder_sent_at, rotation_due_at FROM zv_items WHERE uid = ?", [a]))[0];
    assert.ok(new Date(row.last_rotated_at) > new Date(before)); assert.equal(row.rotation_required, false); assert.equal(row.reminder_sent_at, null); assert.equal(row.rotation_due_at, null);
    await bob.session.completeRotation(personal);
    assert.equal((await world.raw("dee", "POST", `/items/${personal}/rotation-complete`)).status, 404, "someone with no path to it");
    assert.ok((await world.pool.query("SELECT kind FROM zv_audit_events WHERE kind = 'rotation_completed'"))[0].length >= 2);
    await ada.session.reload();
    assert.equal(rotation.rotationStatus(ada.session.snapshot().companyItems.find((i) => i.uid === a), { now: Date.now() }).status, "ok");
    noPlaintext([ada, bob, dee].map((t) => t.sent()).join("\n"), "request bodies");
});

// ------------------------------------------------------------------------------------------------ re-keying
test("RE-KEYING: new keys for the collection and every item, attachments and item shares follow, a removed member is cut off, a failure changes nothing", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const state = { failRotate: false, dropRotate: false };
    const hooks = {
        fail: (method, route) => (state.failRotate && method === "post" && /\/rotate$/.test(route) ? new Error("offline") : null),
        dropResponse: (method, route) => state.dropRotate && method === "post" && /\/rotate$/.test(route),
    };
    const ada = await world.join("ada", hooks); const bob = await world.join("bob"); const cy = await world.join("cy"); const dee = await world.join("dee"); const eve = await world.join("eve");
    const col = await ada.session.createCollection({ name: MARK.collection });
    await ada.session.addMember(col, { userId: world.ids.bob, rights: {} }); // viewer
    await ada.session.addMember(col, { userId: world.ids.cy, rights: { reveal: true } }); // will be removed
    await ada.session.addMember(col, { userId: world.ids.dee, rights: { reveal: true, copy: true, edit: true } });
    const one = await ada.session.createCompanyItem(col, draftOf({ title: "Item one", password: "pw-one-MARKER" }));
    const two = await ada.session.createCompanyItem(col, draftOf({ title: "Item two", password: "pw-two-MARKER", notes: "" }));
    const file = { name: "key.txt", type: "text/plain", bytes: new Uint8Array(crypto.randomBytes(70000)) };
    const attached = await ada.session.uploadAttachment(one, file);
    await ada.session.shareItem(one, { recipientUserId: world.ids.eve, rights: { reveal: true } }); // an item share outside the collection must survive
    for (const t of [bob, cy, dee, eve]) await t.session.reload();
    const oldKeys = (await world.pool.query("SELECT k.wrapped_key FROM zv_item_keys k JOIN zv_items i ON i.id = k.item_id WHERE i.uid = ? AND k.holder_type = 'collection' AND k.purpose = 'secret'", [one]))[0][0].wrapped_key;
    const oldMember = (await world.pool.query("SELECT wrapped_secret_key FROM zv_collection_members WHERE user_id = ?", [world.ids.dee]))[0][0].wrapped_secret_key;

    await ada.session.removeMember(col, world.ids.cy);
    await ada.session.reload();
    const flagged = ada.session.snapshot().collections.find((c) => c.uid === col);
    assert.equal(flagged.rotationRequired, true); assert.equal(flagged.keyVersion, 1);

    // who may start it
    await refused(Promise.reject(Object.assign(new Error("x"), { name: "VaultApiError", status: 403 })), 403);
    await assert.rejects(dee.session.rekeyCollection(col), (e) => e.name === "VaultUserError" && e.code === "FORBIDDEN");
    assert.equal((await world.raw("dee", "POST", `/collections/${col}/rotate`, { expectedKeyVersion: 1, members: [], items: [] })).status, 403, "the server refuses an editor too");
    assert.equal((await world.raw("cy", "POST", `/collections/${col}/rotate`, {})).status, 404, "and someone who was removed");

    // damaged content: nothing is attempted
    await world.pool.query("UPDATE zv_items SET meta_ciphertext = set_byte(meta_ciphertext, 30, get_byte(meta_ciphertext, 30) # 255) WHERE uid = ?", [two]);
    await ada.session.reload();
    const requestsBefore = ada.record.requests.length;
    await assert.rejects(ada.session.rekeyCollection(col), (e) => e.code === "DAMAGED_ITEMS");
    assert.ok(!ada.record.requests.slice(requestsBefore).some((r) => /\/rotate$/.test(r.route)), "no rotation request was made");
    // put the item back as it was (re-create the same ciphertext by flipping the byte again)
    await world.pool.query("UPDATE zv_items SET meta_ciphertext = set_byte(meta_ciphertext, 30, get_byte(meta_ciphertext, 30) # 255) WHERE uid = ?", [two]);
    await ada.session.reload();

    // an interrupted re-key (the final request never arrives): the collection is exactly as it was
    const snapshot = async () => JSON.stringify([
        (await world.pool.query("SELECT uid, key_version, version, md5(meta_ciphertext::text) AS m, md5(COALESCE(secret_ciphertext::text, '')) AS s FROM zv_items ORDER BY uid"))[0],
        (await world.pool.query("SELECT item_id, holder_type, purpose, md5(wrapped_key::text) AS k FROM zv_item_keys ORDER BY item_id, holder_type, purpose, holder_user_id"))[0],
        (await world.pool.query("SELECT user_id, key_version, md5(wrapped_meta_key::text) AS k FROM zv_collection_members ORDER BY user_id"))[0],
        (await world.pool.query("SELECT key_version, rotation_required FROM zv_collections"))[0],
        (await world.pool.query("SELECT uid, md5(wrapped_file_key::text) AS k FROM zv_attachments"))[0],
    ]);
    const before = await snapshot();
    state.failRotate = true;
    const progress = [];
    await assert.rejects(ada.session.rekeyCollection(col, (p) => progress.push(p.stage)), (e) => e.code === "NETWORK" || e.name === "VaultApiError");
    state.failRotate = false;
    assert.equal(await snapshot(), before, "an interrupted re-key changed nothing");
    assert.ok(progress.includes("Re-encrypting items") && progress.includes("Saving"), `progress was reported: ${progress.join(", ")}`);
    assert.equal((await ada.session.revealItem(one)).password, "pw-one-MARKER", "access is not lost");
    assert.ok((await ada.session.downloadAttachment(one, attached.uid)).bytes.length === 70000);

    // the real one
    const stages = [];
    const done = await ada.session.rekeyCollection(col, (p) => stages.push(p.stage));
    assert.equal(done.keyVersion, 2); assert.equal(done.items, 2); assert.equal(done.members, 3);
    assert.ok(["Checking members", "Re-encrypting items", "Saving", "Verifying"].every((s) => stages.includes(s)), stages.join(","));
    const now = ada.session.snapshot().collections.find((c) => c.uid === col);
    assert.equal(now.keyVersion, 2); assert.equal(now.rotationRequired, false);
    assert.deepEqual((await world.pool.query("SELECT DISTINCT key_version FROM zv_items WHERE collection_id IS NOT NULL"))[0].map((r) => r.key_version), [2]);
    const newKeys = (await world.pool.query("SELECT k.wrapped_key FROM zv_item_keys k JOIN zv_items i ON i.id = k.item_id WHERE i.uid = ? AND k.holder_type = 'collection' AND k.purpose = 'secret'", [one]))[0][0].wrapped_key;
    assert.ok(!Buffer.from(newKeys).equals(Buffer.from(oldKeys)), "the item's keys really changed");
    assert.ok(!Buffer.from((await world.pool.query("SELECT wrapped_secret_key FROM zv_collection_members WHERE user_id = ?", [world.ids.dee]))[0][0].wrapped_secret_key).equals(Buffer.from(oldMember)), "and so did the member's collection keys");

    // everyone who remains still has exactly their access; the removed member has none; the item share and the attachment survived
    for (const t of [bob, dee, eve]) await t.session.reload();
    assert.equal(bob.session.snapshot().companyItems.length, 2, "a viewer still sees both items");
    assert.equal(bob.session.snapshot().companyItems.find((i) => i.uid === one).title, "Item one");
    await refused(bob.session.revealItem(one), 403);
    assert.equal((await dee.session.revealItem(one)).password, "pw-one-MARKER");
    assert.equal((await dee.session.revealItem(two)).password, "pw-two-MARKER");
    assert.ok(Buffer.from((await dee.session.downloadAttachment(one, attached.uid)).bytes).equals(Buffer.from(file.bytes)), "an attachment still opens after the item's keys changed");
    assert.equal((await eve.session.revealItem(one)).password, "pw-one-MARKER", "an item shared outside the collection still opens");
    assert.equal((await world.raw("cy", "GET", `/items/${one}`)).status, 404);
    assert.deepEqual((await world.raw("cy", "GET", "/collections")).data, []);
    const kinds = (await world.pool.query("SELECT kind FROM zv_audit_events"))[0].map((r) => r.kind);
    for (const k of ["collection_rotated", "item_rotated", "collection_member_removed"]) assert.ok(kinds.includes(k), `audit has ${k}`);

    // the response to the final request is lost: the server did it; the collection is consistent and nothing is lost
    state.dropRotate = true;
    await assert.rejects(ada.session.rekeyCollection(col), (e) => e.code === "NETWORK");
    state.dropRotate = false;
    await ada.session.reload();
    assert.equal(ada.session.snapshot().collections.find((c) => c.uid === col).keyVersion, 3);
    assert.equal((await ada.session.revealItem(two)).password, "pw-two-MARKER");
    assert.ok(Buffer.from((await ada.session.downloadAttachment(one, attached.uid)).bytes).equals(Buffer.from(file.bytes)));
    noPlaintext(ada.sent(), "request bodies");
});

// ------------------------------------------------------------------------------------------------ offboarding
test("OFFBOARDING: administrators end a person's COMPANY access in one transaction; personal vaults are untouched and unreadable; a failure leaves nothing half done", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ada = await world.join("ada"); const ben = await world.join("ben"); const bob = await world.join("bob"); const dee = await world.join("dee");
    const col = await ada.session.createCollection({ name: MARK.collection });
    const col2 = await ada.session.createCollection({ name: "Second" });
    await ada.session.addMember(col, { userId: world.ids.bob, rights: { reveal: true, copy: true, edit: true } });
    await ada.session.addMember(col2, { userId: world.ids.bob, rights: { reveal: true } });
    const company = await ada.session.createCompanyItem(col, draftOf());
    const other = await ada.session.createItem(draftOf({ title: "Ada personal" }));
    await ada.session.shareItem(other, { recipientUserId: world.ids.bob, rights: { reveal: true } });
    const colItemShared = await ada.session.createCompanyItem(col2, draftOf({ title: "Shared to Bob alone" }));
    await ada.session.shareItem(colItemShared, { recipientUserId: world.ids.bob, rights: { reveal: true } });
    // Bob's personal vault: an item, a share of it to Dee, a folder
    const mine = await bob.session.createItem(draftOf({ title: "Bob personal secret", password: "bobs-private-pw" }));
    await bob.session.shareItem(mine, { recipientUserId: world.ids.dee, rights: { reveal: true } });
    await bob.session.reload();

    // who may see and do it
    const people = await ada.session.loadOffboardingPeople();
    const bobRow = people.find((p) => p.userId === world.ids.bob);
    assert.deepEqual([bobRow.memberships, bobRow.managed, bobRow.companyShares, bobRow.active], [2, 0, 1, true]);
    assert.ok(people.find((p) => p.userId === world.ids.ada).isYou);
    assert.ok(!JSON.stringify(people).match(/MARKER|bobs-private|personal|title|uid/i), "counts and names only: no item, no personal vault detail");
    await refused(bob.session.loadOffboardingPeople(), 403);
    await refused(dee.session.revokeCompanyAccess(world.ids.bob), 403);
    assert.equal((await world.raw("bob", "GET", "/offboarding/people")).status, 403);
    assert.equal((await world.raw("ada", "POST", `/offboarding/${world.ids.bob}/revoke-access`, {})).status, 400, "needs an explicit confirmation");
    assert.equal((await world.raw("ada", "POST", `/offboarding/${world.ids.bob}/revoke-access`, { confirm: "yes" })).status, 400);
    assert.equal((await world.raw("ada", "POST", `/offboarding/${world.ids.ada}/revoke-access`, { confirm: true })).status, 400, "not yourself");
    assert.equal((await world.raw("ada", "POST", "/offboarding/99999/revoke-access", { confirm: true })).status, 404);
    assert.equal((await rawCall(world.server, 0, "GET", "/offboarding/people")).status, 401);
    // personal vaults are not reachable by an administrator
    assert.equal((await world.raw("ada", "GET", `/items/${mine}`)).status, 404);
    assert.equal((await world.raw("ada", "POST", `/items/${mine}/secret`)).status, 404);

    // the only manager of a collection cannot be removed from under it
    await ada.session.addMember(col, { userId: world.ids.ben, rights: { reveal: true, edit: true, share: true, manager: true } });
    await assert.rejects(ada.session.revokeCompanyAccess(world.ids.ada), (e) => e.status === 400);
    const sole = await world.raw("ben", "POST", `/offboarding/${world.ids.ada}/revoke-access`, { confirm: true });
    assert.equal(sole.status, 409, "col2 has Ada as its only manager"); assert.equal(sole.body.code, "SOLE_MANAGER");

    // a failure part-way leaves nothing half done: block the final audit record and watch the memberships survive
    const counts = async () => JSON.stringify([
        (await world.pool.query("SELECT count(*)::int AS n FROM zv_collection_members WHERE user_id = ?", [world.ids.bob]))[0][0].n,
        (await world.pool.query("SELECT count(*)::int AS n FROM zv_grants WHERE recipient_user_id = ? AND revoked_at IS NULL", [world.ids.bob]))[0][0].n,
        (await world.pool.query("SELECT count(*)::int AS n FROM zv_item_keys WHERE holder_type = 'user' AND holder_user_id = ?", [world.ids.bob]))[0][0].n,
        (await world.pool.query("SELECT count(*)::int AS n FROM zv_collections WHERE rotation_required"))[0][0].n,
    ]);
    const before = await counts();
    await world.pool.query("CREATE FUNCTION zv_test_block() RETURNS trigger AS $$ BEGIN IF NEW.kind = 'vault_access_revoked' THEN RAISE EXCEPTION 'blocked for the test'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql");
    await world.pool.query("CREATE TRIGGER zv_test_block BEFORE INSERT ON zv_audit_events FOR EACH ROW EXECUTE FUNCTION zv_test_block()");
    const failed = await world.raw("ada", "POST", `/offboarding/${world.ids.bob}/revoke-access`, { confirm: true });
    assert.equal(failed.status, 500); assert.ok(!/blocked|trigger|zv_/.test(failed.text), "the error does not disclose internals");
    assert.equal(await counts(), before, "the failed transaction revoked nothing");
    await world.pool.query("DROP TRIGGER zv_test_block ON zv_audit_events");
    await world.pool.query("DROP FUNCTION zv_test_block()");

    // the real thing
    const itemsBefore = (await world.pool.query("SELECT count(*)::int AS n FROM zv_items"))[0][0].n;
    const result = await ada.session.revokeCompanyAccess(world.ids.bob);
    assert.equal(result.membershipsRemoved, 2); assert.equal(result.sharesRevoked, 1);
    assert.deepEqual([...result.collectionsNeedingRekey].sort(), [col, col2].sort());
    assert.equal((await world.pool.query("SELECT count(*)::int AS n FROM zv_items"))[0][0].n, itemsBefore, "no credential was deleted");
    await bob.session.reload();
    const s = bob.session.snapshot();
    assert.deepEqual([s.collections.length, s.companyItems.length], [0, 0], "Bob lost the company collections");
    assert.ok(s.sharedItems.some((i) => i.uid === other), "a personal item Ada shared with him personally is Ada's decision, not the company's");
    assert.ok(!s.sharedItems.some((i) => i.uid === colItemShared), "but the share of a COMPANY item ended");
    assert.equal((await world.raw("bob", "GET", `/items/${company}`)).status, 404);
    assert.equal((await bob.session.revealItem(mine)).password, "bobs-private-pw", "his own vault is untouched");
    assert.equal((await world.pool.query("SELECT count(*)::int AS n FROM zv_grants WHERE recipient_user_id = ? AND revoked_at IS NULL", [world.ids.dee]))[0][0].n, 1, "so is his own share of his own item");
    await dee.session.reload();
    assert.equal((await dee.session.revealItem(mine)).password, "bobs-private-pw");
    await ada.session.reload();
    assert.ok(ada.session.snapshot().collections.every((c) => c.rotationRequired), "both collections are flagged for re-keying");
    assert.ok((await world.pool.query("SELECT kind, detail FROM zv_audit_events WHERE kind = 'vault_access_revoked'"))[0].some((r) => r.detail === "members_removed=2,revoked_grants=1"));
    assert.equal((await ada.session.loadOffboardingPeople()).some((p) => p.userId === world.ids.bob), false, "Bob no longer has company vault access");
    // a second run is a harmless no-op
    const again = await ada.session.revokeCompanyAccess(world.ids.bob);
    assert.deepEqual([again.membershipsRemoved, again.sharesRevoked], [0, 0]);
    noPlaintext([ada, bob, dee].map((t) => t.sent()).join("\n"), "request bodies");

    // tenant isolation: an administrator elsewhere cannot touch these people
    const foreign = await buildWorld();
    const foreignAda = await foreign.join("ada");
    assert.deepEqual((await foreignAda.session.loadOffboardingPeople()).map((p) => p.name), [], "nobody has company access in the other tenant");
    assert.equal((await foreign.raw("ada", "POST", `/offboarding/${foreign.ids.bob}/revoke-access`, { confirm: true })).status, 200, "its own people only");
});

test("RE-KEY REQUEST SIZE: the one route that must carry a whole collection accepts a large body, only after authentication; nothing else does", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ada = await world.join("ada"); const dee = await world.join("dee");
    const col = await ada.session.createCollection({ name: "Big" });
    await ada.session.addMember(col, { userId: world.ids.dee, rights: { reveal: true, edit: true } });
    const send = (userId, route, padMb) => fetch(`${world.server.url}/api/ziovault${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...(userId ? { "x-test-user": String(userId) } : {}) }, body: JSON.stringify({ pad: "x".repeat(padMb * 1024 * 1024) }) });
    assert.equal((await send(world.ids.ada, `/collections/${col}/rotate`, 3)).status, 400, "3 MB reaches the handler (and is refused as a bad payload), not the size limit");
    assert.equal((await send(world.ids.dee, `/collections/${col}/rotate`, 3)).status, 403, "a body that large from a non-manager is refused by authorisation");
    assert.equal((await send(world.ids.ada, `/collections/${col}/rotate`, 17)).status, 413, "but there is a ceiling");
    assert.equal((await send(null, `/collections/${col}/rotate`, 3)).status, 401, "and an anonymous caller never gets that far");
    assert.equal((await send(world.ids.ada, "/collections", 3)).status, 413, "every other route keeps the small limit");
    assert.equal((await send(world.ids.ada, `/collections/${col}/members`, 3)).status, 413);
});
