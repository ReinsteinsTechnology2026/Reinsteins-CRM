// ZioVault -- who may administer the company vault: role = 'admin' OR system_access = 'super_admin' (and nobody else), decided by the server from the
// user's FRESH database row. Driven through the real client session against the real router and PostgreSQL.
//
// What it proves: the complete role x system_access x status matrix (collection creation AND the offboarding endpoints), that the browser's idea of
// the role never decides anything, that a demotion or promotion takes effect on the very next request, that a Super Admin with the employee role
// can bootstrap the first collection and becomes its manager with real key envelopes, and that Super Admin grants NO access: a non-member gets 404
// for a collection and its items, and nobody -- Super Admin included -- can read another person's personal vault.
//
// Needs the disposable PostgreSQL (PG_TEST_* variables); otherwise skipped. Run: node --test _test_ziovault_roles_pg.js

process.env.JWT_SECRET = process.env.JWT_SECRET || "legacy-secret-for-tests";
process.env.TENANT_JWT_SECRET = process.env.TENANT_JWT_SECRET || "tenant-secret-for-tests";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createLab } = require("./_ziovault_test_support");
const { load, joinVault, rawCall } = require("./_ziovault_session_support");

const lab = createLab();
const SKIP = lab.skip;
const PW = (name) => `correct horse battery staple ${name.replace(/\W/g, "")} lantern`;
const MARK = { collection: "Executive Credentials COLLECTION-MARKER-6e21", title: "Prod root TITLE-MARKER-4d90", password: "Tr0ub4dor&3-ROLES-PW-MARKER-0b7c", personal: "Bob's private login PERSONAL-MARKER-91ab", personalPw: "Zq8!vN3#kR7@mT2w-BOBPRIVATE-MARKER" };

const ROLES = ["admin", "employee"];
const ACCESS = ["super_admin", "admin", "executive", "hr", "department_head", "manager", "team_lead", "employee"];
const expectedAdmin = (role, access) => role === "admin" || access === "super_admin";

let vault; let sessionModule; let apiModule;
const logged = [];
const realConsole = { log: console.log, error: console.error, info: console.info, warn: console.warn };
let tenantCounter = 1000;

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

async function buildWorld() {
    const tenantId = ++tenantCounter;
    const pool = await lab.tenantDatabase();
    const server = await lab.startApi(pool, { tenantId });
    const world = { tenantId, pool, server, ids: {}, tabs: [] };
    // a person in the company, created with a given role / system access; `claims` is what the BROWSER believes (it may be wrong)
    world.person = async (name, { role = "employee", access = "employee", status = "active", employmentStatus = "active", claims } = {}) => {
        world.ids[name] = await lab.addUser(pool, name, { role, access, status, employmentStatus });
        return world.ids[name];
    };
    world.join = async (name, claims) => {
        const [row] = (await pool.query("SELECT role, system_access FROM users WHERE id = ?", [world.ids[name]]))[0];
        const tab = await joinVault({ vault, sessionModule, apiModule, server, tenantId, userId: world.ids[name], role: claims ? claims.role : row.role, systemAccess: claims ? claims.systemAccess : row.system_access }, PW(name));
        world.tabs.push(tab);
        return tab;
    };
    world.raw = (name, method, route, body) => rawCall(server, world.ids[name], method, route, body);
    return world;
}

const draftOf = (extra = {}) => ({ kind: "login", title: MARK.title, url: "", username: "root", password: MARK.password, notes: "", folderUid: null, favorite: false, rotationIntervalDays: null, fields: [], ...extra });
const refused = (promise, status = 403) => assert.rejects(promise, (e) => e && e.name === "VaultApiError" && e.status === status);

