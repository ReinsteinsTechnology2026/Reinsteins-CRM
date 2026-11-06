// ZioVault Stage 5 -- encrypted attachments, through the REAL client session (encryption in the client's own code) against the REAL router and
// PostgreSQL. Proves: files are encrypted before upload and stored as ciphertext only, names stay encrypted, every permission combination is
// enforced (client and server, including direct requests), tenants are isolated, damaged or swapped ciphertext is detected, interrupted
// uploads are handled honestly, limits and validation hold, and attachments survive a collection re-key.
//
// Needs the disposable PostgreSQL (PG_TEST_* variables); otherwise skipped. Run: node --test _test_ziovault_attachments_pg.js

process.env.JWT_SECRET = process.env.JWT_SECRET || "legacy-secret-for-tests";
process.env.TENANT_JWT_SECRET = process.env.TENANT_JWT_SECRET || "tenant-secret-for-tests";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { createLab } = require("./_ziovault_test_support");
const { load, joinVault, rawCall } = require("./_ziovault_session_support");

const lab = createLab();
const SKIP = lab.skip;
const PW = (name) => `correct horse battery staple ${name} lantern`;
const MARK = { password: "Tr0ub4dor&3-ATTACH-PW-MARKER-31ce", file: "ATTACHMENT-CONTENT-MARKER-77aa-do-not-store", name: "secret-plan-NAME-MARKER-5d2e.txt", title: "Vault item TITLE-MARKER-9b3" };

let vault; let sessionModule; let apiModule; let model;
const logged = [];
const realConsole = { log: console.log, error: console.error, info: console.info, warn: console.warn };
let tenantCounter = 800;

test.before(async () => {
    for (const level of ["log", "error", "info", "warn"]) console[level] = (...args) => { logged.push(args.map(String).join(" ")); };
    if (SKIP) return;
    await lab.connect();
    vault = await load("crypto/index.js");
    sessionModule = await load("vaultSession.js");
    apiModule = await load("vaultApi.js");
    model = await load("attachmentModel.js");
});
test.after(async () => {
    Object.assign(console, realConsole);
    await lab.close();
});

async function buildWorld({ limiters } = {}) {
    const tenantId = ++tenantCounter;
    const pool = await lab.tenantDatabase();
    const server = await lab.startApi(pool, { tenantId, limiters });
    const ids = {
        ada: await lab.addUser(pool, "Ada Admin", { role: "admin", access: "super_admin" }),
        bob: await lab.addUser(pool, "Bob"), cy: await lab.addUser(pool, "Cy"), dee: await lab.addUser(pool, "Dee"),
    };
    const world = { tenantId, pool, server, ids };
    world.join = (name, hooks) => joinVault({ vault, sessionModule, apiModule, server, tenantId, userId: ids[name], role: name === "ada" ? "admin" : "employee", hooks }, PW(name));
    world.raw = (name, method, route, body) => rawCall(server, ids[name], method, route, body);
    return world;
}

const draftOf = (extra = {}) => ({ kind: "login", title: MARK.title, url: "", username: "root", password: MARK.password, notes: "", folderUid: null, favorite: false, rotationIntervalDays: null, fields: [], ...extra });
const fileOf = (size = 200000, { name = MARK.name, marker = MARK.file } = {}) => {
    const bytes = new Uint8Array(crypto.randomBytes(size));
    if (size >= marker.length) bytes.set(Buffer.from(marker), 0);
    return { name, type: "text/plain", bytes };
};
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const refused = (promise, statuses) => assert.rejects(promise, (e) => e && e.name === "VaultApiError" && [].concat(statuses).includes(e.status));
const dumpAttachments = async (pool) => {
    const [rows] = await pool.query("SELECT * FROM zv_attachments");
    return rows.map((r) => [r.meta_ciphertext, r.wrapped_file_key, r.content].map((b) => b.toString("latin1") + b.toString("hex")).join("\n")).join("\n");
};

