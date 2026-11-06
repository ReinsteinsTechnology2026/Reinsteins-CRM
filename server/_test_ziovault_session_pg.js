// ZioVault Stage 3 -- the REAL client session (client/src/vault/vaultSession.js, vaultApi.js and the Stage 1 crypto) driven against the
// REAL Express router and a REAL PostgreSQL database. This is the UI's whole data path: everything a screen does goes through these calls.
//
// Proves: only ciphertext ever leaves the session (every request body is recorded and scanned), the database holds no plaintext, no
// secret reaches a log or browser storage, unlock/lock/auto-lock/multi-tab/session-expiry behave, items and folders round-trip,
// search is local, damaged ciphertext is contained, password health works and audit evidence is written.
//
// Needs the disposable PostgreSQL (PG_TEST_* variables); otherwise skipped (CI: migration-postgres job, PG_TEST_REQUIRED=1).
// Run: node --test _test_ziovault_session_pg.js

process.env.JWT_SECRET = process.env.JWT_SECRET || "legacy-secret-for-tests";
process.env.TENANT_JWT_SECRET = process.env.TENANT_JWT_SECRET || "tenant-secret-for-tests";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { createLab, loadCrypto } = require("./_ziovault_test_support");

const lab = createLab();
const SKIP = lab.skip;
const FAST = { alg: "argon2id13", ops: 2, mem: 32 * 1024 * 1024 };
const MASTER = "correct horse battery staple lantern";
const VAULT_DIR = path.join(__dirname, "..", "client", "src", "vault");
const load = (name) => import(pathToFileURL(path.join(VAULT_DIR, name)).href);

const MARK = {
    password: "Tr0ub4dor&3-PW-MARKER-91c2",
    title: "Production AWS root TITLE-MARKER-5d1e",
    username: "svc-deploy@acme.test USER-MARKER-77aa",
    url: "https://console.aws.example/signin",
    notes: "recovery codes: 4411-9922 NOTE-MARKER-c3f0",
    hidden: "HIDDEN-FIELD-MARKER-8b3d",
    visible: "VISIBLE-FIELD-MARKER-1f4e",
    folder: "Folder Name FOLDER-MARKER-2a9c",
};

let vault;
let api;
let sessionModule;
let apiModule;
const logged = [];
const realConsole = { log: console.log, error: console.error, info: console.info, warn: console.warn };
let tenantCounter = 400;

test.before(async () => {
    for (const level of ["log", "error", "info", "warn"]) console[level] = (...args) => { logged.push(args.map(String).join(" ")); };
    if (SKIP) return;
    await lab.connect();
    vault = await load("crypto/index.js");
    sessionModule = await load("vaultSession.js");
    apiModule = await load("vaultApi.js");
    void loadCrypto;
});
test.after(async () => {
    Object.assign(console, realConsole);
    await lab.close();
});

// ------------------------------------------------------------------------------------------------ harness
const memoryStorage = () => {
    const map = new Map();
    return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
};

// An axios-like stand-in that talks to the real server and records every request body and response body.
function makeHttp(url, userId, record, hooks = {}) {
    const call = async (method, route, body) => {
        if (hooks.fail) { const failure = hooks.fail(method, route); if (failure) throw failure; }
        const text = body === undefined ? undefined : JSON.stringify(body);
        record.requests.push({ method, route, body: text || "" });
        const res = await fetch(`${url}/api${route}`, { method: method.toUpperCase(), headers: { "Content-Type": "application/json", "x-test-user": String(userId) }, body: text });
        const raw = await res.text();
        record.responses.push(raw);
        let data = {};
        try { data = JSON.parse(raw); } catch { data = {}; }
        if (!res.ok) throw { response: { status: res.status, data } };
        return { data };
    };
    return { get: (p) => call("get", p), post: (p, b) => call("post", p, b), patch: (p, b) => call("patch", p, b), put: (p, b) => call("put", p, b), delete: (p) => call("delete", p) };
}

