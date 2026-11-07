// ZioVault Stage 4 -- the REAL company-vault and sharing screens (React + jsdom) driving the real client session and crypto against the real
// Express router and PostgreSQL, with three people signing in one after another (an administrator, an employee, and a colleague who never
// sets up a vault). Not a real browser: jsdom renders the real components and dispatches real DOM events.
//
// Needs the disposable PostgreSQL (PG_TEST_*), the client dev dependencies and jsdom; otherwise skipped.
// Run: node --test _test_ziovault_company_ui_pg.js

process.env.JWT_SECRET = process.env.JWT_SECRET || "legacy-secret-for-tests";
process.env.TENANT_JWT_SECRET = process.env.TENANT_JWT_SECRET || "tenant-secret-for-tests";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createLab } = require("./_ziovault_test_support");
const { createUiHarness, uiAvailable } = require("./_ziovault_ui_support");

const lab = createLab();
const SKIP = lab.skip || (uiAvailable ? false : "client dev dependencies or jsdom are not installed");
const h = createUiHarness();

const PW = { ada: "correct horse battery staple ada lantern", bob: "correct horse battery staple bob lantern" };
const MARK = {
    collection: "Finance Systems COLLECTION-MARKER-6d2f",
    about: "Shared admin logins ABOUT-MARKER-19ab",
    title: "Core banking console TITLE-MARKER-aa41",
    password: "Tr0ub4dor&3-UI-COMPANY-PW-MARKER-5e77",
    notes: "UI-COMPANY-NOTE-MARKER-c0de",
    personal: "Personal CMS login PERSONAL-MARKER-be19",
    personalPw: "Zq8!vN3#kR7@mT2w-PERSONAL-PW-MARKER",
};
const NEEDLES = [MARK.collection, MARK.about, MARK.title, MARK.password, MARK.notes, MARK.personal, MARK.personalPw, PW.ada, PW.bob, "correct horse"];
const assertNone = (text, label) => { for (const n of NEEDLES) assert.ok(!text.includes(n), `${label} contains plaintext: ${n}`); };

let pool; let ids; let collectionUid = null; let personalUid = null;
const logged = [];
const realConsole = { log: console.log, error: console.error, info: console.info, warn: console.warn };
const ADA = () => ({ id: ids.ada, role: "admin" });
const BOB = () => ({ id: ids.bob, role: "employee" });

const cardFor = (name) => h.all(".zv-card").find((c) => c.textContent.includes(name));
async function openCollection() {
    await h.click("vault-nav-company");
    await h.waitFor(() => cardFor(MARK.collection), "collection card");
    await h.click(cardFor(MARK.collection));
    await h.waitFor(() => h.q("vault-collection-view"), "collection view");
}
const itemButton = (title) => h.all('[data-testid^="vault-item-"]').find((b) => b.textContent.includes(title));
const rawStatus = async (userId, method, route) => (await fetch(`${h.world.server.url}/api/ziovault${route}`, { method, headers: { "x-test-user": String(userId) } })).status;

test.before(async () => {
    for (const level of ["log", "error", "info", "warn"]) console[level] = (...args) => { logged.push(args.map(String).join(" ")); };
    if (SKIP) return;
    await lab.connect();
    await h.boot({ lab });
    pool = await lab.tenantDatabase();
    const server = await lab.startApi(pool, { tenantId: 701 });
    ids = {
        ada: await lab.addUser(pool, "Ada Admin", { role: "admin", access: "super_admin" }),
        bob: await lab.addUser(pool, "Bob Builder"),
        cy: await lab.addUser(pool, "Cy NoVault"),
    };
    h.world = { server, tenantId: 701 };
});
test.after(async () => {
    Object.assign(console, realConsole);
    await h.close();
    await lab.close();
});