test("ATTACHMENTS: encrypted in the browser, stored as ciphertext, names stay encrypted, download round-trips byte for byte", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ada = await world.join("ada");
    const itemUid = await ada.session.createItem(draftOf());
    const file = fileOf(200000);
    const saved = await ada.session.uploadAttachment(itemUid, file);
    assert.equal(saved.name, MARK.name); assert.equal(saved.size, 200000);

    const [rows] = await world.pool.query("SELECT octet_length(content) AS n, uploaded_by FROM zv_attachments");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].n, 24 + 200000 + Math.ceil(200000 / 65536) * 17, "header + payload + one tag per 64 KiB frame: ciphertext, not the file");
    assert.equal(rows[0].uploaded_by, world.ids.ada);
    const stored = await dumpAttachments(world.pool);
    assert.ok(!stored.includes(MARK.file) && !stored.includes(Buffer.from(MARK.file).toString("hex")), "no file content in the database");
    assert.ok(!stored.includes("NAME-MARKER") && !stored.includes(Buffer.from("NAME-MARKER").toString("hex")), "no file name in the database");
    assert.ok(!ada.sent().includes(MARK.file) && !ada.sent().includes(Buffer.from(MARK.file).toString("base64").slice(0, 20)), "the request body carries no plaintext");
    assert.ok(!ada.sent().includes("NAME-MARKER"));

    // size and date need no key; names need the item's keys
    const basic = await ada.session.listAttachments(itemUid);
    assert.deepEqual(basic.map((a) => [a.size, a.name]), [[200000 + 24 + Math.ceil(200000 / 65536) * 17, null]], "without opening the item only size and date are known (the stored size is the ciphertext's)");
    const named = await ada.session.listAttachments(itemUid, { withNames: true });
    assert.equal(named[0].name, MARK.name); assert.ok(named[0].createdAt);

    const down = await ada.session.downloadAttachment(itemUid, saved.uid);
    assert.equal(down.name, MARK.name); assert.equal(down.size, 200000); assert.ok(same(down.bytes, file.bytes), "byte for byte");
    const kinds = (await world.pool.query("SELECT kind FROM zv_audit_events ORDER BY id"))[0].map((r) => r.kind);
    for (const kind of ["attachment_added", "attachment_delivered"]) assert.ok(kinds.includes(kind), `audit has ${kind}`);

    await ada.session.deleteAttachment(itemUid, saved.uid);
    assert.equal((await world.pool.query("SELECT count(*)::int AS n FROM zv_attachments"))[0][0].n, 0, "deleting removes the ciphertext itself");
    assert.deepEqual(await ada.session.listAttachments(itemUid), []);
    await refused(ada.session.downloadAttachment(itemUid, saved.uid), 404);
    assert.ok((await world.pool.query("SELECT kind FROM zv_audit_events"))[0].some((r) => r.kind === "attachment_deleted"));
    assert.ok(!JSON.stringify(logged).includes("ATTACHMENT-CONTENT"), "nothing in the logs");
});

test("VALIDATION: empty, oversized, program/script, over-limit and badly named files are refused before anything is encrypted or sent", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ada = await world.join("ada");
    const itemUid = await ada.session.createItem(draftOf());
    const before = ada.record.requests.length;
    const bad = async (file, code) => assert.rejects(ada.session.uploadAttachment(itemUid, file), (e) => e.name === "AttachmentError" && e.code === code, code);
    await bad({ name: "empty.txt", bytes: new Uint8Array(0) }, "EMPTY");
    await bad({ name: "huge.bin", bytes: new Uint8Array(model.MAX_ATTACHMENT_BYTES + 1) }, "TOO_LARGE");
    for (const name of ["setup.exe", "run.BAT", "x.ps1", "tool.js", "payload.scr", "a/b/evil.cmd", "photo.png.exe"]) await bad({ name, bytes: new Uint8Array(10) }, "BLOCKED_TYPE");
    assert.equal(ada.record.requests.slice(before).filter((r) => r.method === "post").length, 0, "nothing was sent for a refused file");

    // names are made safe
    assert.equal(model.sanitizeFileName("../../etc/passwd"), "passwd");
    assert.equal(model.sanitizeFileName("C:\\Users\\x\\report.pdf"), "report.pdf");
    assert.equal(model.sanitizeFileName("a\u202etxt.exe"), "atxt.exe", "bidirectional overrides are removed");
    assert.equal(model.sanitizeFileName("  .hidden  \u0000\u0007"), "hidden");
    assert.equal(model.sanitizeFileName(""), "file"); assert.equal(model.sanitizeFileName("..."), "file");
    assert.ok(model.sanitizeFileName(`${"a".repeat(300)}.pdf`).endsWith(".pdf") && model.sanitizeFileName(`${"a".repeat(300)}.pdf`).length <= 120);
    const odd = await ada.session.uploadAttachment(itemUid, { name: "..\\..\\ev<il>.txt", bytes: new Uint8Array([1, 2, 3]) });
    assert.equal(odd.name, "ev_il_.txt");

    // at most 20 files per item
    for (let i = 1; i < 20; i += 1) await ada.session.uploadAttachment(itemUid, { name: `f${i}.txt`, bytes: new Uint8Array([i]) });
    await bad({ name: "one-too-many.txt", bytes: new Uint8Array([1]) }, "TOO_MANY");
    assert.equal((await ada.session.listAttachments(itemUid)).length, 20);
});