// controllable clock + timers, to test auto-lock without waiting
function makeClock() {
    const clock = { time: 1_800_000_000_000, timers: new Map(), seq: 0 };
    clock.now = () => clock.time;
    clock.setTimer = (fn, ms) => { if (ms < 1000) return setTimeout(fn, ms); clock.seq += 1; clock.timers.set(clock.seq, { fn, at: clock.time + ms }); return clock.seq; };
    clock.clearTimer = (id) => { if (typeof id === 'object') clearTimeout(id); else clock.timers.delete(id); };
    clock.advance = async (ms) => {
        clock.time += ms;
        for (const [id, t] of [...clock.timers]) if (t.at <= clock.time) { clock.timers.delete(id); await t.fn(); }
    };
    return clock;
}

function makeChannelPair() {
    const handlers = [];
    const make = () => ({ posted: [], post(message) { for (const h of handlers) if (h.owner !== this) h.fn(JSON.parse(JSON.stringify(message))); this.posted.push(message); }, onMessage(fn) { handlers.push({ owner: this, fn }); }, close() {} });
    return [make(), make()];
}

async function buildWorld() {
    const tenantId = ++tenantCounter;
    const pool = await lab.tenantDatabase();
    const server = await lab.startApi(pool, { tenantId });
    const userId = await lab.addUser(pool, "Alice");
    const otherId = await lab.addUser(pool, "Bob");
    return { tenantId, pool, server, userId, otherId };
}

async function newSession(world, { userId = world.userId, clock = makeClock(), prefs, channel = null, hooks, storage = memoryStorage(), drafts = memoryStorage() } = {}) {
    const record = { requests: [], responses: [] };
    const http = makeHttp(world.server.url, userId, record, hooks);
    const prefsBox = { value: prefs || {} };
    const session = sessionModule.createVaultSession({
        api: apiModule.createVaultApi(http), vault, kdf: FAST, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
        getIdentity: async () => ({ tenantId: world.tenantId, userId }),
        prefsStore: { load: () => prefsBox.value, save: (p) => { prefsBox.value = p; storage.setItem("ziovault:prefs", JSON.stringify(p)); } },
        draftStorage: drafts, channel,
    });
    return { session, record, clock, storage, drafts, prefsBox };
}

async function setupAndUnlock(world, options) {
    const ctx = await newSession(world, options);
    await ctx.session.init();
    assert.equal(ctx.session.snapshot().status, "no-account");
    await ctx.session.setup(MASTER, MASTER);
    assert.equal(ctx.session.snapshot().status, "setup-recovery");
    const recovery = ctx.session.snapshot().recoverySecret;
    await ctx.session.confirmRecovery(recovery);
    assert.equal(ctx.session.snapshot().status, "unlocked", ctx.session.snapshot().error);
    ctx.recovery = recovery;
    return ctx;
}

const draftOf = (extra = {}) => ({
    kind: "login", title: MARK.title, url: MARK.url, username: MARK.username, password: MARK.password, notes: MARK.notes, folderUid: null, favorite: false, rotationIntervalDays: null,
    fields: [{ label: "Region", value: MARK.visible, hidden: false }, { label: "PIN", value: MARK.hidden, hidden: true }], ...extra,
});

const everythingSent = (ctx) => ctx.record.requests.map((r) => r.body).join("\n");
const everythingReceived = (ctx) => ctx.record.responses.join("\n");
const dbDump = async (pool) => {
    const out = [];
    for (const table of ["zv_accounts", "zv_account_history", "zv_folders", "zv_items", "zv_item_keys", "zv_audit_events"]) {
        const [rows] = await pool.query(`SELECT * FROM ${table}`);
        out.push(JSON.stringify(rows, (_k, v) => (v && v.type === "Buffer" ? Buffer.from(v.data).toString("latin1") : v)));
        for (const row of rows) for (const value of Object.values(row)) if (Buffer.isBuffer(value)) out.push(value.toString("latin1"), value.toString("utf8"), value.toString("hex"));
    }
    return out.join("\n");
};
const assertNoMarkers = (text, label, extra = []) => {
    for (const needle of [...Object.values(MARK), MASTER, "correct horse", ...extra]) assert.ok(!text.includes(needle), `${label} contains plaintext: ${needle}`);
};