test("ADMIN: opens the Company Vault, sees the empty state, creates a collection (name and description encrypted) and adds an item", { skip: SKIP }, async () => {
    await h.signInAs(ADA(), "tok-ada-000000000001-AAAA");
    await h.uiSetup(PW.ada);
    await h.click("vault-nav-company");
    await h.waitFor(() => h.q("vault-company-empty"), "empty state");
    assert.ok(h.q("vault-collection-new"), "an administrator is offered New collection");

    await h.click("vault-collection-new");
    await h.waitFor(() => h.q("vault-collection-form"), "dialog");
    assert.equal(h.q("vault-collection-save").disabled, true, "a name is required");
    await h.type("vault-collection-name", MARK.collection);
    await h.type("vault-collection-description", MARK.about);
    await h.type("vault-collection-kind", "department");
    await h.submit("vault-collection-save");
    await h.waitFor(() => h.q("vault-collection-view"), "the new collection opens", 30000);
    assert.ok(h.text().includes(MARK.collection) && h.q("vault-collection-about").textContent === MARK.about);
    assert.ok(h.q("vault-collection-empty"), "no items yet");
    collectionUid = (await pool.query("SELECT uid FROM zv_collections"))[0][0].uid;
    const [stored] = await pool.query("SELECT name_ciphertext FROM zv_collections");
    assert.ok(!stored[0].name_ciphertext.toString("latin1").includes("Finance"), "the server stores only the encrypted name");

    await h.click("vault-collection-additem");
    await h.waitFor(() => h.q("vault-editor"), "editor");
    assert.match(h.text(), /New company item/);
    assert.equal(h.q("vault-field-folder"), null, "company items have no personal folder");
    assert.equal(h.q("vault-field-favorite"), null, "and no favorite");
    await h.type("vault-field-title", MARK.title);
    await h.type("vault-field-username", "root");
    await h.type("vault-field-password", MARK.password);
    await h.type("vault-field-notes", MARK.notes);
    await h.submit("vault-save");
    await h.waitFor(() => itemButton(MARK.title), "item in the collection", 30000);

    await h.click(itemButton(MARK.title));
    await h.waitFor(() => h.q("vault-detail"), "detail");
    assert.match(h.q("vault-source").textContent, /Company · Finance Systems/);
    assert.ok(!h.q("vault-detail").textContent.includes(MARK.password), "password hidden until revealed");
    await h.click("vault-reveal");
    await h.waitFor(() => h.q("vault-password-text").textContent === MARK.password, "revealed");
    assertNone(h.sent(), "request bodies");
});

test("EMPLOYEE (no collections yet): sees the empty state without an administrator's New collection button", { skip: SKIP }, async () => {
    await h.signInAs(BOB(), "tok-bob-000000000002-BBBB");
    await h.uiSetup(PW.bob);
    await h.click("vault-nav-company");
    await h.waitFor(() => h.q("vault-company-empty"), "empty state");
    assert.equal(h.q("vault-collection-new"), null, "an employee is not offered New collection");
    assert.match(h.q("vault-company-empty").textContent, /not a member of any company collection/);
    await h.click("vault-nav-shared-with-me");
    await h.waitFor(() => h.q("vault-shared-empty"), "nothing shared yet");
    await h.click("vault-nav-shared-by-me");
    await h.waitFor(() => h.q("vault-outgoing-empty"), "nothing shared by me");
});

test("ADMIN adds the employee as a details-only member; a colleague without a vault is not offered", { skip: SKIP }, async () => {
    await h.signInAs(ADA(), "tok-ada-000000000003-AAAA");
    await h.uiUnlock(PW.ada);
    await openCollection();
    await h.click("vault-collection-members");
    await h.waitFor(() => h.q("vault-members-dialog"), "members dialog");
    await h.waitFor(() => h.q("vault-member-person").options.length > 1, "directory loaded");
    const offered = [...h.q("vault-member-person").options].map((o) => o.textContent);
    assert.ok(offered.some((t) => t.includes("Bob Builder")));
    assert.ok(!offered.some((t) => t.includes("Cy NoVault")), "someone who has not set up ZioVault cannot be added");
    assert.match(h.q("vault-members-dialog").textContent, /ask them to open ZioVault once/);
    assert.equal(h.q("member-reveal").disabled, false);

    await h.type("vault-member-person", String(ids.bob));
    await h.type("member-expiry-choice", "7");
    await h.submit("vault-member-add");
    await h.waitFor(() => h.q("vault-members-notice"), "added");
    await h.waitFor(() => h.q(`vault-member-${ids.bob}`), "Bob listed");
    assert.match(h.q(`vault-member-${ids.bob}`).textContent, /Until /, "the expiry is shown");
    const [members] = await pool.query("SELECT can_reveal, wrapped_secret_key, expires_at FROM zv_collection_members WHERE user_id = ?", [ids.bob]);
    assert.equal(members[0].can_reveal, false); assert.equal(members[0].wrapped_secret_key, null, "no secret-key envelope for a details-only member");
    assert.ok(members[0].expires_at);
    assertNone(h.sent(), "request bodies");
});

