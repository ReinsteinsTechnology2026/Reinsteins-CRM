// ZioVault -- the REAL screens (React + jsdom) for a CRM Super Admin whose role is "employee" (a CTO, say), against the real API and PostgreSQL:
// the "New collection" button and the administration screens are offered to role = 'admin' OR system_access = 'super_admin' and to nobody else
// (a plain system_access of 'admin', or an ordinary employee, sees neither), the Super Admin creates the first company collection and becomes
// its manager, and an employee added to it sees only what they were given. Not a real browser: jsdom renders the real components.
//
// Needs the disposable PostgreSQL (PG_TEST_*), the client dev dependencies and jsdom; otherwise skipped.
// Run: node --test _test_ziovault_superadmin_ui_pg.js

process.env.JWT_SECRET = process.env.JWT_SECRET || "legacy-secret-for-tests";
process.env.TENANT_JWT_SECRET = process.env.TENANT_JWT_SECRET || "tenant-secret-for-tests";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createLab } = require("./_ziovault_test_support");
const { createUiHarness, uiAvailable } = require("./_ziovault_ui_support");

const lab = createLab();
const SKIP = lab.skip || (uiAvailable ? false : "client dev dependencies or jsdom are not installed");
const h = createUiHarness();

const PW = { cto: "correct horse battery staple cto lantern", ana: "correct horse battery staple ana lantern", bob: "correct horse battery staple bob lantern" };
const MARK = { collection: "Leadership Credentials COLLECTION-MARKER-3c58", title: "Cloud root TITLE-MARKER-7a02", password: "Tr0ub4dor&3-SADMIN-PW-MARKER-5d11" };
const NEEDLES = [MARK.collection, MARK.title, MARK.password, PW.cto, PW.ana, PW.bob, "correct horse"];
const assertNone = (text, label) => { for (const n of NEEDLES) assert.ok(!text.includes(n), `${label} contains plaintext: ${n}`); };

let pool; let ids; let collectionUid = null;
const logged = [];
const realConsole = { log: console.log, error: console.error, info: console.info, warn: console.warn };
// what the CRM's /tenant-auth/me reports for each person
const CTO = () => ({ id: ids.cto, role: "employee", systemAccess: "super_admin" });
const ANA = () => ({ id: ids.ana, role: "employee", systemAccess: "admin" });
const BOB = () => ({ id: ids.bob, role: "employee", systemAccess: "employee" });
const cardFor = (name) => h.all(".zv-card").find((c) => c.textContent.includes(name));
const itemButton = (title) => h.all('[data-testid^="vault-item-"]').find((b) => b.textContent.includes(title));

test.before(async () => {
    for (const level of ["log", "error", "info", "warn"]) console[level] = (...args) => { logged.push(args.map(String).join(" ")); };
    if (SKIP) return;
    await lab.connect();
    await h.boot({ lab });
    pool = await lab.tenantDatabase();
    const server = await lab.startApi(pool, { tenantId: 761 });
    ids = {
        cto: await lab.addUser(pool, "Chandra CTO", { role: "employee", access: "super_admin" }),
        ana: await lab.addUser(pool, "Ana Plainadmin", { role: "employee", access: "admin" }),
        bob: await lab.addUser(pool, "Bob Builder", { role: "employee", access: "employee" }),
    };
    h.world = { server, tenantId: 761 };
});
test.after(async () => {
    Object.assign(console, realConsole);
    await h.close();
    await lab.close();
});

test("PEOPLE WITHOUT ADMINISTRATION (plain admin access, ordinary employee): no New collection button, no offboarding, and a clear empty state", { skip: SKIP }, async () => {
    await h.signInAs(ANA(), "tok-ana-000000000001-AAAA");
    await h.uiSetup(PW.ana);
    await h.click("vault-nav-company");
    await h.waitFor(() => h.q("vault-company-empty"), "empty state");
    assert.equal(h.q("vault-collection-new"), null, "a plain system_access of 'admin' does not get the button");
    assert.match(h.q("vault-company-empty").textContent, /company administrator, a Super Admin or a collection manager can add you/);
    for (const id of ["vault-nav-offboarding", "vault-nav-audit", "vault-nav-keys"]) assert.equal(h.q(id), null, `${id} is not offered`);

    await h.signInAs(BOB(), "tok-bob-000000000002-BBBB");
    await h.uiSetup(PW.bob);
    await h.click("vault-nav-company");
    await h.waitFor(() => h.q("vault-company-empty"), "empty state");
    assert.equal(h.q("vault-collection-new"), null);
    assert.equal(h.q("vault-nav-offboarding"), null);
});