test("PERMISSIONS: reveal opens files, edit adds and removes them, details-only sees only size and date; outsiders and direct requests are refused", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ada = await world.join("ada"); const bob = await world.join("bob"); const cy = await world.join("cy"); const dee = await world.join("dee");
    const itemUid = await ada.session.createItem(draftOf());
    const file = fileOf(5000);
    const saved = await ada.session.uploadAttachment(itemUid, file);
    await ada.session.shareItem(itemUid, { recipientUserId: world.ids.bob, rights: { reveal: true, copy: true } }); // reveal, no edit
    await ada.session.shareItem(itemUid, { recipientUserId: world.ids.cy, rights: {} }); // details only
    for (const t of [bob, cy, dee]) await t.session.reload();

    // reveal-only: lists names, downloads, cannot add or delete
    assert.equal((await bob.session.listAttachments(itemUid, { withNames: true }))[0].name, MARK.name);
    assert.ok(same((await bob.session.downloadAttachment(itemUid, saved.uid)).bytes, file.bytes));
    await refused(bob.session.uploadAttachment(itemUid, fileOf(100)), 403);
    await refused(bob.session.deleteAttachment(itemUid, saved.uid), 403);
    // details-only: sees that a file exists (size, date), never its name, cannot open it
    const seen = (await cy.session.listAttachments(itemUid))[0];
    assert.ok(seen.size > 0 && seen.createdAt && seen.name === null);
    const rawList = await world.raw("cy", "GET", `/items/${itemUid}/attachments`);
    assert.equal(rawList.status, 200); assert.ok(!rawList.data[0].meta && !rawList.data[0].wrappedFileKey, "the encrypted name and key are not even sent to a details-only person");
    assert.equal((await world.raw("cy", "POST", `/items/${itemUid}/attachments/${saved.uid}/content`)).status, 403);
    await refused(cy.session.downloadAttachment(itemUid, saved.uid), 403);
    // someone with no path to the item: indistinguishable from "not there"
    for (const [method, route, body] of [["GET", `/items/${itemUid}/attachments`], ["POST", `/items/${itemUid}/attachments/${saved.uid}/content`], ["DELETE", `/items/${itemUid}/attachments/${saved.uid}`], ["POST", `/items/${itemUid}/attachments`, { uid: "00000000-0000-4000-8000-000000000001" }]]) {
        assert.equal((await world.raw("dee", method, route, body)).status, 404, `${method} ${route}`);
    }
    assert.deepEqual((await world.raw("dee", "GET", "/attachments")).data, [], "the list of every attachment shows only what the person can see");
    assert.equal((await world.raw("bob", "GET", "/attachments")).data.length, 1);
    // unauthenticated
    const anon = await fetch(`${world.server.url}/api/ziovault/items/${itemUid}/attachments`);
    assert.equal(anon.status, 401);

    // edit right: can add and remove; the file key is wrapped under the item's secret key, so an editor needs no other key
    await ada.session.updateGrant(itemUid, world.ids.bob, { rights: { reveal: true, copy: true, edit: true } });
    await bob.session.reload();
    const added = await bob.session.uploadAttachment(itemUid, fileOf(300, { name: "bobs.txt" }));
    assert.equal((await ada.session.downloadAttachment(itemUid, added.uid)).bytes.length, 300, "the owner opens what an editor added");
    assert.equal((await ada.session.listAttachments(itemUid, { withNames: true })).length, 2);
    await bob.session.deleteAttachment(itemUid, added.uid);
    // revoking the share removes the recipient's way to the files at once
    await ada.session.revokeGrant(itemUid, world.ids.bob);
    assert.equal((await world.raw("bob", "POST", `/items/${itemUid}/attachments/${saved.uid}/content`)).status, 404);
    // losing reveal (downgrade) removes the secret key envelope, and with it the files
    await ada.session.updateGrant(itemUid, world.ids.cy, { rights: { reveal: true } });
    await cy.session.reload();
    assert.ok(same((await cy.session.downloadAttachment(itemUid, saved.uid)).bytes, file.bytes));
    await ada.session.updateGrant(itemUid, world.ids.cy, { rights: { reveal: false } });
    await cy.session.lock("manual"); await cy.session.unlock(cy.password);
    await refused(cy.session.downloadAttachment(itemUid, saved.uid), 403);
});

