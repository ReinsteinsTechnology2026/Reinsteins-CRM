// ZioVault Stage 5 -- the REAL screens (React + jsdom) for attachments, rotation, audit activity, collection keys and employee offboarding, driving
// the real client session and crypto against the real Express router and PostgreSQL. Not a real browser: jsdom renders the real components and
// dispatches real DOM events.
//
// Needs the disposable PostgreSQL (PG_TEST_*), the client dev dependencies and jsdom; otherwise skipped.
// Run: node --test _test_ziovault_stage5_ui_pg.js

process.env.JWT_SECRET = process.env.JWT_SECRET || "legacy-secret-for-tests";
process.env.TENANT_JWT_SECRET = process.env.TENANT_JWT_SECRET || "tenant-secret-for-tests";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { createLab } = require("./_ziovault_test_support");
const { createUiHarness, uiAvailable } = require("./_ziovault_ui_support");

const lab = createLab();
const SKIP = lab.skip || (uiAvailable ? false : "client dev dependencies or jsdom are not installed");
const h = createUiHarness();

const PW = { ada: "correct horse battery staple ada lantern", bob: "correct horse battery staple bob lantern" };
const MARK = {
    collection: "Payments Platform COLLECTION-MARKER-5a1c",
    title: "Gateway console TITLE-MARKER-2b77",
    password: "Tr0ub4dor&3-S5UI-PW-MARKER-77de",
    file: "S5-FILE-CONTENT-MARKER-91ab-never-stored",
    fileName: "gateway-keys-NAME-MARKER-3d4f.txt",
    bobTitle: "Bob private login BOBTITLE-MARKER-18cc",
    bobPw: "Zq8!vN3#kR7@mT2w-BOBPW-MARKER",
};
const NEEDLES = [MARK.collection, MARK.title, MARK.password, MARK.file, MARK.fileName, MARK.bobTitle, MARK.bobPw, PW.ada, PW.bob, "correct horse"];
const assertNone = (text, label) => { for (const n of NEEDLES) assert.ok(!text.includes(n), `${label} contains plaintext: ${n}`); };

let pool; let ids; let itemUid = null; let collectionUid = null;
const downloads = [];
const logged = [];
const realConsole = { log: console.log, error: console.error, info: console.info, warn: console.warn };
const ADA = () => ({ id: ids.ada, role: "admin" });
const BOB = () => ({ id: ids.bob, role: "employee" });
const itemButton = (title) => h.all('[data-testid^="vault-item-"]').find((b) => b.textContent.includes(title));
const cardFor = (name) => h.all(".zv-card").find((c) => c.textContent.includes(name));
const fileBytes = Buffer.concat([Buffer.from(MARK.file), crypto.randomBytes(30000)]);

async function openCollectionItem() {
    await h.click("vault-nav-company");
    await h.waitFor(() => cardFor(MARK.collection), "collection card");
    await h.click(cardFor(MARK.collection));
    await h.waitFor(() => itemButton(MARK.title), "item listed");
    await h.click(itemButton(MARK.title));
    await h.waitFor(() => h.q("vault-detail"), "detail");
}