// ------------------------------------------------------------------------------------------------ tests
test("setup -> recovery key -> unlocked: only ciphertext and envelopes are sent; the master password and recovery key never are", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ctx = await setupAndUnlock(world);
    const sent = everythingSent(ctx);
    assertNoMarkers(sent, "request bodies", [ctx.recovery, ctx.recovery.replace(/-/g, "")]);
    assert.ok(/vaultKeyEnvelope/.test(sent) && /recoveryEnvelope/.test(sent), "the account material was sent (as envelopes)");
    assert.ok(!/"password"\s*:/.test(sent), "no field called password is ever sent");
    const [accounts] = await world.pool.query("SELECT recovery_confirmed_at FROM zv_accounts");
    assert.equal(accounts.length, 1);
    assert.ok(accounts[0].recovery_confirmed_at, "recovery confirmation recorded");
    assertNoMarkers(await dbDump(world.pool), "database", [ctx.recovery]);
});

test("setup refuses weak or mismatched master passwords, and the recovery key must be typed back correctly", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ctx = await newSession(world);
    await ctx.session.init();
    await ctx.session.setup("short", "short");
    assert.match(ctx.session.snapshot().error, /./); assert.equal(ctx.session.snapshot().status, "no-account");
    await ctx.session.setup("password1234", "password1234");
    assert.match(ctx.session.snapshot().error, /easy to guess/);
    await ctx.session.setup(MASTER, MASTER + "x");
    assert.match(ctx.session.snapshot().error, /do not match/);
    assert.equal(ctx.record.requests.filter((r) => r.method === "post").length, 0, "nothing was sent for refused passwords");
    await ctx.session.setup(MASTER, MASTER);
    assert.equal(ctx.session.snapshot().status, "setup-recovery");
    await ctx.session.confirmRecovery("AAAA-AAAA-AAAA-AAAA");
    assert.equal(ctx.session.snapshot().status, "setup-recovery");
    assert.ok(ctx.session.snapshot().error);
    const wrong = ctx.session.snapshot().recoverySecret.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    await ctx.session.confirmRecovery(wrong);
    assert.equal(ctx.session.snapshot().status, "setup-recovery");
});

test("lock wipes decrypted state; unlock needs the right password; repeated failures back off locally", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ctx = await setupAndUnlock(world);
    await ctx.session.createItem(draftOf());
    assert.equal(ctx.session.snapshot().items.length, 1);
    await ctx.session.lock("manual");
    let s = ctx.session.snapshot();
    assert.equal(s.status, "locked"); assert.equal(s.items.length, 0); assert.equal(s.folders.length, 0); assert.equal(s.lockReason, "manual");
    assert.equal(ctx.session.isUnlocked, false);
    assertNoMarkers(JSON.stringify(s), "snapshot after lock");
    await assert.rejects(ctx.session.createItem(draftOf()), (e) => e.code === "LOCKED");
    await assert.rejects(ctx.session.revealItem("00000000-0000-4000-8000-000000000000"), (e) => e.code === "LOCKED");

    for (let i = 0; i < 3; i += 1) { await ctx.session.unlock("wrong password " + i); s = ctx.session.snapshot(); assert.equal(s.error, "Incorrect master password."); assert.equal(s.status, "locked"); }
    const before = ctx.record.requests.length;
    await ctx.session.unlock(MASTER); // inside the back-off window: refused locally even though the password is right
    s = ctx.session.snapshot();
    assert.match(s.error, /Too many incorrect attempts/);
    assert.equal(ctx.record.requests.length, before, "no request is made while backed off");
    await ctx.clock.advance(60_000);
    await ctx.session.unlock(MASTER);
    s = ctx.session.snapshot();
    assert.equal(s.status, "unlocked", s.error);
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0].title, MARK.title);
});