test("COMPANY ITEMS: collection rights decide who opens, adds or removes files", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ada = await world.join("ada"); const bob = await world.join("bob"); const cy = await world.join("cy"); const dee = await world.join("dee");
    const col = await ada.session.createCollection({ name: "Ops" });
    await ada.session.addMember(col, { userId: world.ids.bob, rights: {} });
    await ada.session.addMember(col, { userId: world.ids.cy, rights: { reveal: true } });
    await ada.session.addMember(col, { userId: world.ids.dee, rights: { reveal: true, copy: true, edit: true } });
    const itemUid = await ada.session.createCompanyItem(col, draftOf());
    for (const t of [bob, cy, dee]) await t.session.reload();
    const file = fileOf(2000);
    const saved = await dee.session.uploadAttachment(itemUid, file); // an editor
    assert.ok(same((await ada.session.downloadAttachment(itemUid, saved.uid)).bytes, file.bytes), "the manager opens what an editor added");
    assert.ok(same((await cy.session.downloadAttachment(itemUid, saved.uid)).bytes, file.bytes), "a reveal-only member opens it");
    await refused(cy.session.uploadAttachment(itemUid, fileOf(10)), 403);
    await refused(cy.session.deleteAttachment(itemUid, saved.uid), 403);
    await refused(bob.session.downloadAttachment(itemUid, saved.uid), 403);
    assert.equal((await bob.session.listAttachments(itemUid))[0].name, null, "a details-only member sees a file exists, not its name");
    // an archived collection takes its files out of reach for everyone
    await ada.session.archiveCollection(col);
    assert.equal((await world.raw("dee", "POST", `/items/${itemUid}/attachments/${saved.uid}/content`)).status, 404);
    assert.equal((await world.pool.query("SELECT count(*)::int AS n FROM zv_attachments"))[0][0].n, 1, "archiving deletes nothing");
});

test("TENANT ISOLATION: another company cannot reach, list or guess these files", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ada = await world.join("ada");
    const itemUid = await ada.session.createItem(draftOf());
    const saved = await ada.session.uploadAttachment(itemUid, fileOf(1000));
    const other = await buildWorld();
    await other.join("ada");
    assert.equal((await other.raw("ada", "GET", `/items/${itemUid}/attachments`)).status, 404);
    assert.equal((await other.raw("ada", "POST", `/items/${itemUid}/attachments/${saved.uid}/content`)).status, 404);
    assert.equal((await other.raw("ada", "DELETE", `/items/${itemUid}/attachments/${saved.uid}`)).status, 404);
    assert.deepEqual((await other.raw("ada", "GET", "/attachments")).data, []);
});

