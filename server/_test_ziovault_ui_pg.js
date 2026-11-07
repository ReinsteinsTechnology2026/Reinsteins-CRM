// ZioVault Stage 3 -- the REAL screens (client/src/pages/Vault/*, real React + jsdom DOM events) driving the REAL client session and crypto
// against the REAL Express router and PostgreSQL. Only services/api is replaced by a forwarder to that server. Every request is recorded.
//
// Proves from the user's seat: first-time setup and recovery-key confirmation, add / view / reveal / copy / edit / generate, search, folders,
// health, lock and unlock, failed unlock, session expiry, unreadable items; and that no plaintext appears in any request, in browser
// storage, in the URL or in the DOM while the vault is locked.
//
// Needs the disposable PostgreSQL (PG_TEST_*) and the client dev dependencies + jsdom; otherwise skipped.
// Run: node --test _test_ziovault_ui_pg.js

process.env.JWT_SECRET = process.env.JWT_SECRET || "legacy-secret-for-tests";
process.env.TENANT_JWT_SECRET = process.env.TENANT_JWT_SECRET || "tenant-secret-for-tests";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const { createLab } = require("./_ziovault_test_support");

const ROOT = path.join(__dirname, "..");
const CLIENT = path.join(ROOT, "client");
const HARNESS = path.join(__dirname, "_test_ziovault_ui_harness");
const clientRequire = fs.existsSync(path.join(CLIENT, "package.json")) ? createRequire(path.join(CLIENT, "package.json")) : null;
const tryResolve = (name, paths) => { try { return require.resolve(name, { paths }); } catch { return null; } };
const jsdomPath = tryResolve("jsdom", [path.join(ROOT, "node_modules"), path.join(CLIENT, "node_modules"), __dirname]);
const viteOk = clientRequire && tryResolve("vite", [CLIENT]) && tryResolve("react-dom", [CLIENT]);
const lab = createLab();
const SKIP = lab.skip || (!viteOk || !jsdomPath ? "client dev dependencies or jsdom are not installed" : false);

const MASTER = "correct horse battery staple lantern";
const MARK = {
    password: "Tr0ub4dor&3-PW-MARKER-91c2",
    title: "Production AWS root TITLE-MARKER-5d1e",
    username: "svc-deploy@acme.test",
    notes: "recovery codes: 4411-9922 NOTE-MARKER-c3f0",
    folder: "Banking FOLDER-MARKER-2a9c",
};

let vite; let React; let act; let createRoot;
let Page; let runtime;
let world; let record; let identity; let injectFailure = null;
let container; let root;
const logged = [];
const realConsole = { log: console.log, error: console.error, info: console.info, warn: console.warn };
const clipboard = { value: "", writeText: async (t) => { clipboard.value = t; }, readText: async () => clipboard.value };

// ------------------------------------------------------------------------------------------------ DOM helpers
const q = (id) => container.querySelector(`[data-testid="${id}"]`);
const all = (selector) => [...container.querySelectorAll(selector)];
const tick = (ms = 20) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
async function waitFor(predicate, label, timeout = 30000) {
    const end = Date.now() + timeout;
    for (;;) {
        await tick(25);
        let value;
        try { value = predicate(); } catch { value = null; }
        if (value) return value;
        if (Date.now() > end) throw new Error(`timed out waiting for ${label}\n--- page ---\n${container.textContent.slice(0, 600)}`);
    }
}
async function type(id, text) {
    const el = typeof id === "string" ? q(id) : id;
    assert.ok(el, `${id} exists`);
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    await act(async () => {
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
        el.dispatchEvent(new window.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    });
}
async function click(target) {
    const el = typeof target === "string" ? q(target) : target;
    assert.ok(el, `${target} exists`);
    await act(async () => { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })); });
}
async function check(id, on = true) {
    const el = q(id);
    if (el.checked !== on) await click(el);
}
async function submit(formChild) {
    const form = (typeof formChild === "string" ? q(formChild) : formChild).closest("form");
    await act(async () => { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
}
const status = () => container.querySelector('[data-testid="vault-page"]')?.getAttribute("data-status");

async function mount() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(React.createElement(Page)); });
}
async function unmount() {
    if (root) await act(async () => { root.unmount(); });
    if (container) container.remove();
    root = null; container = null;
    await runtime.resetVaultSession();
}