async function chooseFile(name, bytes) {
    const input = h.q("vault-attach-input");
    const file = new window.File([bytes], name, { type: "text/plain" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await h.act(async () => { input.dispatchEvent(new window.Event("change", { bubbles: true })); });
}

test.before(async () => {
    for (const level of ["log", "error", "info", "warn"]) console[level] = (...args) => { logged.push(args.map(String).join(" ")); };
    if (SKIP) return;
    await lab.connect();
    await h.boot({ lab });
    // jsdom has no Blob.arrayBuffer, saving files or object URLs: small stand-ins that keep what would be saved
    window.File.prototype.arrayBuffer = function arrayBuffer() {
        return new Promise((resolve, reject) => { const r = new window.FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsArrayBuffer(this); });
    };
    // the screens run in Node here, so it is Node's URL that the page code sees
    for (const U of [window.URL, globalThis.URL]) {
        U.createObjectURL = (blob) => { downloads.push({ blob }); return `blob:test/${downloads.length}`; };
        U.revokeObjectURL = () => {};
    }
    window.HTMLAnchorElement.prototype.click = function click() { downloads[downloads.length - 1].name = this.download; downloads[downloads.length - 1].href = this.href; };
    pool = await lab.tenantDatabase();
    const server = await lab.startApi(pool, { tenantId: 751 });
    ids = { ada: await lab.addUser(pool, "Ada Admin", { role: "admin", access: "super_admin" }), bob: await lab.addUser(pool, "Bob Builder") };
    h.world = { server, tenantId: 751 };
});
test.after(async () => {
    Object.assign(console, realConsole);
    await h.close();
    await lab.close();
});

test("ATTACHMENTS (screens): add a file, see names only on request, download it decrypted, delete it; the server sees only ciphertext", { skip: SKIP }, async () => {
    await h.signInAs(ADA(), "tok-ada-000000000001-AAAA");
    await h.uiSetup(PW.ada);
    await h.click("vault-nav-company");
    await h.waitFor(() => h.q("vault-company-empty"), "empty");
    await h.click("vault-collection-new");
    await h.waitFor(() => h.q("vault-collection-form"), "dialog");
    await h.type("vault-collection-name", MARK.collection);
    await h.submit("vault-collection-save");
    await h.waitFor(() => h.q("vault-collection-view"), "collection opens", 30000);
    collectionUid = (await pool.query("SELECT uid FROM zv_collections"))[0][0].uid;
    await h.click("vault-collection-additem");
    await h.waitFor(() => h.q("vault-editor"), "editor");
    await h.type("vault-field-title", MARK.title);
    await h.type("vault-field-password", MARK.password);
    await h.submit("vault-save");
    await h.waitFor(() => itemButton(MARK.title), "item", 30000);
    itemUid = itemButton(MARK.title).getAttribute("data-testid").replace("vault-item-", "");
    await h.click(itemButton(MARK.title));
    await h.waitFor(() => h.q("vault-attachments"), "attachments panel");
    await h.waitFor(() => h.q("vault-attach-empty"), "empty state");

    await chooseFile(MARK.fileName, fileBytes);
    await h.waitFor(() => h.q("vault-attach-notice") && h.all('[data-testid^="vault-attachment-vault"], [data-testid^="vault-attachment-"]').length > 0, "uploaded", 30000);
    assert.match(h.q("vault-attach-notice").textContent, /encrypted and saved/);
    assert.ok(!h.q("vault-attachments").querySelector(".zv-files").textContent.includes(MARK.fileName), "in the list the name is not shown until asked for");
    const [stored] = await pool.query("SELECT content, meta_ciphertext FROM zv_attachments");
    assert.equal(stored.length, 1);
    assert.ok(!stored[0].content.toString("latin1").includes(MARK.file) && !stored[0].meta_ciphertext.toString("latin1").includes("NAME-MARKER"), "ciphertext only");
    assert.ok(!h.sent().includes(MARK.file) && !h.sent().includes("NAME-MARKER"), "no plaintext in the upload");

    await h.click("vault-attach-names");
    await h.waitFor(() => h.q("vault-attachments").querySelector(".zv-files").textContent.includes(MARK.fileName), "the name appears when asked for");
    const row = h.all('[data-testid^="vault-attachment-download-"]')[0];
    await h.click(row);
    await h.waitFor(() => downloads.length === 1 && downloads[0].name, "download started");
    assert.equal(downloads[0].name, MARK.fileName);
    assert.equal(downloads[0].blob.type, "application/octet-stream", "never the type the uploader claimed, never shown in the page");
    const saved = Buffer.from(await downloads[0].blob.arrayBuffer ? await downloads[0].blob.arrayBuffer() : await new window.File([downloads[0].blob], "x").arrayBuffer());
    assert.ok(saved.equals(fileBytes), "decrypted here, byte for byte");

    // refused files explain themselves and send nothing
    const before = h.record.requests.length;
    await chooseFile("installer.exe", Buffer.from([1, 2, 3]));
    await h.waitFor(() => h.q("vault-attach-error"), "refused");
    assert.match(h.q("vault-attach-error").textContent, /Programs and scripts/);
    assert.equal(h.record.requests.slice(before).filter((r) => r.method === "post").length, 0);

    await h.click("vault-nav-attachments");
    await h.waitFor(() => h.q("vault-attachments-table"), "the attachments screen");
    assert.match(h.q(`vault-attachments-row-${itemUid}`).textContent, /Company/);
    await h.click(`vault-attachments-open-${itemUid}`);
    await h.waitFor(() => h.q("vault-attachments") && h.q("vault-detail"), "the item opens from the list");
    await h.click(h.all('[data-testid^="vault-attachment-delete-"]')[0]);
    await h.click("vault-attachment-delete-confirm");
    await h.waitFor(() => h.q("vault-attach-empty"), "deleted");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM zv_attachments"))[0][0].n, 0);
    assertNone(h.sent(), "request bodies");
});

test("ROTATION (screens): schedule an item, see it become overdue, find it under Rotation status, record the change", { skip: SKIP }, async () => {
    await h.click("vault-nav-company");
    await h.waitFor(() => cardFor(MARK.collection), "card");
    await h.click(cardFor(MARK.collection));
    await h.waitFor(() => itemButton(MARK.title), "item");
    await h.click(itemButton(MARK.title));
    await h.waitFor(() => h.q("vault-rotation"), "rotation panel");
    assert.equal(h.q("vault-rotation-status").getAttribute("data-status"), "none");
    await h.type("vault-rotation-interval", "30");
    await h.submit("vault-rotation-save");
    await h.waitFor(() => h.q("vault-rotation-notice"), "saved");
    await h.waitFor(() => h.q("vault-rotation-status").getAttribute("data-status") === "ok", "scheduled");

    await pool.query("UPDATE zv_items SET last_rotated_at = now() - interval '31 days' WHERE uid = ?", [itemUid]);
    await h.signInAs(ADA(), "tok-ada-000000000002-AAAA");
    await h.uiUnlock(PW.ada);
    await h.click("vault-nav-company");
    await h.waitFor(() => cardFor(MARK.collection), "card");
    assert.ok(h.q(`vault-collection-due-${collectionUid}`), "the collection card says something is due");
    await h.click(cardFor(MARK.collection));
    await h.waitFor(() => itemButton(MARK.title), "item");
    assert.equal(h.all('[data-testid="vault-rotation-badge"]')[0].getAttribute("data-status"), "overdue");

    await h.click("vault-nav-rotation");
    await h.waitFor(() => h.q("vault-rotation-table"), "the rotation screen");
    assert.match(h.q("vault-rotation-summary").textContent, /Overdue/);
    assert.equal(h.q(`vault-rotation-row-${itemUid}`).getAttribute("data-status"), "overdue");
    await h.click(`vault-rotation-done-${itemUid}`);
    await h.waitFor(() => h.q("vault-rotation-view-notice"), "recorded");
    await h.waitFor(() => !h.q(`vault-rotation-row-${itemUid}`), "it no longer needs attention");
    await h.type("vault-rotation-filter", "all");
    await h.waitFor(() => h.q(`vault-rotation-row-${itemUid}`)?.getAttribute("data-status") === "ok", "scheduled again");
    await h.type("vault-rotation-warn", "30");
    assert.equal(window.localStorage.getItem("ziovault:prefs").includes("\"rotationWarnDays\":30"), true, "the warning window is a stored preference (a number)");
    assert.ok((await pool.query("SELECT kind FROM zv_audit_events WHERE kind = 'rotation_completed'"))[0].length >= 1);
});

test("MANAGER VISIBILITY: audit, collection keys and offboarding appear only for the people who may use them", { skip: SKIP }, async () => {
    await h.signInAs(BOB(), "tok-bob-000000000003-BBBB");
    await h.uiSetup(PW.bob);
    for (const id of ["vault-nav-audit", "vault-nav-keys", "vault-nav-offboarding"]) assert.equal(h.q(id), null, `${id} is not offered to an employee`);
    assert.ok(h.q("vault-nav-rotation") && h.q("vault-nav-attachments") && h.q("vault-nav-company"));
    // Bob's own vault, to prove later that offboarding does not touch it
    await h.click("vault-add");
    await h.waitFor(() => h.q("vault-editor"), "editor");
    await h.type("vault-field-title", MARK.bobTitle);
    await h.type("vault-field-password", MARK.bobPw);
    await h.submit("vault-save");
    await h.waitFor(() => itemButton(MARK.bobTitle), "bob's item", 30000);
});

test("COLLECTION KEYS (screens): the re-key dialog explains its limits, shows progress, ends with a verified result and a new key version", { skip: SKIP }, async () => {
    await h.signInAs(ADA(), "tok-ada-000000000004-AAAA");
    await h.uiUnlock(PW.ada);
    await h.click("vault-nav-company");
    await h.waitFor(() => cardFor(MARK.collection), "card");
    await h.click(cardFor(MARK.collection));
    await h.waitFor(() => h.q("vault-collection-members"), "manager buttons");
    await h.click("vault-collection-members");
    await h.waitFor(() => h.q("vault-member-person") && h.q("vault-member-person").options.length > 1, "directory");
    await h.type("vault-member-person", String(ids.bob));
    await h.check("member-reveal");
    await h.submit("vault-member-add");
    await h.waitFor(() => h.q(`vault-member-${ids.bob}`), "Bob added", 30000);

    await h.click("vault-nav-keys");
    await h.waitFor(() => h.q("vault-keys-table"), "keys screen");
    assert.equal(h.q(`vault-keys-version-${collectionUid}`).textContent, "1");
    await h.click(`vault-keys-rekey-${collectionUid}`);
    await h.waitFor(() => h.q("vault-rekey-dialog"), "dialog");
    await h.waitFor(() => h.q("vault-rekey-members"), "members shown");
    assert.match(h.q("vault-rekey-members").textContent, /Bob Builder/);
    assert.match(h.q("vault-rekey-dialog").textContent, /cannot.*erase a password someone already saw/, "the limitation is stated");
    assert.equal(h.q("vault-rekey-start").disabled, true, "it cannot be started by accident");
    await h.check("vault-rekey-ack");
    await h.click("vault-rekey-start");
    await h.waitFor(() => h.q("vault-rekey-done"), "finished", 60000);
    assert.match(h.q("vault-rekey-done").textContent, /key version 2/);
    assert.match(h.q("vault-rekey-done").textContent, /opened again successfully/);
    await h.click(h.button("Close"));
    await h.waitFor(() => h.q(`vault-keys-version-${collectionUid}`)?.textContent === "2", "the table shows the new version");

    // the item still opens, with the new keys
    await h.click("vault-nav-company");
    await h.waitFor(() => cardFor(MARK.collection), "card");
    await h.click(cardFor(MARK.collection));
    await h.waitFor(() => itemButton(MARK.title), "item");
    await h.click(itemButton(MARK.title));
    await h.waitFor(() => h.q("vault-reveal"), "reveal");
    await h.click("vault-reveal");
    await h.waitFor(() => h.q("vault-password-text").textContent === MARK.password, "still readable after re-keying");
    assertNone(h.sent(), "request bodies");
});

test("AUDIT ACTIVITY (screens): managers see who did what, can filter it, and the screen holds no secret", { skip: SKIP }, async () => {
    await h.click("vault-nav-audit");
    await h.waitFor(() => h.q("vault-audit-table"), "audit table");
    const text = h.q("vault-audit-table").textContent;
    for (const phrase of [/created the collection/, /added a member to/, /re-keyed the collection/, /opened the password of/]) assert.match(text, phrase);
    assert.ok(h.all("tbody tr").every((r) => /Completed/.test(r.textContent)), "every row carries a result");
    assert.match(text, /Recorded by the server/);
    assert.ok(!text.includes(MARK.password), "no password");
    await h.type("vault-audit-kind", "collection_rotated");
    await h.submit("vault-audit-apply");
    await h.waitFor(() => h.all("tbody tr").length > 0 && h.all("tbody tr").every((r) => r.getAttribute("data-kind") === "collection_rotated"), "filtered by action");
    await h.type("vault-audit-kind", "");
    await h.type("vault-audit-from", "2999-01-01");
    await h.submit("vault-audit-apply");
    await h.waitFor(() => h.q("vault-audit-empty"), "nothing in the far future");
    await h.type("vault-audit-from", "");
    await h.type("vault-audit-user", String(ids.bob));
    await h.submit("vault-audit-apply");
    await h.waitFor(() => h.q("vault-audit-table") && h.all("tbody tr").every((r) => /Bob|Ada/.test(r.textContent)), "filtered by employee");
    // the manager sees the names and titles of their own collections and items (decrypted here, in their own browser); never a secret
    for (const secret of [MARK.password, MARK.file, MARK.bobPw, PW.ada, PW.bob]) assert.ok(!(h.text() + document.body.innerHTML).includes(secret), `the audit screen shows a secret: ${secret}`);
});

test("OFFBOARDING (screens): an administrator ends a person's company access after a confirmation; their personal vault is untouched", { skip: SKIP }, async () => {
    await h.click("vault-nav-offboarding");
    await h.waitFor(() => h.q("vault-offboarding-table"), "offboarding table");
    assert.match(h.q(`vault-offboarding-row-${ids.bob}`).textContent, /Bob Builder/);
    assert.equal(h.q(`vault-offboarding-start-${ids.ada}`), null, "nobody ends their own access here");
    await h.click(`vault-offboarding-start-${ids.bob}`);
    await h.waitFor(() => h.q("vault-offboarding-dialog"), "confirmation dialog");
    const dialog = h.q("vault-offboarding-dialog").textContent;
    for (const phrase of [/removed from 1 collection/, /personal vault is not touched/, /Nothing is deleted/, /if anything fails, nothing is changed/, /cannot make them forget/]) assert.match(dialog, phrase);
    assert.equal(h.q("vault-offboarding-confirm").disabled, true, "it cannot be done by accident");
    await h.check("vault-offboarding-ack");
    await h.click("vault-offboarding-confirm");
    await h.waitFor(() => h.q("vault-offboarding-outcome"), "result", 30000);
    const outcome = h.q("vault-offboarding-outcome").textContent;
    assert.match(outcome, /Company vault access ended for Bob Builder/);
    assert.match(outcome, /Follow-up: re-key Payments Platform/, "what to do next, by collection name");
    await h.waitFor(() => !h.q(`vault-offboarding-row-${ids.bob}`), "Bob is no longer listed");

    await h.signInAs(BOB(), "tok-bob-000000000005-BBBB");
    await h.uiUnlock(PW.bob);
    await h.click("vault-nav-company");
    await h.waitFor(() => h.q("vault-company-empty"), "Bob has no company collections any more");
    await h.click("vault-nav-all");
    await h.waitFor(() => itemButton(MARK.bobTitle), "his own item is still there");
    await h.click(itemButton(MARK.bobTitle));
    await h.click("vault-reveal");
    await h.waitFor(() => h.q("vault-password-text").textContent === MARK.bobPw, "and still opens");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM zv_items WHERE collection_id IS NOT NULL"))[0][0].n, 1, "the company credential was kept");
});

test("NOTHING SECRET LEAKS through the Stage 5 screens: requests, storage, console, URL, locked page", { skip: SKIP }, async () => {
    await h.click("vault-lock-button");
    await h.waitFor(() => h.q("vault-unlock-password"), "locked");
    assertNone(h.text() + document.body.innerHTML, "the locked page");
    assertNone(h.sent(), "all request bodies");
    assertNone(logged.join("\n"), "console output");
    assertNone(h.storageDump(), "browser storage");
    assert.equal(window.location.href, "http://localhost/");
    assert.ok(!h.record.requests.some((r) => /password|secret=|token=|name=/i.test(r.route)), "nothing secret in a URL");
    const keys = [...Array(window.localStorage.length).keys()].map((i) => window.localStorage.key(i));
    assert.ok(keys.every((k) => k === "ziovault:prefs"), `only preferences in localStorage: ${keys}`);
    await h.unmount();
});