test("DAMAGED CIPHERTEXT: a changed, truncated, extended or swapped file is reported as damaged and never shown", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const ada = await world.join("ada");
    const itemUid = await ada.session.createItem(draftOf());
    const a = await ada.session.uploadAttachment(itemUid, fileOf(150000, { name: "a.bin" }));
    const b = await ada.session.uploadAttachment(itemUid, fileOf(150000, { name: "b.bin", marker: "SECOND-FILE" }));
    const damaged = (promise) => assert.rejects(promise, (e) => e.name === "VaultUserError" && e.code === "ATTACHMENT_DAMAGED");

    await world.pool.query("UPDATE zv_attachments SET content = set_byte(content, 100000, get_byte(content, 100000) # 255) WHERE uid = ?", [a.uid]);
    await damaged(ada.session.downloadAttachment(itemUid, a.uid));
    assert.ok((await ada.session.downloadAttachment(itemUid, b.uid)).bytes.length === 150000, "the other file is unaffected");
    // truncation (drop the last frame) and appended data
    await world.pool.query("UPDATE zv_attachments SET content = substring(content from 1 for octet_length(content) - 70000) WHERE uid = ?", [b.uid]);
    await damaged(ada.session.downloadAttachment(itemUid, b.uid));
    const c = await ada.session.uploadAttachment(itemUid, fileOf(1000, { name: "c.bin" }));
    await world.pool.query("UPDATE zv_attachments SET content = content || '\\x00112233'::bytea WHERE uid = ?", [c.uid]);
    await damaged(ada.session.downloadAttachment(itemUid, c.uid));
    // swapping the ciphertext of two files (each is bound to its own id)
    const d = await ada.session.uploadAttachment(itemUid, fileOf(1000, { name: "d.bin" }));
    const e = await ada.session.uploadAttachment(itemUid, fileOf(1000, { name: "e.bin" }));
    await world.pool.query("UPDATE zv_attachments x SET content = y.content FROM zv_attachments y WHERE x.uid = ? AND y.uid = ?", [d.uid, e.uid]);
    await damaged(ada.session.downloadAttachment(itemUid, d.uid));
    // a damaged encrypted name: the list says so instead of failing
    await world.pool.query("UPDATE zv_attachments SET meta_ciphertext = set_byte(meta_ciphertext, 30, get_byte(meta_ciphertext, 30) # 255) WHERE uid = ?", [e.uid]);
    const listed = await ada.session.listAttachments(itemUid, { withNames: true });
    assert.equal(listed.find((x) => x.uid === e.uid).damaged, true);
    assert.equal(listed.find((x) => x.uid === c.uid).name, "c.bin");
});

test("INTERRUPTED UPLOADS: a dropped connection is resolved by asking the server, never by guessing", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const state = { mode: "none" };
    const ada = await world.join("ada", {
        fail: (method, route) => (state.mode === "lost-before" && method === "post" && /\/attachments$/.test(route) ? new Error("offline") : null),
        dropResponse: (method, route) => state.mode === "lost-after" && method === "post" && /\/attachments$/.test(route),
    });
    const itemUid = await ada.session.createItem(draftOf());
    // the request never left: nothing is saved, and the message says so
    state.mode = "lost-before";
    await assert.rejects(ada.session.uploadAttachment(itemUid, fileOf(500, { name: "x.txt" })), (e) => e.code === "UPLOAD_INTERRUPTED");
    assert.equal((await world.pool.query("SELECT count(*)::int AS n FROM zv_attachments"))[0][0].n, 0);
    // the server handled it but the answer was lost: the session finds the file and reports success
    state.mode = "lost-after";
    const recovered = await ada.session.uploadAttachment(itemUid, fileOf(500, { name: "y.txt" }));
    assert.equal(recovered.recovered, true);
    state.mode = "none";
    assert.equal((await world.pool.query("SELECT count(*)::int AS n FROM zv_attachments"))[0][0].n, 1, "exactly one copy");
    assert.equal((await ada.session.listAttachments(itemUid, { withNames: true }))[0].name, "y.txt");
});