test("EMPLOYEE (details-only member): sees the collection and the item's details, but cannot reveal or copy the password", { skip: SKIP }, async () => {
    await h.signInAs(BOB(), "tok-bob-000000000004-BBBB");
    await h.uiUnlock(PW.bob);
    await h.click("vault-nav-company");
    await h.waitFor(() => cardFor(MARK.collection), "collection card");
    const card = cardFor(MARK.collection);
    assert.match(card.textContent, /1 item/); assert.match(card.textContent, new RegExp(MARK.about.slice(0, 20)));
    assert.equal(h.q("vault-collection-new"), null);
    await h.click(card);
    await h.waitFor(() => itemButton(MARK.title), "item listed");
    assert.equal(h.q("vault-collection-members"), null, "only a manager manages members");
    assert.equal(h.q("vault-collection-additem"), null, "no add-item for a viewer");
    await h.click(itemButton(MARK.title));
    await h.waitFor(() => h.q("vault-detail"), "detail");
    assert.ok(h.q("vault-no-reveal"), "the screen explains why there is no Reveal");
    assert.equal(h.q("vault-reveal"), null); assert.equal(h.q("vault-copy-password"), null); assert.equal(h.q("vault-edit"), null); assert.equal(h.q("vault-delete"), null);
    assert.ok(!h.text().includes(MARK.password) && !h.text().includes(MARK.notes));
    assert.equal(await rawStatus(ids.bob, "POST", `/items/${(await pool.query("SELECT uid FROM zv_items"))[0][0].uid}/secret`), 403, "the server refuses even a direct request");
});

test("OWNER shares a personal item with reveal + copy for one day: dialog, status, 'Shared by me'", { skip: SKIP }, async () => {
    await h.signInAs(ADA(), "tok-ada-000000000005-AAAA");
    await h.uiUnlock(PW.ada);
    await h.click("vault-add");
    await h.waitFor(() => h.q("vault-editor"), "editor");
    await h.type("vault-field-title", MARK.personal);
    await h.type("vault-field-password", MARK.personalPw);
    await h.submit("vault-save");
    await h.waitFor(() => itemButton(MARK.personal), "personal item");
    personalUid = itemButton(MARK.personal).getAttribute("data-testid").replace("vault-item-", "");
    await h.click(itemButton(MARK.personal));
    await h.waitFor(() => h.q("vault-share"), "Share button");
    await h.click("vault-share");
    await h.waitFor(() => h.q("vault-share-dialog"), "share dialog");
    await h.waitFor(() => h.q("vault-share-recipient").options.length > 1, "directory");
    assert.ok(h.q("vault-share-none"), "not shared with anyone yet");
    const options = [...h.q("vault-share-recipient").options].map((o) => o.textContent);
    assert.ok(options.some((t) => t.includes("Bob Builder")) && !options.some((t) => t.includes("Cy NoVault")));
    assert.match(h.q("vault-share-dialog").textContent, /Only this item is shared/);

    await h.type("vault-share-recipient", String(ids.bob));
    await h.check("share-reveal");
    await h.check("share-copy");
    assert.equal(h.q("share-edit").checked, false);
    await h.type("share-expiry-choice", "1");
    await h.submit("vault-share-submit");
    await h.waitFor(() => h.q(`vault-grant-${ids.bob}`), "Bob has access", 30000);
    assert.match(h.q("vault-share-notice").textContent, /Shared/);
    assert.match(h.q(`vault-grant-${ids.bob}`).textContent, /Reveal/);
    assert.match(h.q(`vault-grant-${ids.bob}`).textContent, /Copy/);
    assert.match(h.q(`vault-grant-${ids.bob}`).textContent, /Until /);
    const [keys] = await pool.query("SELECT k.purpose FROM zv_item_keys k JOIN zv_items i ON i.id = k.item_id WHERE i.uid = ? AND k.holder_type = 'user' AND k.holder_user_id = ?", [personalUid, ids.bob]);
    assert.deepEqual(keys.map((k) => k.purpose).sort(), ["meta", "secret"]);
    const [other] = await pool.query("SELECT count(*)::int AS n FROM zv_item_keys k JOIN zv_items i ON i.id = k.item_id WHERE i.owner_user_id = ? AND i.uid <> ? AND k.holder_type = 'user'", [ids.ada, personalUid]);
    assert.equal(other[0].n, 0, "nothing else of the owner's vault was shared");
    await h.click(h.button("Close"));

    await h.click("vault-nav-shared-by-me");
    await h.waitFor(() => h.q("vault-outgoing-table"), "table");
    const row = h.all("tbody tr")[0];
    assert.match(row.textContent, /Bob Builder/); assert.match(row.textContent, /Active/); assert.match(row.textContent, new RegExp("Personal CMS login"));
    assertNone(h.sent(), "request bodies");
});