test("create, view, reveal, edit, favorite, delete and restore round-trip; the server and database see only ciphertext", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ctx = await setupAndUnlock(world);
    const uid = await ctx.session.createItem(draftOf({ favorite: true }));
    let s = ctx.session.snapshot();
    assert.equal(s.items.length, 1);
    const view = s.items[0];
    assert.equal(view.title, MARK.title); assert.equal(view.username, MARK.username); assert.equal(view.favorite, true);
    assert.deepEqual(view.fields, [{ label: "Region", value: MARK.visible }]);
    assert.ok(!JSON.stringify(s).includes(MARK.password), "the list state never holds a password");
    assert.ok(!JSON.stringify(s).includes(MARK.hidden) && !JSON.stringify(s).includes(MARK.notes));

    const secret = await ctx.session.revealItem(uid);
    assert.equal(secret.password, MARK.password); assert.equal(secret.notes, MARK.notes); assert.deepEqual(secret.hidden, [{ label: "PIN", value: MARK.hidden }]);

    const loaded = await ctx.session.loadForEditing(uid);
    assert.equal(loaded.draft.password, MARK.password); assert.equal(loaded.draft.fields.length, 2);
    await ctx.session.updateItem(uid, { ...loaded.draft, title: "Renamed", password: "N3w-Pass-Phrase-77!" }, loaded.version);
    s = ctx.session.snapshot();
    assert.equal(s.items[0].title, "Renamed");
    assert.equal((await ctx.session.revealItem(uid)).password, "N3w-Pass-Phrase-77!");
    await assert.rejects(ctx.session.updateItem(uid, loaded.draft, loaded.version), (e) => e.code === "STALE_VERSION" || e.status === 409);

    await ctx.session.setFavorite(uid, false);
    assert.equal(ctx.session.snapshot().items[0].favorite, false);

    await ctx.session.deleteItem(uid);
    s = ctx.session.snapshot();
    assert.equal(s.items.length, 0); assert.equal(s.trash.length, 1); assert.ok(s.trash[0].deletedAt);
    await ctx.session.restoreItem(uid);
    s = ctx.session.snapshot();
    assert.equal(s.items.length, 1); assert.equal(s.trash.length, 0);

    assertNoMarkers(everythingSent(ctx), "request bodies", ["N3w-Pass-Phrase-77!", "Renamed"]);
    assertNoMarkers(everythingReceived(ctx).replace(/"secret":"[^"]*"/g, ""), "responses", ["N3w-Pass-Phrase-77!"]);
    assertNoMarkers(await dbDump(world.pool), "database", ["N3w-Pass-Phrase-77!", "Renamed"]);
    const [events] = await world.pool.query("SELECT kind FROM zv_audit_events ORDER BY id");
    const kinds = events.map((e) => e.kind);
    for (const kind of ["item_created", "item_updated", "secret_delivered", "reveal_reported", "item_deleted", "item_restored"]) assert.ok(kinds.includes(kind), `audit has ${kind}`);
    assertNoMarkers(JSON.stringify(events), "audit events");
});

