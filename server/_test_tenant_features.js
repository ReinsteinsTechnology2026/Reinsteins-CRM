// Tenant feature management -- catalog, API gate, Socket.IO gate, Owner API, live revalidation, backward compatibility.
// Real Express/Socket.IO servers, the real gate/controller/service code, real JWTs; only the databases are replaced by
// in-memory fakes. (The PostgreSQL side -- table, migration, backfill, cascade -- is _test_company_features_pg.js.)
// Run: node --test _test_tenant_features.js

process.env.JWT_SECRET = process.env.JWT_SECRET || "legacy-secret-for-tests";
process.env.TENANT_JWT_SECRET = process.env.TENANT_JWT_SECRET || "tenant-secret-for-tests";
process.env.PLATFORM_JWT_SECRET = process.env.PLATFORM_JWT_SECRET || "platform-secret-for-tests";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

const catalog = require("./config/tenantFeatures");
const { FEATURE_IDS, FEATURES, FEATURE_BY_ID, CORE_API_PREFIXES, API_RULES } = catalog;
const { createFeatureGate, DISABLED_MESSAGE } = require("./middleware/featureGate");
const { createCompanyFeatureService } = require("./services/companyFeatureService");
const { createOnTenantEvent } = require("./services/socketFeatureGate");
const { applyFeatureChange } = require("./services/featureRealtimeService");
const { presenceRoom } = require("./utils/socketRooms");
const { COMPANY_FEATURES_DDL } = require("./schemas/companyFeaturesDdl");

const read = (...parts) => fs.readFileSync(path.join(__dirname, ...parts), "utf8").replace(/\r\n/g, "\n");
const appSource = read("app.js");

// ------------------------------------------------------------------------------------------------ fake platform data

function makePlatform() {
    const companies = new Map([
        [1, { id: 1, company_slug: "acme", company_name: "Acme" }],
        [2, { id: 2, company_slug: "beta", company_name: "Beta" }],
        [3, { id: 3, company_slug: "legacyco", company_name: "Old Co" }], // never configured: no feature rows
    ]);
    const rows = new Map([
        [1, new Map(FEATURE_IDS.map((id) => [id, ["dashboard", "employee_management", "attendance", "task_management"].includes(id)]))],
        [2, new Map(FEATURE_IDS.map((id) => [id, ["dashboard", "employee_management", "attendance", "chat", "meetings", "smart_sheets"].includes(id)]))],
    ]);
    const pool = {
        async query(sql, params) {
            const company = rows.get(Number(params[0]));
            return [company ? [...company].map(([feature_id, enabled]) => ({ feature_id, enabled })) : []];
        },
    };
    const clock = { value: 1000 };
    const service = createCompanyFeatureService({ pool, now: () => clock.value });
    return { companies, rows, pool, clock, service };
}