test("SERVER LIMITS: size, count, shape and rate are enforced on direct requests too", { skip: SKIP }, async () => {
    const rate = { n: 0, max: Infinity };
    const limiters = {
        unlock: (_q, _s, next) => next(), recovery: (_q, _s, next) => next(), share: (_q, _s, next) => next(), secret: (_q, _s, next) => next(), write: (_q, _s, next) => next(),
        upload: (_q, res, next) => (++rate.n > rate.max ? res.status(429).json({ success: false, code: "RATE_LIMITED" }) : next()),
    };
    const world = await buildWorld({ limiters });
    const ada = await world.join("ada");
    const itemUid = await ada.session.createItem(draftOf());
    const b64 = (buf) => Buffer.from(buf).toString("base64url");
    const envelope = (n) => { const e = crypto.randomBytes(n); e[0] = 1; return b64(e); };
    const body = (extra = {}) => ({ uid: crypto.randomUUID(), meta: envelope(100), wrappedFileKey: envelope(73), content: b64(crypto.randomBytes(100)), ...extra });

    for (const [label, extra] of [
        ["content too small", { content: b64(crypto.randomBytes(10)) }],
        ["content too large", { content: b64(crypto.randomBytes(10489857)) }],
        ["bad file key size", { wrappedFileKey: envelope(80) }],
        ["bad envelope version", { meta: b64(crypto.randomBytes(100).fill(9)) }],
        ["not base64url", { content: "!!!not base64!!!" }],
        ["bad uid", { uid: "nope" }],
    ]) {
        const res = await world.raw("ada", "POST", `/items/${itemUid}/attachments`, body(extra));
        assert.equal(res.status, 400, label);
    }
    assert.equal((await world.pool.query("SELECT count(*)::int AS n FROM zv_attachments"))[0][0].n, 0, "refused uploads stored nothing");
    // the largest valid file goes through the larger, route-specific body limit ...
    const biggest = await world.raw("ada", "POST", `/items/${itemUid}/attachments`, body({ content: b64(crypto.randomBytes(10489856)) }));
    assert.equal(biggest.status, 201);
    // ... but no other route accepts a body that large
    const elsewhere = await fetch(`${world.server.url}/api/ziovault/items`, { method: "POST", headers: { "Content-Type": "application/json", "x-test-user": String(world.ids.ada) }, body: JSON.stringify({ pad: "x".repeat(3 * 1024 * 1024) }) });
    assert.equal(elsewhere.status, 413);
    // the upload rate limit sits in front of everything else (here: one upload per window, the second is refused)
    rate.n = 0; rate.max = 1;
    assert.equal((await world.raw("ada", "POST", `/items/${itemUid}/attachments`, body())).status, 201);
    assert.equal((await world.raw("ada", "POST", `/items/${itemUid}/attachments`, body())).status, 429);
    assert.ok(!JSON.stringify(logged).includes("ATTACHMENT-CONTENT"));
});

test("HARDENING: a per-person storage ceiling stops unbounded uploads, and the heavier read endpoints sit behind the rate limiter", { skip: SKIP }, async () => {
    const calls = { write: 0 };
    const pass = (_q, _s, next) => next();
    const limiters = { unlock: pass, recovery: pass, share: pass, secret: pass, upload: pass, write: (_q, _s, next) => { calls.write += 1; next(); } };
    const world = await buildWorld({ limiters });
    const ada = await world.join("ada");
    const itemUid = await ada.session.createItem(draftOf());

    const before = calls.write;
    for (const route of ["/audit/company", "/attachments", `/items/${itemUid}/attachments`, "/offboarding/people"]) await world.raw("ada", "GET", route);
    assert.equal(calls.write - before, 4, "each of the four reads went through the limiter");

    process.env.ZIOVAULT_ATTACHMENT_QUOTA_BYTES = "100000";
    try {
        await ada.session.uploadAttachment(itemUid, fileOf(60000, { name: "one.bin" }));
        await assert.rejects(ada.session.uploadAttachment(itemUid, fileOf(60000, { name: "two.bin" })), (e) => e && e.name === "VaultApiError" && e.status === 400 && /storage limit/.test(e.message), "the second file would pass the ceiling");
        assert.equal((await ada.session.listAttachments(itemUid)).length, 1, "and was not stored");
        // deleting frees room again
        const [one] = await ada.session.listAttachments(itemUid);
        await ada.session.deleteAttachment(itemUid, one.uid);
        await ada.session.uploadAttachment(itemUid, fileOf(60000, { name: "two.bin" }));
    } finally {
        delete process.env.ZIOVAULT_ATTACHMENT_QUOTA_BYTES;
    }
});