test("secure notes and API keys, validation errors stay readable, nothing is sent for an invalid item", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ctx = await setupAndUnlock(world);
    const sentBefore = ctx.record.requests.length;
    await assert.rejects(ctx.session.createItem({ ...draftOf(), title: "" }), (e) => e.name === "InvalidItemError");
    await assert.rejects(ctx.session.createItem({ kind: "secure_note", title: "Empty note", notes: "", fields: [], folderUid: null, favorite: false }), (e) => e.name === "InvalidItemError");
    assert.equal(ctx.record.requests.length, sentBefore, "nothing sent");
    const note = await ctx.session.createItem({ kind: "secure_note", title: "Wifi", url: "", username: "", password: "", notes: MARK.notes, fields: [], folderUid: null, favorite: false });
    const key = await ctx.session.createItem({ kind: "api_key", title: "Stripe", url: "", username: "", password: "sk_live_API-KEY-MARKER-0042", notes: "", fields: [], folderUid: null, favorite: false });
    const items = ctx.session.snapshot().items;
    assert.deepEqual(items.map((i) => i.kind).sort(), ["api_key", "secure_note"]);
    assert.equal((await ctx.session.revealItem(note)).notes, MARK.notes);
    assert.equal((await ctx.session.revealItem(key)).password, "sk_live_API-KEY-MARKER-0042");
    assertNoMarkers(everythingSent(ctx), "request bodies", ["sk_live_API-KEY-MARKER-0042"]);
});

test("folders: encrypted names, move items without touching secrets, delete a folder keeps its items", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ctx = await setupAndUnlock(world);
    const folderUid = await ctx.session.createFolder(MARK.folder);
    assert.deepEqual(ctx.session.snapshot().folders.map((f) => f.name), [MARK.folder]);
    const uid = await ctx.session.createItem(draftOf());
    const secretsBefore = ctx.record.requests.filter((r) => /\/secret$/.test(r.route)).length;
    await ctx.session.moveToFolder(uid, folderUid);
    assert.equal(ctx.session.snapshot().items[0].folderUid, folderUid);
    assert.equal(ctx.record.requests.filter((r) => /\/secret$/.test(r.route)).length, secretsBefore, "moving an item does not fetch its secret");
    assert.equal((await ctx.session.revealItem(uid)).password, MARK.password, "the secret is intact after the move");

    await ctx.session.renameFolder(folderUid, "Renamed folder");
    assert.equal(ctx.session.snapshot().folders[0].name, "Renamed folder");
    const [rows] = await world.pool.query("SELECT * FROM zv_folders");
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes("Renamed") && !JSON.stringify(rows).includes("FOLDER-MARKER"));
    await assert.rejects(ctx.session.createFolder("   "), (e) => e.name === "VaultUserError");

    await ctx.session.deleteFolder(folderUid);
    const s = ctx.session.snapshot();
    assert.equal(s.folders.length, 0); assert.equal(s.items.length, 1, "the item survives its folder");
    assert.equal(s.items[0].folderUid, folderUid, "the stale reference is harmless: the UI shows it as no folder");
    assertNoMarkers(everythingSent(ctx), "request bodies", ["Renamed folder"]);
});

test("folders are private: another user sees neither the folders nor the items", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const alice = await setupAndUnlock(world);
    await alice.session.createFolder("Alice only");
    await alice.session.createItem(draftOf());
    const bob = await newSession(world, { userId: world.otherId });
    await bob.session.init();
    await bob.session.setup(MASTER + " bob", MASTER + " bob");
    await bob.session.confirmRecovery(bob.session.snapshot().recoverySecret);
    assert.equal(bob.session.snapshot().items.length, 0); assert.equal(bob.session.snapshot().folders.length, 0);
    const res = await fetch(`${world.server.url}/api/ziovault/folders`, { headers: { "x-test-user": String(world.otherId) } });
    assert.deepEqual((await res.json()).data, []);
    const ids = (await world.pool.query("SELECT uid FROM zv_folders"))[0];
    const del = await fetch(`${world.server.url}/api/ziovault/folders/${ids[0].uid}`, { method: "DELETE", headers: { "x-test-user": String(world.otherId) } });
    assert.equal(del.status, 404, "someone else's folder looks like it does not exist");
    assert.equal((await world.pool.query("SELECT 1 FROM zv_folders"))[0].length, 1);
});