test("MATRIX: every role x system_access combination - the server allows collection creation and offboarding exactly when role = 'admin' OR system_access = 'super_admin'", { skip: SKIP }, async () => {
    const world = await buildWorld();
    const allowedCombos = [];
    for (const role of ROLES) {
        for (const access of ACCESS) {
            const name = `${role}-${access}`;
            await world.person(name, { role, access });
            const tab = await world.join(name);
            const should = expectedAdmin(role, access);
            if (should) allowedCombos.push(name);
            assert.equal(tab.session.snapshot().canCreateCollections, should, `${name}: the screen offers the button exactly when the server would allow it`);
            if (should) {
                const uid = await tab.session.createCollection({ name: `Collection of ${name}` });
                assert.ok(uid, `${name} can create a collection`);
                assert.equal((await world.raw(name, "GET", "/offboarding/people")).status, 200, `${name} can list people for offboarding`);
            } else {
                await refused(tab.session.createCollection({ name: `Nope ${name}` }));
                assert.equal((await world.raw(name, "GET", "/offboarding/people")).status, 403, `${name} cannot list people for offboarding`);
                assert.equal((await world.raw(name, "POST", "/offboarding/1/revoke-access", { confirm: true })).status, 403, `${name} cannot end anyone's access`);
            }
        }
    }
    assert.deepEqual(allowedCombos.sort(), ["admin-admin", "admin-employee", "admin-executive", "admin-department_head", "admin-hr", "admin-manager", "admin-super_admin", "admin-team_lead", "employee-super_admin"].sort(),
        "exactly: every admin-role account, and a Super Admin whatever the role");
    assert.ok(!allowedCombos.includes("employee-admin"), "a plain system_access of 'admin' does NOT qualify unless the role is also 'admin'");
    const [collections] = await world.pool.query("SELECT count(*)::int AS n FROM zv_collections");
    assert.equal(collections[0].n, allowedCombos.length, "one collection per allowed combination, none for the refused ones");
});

test("STATUS: an account that is not active cannot administer anything, whatever its role or access", { skip: SKIP }, async () => {
    const world = await buildWorld();
    for (const [label, change] of [
        ["status inactive", "UPDATE users SET status = 'inactive' WHERE id = ?"],
        ["employment resigned", "UPDATE users SET employment_status = 'resigned' WHERE id = ?"],
        ["employment terminated", "UPDATE users SET employment_status = 'terminated' WHERE id = ?"],
    ]) {
        const name = `cto-${label.replace(/\W/g, "")}`;
        await world.person(name, { role: "employee", access: "super_admin" });
        const tab = await world.join(name);
        assert.ok(await tab.session.createCollection({ name: "while active" }), `${label}: allowed while active`);
        await world.pool.query(change, [world.ids[name]]);
        await refused(tab.session.createCollection({ name: "after" }));
        assert.equal((await world.raw(name, "GET", "/offboarding/people")).status, 403, `${label}: offboarding refused`);
        assert.equal((await world.raw(name, "GET", "/collections")).status, 403, `${label}: nothing at all is served to an inactive account`);
    }
    // (a NULL employment status exists only in the legacy database, where the CRM's login counts it as active; that case is covered by the migration tests)
});