test("RECIPIENT: 'Shared with me' shows who shared it, the permissions and expiry; reveal and copy work; edit and share are not offered", { skip: SKIP }, async () => {
    await h.signInAs(BOB(), "tok-bob-000000000006-BBBB");
    await h.uiUnlock(PW.bob);
    await h.click("vault-nav-shared-with-me");
    await h.waitFor(() => itemButton(MARK.personal), "shared item listed");
    await h.waitFor(() => itemButton(MARK.personal).textContent.includes("From Ada Admin"), "sender named");
    assert.match(itemButton(MARK.personal).textContent, /Reveal/); assert.match(itemButton(MARK.personal).textContent, /Until /);
    assert.equal(h.all('[data-testid^="vault-item-"]').length, 1, "only the shared item, none of the owner's other items");
    await h.click(itemButton(MARK.personal));
    await h.waitFor(() => h.q("vault-detail"), "detail");
    assert.match(h.q("vault-source").textContent, /Shared with you by Ada Admin/);
    assert.ok(h.q("vault-rights") && h.q("vault-expiry"));
    assert.ok(!h.q("vault-detail").textContent.includes(MARK.personalPw));
    assert.equal(h.q("vault-edit"), null); assert.equal(h.q("vault-share"), null); assert.equal(h.q("vault-delete"), null); assert.equal(h.q("vault-favorite"), null);
    await h.click("vault-reveal");
    await h.waitFor(() => h.q("vault-password-text").textContent === MARK.personalPw, "revealed");
    await h.click("vault-copy-password");
    await h.waitFor(() => h.q("vault-message"), "copied");
    assert.equal(h.clipboard.value, MARK.personalPw);
    await h.click("vault-lock-button");
    await h.waitFor(() => h.q("vault-unlock-password"), "locked");
    assert.equal(h.clipboard.value, "", "locking takes the copied password back off the clipboard");
    assertNone(h.text() + document.body.innerHTML, "page after lock");
});

test("OWNER changes the permissions (adds Edit), the recipient edits; then the owner ends the access and it is gone for the recipient", { skip: SKIP }, async () => {
    await h.signInAs(ADA(), "tok-ada-000000000007-AAAA");
    await h.uiUnlock(PW.ada);
    await h.click("vault-nav-shared-by-me");
    await h.waitFor(() => h.q("vault-outgoing-table"), "table");
    await h.click(h.all('[data-testid^="vault-outgoing-manage-"]')[0]);
    await h.waitFor(() => h.q("vault-share-dialog"), "dialog");
    await h.waitFor(() => h.q(`vault-grant-edit-${ids.bob}`), "grant listed");
    await h.click(`vault-grant-edit-${ids.bob}`);
    await h.check("edit-edit");
    await h.type("edit-expiry-choice", "none");
    await h.click("vault-grant-save");
    await h.waitFor(() => h.q("vault-share-notice") && !h.q("vault-grant-save"), "permissions updated (the edit form closes)");
    assert.ok(h.all(`[data-testid="vault-grant-${ids.bob}"] .zv-chip`).some((c) => c.textContent === "Edit"), "the Edit permission is now shown for Bob");
    assert.match(h.q("vault-share-notice").textContent, /Access updated/);
    assert.match(h.q(`vault-grant-${ids.bob}`).textContent, /No expiry/);

    // the recipient can now edit through the screens
    await h.signInAs(BOB(), "tok-bob-000000000008-BBBB");
    await h.uiUnlock(PW.bob);
    await h.click("vault-nav-shared-with-me");
    await h.waitFor(() => itemButton(MARK.personal), "shared item");
    await h.click(itemButton(MARK.personal));
    await h.waitFor(() => h.q("vault-edit"), "Edit is offered now");
    assert.equal(h.q("vault-share"), null, "still not allowed to manage access");
    await h.click("vault-edit");
    await h.waitFor(() => h.q("vault-editor") && h.q("vault-field-password").value === MARK.personalPw, "editor with decrypted values");
    assert.equal(h.q("vault-field-folder"), null); assert.equal(h.q("vault-field-favorite"), null);
    await h.type("vault-field-title", "Edited by the recipient");
    await h.submit("vault-save");
    await h.waitFor(() => itemButton("Edited by the recipient"), "edit saved", 30000);

    // the owner ends the access
    await h.signInAs(ADA(), "tok-ada-000000000009-AAAA");
    await h.uiUnlock(PW.ada);
    await h.click("vault-nav-shared-by-me");
    await h.waitFor(() => h.q("vault-outgoing-table"), "table");
    assert.match(h.text(), /Edited by the recipient/, "the owner sees the recipient's edit");
    await h.click(h.all('[data-testid^="vault-outgoing-manage-"]')[0]);
    await h.waitFor(() => h.q(`vault-grant-revoke-${ids.bob}`), "End access");
    await h.click(`vault-grant-revoke-${ids.bob}`);
    await h.click("vault-grant-revoke-confirm");
    await h.waitFor(() => h.q("vault-share-none"), "no one has access any more", 30000);
    await h.click(h.button("Close"));
    await h.click("vault-nav-shared-by-me");
    await h.waitFor(() => h.q("vault-outgoing-table") && /Ended/.test(h.q("vault-outgoing-table").textContent), "the table says Ended");
    const [left] = await pool.query("SELECT count(*)::int AS n FROM zv_item_keys WHERE holder_type = 'user' AND holder_user_id = ?", [ids.bob]);
    assert.equal(left[0].n, 0, "the recipient's key envelopes are deleted");

    await h.signInAs(BOB(), "tok-bob-000000000010-BBBB");
    await h.uiUnlock(PW.bob);
    await h.click("vault-nav-shared-with-me");
    await h.waitFor(() => h.q("vault-shared-empty"), "gone for the recipient");
    assert.ok(!h.text().includes("Edited by the recipient"), "no trace of the item's content");
    assert.equal(await rawStatus(ids.bob, "GET", `/items/${personalUid}`), 404);
});