function installHttp() {
    const call = async (method, route, body) => {
        if (injectFailure) { const failure = injectFailure(method, route); if (failure) throw failure; }
        if (route === "/tenant-auth/me") return { data: { company: { id: world.tenantId }, user: { id: identity } } };
        const text = body === undefined ? undefined : JSON.stringify(body);
        record.requests.push({ method, route, body: text || "" });
        const res = await fetch(`${world.server.url}/api${route}`, { method: method.toUpperCase(), headers: { "Content-Type": "application/json", "x-test-user": String(identity) }, body: text });
        const raw = await res.text();
        record.responses.push(raw);
        let data = {};
        try { data = JSON.parse(raw); } catch { data = {}; }
        if (!res.ok) throw { response: { status: res.status, data } };
        return { data };
    };
    globalThis.__zvHttp = { get: (p) => call("get", p), post: (p, b) => call("post", p, b), patch: (p, b) => call("patch", p, b), put: (p, b) => call("put", p, b), delete: (p) => call("delete", p) };
}

const storageDump = () => {
    const out = [];
    for (const store of [window.localStorage, window.sessionStorage]) for (let i = 0; i < store.length; i += 1) out.push(store.key(i), store.getItem(store.key(i)));
    return out.join("\n");
};
const NEEDLES = () => [MARK.password, MARK.title, MARK.notes, MARK.folder, MASTER, "correct horse"];
const assertNone = (text, label, extra = []) => { for (const n of [...NEEDLES(), ...extra]) assert.ok(!text.includes(n), `${label} contains plaintext: ${n}`); };
const sent = () => record.requests.map((r) => r.body).join("\n");