test("THE DATABASE DECIDES, NOT THE BROWSER: a wrong claim in the page changes what is shown, never what is allowed; a demotion or promotion applies on the next request", { skip: SKIP }, async () => {
    const world = await buildWorld();
    // a plain employee whose page CLAIMS to be an admin: the button shows, the server refuses
    await world.person("liar", { role: "employee", access: "employee" });
    const liar = await world.join("liar", { role: "admin", systemAccess: "super_admin" });
    assert.equal(liar.session.snapshot().canCreateCollections, true, "the (wrong) claim shows the button");
    await refused(liar.session.createCollection({ name: "forged" }));
    assert.equal((await world.raw("liar", "GET", "/offboarding/people")).status, 403);
    // a real Super Admin whose page claims nothing: no button, but the server (which reads the row) still allows it
    await world.person("modest", { role: "employee", access: "super_admin" });
    const modest = await world.join("modest", { role: "employee", systemAccess: "employee" });
    assert.equal(modest.session.snapshot().canCreateCollections, false);
    assert.ok(await modest.session.createCollection({ name: "allowed by the row" }));

    // demotion: takes effect on the very next request, no new login needed
    await world.person("cto", { role: "employee", access: "super_admin" });
    const cto = await world.join("cto");
    const kept = await cto.session.createCollection({ name: "made while Super Admin" });
    await world.pool.query("UPDATE users SET system_access = 'executive' WHERE id = ?", [world.ids.cto]);
    await refused(cto.session.createCollection({ name: "after demotion" }));
    assert.equal((await world.raw("cto", "GET", "/offboarding/people")).status, 403);
    // ... but what the person created stays theirs by EXPLICIT MEMBERSHIP, which does not depend on the role
    await cto.session.reload();
    assert.equal(cto.session.snapshot().collections.find((c) => c.uid === kept).rights.manage, true, "membership, not the role, keeps the manager rights");
    // promotion: also immediate
    await world.pool.query("UPDATE users SET system_access = 'super_admin' WHERE id = ?", [world.ids.cto]);
    assert.ok(await cto.session.createCollection({ name: "after promotion" }));
});

test("BOOTSTRAP: a Super Admin with the employee role creates the first company collection and becomes its manager with real key envelopes", { skip: SKIP }, async () => {
    const world = await buildWorld();
    await world.person("cto", { role: "employee", access: "super_admin" }); // designation CTO
    await world.person("bob"); await world.person("cy");
    const cto = await world.join("cto");
    assert.equal(cto.session.snapshot().canCreateCollections, true);
    const col = await cto.session.createCollection({ name: MARK.collection, description: "the first one" });

    // the creator is the first member: manager, every right, and their OWN key envelopes (made in their browser)
    const [member] = (await world.pool.query("SELECT is_manager, can_reveal, can_copy, can_edit, can_share, wrapped_meta_key, wrapped_secret_key, sender_user_id FROM zv_collection_members WHERE user_id = ?", [world.ids.cto]));
    assert.equal(member.length, 1);
    assert.deepEqual([member[0].is_manager, member[0].can_reveal, member[0].can_copy, member[0].can_edit, member[0].can_share], [true, true, true, true, true]);
    assert.ok(member[0].wrapped_meta_key.length >= 73 && member[0].wrapped_secret_key.length >= 73, "both key envelopes exist");
    assert.equal(member[0].sender_user_id, world.ids.cto, "wrapped by the creator's own key pair");
    const [stored] = await world.pool.query("SELECT name_ciphertext FROM zv_collections");
    assert.ok(!stored[0].name_ciphertext.toString("latin1").includes("Executive"), "the server holds only the encrypted name");
    assert.equal(cto.session.snapshot().collections.find((c) => c.uid === col).name, MARK.collection, "and the creator reads it with their own key");

    // from there everything is explicit membership
    const bob = await world.join("bob"); const cy = await world.join("cy"); // (a person must have set up their own vault before they can be added)
    await cto.session.addMember(col, { userId: world.ids.bob, rights: { reveal: true } });
    await cto.session.addMember(col, { userId: world.ids.cy, rights: {} });
    const item = await cto.session.createCompanyItem(col, draftOf());
    assert.equal((await bob.session.revealItem(item)).password, MARK.password);
    await refused(cy.session.revealItem(item));
    assert.equal((await world.pool.query("SELECT count(*)::int AS n FROM zv_collections"))[0][0].n, 1);
    assert.ok(!cto.sent().includes(MARK.password) && !cto.sent().includes(MARK.collection), "nothing but ciphertext was sent");
});