test("search is local: matches decrypted details only, never the password or notes, and sends nothing", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ctx = await setupAndUnlock(world);
    const { matchesQuery } = await load("itemModel.js");
    await ctx.session.createItem(draftOf());
    await ctx.session.createItem(draftOf({ title: "Other thing", username: "zed", fields: [] }));
    const { items } = ctx.session.snapshot();
    const before = ctx.record.requests.length;
    const hits = (q) => items.filter((i) => matchesQuery(i, q)).length;
    assert.equal(hits("aws"), 2); assert.equal(hits("AWS root"), 1); assert.equal(hits("svc-deploy"), 1); assert.equal(hits("zed"), 1); assert.equal(hits("console.aws"), 2);
    assert.equal(hits(MARK.visible), 1);
    assert.equal(hits("Tr0ub4dor"), 0, "passwords are not searchable"); assert.equal(hits("recovery codes"), 0); assert.equal(hits(MARK.hidden), 0);
    assert.equal(ctx.record.requests.length, before, "searching makes no request");
});

test("damaged ciphertext is contained: the list survives, the item is marked unreadable, reveal fails safely", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ctx = await setupAndUnlock(world);
    const good = await ctx.session.createItem(draftOf({ title: "Good item" }));
    const bad = await ctx.session.createItem(draftOf({ title: "Will be damaged" }));
    await world.pool.query("UPDATE zv_items SET meta_ciphertext = set_byte(meta_ciphertext, 30, get_byte(meta_ciphertext, 30) # 255) WHERE uid = ?", [bad]);
    const views = await ctx.session.reload();
    assert.equal(views.find((v) => v.uid === good).title, "Good item");
    const broken = views.find((v) => v.uid === bad);
    assert.equal(broken.corrupt, true); assert.equal(broken.title, "Unreadable item");
    await ctx.session.lock("manual"); await ctx.session.unlock(MASTER); // forget the secrets cached from creation
    await world.pool.query("UPDATE zv_items SET secret_ciphertext = set_byte(secret_ciphertext, 30, get_byte(secret_ciphertext, 30) # 255) WHERE uid = ?", [good]);
    await assert.rejects(ctx.session.revealItem(good), (e) => e.name === "VaultCryptoError");
    assert.ok(!ctx.session.describe(new Error("boom")).includes("boom"), "unknown errors are never shown raw");
    assert.equal(ctx.session.isUnlocked, true, "damage does not lock or break the session");
});

test("password health: finds weak, reused and old passwords from the real vault, locally, with audit evidence", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ctx = await setupAndUnlock(world);
    const strong = "Xk4$mP9#vL2@qW8zR5!t";
    const a = await ctx.session.createItem(draftOf({ title: "Bank", url: "", username: "a", password: strong, fields: [], notes: "" }));
    const b = await ctx.session.createItem(draftOf({ title: "Forum", url: "", username: "a", password: strong, fields: [], notes: "" }));
    const c = await ctx.session.createItem(draftOf({ title: "Shop", url: "", username: "a", password: "password123", fields: [], notes: "" }));
    await ctx.session.createItem({ kind: "secure_note", title: "Note", url: "", username: "", password: "", notes: "n", fields: [], folderUid: null, favorite: false });
    await world.pool.query("UPDATE zv_items SET last_rotated_at = now() - interval '400 days' WHERE uid = ?", [c]);
    await ctx.session.lock("manual"); await ctx.session.unlock(MASTER); // forget the secrets cached from creation
    const report = await ctx.session.runHealth();
    assert.equal(report.summary.total, 3);
    assert.deepEqual(report.findings.weak.map((f) => f.uid), [c]);
    assert.deepEqual(report.findings.reused[0].items.map((i) => i.uid).sort(), [a, b].sort());
    assert.deepEqual(report.findings.old.map((f) => f.uid), [c]);
    assert.ok(!JSON.stringify(report).includes(strong) && !JSON.stringify(report).includes("password123"));
    assert.ok(!JSON.stringify(ctx.session.snapshot()).includes(strong), "no password in the state");
    const [events] = await world.pool.query("SELECT kind FROM zv_audit_events WHERE kind = 'secret_delivered'");
    assert.equal(events.length, 3, "each scanned secret is an audited delivery");
    assertNoMarkers(everythingSent(ctx), "request bodies", [strong, "password123"]);
    ctx.session.snapshot().health.report && await ctx.session.lock("manual");
    assert.equal(ctx.session.snapshot().health, null, "the report is dropped on lock");
});