const tenantToken = (companyId, companySlug, secret = process.env.TENANT_JWT_SECRET) => {
    const { TENANT_JWT_ISSUER, TENANT_JWT_AUDIENCE } = require("./controllers/tenantAuthController");
    return jwt.sign({ userId: 1, companyId, companySlug, type: "tenant_user" }, secret, { expiresIn: "1h", issuer: TENANT_JWT_ISSUER, audience: TENANT_JWT_AUDIENCE });
};
const legacyToken = () => jwt.sign({ id: 1, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

async function listen(app) {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
}
const call = async (url, route, token, options = {}) => {
    const res = await fetch(`${url}${route}`, { method: options.method || "GET", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: options.body ? JSON.stringify(options.body) : undefined });
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    return { status: res.status, body };
};

// An API where each module's route answers with that module's stored data; the route's own authentication is a stand-in that
// answers 401 for a request without a usable token (like the real `protect`).
async function startApi(platform, { failing = false } = {}) {
    const data = { chat: ["hello from chat"], smart_sheets: ["budget"], task_management: ["task 1"] };
    const gate = createFeatureGate({
        getCompanyById: async (id) => (failing ? Promise.reject(new Error("platform db down")) : platform.companies.get(Number(id)) || null),
        getEnabledFeatureIds: (id) => platform.service.getEnabledFeatureIds(id),
    });
    const app = express();
    app.use("/api", gate);
    const authenticated = (req, res, next) => (req.headers.authorization ? next() : res.status(401).json({ success: false, message: "Authentication required" }));
    app.get("/api/chat/conversations", authenticated, (req, res) => res.json({ success: true, data: data.chat }));
    app.get("/api/smart-sheets", authenticated, (req, res) => res.json({ success: true, data: data.smart_sheets }));
    app.get("/api/tasks", authenticated, (req, res) => res.json({ success: true, data: data.task_management }));
    app.get("/api/employees/profile/me", authenticated, (req, res) => res.json({ success: true, me: true }));
    app.get("/api/employees", authenticated, (req, res) => res.json({ success: true, employees: [] }));
    app.get("/api/reports/tasks", authenticated, (req, res) => res.json({ success: true, report: "tasks" }));
    app.get("/api/reports/export/leave", authenticated, (req, res) => res.json({ success: true, report: "leave" }));
    app.get("/api/notifications", authenticated, (req, res) => res.json({ success: true, notifications: [] }));
    const started = await listen(app);
    return { ...started, data };
}

// ------------------------------------------------------------------------------------------------ catalog integrity

test("catalog: stable snake_case ids, unique, every dependency exists and there are no cycles", () => {
    assert.equal(new Set(FEATURE_IDS).size, FEATURE_IDS.length);
    for (const feature of FEATURES) {
        assert.match(feature.id, /^[a-z]+(_[a-z]+)*$/, `${feature.id} is a stable identifier`);
        assert.ok(feature.name && feature.description, `${feature.id} has a name and a description for the Owner Portal`);
        for (const required of feature.requires) assert.ok(FEATURE_BY_ID[required], `${feature.id} requires a real feature`);
    }
    const visiting = new Set();
    const visit = (id) => {
        assert.ok(!visiting.has(id), `dependency cycle through ${id}`);
        visiting.add(id);
        FEATURE_BY_ID[id].requires.forEach(visit);
        visiting.delete(id);
    };
    FEATURE_IDS.forEach(visit);
});

test("catalog: every real CRM module is in it (the modules the repository actually has)", () => {
    for (const id of ["dashboard", "employee_management", "attendance", "leave_management", "shift_management", "task_management", "techops", "reports", "chat", "meetings", "sops", "smart_sheets", "email"]) {
        assert.ok(FEATURE_BY_ID[id], id);
    }
});

test("DRIFT GUARD: every /api route group mounted in app.js is feature-gated or explicitly core", () => {
    const mounts = [...appSource.matchAll(/app\.use\(\s*"(\/api\/[a-z-]+)"/g)].map((match) => match[1]);
    assert.ok(mounts.length > 25, "found the mounts");
    const unclassified = mounts.filter((mount) => !CORE_API_PREFIXES.includes(mount) && !catalog.featuresForApiPath(`${mount}/x`).gated);
    assert.deepEqual(unclassified, [], "a route group nobody classified would silently bypass the feature gate");
});

test("DRIFT GUARD: every Socket.IO event registered by the server belongs to a feature or is explicitly ungated", () => {
    const events = [...appSource.matchAll(/onTenantEvent\(\s*"([a-z]+:[a-z-]+|[a-z]+)"/g)].map((match) => match[1]);
    const smartSheets = [...read("services", "smartSheetRealtime.js").matchAll(/onTenantEvent\("([a-z]+:[a-z-]+)"/g)].map((match) => match[1]);
    assert.ok(events.length >= 20 && smartSheets.length >= 3);
    const ungated = [...events, ...smartSheets].filter((event) => !catalog.featureForSocketEvent(event));
    assert.deepEqual([...new Set(ungated)], ["disconnect"], "only the disconnect event is not module traffic");
    assert.equal(catalog.featureForSocketEvent("meeting:join"), "meetings");
    assert.equal(catalog.featureForSocketEvent("call:start"), "chat");
    assert.equal(catalog.featureForSocketEvent("smartsheet:op"), "smart_sheets");
});

test("the platform schema file contains exactly the migration's DDL (a new platform database equals a migrated one)", () => {
    assert.ok(read("schemas", "platformSchema.postgresql.sql").includes(COMPANY_FEATURES_DDL));
});

test("the browser's path -> feature table agrees with the server's catalog", async () => {
    const { pathToFileURL } = require("url");
    const client = await import(pathToFileURL(path.join(__dirname, "..", "client", "src", "utils", "tenantFeatures.js")).href);
    const appJsx = read("..", "client", "src", "App.jsx").replace(/\r\n/g, "\n");
    const routes = [...appJsx.matchAll(/\{ path: "([^"]+)", Component/g)].map((match) => match[1]);
    assert.ok(routes.length > 30);
    for (const route of routes) {
        const feature = client.featureForSubPath(route);
        if (feature) assert.ok(FEATURE_BY_ID[feature], `${route} -> ${feature} is a real feature`);
    }
    // each module with API rules is reachable in the browser's table, and the pages the Owner can switch off are mapped
    const expected = { chat: "chat", meetings: "meetings", "smart-sheets": "smart_sheets", "shift-management": "shift_management", tasks: "task_management", projects: "techops", sops: "sops", email: "email", reports: "reports", leave: "leave_management", attendance: "attendance", employees: "employee_management" };
    for (const [segment, feature] of Object.entries(expected)) assert.equal(client.featureForSubPath(segment), feature, segment);
    assert.equal(client.featureForSubPath(""), "dashboard");
    assert.equal(client.featureForSubPath("settings"), null, "settings is always available");
    assert.equal(client.featureForSubPath("profile"), null, "my profile is always available");
    assert.equal(client.featureForSubPath("team/leave-approvals"), "leave_management");
});

test("the landing page for a company without a dashboard exists in BOTH portals for every module", async () => {
    const { pathToFileURL } = require("url");
    const client = await import(pathToFileURL(path.join(__dirname, "..", "client", "src", "utils", "tenantFeatures.js")).href);
    const appJsx = read("..", "client", "src", "App.jsx");
    const block = (name) => appJsx.slice(appJsx.indexOf(`const ${name} = [`), appJsx.indexOf("];", appJsx.indexOf(`const ${name} = [`)));
    const routes = { admin: [...block("ADMIN_ROUTES").matchAll(/{ path: "([^"]+)"/g)].map((m) => m[1]), employee: [...block("EMPLOYEE_ROUTES").matchAll(/{ path: "([^"]+)"/g)].map((m) => m[1]) };
    assert.ok(routes.admin.length > 15 && routes.employee.length > 15);
    for (const portal of ["admin", "employee"]) {
        let reachable = 0;
        for (const id of FEATURE_IDS.filter((feature) => feature !== "dashboard")) {
            const target = client.firstEnabledLanding([id], portal);
            if (target === null) continue; // a module with no page in this portal (e.g. company email in the admin portal)
            reachable += 1;
            assert.ok(routes[portal].includes(target), `${portal}: ${id} lands on "${target}", which is not a route of that portal`);
            assert.equal(client.featureForSubPath(target), id, `${portal}: "${target}" belongs to ${id}`);
        }
        assert.ok(reachable >= 10, portal);
        assert.equal(client.firstEnabledLanding([], portal), null);
    }
});

// ------------------------------------------------------------------------------------------------ selection rules

test("validateSelection: unknown ids, empty selections and missing dependencies are refused; a valid selection is normalised", () => {
    assert.equal(catalog.validateSelection("chat").code, "INVALID_FEATURES");
    assert.equal(catalog.validateSelection(["chat", "nope"]).code, "UNKNOWN_FEATURE");
    assert.equal(catalog.validateSelection([]).code, "EMPTY_SELECTION");

    const missing = catalog.validateSelection(["shift_management", "meetings"]);
    assert.equal(missing.code, "MISSING_DEPENDENCIES");
    assert.deepEqual(missing.missing, { shift_management: ["employee_management"], meetings: ["employee_management"] });
    assert.match(missing.message, /Shift Management requires Employee Management/);

    assert.equal(catalog.validateSelection(["techops"]).code, "MISSING_DEPENDENCIES");
    const ok = catalog.validateSelection(["meetings", "employee_management", "chat", "chat"]);
    assert.deepEqual(ok, { ok: true, features: ["employee_management", "chat", "meetings"] }, "deduplicated, in catalog order");
    assert.deepEqual(catalog.dependentsOf("employee_management", ["employee_management", "meetings", "chat"]), ["meetings"]);
});

// ------------------------------------------------------------------------------------------------ the service (semantics)

test("service: a company with no rows is unconfigured and gets every module; a configured company gets exactly its rows", async () => {
    const platform = makePlatform();
    assert.deepEqual(await platform.service.getFeatureStates(3), { configured: false, enabled: FEATURE_IDS });
    const acme = await platform.service.getFeatureStates(1);
    assert.equal(acme.configured, true);
    assert.deepEqual(acme.enabled, ["dashboard", "employee_management", "attendance", "task_management"]);
    assert.deepEqual((await platform.service.getFeatureStates(0)).enabled, [], "an unresolvable company gets nothing");
    assert.deepEqual((await platform.service.getFeatureStates("abc")).enabled, []);
});

test("service: a module added to the catalog later stays OFF for an already-configured company", async () => {
    const platform = makePlatform();
    platform.rows.get(1).delete("email"); // simulate a feature that did not exist when company 1 was configured
    assert.equal(await platform.service.isFeatureEnabled(1, "email"), false);
});

test("service: reads are cached for a few seconds, and invalidate() makes a change visible at once", async () => {
    const platform = makePlatform();
    let queries = 0;
    const counting = createCompanyFeatureService({ pool: { query: async (...args) => { queries += 1; return platform.pool.query(...args); } }, now: () => platform.clock.value });
    await counting.getEnabledFeatureIds(1);
    await counting.getEnabledFeatureIds(1);
    assert.equal(queries, 1, "second read served from the cache");
    platform.rows.get(1).set("chat", true);
    assert.equal((await counting.getEnabledFeatureIds(1)).includes("chat"), false, "still cached");
    counting.invalidate(1);
    assert.equal((await counting.getEnabledFeatureIds(1)).includes("chat"), true, "visible right after invalidate");
    platform.rows.get(1).set("chat", false);
    platform.clock.value += 5000;
    assert.equal((await counting.getEnabledFeatureIds(1)).includes("chat"), false, "and after the cache expires");
});

// ------------------------------------------------------------------------------------------------ API gate

test("API gate: a disabled module's API answers 403 FEATURE_NOT_ENABLED; enabled modules and core routes work", async () => {
    const platform = makePlatform();
    const api = await startApi(platform);
    try {
        const acme = tenantToken(1, "acme");
        const disabled = await call(api.url, "/api/chat/conversations", acme);
        assert.equal(disabled.status, 403);
        assert.equal(disabled.body.code, "FEATURE_NOT_ENABLED");
        assert.equal(disabled.body.message, DISABLED_MESSAGE);
        assert.deepEqual(disabled.body.features, ["chat"]);
        assert.equal(disabled.body.data, undefined, "no data of the disabled module leaks");
        assert.equal((await call(api.url, "/api/smart-sheets", acme)).status, 403, "Company A does not have Smart Sheets");

        assert.equal((await call(api.url, "/api/tasks", acme)).status, 200, "an enabled module works");
        assert.equal((await call(api.url, "/api/employees", acme)).status, 200);
        assert.equal((await call(api.url, "/api/employees/profile/me", acme)).status, 200, "my profile is always available");
        assert.equal((await call(api.url, "/api/notifications", acme)).status, 200, "notifications are always available");
    } finally {
        api.server.close();
    }
});

test("API gate: Company B gets its own modules (the same URLs, a different answer)", async () => {
    const platform = makePlatform();
    const api = await startApi(platform);
    try {
        const beta = tenantToken(2, "beta");
        assert.equal((await call(api.url, "/api/chat/conversations", beta)).status, 200);
        assert.equal((await call(api.url, "/api/smart-sheets", beta)).status, 200);
        const tasks = await call(api.url, "/api/tasks", beta);
        assert.equal(tasks.status, 403, "Company B does not have Task Management");
        assert.equal(tasks.body.code, "FEATURE_NOT_ENABLED");
    } finally {
        api.server.close();
    }
});

test("API gate: reports need the reports module AND the module whose data they read", async () => {
    const platform = makePlatform();
    const api = await startApi(platform);
    try {
        // Acme has task_management but not reports
        assert.deepEqual((await call(api.url, "/api/reports/tasks", tenantToken(1, "acme"))).body.features, ["reports"]);
        platform.rows.set(1, new Map(FEATURE_IDS.map((id) => [id, id === "reports" || id === "dashboard"])));
        platform.service.invalidate(1);
        const noTasks = await call(api.url, "/api/reports/tasks", tenantToken(1, "acme"));
        assert.equal(noTasks.status, 403);
        assert.deepEqual(noTasks.body.features, ["task_management"], "reports on, but the task data module is off");
        assert.deepEqual((await call(api.url, "/api/reports/export/leave", tenantToken(1, "acme"))).body.features, ["leave_management"]);
    } finally {
        api.server.close();
    }
});

test("API gate: the caller's identity comes only from the SIGNED token -- not from headers, query or body", async () => {
    const platform = makePlatform();
    const api = await startApi(platform);
    try {
        const acme = tenantToken(1, "acme");
        const res = await fetch(`${api.url}/api/chat/conversations?companyId=2&companySlug=beta`, {
            headers: { Authorization: `Bearer ${acme}`, "x-company-id": "2", "x-company-slug": "beta" },
        });
        assert.equal(res.status, 403, "pretending to be Company B changes nothing");

        // a token for Company 2 whose slug does not match the company: ignored by the gate, the route's authentication decides
        const mismatched = await call(api.url, "/api/chat/conversations", tenantToken(1, "beta"));
        assert.notEqual(mismatched.body?.data, undefined, "the gate did not treat the mismatched token as tenant 1 or 2 (passes to authentication)");
        // a token signed with a different secret is not a tenant token at all
        const forged = await call(api.url, "/api/chat/conversations", jwt.sign({ userId: 1, companyId: 2, companySlug: "beta", type: "tenant_user" }, "attacker-secret"));
        assert.notEqual(forged.status, 403, "not recognised as any tenant: left to the route's own authentication");
    } finally {
        api.server.close();
    }
});

test("API gate: no token is passed through untouched (the route answers 401) -- the gate never describes features to strangers", async () => {
    const platform = makePlatform();
    const api = await startApi(platform);
    try {
        const anonymous = await call(api.url, "/api/chat/conversations", null);
        assert.equal(anonymous.status, 401);
        assert.equal(anonymous.body.code, undefined);
    } finally {
        api.server.close();
    }
});

test("API gate: a legacy Reinsteins session keeps every module (the legacy database is not feature-managed)", async () => {
    const platform = makePlatform();
    const api = await startApi(platform);
    try {
        for (const route of ["/api/chat/conversations", "/api/smart-sheets", "/api/tasks", "/api/employees"]) {
            assert.equal((await call(api.url, route, legacyToken())).status, 200, route);
        }
    } finally {
        api.server.close();
    }
});

test("EXISTING TENANTS: a company that was never configured keeps every module", async () => {
    const platform = makePlatform();
    const api = await startApi(platform);
    try {
        const old = tenantToken(3, "legacyco");
        for (const route of ["/api/chat/conversations", "/api/smart-sheets", "/api/tasks", "/api/employees", "/api/reports/tasks"]) {
            assert.equal((await call(api.url, route, old)).status, 200, route);
        }
    } finally {
        api.server.close();
    }
});

test("API gate fails CLOSED: if the configuration cannot be read, a gated module is not served", async () => {
    const platform = makePlatform();
    const api = await startApi(platform, { failing: true });
    const quiet = console.error;
    console.error = () => {};
    try {
        const res = await call(api.url, "/api/tasks", tenantToken(1, "acme"));
        assert.equal(res.status, 503);
        assert.equal(res.body.data, undefined);
    } finally {
        console.error = quiet;
        api.server.close();
    }
});

test("UPDATING FEATURES: a change is seen on the very next request, and re-enabling restores access to the module's existing data", async () => {
    const platform = makePlatform();
    const api = await startApi(platform);
    try {
        const acme = tenantToken(1, "acme");
        assert.equal((await call(api.url, "/api/tasks", acme)).body.data[0], "task 1");

        // the Owner switches Task Management off (what setCompanyFeatures does: rewrite the rows, drop the cache entry)
        platform.rows.get(1).set("task_management", false);
        platform.service.invalidate(1);
        const off = await call(api.url, "/api/tasks", acme);
        assert.equal(off.status, 403);
        assert.equal(off.body.data, undefined);
        assert.deepEqual(api.data.task_management, ["task 1"], "switching a module off deletes nothing");

        // ... and on again: the data is exactly where it was
        platform.rows.get(1).set("task_management", true);
        platform.service.invalidate(1);
        const back = await call(api.url, "/api/tasks", acme);
        assert.equal(back.status, 200);
        assert.deepEqual(back.body.data, ["task 1"], "existing data is available again");
    } finally {
        api.server.close();
    }
});

// ------------------------------------------------------------------------------------------------ signed-file route

test("uploaded files: a folder written by a disabled module is not served; core folders are", () => {
    assert.equal(catalog.featureForUploadPath("/uploads/tenant_acme/chat/files/a.pdf"), "chat");
    assert.equal(catalog.featureForUploadPath("/uploads/tenant_acme/meetings/images/a.png"), "meetings");
    assert.equal(catalog.featureForUploadPath("/uploads/tenant_acme/tasks/a.pdf"), "task_management");
    assert.equal(catalog.featureForUploadPath("/uploads/tenant_acme/sops/a.pdf"), "sops");
    assert.equal(catalog.featureForUploadPath("/uploads/tenant_acme/profiles/a.jpg"), null);
    assert.equal(catalog.featureForUploadPath("/uploads/tenant_acme/branding/logo.png"), null);
    assert.equal(catalog.featureForUploadPath("/uploads/profiles/legacy.jpeg"), null, "legacy files are not feature-managed");
    assert.match(appSource, /featureForUploadPath\(requestedPath\)/, "the file route applies it");
});

// ------------------------------------------------------------------------------------------------ Socket.IO gate

function loadSocketClient() {
    return require(require.resolve("socket.io-client", { paths: [path.join(__dirname, "..", "client"), __dirname] }));
}

async function startSockets(platform, { failing = false } = {}) {
    const httpServer = http.createServer();
    const io = new Server(httpServer, { cors: { origin: true } });
    const handled = [];
    io.use((socket, next) => {
        const token = String(socket.handshake.auth.token);
        // token "acme" / "beta" -> tenant sockets with the companyId from the (already verified) token; "legacy" -> no companyId
        const company = { acme: 1, beta: 2, legacyco: 3 }[token];
        socket.tenantContext = token === "legacy" ? { tenantPool: null, companySlug: "reinsteins" } : { tenantPool: {}, companySlug: token, companyId: company };
        next();
    });
    io.on("connection", (socket) => {
        const onTenantEvent = createOnTenantEvent({
            socket,
            getEnabledFeatureIds: (id) => (failing ? Promise.reject(new Error("db down")) : platform.service.getEnabledFeatureIds(id)),
            runWithTenantContext: (context, fn) => fn(),
        });
        socket.join(presenceRoom(socket.tenantContext.companySlug));
        for (const event of ["meeting:join", "conversation:join", "smartsheet:join", "smartsheet:op", "call:start", "presence:ping"]) {
            onTenantEvent(event, (payload, ack) => {
                handled.push(`${socket.tenantContext.companySlug}:${event}`);
                if (typeof ack === "function") ack({ ok: true, event });
            });
        }
    });
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${httpServer.address().port}`;
    const { io: connect } = loadSocketClient();
    const clients = [];
    return {
        io, handled,
        async client(token) {
            const socket = connect(url, { auth: { token }, transports: ["websocket"], reconnection: false, forceNew: true });
            clients.push(socket);
            await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
            return socket;
        },
        async close() {
            clients.forEach((socket) => socket.close());
            await io.close();
        },
    };
}

const ask = (socket, event, payload = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 3000);
    socket.emit(event, payload, (answer) => { clearTimeout(timer); resolve(answer); });
});

test("SOCKET: events of a disabled module are refused before the handler runs; enabled ones work", async () => {
    const platform = makePlatform();
    const sockets = await startSockets(platform);
    try {
        const acme = await sockets.client("acme"); // dashboard, employees, attendance, tasks
        for (const event of ["meeting:join", "conversation:join", "smartsheet:join", "smartsheet:op", "call:start"]) {
            const answer = await ask(acme, event);
            assert.equal(answer.code, "FEATURE_NOT_ENABLED", event);
            assert.equal(answer.success, false);
        }
        assert.deepEqual(sockets.handled, [], "no handler of a disabled module ran");

        const beta = await sockets.client("beta"); // chat, meetings, smart sheets
        for (const event of ["meeting:join", "conversation:join", "smartsheet:join", "smartsheet:op"]) assert.equal((await ask(beta, event)).ok, true, event);
        assert.equal((await ask(beta, "call:start")).ok, true, "calls belong to chat, which beta has");
        assert.ok(sockets.handled.every((entry) => entry.startsWith("beta:")));
    } finally {
        await sockets.close();
    }
});

test("SOCKET: an event without an acknowledgement callback is answered with feature:not-enabled", async () => {
    const platform = makePlatform();
    const sockets = await startSockets(platform);
    try {
        const acme = await sockets.client("acme");
        const refused = new Promise((resolve) => acme.once("feature:not-enabled", resolve));
        acme.emit("meeting:join", { meetingId: 1 });
        const message = await refused;
        assert.equal(message.code, "FEATURE_NOT_ENABLED");
        assert.equal(message.event, "meeting:join");
        assert.deepEqual(sockets.handled, []);
    } finally {
        await sockets.close();
    }
});

test("SOCKET: ungated events and legacy sockets are unaffected", async () => {
    const platform = makePlatform();
    const sockets = await startSockets(platform);
    try {
        const acme = await sockets.client("acme");
        assert.equal((await ask(acme, "presence:ping")).ok, true, "an event that belongs to no module");
        const legacy = await sockets.client("legacy");
        for (const event of ["meeting:join", "smartsheet:join", "conversation:join"]) assert.equal((await ask(legacy, event)).ok, true, `legacy ${event}`);
        const old = await sockets.client("legacyco"); // never configured -> every module
        assert.equal((await ask(old, "smartsheet:join")).ok, true);
    } finally {
        await sockets.close();
    }
});

test("SOCKET: switching a feature off takes effect for a socket that is ALREADY connected (and back on restores it)", async () => {
    const platform = makePlatform();
    const sockets = await startSockets(platform);
    try {
        const beta = await sockets.client("beta");
        assert.equal((await ask(beta, "smartsheet:join")).ok, true);

        platform.rows.get(2).set("smart_sheets", false);
        platform.service.invalidate(2);
        assert.equal((await ask(beta, "smartsheet:op")).code, "FEATURE_NOT_ENABLED", "the very next event is refused");
        assert.equal((await ask(beta, "meeting:join")).ok, true, "other modules keep working");

        platform.rows.get(2).set("smart_sheets", true);
        platform.service.invalidate(2);
        assert.equal((await ask(beta, "smartsheet:join")).ok, true, "restored");
    } finally {
        await sockets.close();
    }
});

test("SOCKET: events keep their order while being checked, and the gate fails closed", async () => {
    const platform = makePlatform();
    const sockets = await startSockets(platform);
    try {
        const beta = await sockets.client("beta");
        const order = [];
        await Promise.all([1, 2, 3, 4, 5].map((n) => new Promise((resolve) => beta.emit(n % 2 ? "smartsheet:join" : "smartsheet:op", { n }, () => { order.push(n); resolve(); }))));
        assert.deepEqual(order, [1, 2, 3, 4, 5]);
    } finally {
        await sockets.close();
    }

    const broken = await startSockets(platform, { failing: true });
    const quiet = console.error;
    console.error = () => {};
    try {
        const beta = await broken.client("beta");
        assert.equal((await ask(beta, "smartsheet:join")).code, "FEATURE_NOT_ENABLED", "unreadable configuration = refused");
        assert.equal((await ask(beta, "presence:ping")).ok, true, "events that are not module traffic still work");
    } finally {
        console.error = quiet;
        await broken.close();
    }
});

test("LIVE REVALIDATION: the Owner's change notifies that company's open sessions only and removes them from the module's live rooms", async () => {
    const platform = makePlatform();
    const sockets = await startSockets(platform);
    try {
        const beta = await sockets.client("beta");
        const acme = await sockets.client("acme");
        const betaServer = [...sockets.io.sockets.sockets.values()].find((socket) => socket.tenantContext.companySlug === "beta");
        betaServer.join("tenant:beta:smartsheet:5");
        betaServer.join("tenant:beta:meeting:9");
        betaServer.join("tenant:beta:conversation:3");

        const betaHeard = new Promise((resolve) => beta.once("tenant:features-changed", resolve));
        let acmeHeard = false;
        acme.on("tenant:features-changed", () => { acmeHeard = true; });

        const result = applyFeatureChange(sockets.io, "beta", {
            before: ["dashboard", "employee_management", "attendance", "chat", "meetings", "smart_sheets"],
            after: ["dashboard", "employee_management", "attendance", "chat"],
        });
        assert.equal(result.notified, true);
        assert.equal(result.roomsLeft, 2, "the spreadsheet room and the meeting room");

        const message = await betaHeard;
        assert.deepEqual(message.features, ["dashboard", "employee_management", "attendance", "chat"]);
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(acmeHeard, false, "Company A was not told about Company B's change");
        assert.equal(betaServer.rooms.has("tenant:beta:smartsheet:5"), false);
        assert.equal(betaServer.rooms.has("tenant:beta:meeting:9"), false);
        assert.equal(betaServer.rooms.has("tenant:beta:conversation:3"), true, "chat was not switched off");
    } finally {
        await sockets.close();
    }
});

// ------------------------------------------------------------------------------------------------ Owner API (controller)

function useStubs(overrides) {
    const restore = [];
    for (const [target, name, fn] of overrides) {
        const original = target[name];
        target[name] = fn;
        restore.push(() => { target[name] = original; });
    }
    return () => restore.reverse().forEach((undo) => undo());
}
const makeRes = () => {
    const res = { statusCode: 200, body: null, status(code) { res.statusCode = code; return res; }, json(body) { res.body = body; return res; } };
    return res;
};

function ownerHarness() {
    const state = { stored: new Map(), created: [], deletedPending: [], audit: [], provisioned: [], saveFails: false, io: null };
    const platformCompanyService = require("./services/platformCompanyService");
    const tenantProvisioningService = require("./services/tenantProvisioningService");
    const platformAuditService = require("./services/platformAuditService");
    const companyFeatureService = require("./services/companyFeatureService");
    const restore = useStubs([
        [platformCompanyService, "createPendingCompany", async (input) => { const company = { id: 40 + state.created.length, ...input }; state.created.push(company); return company; }],
        [platformCompanyService, "deletePendingCompany", async (id) => { state.deletedPending.push(id); }],
        [platformCompanyService, "activateCompany", async (id, db) => ({ id, company_name: "Fresh", company_slug: "fresh", status: "active", access_type: "trial", tenant_db_name: db, created_at: new Date() })],
        [platformCompanyService, "getCompanyById", async (id) => (id === 1 ? { id: 1, company_slug: "acme", company_name: "Acme", status: "active" } : id === 2 ? { id: 2, company_slug: "beta", company_name: "Beta", status: "active" } : null)],
        [tenantProvisioningService, "provisionTenantDatabase", async ({ databaseName }) => { state.provisioned.push(databaseName); return { success: true }; }],
        [platformAuditService, "logAction", async (entry) => { state.audit.push(entry); }],
        [companyFeatureService, "setCompanyFeatures", async (companyId, ids) => {
            if (state.saveFails) throw new Error("db down");
            const before = state.stored.get(companyId) || [...FEATURE_IDS];
            state.stored.set(companyId, ids);
            return { before, after: ids };
        }],
        [companyFeatureService, "getFeatureStates", async (companyId) => ({ configured: state.stored.has(companyId), enabled: state.stored.get(companyId) || [...FEATURE_IDS] })],
    ]);
    const controller = require("./controllers/platformCompanyController");
    const request = (body, params = {}) => ({ body, params, platformUser: { id: 9 }, app: { get: () => state.io } });
    return { state, controller, request, restore };
}

const quietly = async (work) => {
    const original = { log: console.log, error: console.error };
    console.log = () => {};
    console.error = () => {};
    try { return await work(); } finally { Object.assign(console, original); }
};

test("OWNER: the catalog endpoint lists every module with name, description and dependencies", async () => {
    const { controller, restore } = ownerHarness();
    try {
        const res = makeRes();
        await controller.getFeatureCatalog({}, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.features.length, FEATURE_IDS.length);
        const meetings = res.body.features.find((feature) => feature.id === "meetings");
        assert.deepEqual(meetings.requires, ["employee_management"]);
        assert.ok(meetings.name && meetings.description);
    } finally {
        restore();
    }
});

test("CREATE COMPANY: the selected features are saved with the company, and ONLY those", async () => {
    const { state, controller, request, restore } = ownerHarness();
    try {
        const res = makeRes();
        const selection = ["dashboard", "employee_management", "attendance", "task_management"];
        await quietly(() => controller.createCompany(request({ companyName: "Company A", companySlug: "company_a", accessType: "trial", features: selection }), res));
        assert.equal(res.statusCode, 201, JSON.stringify(res.body));
        assert.deepEqual(res.body.company.features, selection);
        assert.deepEqual(state.stored.get(state.created[0].id), selection, "exactly the selection was persisted");
        assert.ok(!state.stored.get(state.created[0].id).includes("chat"), "an unselected module is not enabled");
        assert.deepEqual(state.audit[0].metadata.features, selection, "the audit log records what was granted");
    } finally {
        restore();
    }
});

test("CREATE COMPANY: a company with only a few modules, and one with a different set", async () => {
    const { state, controller, request, restore } = ownerHarness();
    try {
        const small = makeRes();
        await quietly(() => controller.createCompany(request({ companyName: "Small Co", companySlug: "small_co", accessType: "trial", features: ["dashboard", "sops"] }), small));
        assert.equal(small.statusCode, 201);
        const b = makeRes();
        const second = ["dashboard", "employee_management", "attendance", "chat", "meetings", "smart_sheets"];
        await quietly(() => controller.createCompany(request({ companyName: "Company B", companySlug: "company_b", accessType: "paid", features: second }), b));
        assert.deepEqual(state.stored.get(state.created[0].id), ["dashboard", "sops"]);
        assert.deepEqual(state.stored.get(state.created[1].id), second);
    } finally {
        restore();
    }
});

test("CREATE COMPANY: an invalid selection is refused BEFORE anything is created or provisioned", async () => {
    const { state, controller, request, restore } = ownerHarness();
    try {
        for (const [features, code] of [[["chat", "made_up"], "UNKNOWN_FEATURE"], [[], "EMPTY_SELECTION"], [["shift_management"], "MISSING_DEPENDENCIES"], ["chat", "INVALID_FEATURES"]]) {
            const res = makeRes();
            await quietly(() => controller.createCompany(request({ companyName: "Bad Co", companySlug: "bad_co", accessType: "trial", features }), res));
            assert.equal(res.statusCode, 400);
            assert.equal(res.body.code, code);
        }
        assert.deepEqual(state.created, [], "no company row");
        assert.deepEqual(state.provisioned, [], "no tenant database");
    } finally {
        restore();
    }
});

test("CREATE COMPANY: omitting `features` (an older caller) gives every module; failing to save the features cancels the creation", async () => {
    const { state, controller, request, restore } = ownerHarness();
    try {
        const all = makeRes();
        await quietly(() => controller.createCompany(request({ companyName: "Old Caller", companySlug: "old_caller", accessType: "trial" }), all));
        assert.equal(all.statusCode, 201);
        assert.deepEqual(state.stored.get(state.created[0].id), FEATURE_IDS);

        state.saveFails = true;
        const failed = makeRes();
        await quietly(() => controller.createCompany(request({ companyName: "Unlucky", companySlug: "unlucky", accessType: "trial", features: ["dashboard"] }), failed));
        assert.equal(failed.statusCode, 500);
        assert.deepEqual(state.deletedPending, [state.created[1].id], "the pending company was removed");
        assert.equal(state.provisioned.length, 1, "and no second tenant database was provisioned");
    } finally {
        restore();
    }
});

test("EDIT COMPANY FEATURES: view, enable more, disable some, save -- audited and pushed to the company's open sessions", async () => {
    const { state, controller, request, restore } = ownerHarness();
    try {
        const emitted = [];
        state.io = {
            sockets: { adapter: { rooms: new Map([["tenant:acme:chat-none", new Set()]]) } },
            to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
            in: () => ({ socketsLeave() {} }),
        };
        state.stored.set(1, ["dashboard", "employee_management", "attendance", "task_management"]);

        const view = makeRes();
        await controller.getCompanyFeatures(request({}, { id: "1" }), view);
        assert.deepEqual(view.body.features, ["dashboard", "employee_management", "attendance", "task_management"]);
        assert.equal(view.body.configured, true);

        const next = ["dashboard", "employee_management", "attendance", "chat", "meetings"]; // enable chat+meetings, disable tasks
        const save = makeRes();
        await controller.updateCompanyFeatures(request({ features: next }, { id: "1" }), save);
        assert.equal(save.statusCode, 200);
        assert.deepEqual(state.stored.get(1), next);

        assert.deepEqual(emitted, [{ room: presenceRoom("acme"), event: "tenant:features-changed", payload: { features: next } }]);
        assert.deepEqual(state.audit.at(-1).metadata.enabled, ["chat", "meetings"]);
        assert.deepEqual(state.audit.at(-1).metadata.disabled, ["task_management"]);
        assert.equal(state.audit.at(-1).actionType, "company_features_updated");
    } finally {
        restore();
    }
});

test("EDIT COMPANY FEATURES: dependencies are explained, never silently resolved; bad input and unknown companies are refused", async () => {
    const { state, controller, request, restore } = ownerHarness();
    try {
        state.stored.set(1, ["dashboard", "employee_management", "meetings"]);
        const refused = makeRes();
        await controller.updateCompanyFeatures(request({ features: ["dashboard", "meetings"] }, { id: "1" }), refused); // drops employee_management but keeps meetings
        assert.equal(refused.statusCode, 400);
        assert.equal(refused.body.code, "MISSING_DEPENDENCIES");
        assert.deepEqual(refused.body.missing, { meetings: ["employee_management"] });
        assert.deepEqual(state.stored.get(1), ["dashboard", "employee_management", "meetings"], "nothing changed");

        for (const [params, body, status] of [[{ id: "999" }, { features: ["dashboard"] }, 404], [{ id: "abc" }, { features: ["dashboard"] }, 400], [{ id: "1" }, { features: ["bogus"] }, 400], [{ id: "1" }, {}, 400]]) {
            const res = makeRes();
            await controller.updateCompanyFeatures(request(body, params), res);
            assert.equal(res.statusCode, status, JSON.stringify([params, body]));
        }
        const missing = makeRes();
        await controller.getCompanyFeatures(request({}, { id: "999" }), missing);
        assert.equal(missing.statusCode, 404);
    } finally {
        restore();
    }
});

// ------------------------------------------------------------------------------------------------ tenant isolation of the configuration itself

test("ISOLATION: a tenant (even its admin) cannot read or change any company's feature configuration -- the Owner routes only accept an Owner token", async () => {
    const routes = read("routes", "platformCompanyRoutes.js");
    for (const route of [`router.get("/features/catalog", platformProtect`, `router.get("/:id/features", platformProtect`, `router.put("/:id/features", platformProtect`]) {
        assert.ok(routes.includes(route), `${route} is behind platformProtect`);
    }

    // exercised for real: the actual router + the actual platformProtect against a tenant token and a legacy token
    const app = express();
    app.use(express.json());
    app.use("/api/platform/companies", require("./routes/platformCompanyRoutes"));
    const { server, url } = await listen(app);
    try {
        for (const token of [tenantToken(2, "beta"), tenantToken(1, "acme"), legacyToken(), null]) {
            assert.equal((await call(url, "/api/platform/companies/1/features", token)).status, 401, "read");
            assert.equal((await call(url, "/api/platform/companies/1/features", token, { method: "PUT", body: { features: FEATURE_IDS } })).status, 401, "write");
            assert.equal((await call(url, "/api/platform/companies/features/catalog", token)).status, 401, "catalog");
        }
    } finally {
        server.close();
    }
});

test("ISOLATION: the /me response and the sign-in session carry only the caller's own company's modules", () => {
    const routes = read("routes", "tenantAuthRoutes.js");
    assert.match(routes, /getEnabledFeatureIds\(req\.tenantCompany\.id\)/, "/me uses the company resolved from the token");
    const controller = read("controllers", "tenantAuthController.js");
    assert.equal((controller.match(/getEnabledFeatureIds\(company\.id\)/g) || []).length, 2, "login and forced-password-change sessions");
});

test("the dashboard only queries and reports the sections of the modules the company has", () => {
    const dashboard = read("controllers", "dashboardController.js");
    for (const [feature, field] of [["employee_management", "totalEmployees"], ["attendance", "presentToday"], ["leave_management", "onLeave"], ["task_management", "activeTasks"]]) {
        assert.match(dashboard, new RegExp(`!has\\("${feature}"\\) \\? \\[\\[\\{ ${field}: 0 \\}\\]\\]`), `${field} is not queried without ${feature}`);
    }
    assert.match(dashboard, /sections:\s*\{/);
});