test("SUPER ADMIN WITH THE EMPLOYEE ROLE: is offered New collection, creates the first company collection and becomes its manager", { skip: SKIP }, async () => {
    await h.signInAs(CTO(), "tok-cto-000000000003-CCCC");
    await h.uiSetup(PW.cto);
    assert.ok(h.q("vault-nav-offboarding"), "the offboarding screen is offered to a Super Admin");
    await h.click("vault-nav-company");
    await h.waitFor(() => h.q("vault-company-empty"), "empty state");
    assert.ok(h.q("vault-collection-new"), "a Super Admin is offered New collection");
    assert.match(h.q("vault-company-empty").textContent, /Create the first collection/);
    await h.click("vault-collection-new");
    await h.waitFor(() => h.q("vault-collection-form"), "dialog");
    await h.type("vault-collection-name", MARK.collection);
    await h.submit("vault-collection-save");
    await h.waitFor(() => h.q("vault-collection-view"), "the collection opens", 30000);
    collectionUid = (await pool.query("SELECT uid FROM zv_collections"))[0][0].uid;
    for (const id of ["vault-collection-members", "vault-collection-edit", "vault-collection-archive", "vault-collection-additem"]) assert.ok(h.q(id), `${id}: the creator is its manager`);

    const [member] = await pool.query("SELECT is_manager, can_reveal, can_edit, can_share, wrapped_meta_key, wrapped_secret_key FROM zv_collection_members WHERE user_id = ?", [ids.cto]);
    assert.deepEqual([member[0].is_manager, member[0].can_reveal, member[0].can_edit, member[0].can_share], [true, true, true, true]);
    assert.ok(member[0].wrapped_meta_key.length >= 73 && member[0].wrapped_secret_key.length >= 73, "with encrypted key envelopes of their own");
    const [name] = await pool.query("SELECT name_ciphertext FROM zv_collections");
    assert.ok(!name[0].name_ciphertext.toString("latin1").includes("Leadership"), "the server never sees the name");

    // an item, and an explicit membership for Bob
    await h.click("vault-collection-additem");
    await h.waitFor(() => h.q("vault-editor"), "editor");
    await h.type("vault-field-title", MARK.title);
    await h.type("vault-field-password", MARK.password);
    await h.submit("vault-save");
    await h.waitFor(() => itemButton(MARK.title), "item", 30000);
    await h.click("vault-collection-members");
    await h.waitFor(() => h.q("vault-member-person") && h.q("vault-member-person").options.length > 1, "directory");
    const offered = [...h.q("vault-member-person").options].map((o) => o.textContent);
    assert.ok(offered.some((t) => t.includes("Bob Builder")) && offered.some((t) => t.includes("Ana Plainadmin")), "colleagues with a vault can be added");
    await h.type("vault-member-person", String(ids.bob));
    await h.check("member-reveal");
    await h.submit("vault-member-add");
    await h.waitFor(() => h.q(`vault-member-${ids.bob}`), "Bob added", 30000);
    assertNone(h.sent(), "request bodies");
});

test("THE ADDED EMPLOYEE sees only what they were given; the Super Admin's role gave nobody else access", { skip: SKIP }, async () => {
    await h.signInAs(BOB(), "tok-bob-000000000004-BBBB");
    await h.uiUnlock(PW.bob);
    await h.click("vault-nav-company");
    await h.waitFor(() => cardFor(MARK.collection), "Bob sees the collection he was added to");
    assert.equal(h.q("vault-collection-new"), null);
    await h.click(cardFor(MARK.collection));
    await h.waitFor(() => itemButton(MARK.title), "item");
    await h.click(itemButton(MARK.title));
    await h.click("vault-reveal");
    await h.waitFor(() => h.q("vault-password-text").textContent === MARK.password, "Bob can reveal (he was given reveal)");
    assert.equal(h.q("vault-edit"), null, "but not edit");

    // Ana (plain admin access, not a member) sees nothing of it
    await h.signInAs(ANA(), "tok-ana-000000000005-AAAA");
    await h.uiUnlock(PW.ana);
    await h.click("vault-nav-company");
    await h.waitFor(() => h.q("vault-company-empty"), "Ana has no collection");
    assert.equal(await fetch(`${h.world.server.url}/api/ziovault/collections/${collectionUid}`, { headers: { "x-test-user": String(ids.ana) } }).then((r) => r.status), 404, "and gets 404 for it");
});

test("NOTHING SECRET LEAKS through these screens", { skip: SKIP }, async () => {
    await h.click("vault-lock-button");
    await h.waitFor(() => h.q("vault-unlock-password"), "locked");
    assertNone(h.text() + document.body.innerHTML, "the locked page");
    assertNone(h.sent(), "all request bodies");
    assertNone(logged.join("\n"), "console output");
    assertNone(h.storageDump(), "browser storage");
    await h.unmount();
});