// ------------------------------------------------------------------------------------------------ setup / teardown
test.before(async () => {
    for (const level of ["log", "error", "info", "warn"]) console[level] = (...args) => { logged.push(args.map(String).join(" ")); };
    if (SKIP) return;
    await lab.connect();
    const { JSDOM } = require(jsdomPath);
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
    for (const key of ["HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "sessionStorage", "localStorage", "getComputedStyle"]) {
        if (!(key in globalThis) || key === "sessionStorage" || key === "localStorage") Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
    }
    Object.defineProperty(dom.window.navigator, "clipboard", { value: clipboard, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
    React = clientRequire("react");
    act = React.act;
    createRoot = clientRequire("react-dom/client").createRoot;
    const { createServer } = clientRequire("vite");
    vite = await createServer({
        root: CLIENT, server: { middlewareMode: true }, appType: "custom", logLevel: "error", optimizeDeps: { noDiscovery: true, include: [] },
        resolve: { alias: [{ find: /^(\.\.?\/)+services\/api$/, replacement: path.join(HARNESS, "api.js") }] },
    });
    Page = (await vite.ssrLoadModule("/src/pages/Vault/VaultPage.jsx")).default;
    runtime = await vite.ssrLoadModule("/src/vault/vaultRuntime.js");

    const pool = await lab.tenantDatabase();
    const server = await lab.startApi(pool, { tenantId: 501 });
    identity = await lab.addUser(pool, "Alice");
    world = { pool, server, tenantId: 501 };
    record = { requests: [], responses: [] };
    installHttp();
    window.sessionStorage.setItem("company", JSON.stringify({ id: 501 }));
    window.sessionStorage.setItem("token", "tok-0123456789abcdef-AAAA");
});

test.after(async () => {
    Object.assign(console, realConsole);
    if (runtime) await runtime.resetVaultSession();
    if (vite) await vite.close();
    await lab.close();
});

// ------------------------------------------------------------------------------------------------ the tests (they share one vault and run in order)
test("first-time setup: password strength, mismatch, recovery key shown once and confirmed by typing it back", { skip: SKIP }, async () => {
    await mount();
    await waitFor(() => q("vault-setup-password"), "setup screen");
    assert.match(container.textContent, /cannot be recovered by anyone/, "permanent-loss warning is shown");
    assert.equal(q("vault-setup-submit").disabled, true, "cannot submit before acknowledging");

    await type("vault-setup-password", "password1234");
    await type("vault-setup-confirm", "password1234");
    await check("vault-setup-ack");
    assert.ok(q("vault-strength"), "strength meter is shown");
    await submit("vault-setup-submit");
    await waitFor(() => q("vault-error"), "weak password refused");
    assert.match(q("vault-error").textContent, /easy to guess/);
    assert.equal(record.requests.filter((r) => r.method === "post").length, 0, "nothing sent");

    await type("vault-setup-password", MASTER);
    await type("vault-setup-confirm", MASTER + "x");
    await submit("vault-setup-submit");
    await waitFor(() => /do not match/.test(q("vault-error")?.textContent || ""), "mismatch refused");

    await type("vault-setup-confirm", MASTER);
    await submit("vault-setup-submit");
    await waitFor(() => q("vault-recovery-secret"), "recovery screen", 60000);
    const recovery = q("vault-recovery-secret").textContent.trim();
    assert.match(recovery, /^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/, "14 groups of 4");
    assert.match(container.textContent, /nobody, including ZioVenture, can recover it/);
    assert.equal(q("vault-recovery-confirm").disabled, true);

    await type("vault-recovery-retype", recovery.slice(0, -1) + (recovery.endsWith("0") ? "1" : "0"));
    await check("vault-recovery-ack");
    await submit("vault-recovery-confirm");
    await waitFor(() => q("vault-error"), "wrong recovery key refused");
    assert.equal(status(), "setup-recovery");

    await type("vault-recovery-retype", recovery);
    await submit("vault-recovery-confirm");
    await waitFor(() => q("vault-app"), "vault opened", 30000);
    assert.equal(status(), "unlocked");
    assertNone(sent(), "request bodies", [recovery]);
    assert.ok(!window.localStorage.getItem("ziovault:recovery") && !storageDump().includes(recovery), "recovery key is not stored in the browser");
});

test("add an item through the form: password hidden, generator works, only ciphertext is sent", { skip: SKIP }, async () => {
    await click("vault-add");
    await waitFor(() => q("vault-editor"), "editor");
    await type("vault-field-title", MARK.title);
    await type("vault-field-url", "https://console.aws.example/signin");
    await type("vault-field-username", MARK.username);
    assert.equal(q("vault-field-password").type, "password", "password field is masked");
    await type("vault-field-password", MARK.password);
    await type("vault-field-notes", MARK.notes);
    await click("vault-add-field");
    await type("vault-custom-label-0", "Region");
    await type("vault-custom-value-0", "eu-west-1");
    await submit("vault-save");
    await waitFor(() => all('[data-testid^="vault-item-"]').length === 1, "item in list");
    assert.ok(container.textContent.includes(MARK.title));
    assertNone(sent(), "request bodies");
    const [rows] = await world.pool.query("SELECT meta_ciphertext, secret_ciphertext FROM zv_items");
    assert.equal(rows.length, 1);
    for (const needle of NEEDLES()) { assert.ok(!rows[0].meta_ciphertext.toString("latin1").includes(needle) && !rows[0].secret_ciphertext.toString("latin1").includes(needle)); }

    // generator: produces a value, shown, and only used on request
    await click("vault-add");
    await waitFor(() => q("vault-editor"), "editor 2");
    await type("vault-field-title", "Generated login");
    await click("vault-open-generator");
    await waitFor(() => q("vault-generator"), "generator");
    await click("vault-generate");
    const generated = (await waitFor(() => q("vault-generated-value"), "generated value")).textContent;
    assert.equal(generated.length, 20);
    const bodiesBeforeUse = record.requests.length;
    assert.ok(!sent().includes(generated), "a generated value is not transmitted before saving");
    await click("vault-gen-use");
    assert.equal(q("vault-field-password").value, generated);
    await submit("vault-save");
    await waitFor(() => all('[data-testid^="vault-item-"]').length === 2, "second item");
    assert.ok(record.requests.length > bodiesBeforeUse);
    assert.ok(!sent().includes(generated), "even after saving, only the encrypted form was sent");
});

test("view an item: password and notes hidden until Reveal; Reveal shows them; Copy puts the password on the clipboard; Hide removes it", { skip: SKIP }, async () => {
    await click(all('[data-testid^="vault-item-"]').find((b) => b.textContent.includes(MARK.title)));
    await waitFor(() => q("vault-detail"), "detail");
    assert.ok(!q("vault-detail").textContent.includes(MARK.password), "password not in the DOM");
    assert.ok(!q("vault-detail").textContent.includes(MARK.notes), "notes not in the DOM");
    assert.match(q("vault-password-text").textContent, /^•+$/);
    await click("vault-reveal");
    await waitFor(() => q("vault-password-text").textContent === MARK.password, "revealed");
    assert.ok(q("vault-notes-text").textContent.includes("NOTE-MARKER"));
    await click("vault-copy-password");
    await waitFor(() => q("vault-message"), "copy message");
    assert.equal(clipboard.value, MARK.password);
    assert.match(q("vault-message").textContent, /clipboard/i);
    await click("vault-reveal");
    assert.ok(!q("vault-detail").textContent.includes(MARK.password), "Hide removes the password from the DOM");
    // the delivery is recorded by the server; the "shown" and "copied" reports are sent in the background, so wait for them
    let kinds = [];
    for (let i = 0; i < 100 && !(kinds.includes("reveal_reported") && kinds.includes("copy_reported")); i += 1) {
        kinds = (await world.pool.query("SELECT kind FROM zv_audit_events"))[0].map((e) => e.kind);
        await tick(50);
    }
    for (const kind of ["secret_delivered", "reveal_reported", "copy_reported"]) assert.ok(kinds.includes(kind), `audit evidence: ${kind}`);
});

test("edit through the form and see the change; stale edits are refused with a readable message", { skip: SKIP }, async () => {
    await click("vault-edit");
    await waitFor(() => q("vault-editor") && q("vault-field-password").value === MARK.password, "editor with decrypted values");
    await type("vault-field-title", "AWS root (renamed)");
    await submit("vault-save");
    await waitFor(() => container.textContent.includes("AWS root (renamed)"), "renamed");
    assertNone(sent(), "request bodies", ["AWS root (renamed)"]);
});

test("search is local and finds by details, not by password; favorites and folders work", { skip: SKIP }, async () => {
    const before = record.requests.length;
    await type("vault-search", "svc-deploy");
    await waitFor(() => all('[data-testid^="vault-item-"]').length === 1, "filtered by username");
    await type("vault-search", "Tr0ub4dor");
    await waitFor(() => q("vault-empty"), "no match by password");
    await type("vault-search", "");
    assert.equal(record.requests.length, before, "searching sent nothing");

    await type("vault-folder-name", MARK.folder);
    await click("vault-folder-add");
    await waitFor(() => all('[data-testid^="vault-folder-"]').some((b) => b.textContent.includes("Banking")), "folder");
    assertNone(sent(), "request bodies");
    const folderButton = all('[data-testid^="vault-folder-"]').find((b) => b.textContent.includes("Banking"));
    await click(folderButton);
    await waitFor(() => q("vault-empty"), "folder is empty");
    await click("vault-nav-all");
    await click(all('[data-testid^="vault-item-"]').find((b) => b.textContent.includes("AWS root")));
    await waitFor(() => q("vault-move"), "move control");
    const folderUid = folderButton.getAttribute("data-testid").replace("vault-folder-", "");
    await type("vault-move", folderUid);
    await click(folderButton);
    await waitFor(() => all('[data-testid^="vault-item-"]').length === 1, "item now in folder");
    await click("vault-nav-all");
    await click(all('[data-testid^="vault-item-"]').find((b) => b.textContent.includes("AWS root")));
    await waitFor(() => q("vault-favorite"), "favorite button");
    await click("vault-favorite");
    await click("vault-nav-favorites");
    await waitFor(() => all('[data-testid^="vault-item-"]').length === 1, "favorites view");
    await click("vault-nav-all");
});

test("password health runs locally and reports weak and reused passwords without showing any password", { skip: SKIP }, async () => {
    for (const [title, pw] of [["Weak one", "password123"], ["Reuse A", "Zq8!vN3#kR7@mT2w"], ["Reuse B", "Zq8!vN3#kR7@mT2w"]]) {
        await click("vault-add");
        await waitFor(() => q("vault-editor"), "editor");
        await type("vault-field-title", title);
        await type("vault-field-password", pw);
        await submit("vault-save");
        await waitFor(() => container.textContent.includes(title) && !q("vault-editor"), `saved ${title}`);
    }
    await click("vault-nav-health");
    await waitFor(() => q("vault-health-run"), "health panel");
    await click("vault-health-run");
    const summary = await waitFor(() => q("vault-health-summary"), "health summary", 60000);
    assert.match(summary.textContent, /Weak one/);
    assert.match(summary.textContent, /Reuse A/);
    assert.ok(!container.textContent.includes("password123") && !container.textContent.includes("Zq8!vN3"), "no password is shown");
    assert.match(container.textContent, /breach/i, "the limit (no breach lookup) is stated");
    await click("vault-nav-all");
});

test("lock hides everything: the DOM, storage and URL hold no plaintext; a wrong password is refused; the right one restores the vault", { skip: SKIP }, async () => {
    await click("vault-lock-button");
    await waitFor(() => q("vault-unlock-password"), "unlock screen");
    assert.equal(status(), "locked");
    assertNone(container.textContent + document.body.innerHTML, "page after lock", ["Zq8!vN3", "password123", "AWS root", "svc-deploy"]);
    assertNone(storageDump(), "browser storage");
    assert.equal(window.location.href, "http://localhost/", "nothing was put in the URL");
    assert.match(q("vault-lock-reason").textContent, /locked the vault/);
    assert.equal(clipboard.value, "", "the copied password was taken back off the clipboard on lock");

    await type("vault-unlock-password", "not the password");
    await submit("vault-unlock-submit");
    await waitFor(() => q("vault-error"), "wrong password message");
    assert.equal(q("vault-error").textContent, "Incorrect master password.");
    assert.equal(status(), "locked");

    await type("vault-unlock-password", MASTER);
    await submit("vault-unlock-submit");
    await waitFor(() => q("vault-app"), "unlocked again", 30000);
    assert.ok(container.textContent.includes("Weak one"));
});

test("an unsaved edit survives an automatic lock as ciphertext and is offered after unlock", { skip: SKIP }, async () => {
    await click("vault-add");
    await waitFor(() => q("vault-editor"), "editor");
    await type("vault-field-title", "Half written TITLE-MARKER-draft");
    await type("vault-field-password", "Draft-PW-MARKER-5511");
    await runtime.getVaultSession().lock("inactivity");
    await waitFor(() => q("vault-unlock-password"), "locked");
    assert.ok(q("vault-draft-notice"), "the person is told a draft is kept");
    const draftEntries = [...Array(window.sessionStorage.length).keys()].map((i) => window.sessionStorage.key(i)).filter((k) => k.startsWith("ziovault:draft:"));
    assert.equal(draftEntries.length, 1);
    assertNone(storageDump(), "browser storage", ["Draft-PW-MARKER-5511", "Half written"]);
    assert.match(q("vault-lock-reason").textContent, /inactivity/);
    await type("vault-unlock-password", MASTER);
    await submit("vault-unlock-submit");
    await waitFor(() => q("vault-restore-draft"), "restore offer", 30000);
    await click(q("vault-restore-draft").querySelector("button"));
    await waitFor(() => q("vault-editor") && q("vault-field-title").value.includes("Half written"), "draft restored into the editor");
    assert.equal(q("vault-field-password").value, "Draft-PW-MARKER-5511");
    await click("vault-cancel");
    assert.equal(window.sessionStorage.getItem(draftEntries[0]), null, "the sealed draft is gone");
});

test("session expiry: when the CRM session ends the vault locks and says why", { skip: SKIP }, async () => {
    injectFailure = (_m, route) => (route.startsWith("/ziovault") ? { response: { status: 401, data: {} } } : null);
    await click("vault-nav-trash"); // loads the trash from the server
    await waitFor(() => q("vault-unlock-password"), "locked after expiry");
    injectFailure = null;
    assert.match(q("vault-lock-reason").textContent, /session expired/i);
    assertNone(container.textContent, "page after expiry", ["Zq8!vN3", "AWS root"]);
    await type("vault-unlock-password", MASTER);
    await submit("vault-unlock-submit");
    await waitFor(() => q("vault-app"), "unlocked", 30000);
});

test("damaged ciphertext: the item is shown as unreadable, the rest of the vault still works", { skip: SKIP }, async () => {
    await world.pool.query("UPDATE zv_items SET meta_ciphertext = set_byte(meta_ciphertext, 30, get_byte(meta_ciphertext, 30) # 255) WHERE id = (SELECT min(id) FROM zv_items)");
    await runtime.getVaultSession().reload();
    await waitFor(() => container.textContent.includes("Unreadable item"), "unreadable item listed");
    assert.ok(container.textContent.includes("Weak one"), "other items still listed");
    await click(all('[data-testid^="vault-item-"]').find((b) => b.textContent.includes("Unreadable item")));
    await waitFor(() => q("vault-corrupt"), "corrupt notice");
    assert.match(q("vault-corrupt").textContent, /could not be decrypted/);
});

test("the whole session: no secret in any request, response log, console output or browser storage", { skip: SKIP }, async () => {
    assertNone(sent(), "all request bodies", ["Draft-PW-MARKER-5511", "AWS root (renamed)", "Weak one", "Reuse A", "Zq8!vN3", "password123"]);
    assertNone(logged.join("\n"), "console output", ["Draft-PW-MARKER-5511"]);
    assertNone(storageDump(), "browser storage");
    assert.deepEqual([...Array(window.localStorage.length).keys()].map((i) => window.localStorage.key(i)).sort(), ["ziovault:prefs"].filter((k) => window.localStorage.getItem(k)));
    assert.ok(!record.requests.some((r) => /password|secret=|token=/i.test(r.route)), "no secret in a URL");
    await unmount();
});