test("EXPIRY: when a share's time passes the recipient can no longer open it, and the owner sees it as expired", { skip: SKIP }, async () => {
    await h.signInAs(ADA(), "tok-ada-000000000011-AAAA");
    await h.uiUnlock(PW.ada);
    await h.waitFor(() => h.q("vault-app"), "app");
    await h.click(itemButton("Edited by the recipient") || h.all('[data-testid^="vault-item-"]')[0]);
    await h.waitFor(() => h.q("vault-share"), "Share");
    await h.click("vault-share");
    await h.waitFor(() => h.q("vault-share-dialog"), "dialog");
    await h.waitFor(() => h.q("vault-share-recipient").options.length > 1, "directory");
    await h.type("vault-share-recipient", String(ids.bob));
    await h.type("share-expiry-choice", "1");
    await h.submit("vault-share-submit");
    await h.waitFor(() => h.q(`vault-grant-${ids.bob}`), "shared again", 30000);
    await h.click(h.button("Close"));
    await pool.query("UPDATE zv_grants SET expires_at = now() - interval '1 minute' WHERE recipient_user_id = ? AND revoked_at IS NULL", [ids.bob]);

    await h.signInAs(BOB(), "tok-bob-000000000012-BBBB");
    await h.uiUnlock(PW.bob);
    await h.click("vault-nav-shared-with-me");
    await h.waitFor(() => h.q("vault-shared-empty"), "expired share is gone");

    await h.signInAs(ADA(), "tok-ada-000000000013-AAAA");
    await h.uiUnlock(PW.ada);
    await h.click("vault-nav-shared-by-me");
    await h.waitFor(() => h.q("vault-outgoing-table"), "table");
    assert.ok(h.all("tbody tr").some((r) => r.getAttribute("data-status") === "expired" && /Expired/.test(r.textContent)), "the owner sees an expired share");
});

test("NOTHING SECRET LEAKS through the screens: no request, browser storage, console line or locked page holds a password, note, name or master password", { skip: SKIP }, async () => {
    assertNone(h.sent(), "all request bodies");
    assertNone(logged.join("\n"), "console output");
    assertNone(h.storageDump(), "browser storage");
    assert.equal(window.location.href, "http://localhost/", "nothing in the URL");
    assert.ok(!h.record.requests.some((r) => /password|secret=|token=/i.test(r.route)), "no secret in a URL");
    const keys = [...Array(window.localStorage.length).keys()].map((i) => window.localStorage.key(i));
    assert.ok(keys.every((k) => k === "ziovault:prefs"), `only preferences in localStorage: ${keys}`);
    await h.unmount();
});