test("auto-lock after inactivity, activity postpones it, and lock clears the clipboard-free state; preferences are numbers only", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ctx = await setupAndUnlock(world);
    ctx.session.setPrefs({ autoLockMinutes: 1 });
    await ctx.clock.advance(50_000);
    ctx.session.touch();
    await ctx.clock.advance(50_000);
    assert.equal(ctx.session.snapshot().status, "unlocked", "activity postponed the lock");
    await ctx.clock.advance(70_000);
    assert.equal(ctx.session.snapshot().status, "locked");
    assert.equal(ctx.session.snapshot().lockReason, "inactivity");
    assert.equal(ctx.session.isUnlocked, false);
    assert.deepEqual(JSON.parse(ctx.storage.getItem("ziovault:prefs")), { autoLockMinutes: 1, clipboardClearSeconds: 30, oldPasswordDays: 180, rotationWarnDays: 14 });
    ctx.session.setPrefs({ autoLockMinutes: 99999, clipboardClearSeconds: "x", evil: "<script>" });
    assert.deepEqual(ctx.session.snapshot().prefs, { autoLockMinutes: 1, clipboardClearSeconds: 30, oldPasswordDays: 180, rotationWarnDays: 14 }, "invalid values are ignored");
});

test("an edit in progress survives a lock as ciphertext only, and is offered again after unlock", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const drafts = memoryStorage();
    const ctx = await setupAndUnlock(world, { drafts });
    ctx.session.setDraftProvider(() => ({ ...draftOf({ title: "Half written" }), uid: null }));
    await ctx.session.lock("inactivity");
    assert.equal(ctx.session.snapshot().draftAvailable, true);
    assert.equal(drafts.map.size, 1);
    const stored = [...drafts.map.values()][0];
    assertNoMarkers(stored + [...drafts.map.keys()].join(), "stored draft");
    assert.ok(!Buffer.from(stored, "base64url").toString("latin1").includes("Half written"));
    await ctx.session.unlock(MASTER);
    const restored = await ctx.session.restoreDraft();
    assert.equal(restored.title, "Half written"); assert.equal(restored.password, MARK.password);
    assert.equal(drafts.map.size, 0, "a draft is restored once and removed");
    assert.equal(await ctx.session.restoreDraft(), null);
    // a draft sealed for one vault is rejected by another person's session
    ctx.session.setDraftProvider(() => ({ title: "x" }));
    await ctx.session.lock("manual");
    const foreign = new Map(drafts.map);
    drafts.setItem(`ziovault:draft:${world.tenantId}:${world.userId}`, "AAAA" + [...drafts.map.values()][0]);
    await ctx.session.unlock(MASTER);
    assert.equal(await ctx.session.restoreDraft(), null, "damaged draft is dropped");
    void foreign;
});

test("multi-tab: locking one tab locks the others of the same person only; a password change locks other tabs", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const [chA, chB] = makeChannelPair();
    const a = await setupAndUnlock(world, { channel: chA });
    const b = await newSession(world, { channel: chB });
    await b.session.init();
    await b.session.unlock(MASTER);
    assert.equal(b.session.snapshot().status, "unlocked");
    await a.session.lock("manual");
    assert.equal(b.session.snapshot().status, "locked");
    assert.equal(b.session.snapshot().lockReason, "other-tab");
    assert.equal(b.session.isUnlocked, false);

    await a.session.unlock(MASTER); await b.session.unlock(MASTER);
    const NEW = "another long passphrase of words, ocean";
    assert.equal(await a.session.changePassword(MASTER, NEW, NEW), true, a.session.snapshot().error);
    assert.equal(b.session.snapshot().status, "locked");
    assert.equal(b.session.snapshot().lockReason, "password-changed");
    await b.session.unlock(MASTER);
    assert.equal(b.session.snapshot().error, "Incorrect master password.");
    await b.session.lock("manual"); // reset back-off by waiting
    await b.clock.advance(60_000);
    await b.session.unlock(NEW);
    assert.equal(b.session.snapshot().status, "unlocked");

    // a message for a different person's scope is ignored
    const [x, y] = makeChannelPair();
    const mine = await setupAndUnlock(await buildWorld(), { channel: x });
    y.post({ type: "lock", reason: "manual", scope: "999:999" });
    assert.equal(mine.session.snapshot().status, "unlocked");
});

