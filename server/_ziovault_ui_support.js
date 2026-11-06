// Shared harness for rendering the REAL ZioVault screens (React + jsdom, through the client's own Vite) against the REAL Express router
// and PostgreSQL. Only services/api is replaced by a forwarder to that server. Used by the Stage 4 screen tests.

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");
const CLIENT = path.join(ROOT, "client");
const HARNESS = path.join(__dirname, "_test_ziovault_ui_harness");

const clientRequire = fs.existsSync(path.join(CLIENT, "package.json")) ? createRequire(path.join(CLIENT, "package.json")) : null;
const tryResolve = (name, paths) => { try { return require.resolve(name, { paths }); } catch { return null; } };
const jsdomPath = tryResolve("jsdom", [path.join(ROOT, "node_modules"), path.join(CLIENT, "node_modules"), __dirname]);
const viteOk = Boolean(clientRequire && tryResolve("vite", [CLIENT]) && tryResolve("react-dom", [CLIENT]));
const uiAvailable = viteOk && Boolean(jsdomPath);

function createUiHarness() {
    const h = { clipboard: { value: "", writeText: async (t) => { h.clipboard.value = t; }, readText: async () => h.clipboard.value } };
    let vite; let React; let act; let createRoot; let Page; let container = null; let root = null;
    h.runtime = null;
    h.world = null; // { server, tenantId }
    h.identity = { id: 0, role: "employee" };
    h.record = { requests: [], responses: [] };
    h.injectFailure = null;

    h.q = (id) => container.querySelector(`[data-testid="${id}"]`);
    h.all = (selector) => [...container.querySelectorAll(selector)];
    h.text = () => container.textContent;
    h.act = (fn) => act(fn);
    h.tick = (ms = 20) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
    h.waitFor = async (predicate, label, timeout = 30000) => {
        const end = Date.now() + timeout;
        for (;;) {
            await h.tick(25);
            let value;
            try { value = predicate(); } catch { value = null; }
            if (value) return value;
            if (Date.now() > end) throw new Error(`timed out waiting for ${label}\n--- page ---\n${container.textContent.slice(0, 700)}`);
        }
    };
    h.type = async (id, text) => {
        const el = typeof id === "string" ? h.q(id) : id;
        if (!el) throw new Error(`${id} not found`);
        const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
        await act(async () => {
            Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
            el.dispatchEvent(new window.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
        });
    };
    h.click = async (target) => {
        const el = typeof target === "string" ? h.q(target) : target;
        if (!el) throw new Error(`${target} not found`);
        await act(async () => { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })); });
    };
    h.check = async (id, on = true) => {
        const el = h.q(id);
        if (!el) throw new Error(`${id} not found`);
        if (el.checked !== on) await h.click(el);
    };
    h.submit = async (child) => {
        const el = typeof child === "string" ? h.q(child) : child;
        if (!el) throw new Error(`${child} not found`);
        await act(async () => { el.closest("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    };
    h.status = () => container.querySelector('[data-testid="vault-page"]')?.getAttribute("data-status");
    h.button = (label) => h.all("button").find((b) => b.textContent.trim().startsWith(label));

    h.boot = async ({ lab }) => {
        const { JSDOM } = require(jsdomPath);
        const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
        Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
        for (const key of ["HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "sessionStorage", "localStorage", "getComputedStyle"]) {
            if (!(key in globalThis) || key === "sessionStorage" || key === "localStorage") Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
        }
        Object.defineProperty(dom.window.navigator, "clipboard", { value: h.clipboard, configurable: true });
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
        h.runtime = await vite.ssrLoadModule("/src/vault/vaultRuntime.js");
        void lab;
        const call = async (method, route, body) => {
            if (h.injectFailure) { const failure = h.injectFailure(method, route); if (failure) throw failure; }
            if (route === "/tenant-auth/me") return { data: { company: { id: h.world.tenantId }, user: { id: h.identity.id, role: h.identity.role } } };
            const text = body === undefined ? undefined : JSON.stringify(body);
            h.record.requests.push({ method, route, body: text || "", user: h.identity.id });
            const res = await fetch(`${h.world.server.url}/api${route}`, { method: method.toUpperCase(), headers: { "Content-Type": "application/json", "x-test-user": String(h.identity.id) }, body: text });
            const raw = await res.text();
            h.record.responses.push(raw);
            let data = {};
            try { data = JSON.parse(raw); } catch { data = {}; }
            if (!res.ok) throw { response: { status: res.status, data } };
            return { data };
        };
        globalThis.__zvHttp = { get: (p) => call("get", p), post: (p, b) => call("post", p, b), patch: (p, b) => call("patch", p, b), put: (p, b) => call("put", p, b), delete: (p) => call("delete", p) };
    };

    h.mount = async () => {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => { root.render(React.createElement(Page)); });
    };
    h.unmount = async () => {
        if (root) await act(async () => { root.unmount(); });
        if (container) container.remove();
        root = null; container = null;
        await h.runtime.resetVaultSession();
    };
    h.signInAs = async (identity, token) => {
        await h.unmount();
        h.identity = identity;
        window.sessionStorage.setItem("company", JSON.stringify({ id: h.world.tenantId }));
        window.sessionStorage.setItem("token", token);
        await h.mount();
    };
    h.storageDump = () => {
        const out = [];
        for (const store of [window.localStorage, window.sessionStorage]) for (let i = 0; i < store.length; i += 1) out.push(store.key(i), store.getItem(store.key(i)));
        return out.join("\n");
    };
    h.close = async () => {
        if (h.runtime) await h.runtime.resetVaultSession();
        if (vite) await vite.close();
    };
    h.sent = () => h.record.requests.map((r) => r.body).join("\n");

    // the first-time setup flow through the real screens; returns the recovery key that was shown
    h.uiSetup = async (password) => {
        await h.waitFor(() => h.q("vault-setup-password"), "setup screen");
        await h.type("vault-setup-password", password);
        await h.type("vault-setup-confirm", password);
        await h.check("vault-setup-ack");
        await h.submit("vault-setup-submit");
        await h.waitFor(() => h.q("vault-recovery-secret"), "recovery screen", 60000);
        const recovery = h.q("vault-recovery-secret").textContent.trim();
        await h.type("vault-recovery-retype", recovery);
        await h.check("vault-recovery-ack");
        await h.submit("vault-recovery-confirm");
        await h.waitFor(() => h.q("vault-app"), "vault opened", 30000);
        return recovery;
    };
    h.uiUnlock = async (password) => {
        await h.waitFor(() => h.q("vault-unlock-password"), "unlock screen");
        await h.type("vault-unlock-password", password);
        await h.submit("vault-unlock-submit");
        await h.waitFor(() => h.q("vault-app"), "vault unlocked", 30000);
    };
    return h;
}

module.exports = { createUiHarness, uiAvailable };
