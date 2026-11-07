// Shared harness for the ZioVault tests that drive the REAL client session (client/src/vault/vaultSession.js + vaultApi.js + the Stage 1
// crypto) against the REAL Express router and a REAL PostgreSQL database. Every request and response body is recorded so a test can prove
// what did, and did not, leave the browser.

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const VAULT_DIR = path.join(__dirname, "..", "client", "src", "vault");
const load = (name) => import(pathToFileURL(path.join(VAULT_DIR, name)).href);
const FAST = { alg: "argon2id13", ops: 2, mem: 32 * 1024 * 1024 };

const memoryStorage = () => {
    const map = new Map();
    return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
};

// An axios-like stand-in that talks to the real server and records every request and response body.
function makeHttp(url, userId, record, hooks = {}) {
    const call = async (method, route, body) => {
        if (hooks.fail) { const failure = hooks.fail(method, route); if (failure) throw failure; }
        const text = body === undefined ? undefined : JSON.stringify(body);
        record.requests.push({ method, route, body: text || "" });
        const res = await fetch(`${url}/api${route}`, { method: method.toUpperCase(), headers: { "Content-Type": "application/json", "x-test-user": String(userId) }, body: text });
        const raw = await res.text();
        record.responses.push(raw);
        if (hooks.dropResponse && hooks.dropResponse(method, route)) throw new Error("connection lost"); // the server DID handle it; the browser never heard back
        let data = {};
        try { data = JSON.parse(raw); } catch { data = {}; }
        if (!res.ok) throw { response: { status: res.status, data } };
        return { data };
    };
    return { get: (p) => call("get", p), post: (p, b) => call("post", p, b), patch: (p, b) => call("patch", p, b), put: (p, b) => call("put", p, b), delete: (p) => call("delete", p) };
}

// controllable clock + timers, to test auto-lock without waiting (short timers, such as the "let the screen paint" pause, stay real)
function makeClock() {
    const clock = { time: 1_800_000_000_000, timers: new Map(), seq: 0 };
    clock.now = () => clock.time;
    clock.setTimer = (fn, ms) => { if (ms < 1000) return setTimeout(fn, ms); clock.seq += 1; clock.timers.set(clock.seq, { fn, at: clock.time + ms }); return clock.seq; };
    clock.clearTimer = (id) => { if (typeof id === "object") clearTimeout(id); else clock.timers.delete(id); };
    clock.advance = async (ms) => {
        clock.time += ms;
        for (const [id, t] of [...clock.timers]) if (t.at <= clock.time) { clock.timers.delete(id); await t.fn(); }
    };
    return clock;
}

// One signed-in person in one browser tab, against one tenant's server.
async function newTab({ vault, sessionModule, apiModule, server, tenantId, userId, role = "employee", hooks, clock = makeClock() }) {
    const record = { requests: [], responses: [] };
    const http = makeHttp(server.url, userId, record, hooks);
    const drafts = memoryStorage();
    const storage = memoryStorage();
    const session = sessionModule.createVaultSession({
        api: apiModule.createVaultApi(http), vault, kdf: FAST, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
        getIdentity: async () => ({ tenantId, userId, role }),
        prefsStore: { load: () => ({}), save: (p) => storage.setItem("ziovault:prefs", JSON.stringify(p)) },
        draftStorage: drafts, channel: null,
    });
    return { session, record, clock, http, userId, tenantId, storage, drafts, sent: () => record.requests.map((r) => r.body).join("\n") };
}

async function joinVault(tabOptions, password) {
    const tab = await newTab(tabOptions);
    await tab.session.init();
    if (tab.session.snapshot().status !== "no-account") throw new Error(`expected no vault, got ${tab.session.snapshot().status}`);
    await tab.session.setup(password, password);
    await tab.session.confirmRecovery(tab.session.snapshot().recoverySecret);
    if (tab.session.snapshot().status !== "unlocked") throw new Error(`could not unlock: ${tab.session.snapshot().error}`);
    tab.password = password;
    return tab;
}

// a direct request that does not go through the client session (what a hostile or modified client could send)
async function rawCall(server, userId, method, route, body, record) {
    const res = await fetch(`${server.url}/api/ziovault${route}`, {
        method, headers: { "Content-Type": "application/json", "x-test-user": String(userId) }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (record) record.responses.push(text);
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, body: json, data: json && json.data, text };
}

module.exports = { load, FAST, memoryStorage, makeHttp, makeClock, newTab, joinVault, rawCall };