test("session expiry: a 401 from the server locks the vault at once and wipes everything", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const state = { expired: false };
    const ctx = await setupAndUnlock(world, { hooks: { fail: () => (state.expired ? { response: { status: 401, data: { message: "expired" } } } : null) } });
    await ctx.session.createItem(draftOf());
    state.expired = true;
    await assert.rejects(ctx.session.reload(), (e) => e.code === "SESSION_EXPIRED");
    const s = ctx.session.snapshot();
    assert.equal(s.status, "locked"); assert.equal(s.lockReason, "expired"); assert.equal(s.items.length, 0);
    assert.equal(ctx.session.isUnlocked, false);
    state.expired = false;
    await ctx.session.unlock(MASTER);
    assert.equal(ctx.session.snapshot().status, "unlocked");
});

test("CRM sign-out underneath the vault locks it (auth watcher)", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ctx = await setupAndUnlock(world);
    let fingerprint = "token-A";
    let tick = null;
    const stop = ctx.session.watchAuth(() => fingerprint, 10, { setIntervalFn: (fn) => { tick = fn; return 1; }, clearIntervalFn: () => {} });
    tick();
    assert.equal(ctx.session.snapshot().status, "unlocked");
    fingerprint = "";
    tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.session.snapshot().status, "locked");
    assert.equal(ctx.session.snapshot().lockReason, "logout");
    stop();
});

test("recovery: the recovery key opens a vault whose master password was forgotten, and sets a new one", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ctx = await setupAndUnlock(world);
    const uid = await ctx.session.createItem(draftOf());
    await ctx.session.lock("manual");
    const NEW = "brand new passphrase with several words";
    assert.equal(await ctx.session.recover("AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA", NEW, NEW), false);
    assert.match(ctx.session.snapshot().error, /recovery key/i);
    assert.equal(await ctx.session.recover(ctx.recovery, NEW, NEW), true, ctx.session.snapshot().error);
    assert.equal(ctx.session.snapshot().status, "unlocked");
    assert.equal((await ctx.session.revealItem(uid)).password, MARK.password, "data is intact after recovery");
    await ctx.session.lock("manual");
    await ctx.session.unlock(MASTER);
    assert.equal(ctx.session.snapshot().error, "Incorrect master password.", "the old master password no longer works");
    assertNoMarkers(everythingSent(ctx), "request bodies", [ctx.recovery, NEW]);
});

test("no secret reaches logs or browser storage during the whole flow", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const storage = memoryStorage();
    const drafts = memoryStorage();
    const ctx = await setupAndUnlock(world, { storage, drafts });
    ctx.session.setDraftProvider(() => draftOf());
    const uid = await ctx.session.createItem(draftOf());
    await ctx.session.revealItem(uid);
    ctx.session.setPrefs({ autoLockMinutes: 15 });
    await ctx.session.lock("manual");
    await ctx.session.unlock("definitely wrong");
    const everything = [...storage.map.entries(), ...drafts.map.entries()].flat().join("\n") + logged.join("\n");
    assertNoMarkers(everything, "browser storage and logs", [ctx.recovery]);
    assert.deepEqual([...storage.map.keys()], ["ziovault:prefs"]);
});