test("SUPER ADMIN IS NOT ACCESS: a Super Admin who is not a member gets 404 for the collection and everything in it, and nobody can read a personal vault", { skip: SKIP }, async () => {
    const world = await buildWorld();
    await world.person("cto", { role: "employee", access: "super_admin" });
    await world.person("cto2", { role: "employee", access: "super_admin" }); // another Super Admin, NOT a member
    await world.person("adminrole", { role: "admin", access: "super_admin" });
    await world.person("plain", { role: "employee", access: "admin" });
    await world.person("bob");
    const cto = await world.join("cto"); const cto2 = await world.join("cto2"); const adminrole = await world.join("adminrole"); const plain = await world.join("plain"); const bob = await world.join("bob");
    const col = await cto.session.createCollection({ name: MARK.collection });
    await cto.session.addMember(col, { userId: world.ids.bob, rights: { reveal: true, edit: true } });
    const item = await cto.session.createCompanyItem(col, draftOf());
    const mine = await bob.session.createItem(draftOf({ title: MARK.personal, password: MARK.personalPw }));
    await bob.session.shareItem(mine, { recipientUserId: world.ids.cto, rights: {} }).catch(() => {}); // a share to one person is a share to that person only

    for (const name of ["cto2", "adminrole", "plain"]) {
        assert.deepEqual((await world.raw(name, "GET", "/collections")).data, [], `${name}: lists no collection`);
        for (const [method, route, body] of [
            ["GET", `/collections/${col}`], ["PATCH", `/collections/${col}`, {}], ["POST", `/collections/${col}/archive`], ["POST", `/collections/${col}/items`, {}], ["POST", `/collections/${col}/rotate`, {}],
            ["POST", `/collections/${col}/members`, { userId: world.ids[name], rights: {} }], ["GET", `/items/${item}`], ["POST", `/items/${item}/secret`], ["GET", `/items/${item}/attachments`],
        ]) {
            assert.equal((await world.raw(name, method, route, body)).status, 404, `${name}: ${method} ${route} must look like it does not exist`);
        }
        assert.equal((await world.raw(name, "GET", `/items/${mine}`)).status, 404, `${name}: another person's personal item does not exist for them`);
        assert.equal((await world.raw(name, "POST", `/items/${mine}/secret`)).status, 404, `${name}: and its secret is not served`);
        assert.equal((await world.raw(name, "GET", "/audit/company")).status, 403, `${name}: manages nothing, so sees no company activity`);
    }
    // cannot add themselves to it either (that needs an existing manager: the loop above already got 404 for POST /members)
    assert.deepEqual(cto2.session.snapshot().collections, []);
    // plain admin access: no administration at all
    assert.equal((await world.raw("plain", "GET", "/offboarding/people")).status, 403);
    await refused(plain.session.createCollection({ name: "no" }));
    // a Super Admin sees WHO has company access (counts only) and may end it; Bob's own vault stays his
    const people = await cto2.session.loadOffboardingPeople();
    assert.ok(!JSON.stringify(people).match(/PERSONAL-MARKER|BOBPRIVATE|TITLE-MARKER|COLLECTION-MARKER/), "counts and names only");
    assert.equal(people.find((p) => p.name === "bob").memberships, 1);
    // ending access of the only manager's collection is refused; ending Bob's (a plain member) works
    const sole = await world.raw("cto2", "POST", `/offboarding/${world.ids.cto}/revoke-access`, { confirm: true });
    assert.equal(sole.status, 409); assert.equal(sole.body.code, "SOLE_MANAGER");
    const done = await cto2.session.revokeCompanyAccess(world.ids.bob);
    assert.equal(done.membershipsRemoved, 1);
    await bob.session.reload();
    assert.equal(bob.session.snapshot().collections.length, 0, "Bob lost the company collection");
    assert.equal((await bob.session.revealItem(mine)).password, MARK.personalPw, "and kept his personal vault, which the Super Admin never saw");
    assert.ok(!cto2.sent().includes(MARK.personalPw) && !cto2.record.responses.join("").includes(MARK.personalPw));
    for (const needle of [MARK.password, MARK.personalPw, MARK.title, MARK.collection, "correct horse"]) assert.ok(!logged.join("\n").includes(needle), `console holds ${needle}`);
});
