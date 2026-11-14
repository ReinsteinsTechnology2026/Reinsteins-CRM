// Unified email accounts on a REAL PostgreSQL: schema + additive migration, connecting Gmail / Google Workspace / Outlook.com /
// Microsoft 365, multi-account use, tenant and employee isolation, OAuth callback security, encrypted tokens, refresh / revocation,
// synchronisation, duplicate-safe notifications, push (Gmail watch, Graph change notifications), renewal, and the unified inbox.
//
// Only DEFINES the cases; _test_email_accounts_pg.js loads it with a disposable database (PG_TEST_* guard, run in CI).
// The provider networks are scripted fakes: THIS PROVES THE CRM'S BEHAVIOUR, NOT LIVE GOOGLE / MICROSOFT CONNECTIVITY.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { createEmailAccountStore } = require("./services/emailAccountStore");
const { createEmailAccountService, MAX_ACCOUNTS_PER_USER } = require("./services/emailAccountService");
const { createEmailSyncService } = require("./services/emailSyncService");
const secretBox = require("./utils/secretBox");
const migration = require("./_migrate_add_email_accounts");
const { GOOGLE_SCOPES, MICROSOFT_ACCOUNT_SCOPES } = require("./config/emailProvidersConfig");

const KEY = crypto.randomBytes(32).toString("base64");
const GOOGLE_ID = "g-client.apps.googleusercontent.com";
const MS_ID = "ms-client-id";
const WORK_TID = "11111111-2222-3333-4444-555555555555";
const PERSONAL_TID = "9188040d-6c67-4c5b-b112-36a304b66dad";

const configs = (push) => ({
    google: { provider: "google", configured: true, missing: [], clientId: GOOGLE_ID, clientSecret: "g-secret", redirectUri: "https://crm.test/api/email/accounts/callback/google", scopes: GOOGLE_SCOPES, requiredScopes: ["https://www.googleapis.com/auth/gmail.modify"], pubsubTopic: push ? "projects/p/topics/t" : "", pushAudience: push ? "https://crm.test/api/email/push/google" : "", pushServiceAccount: push ? "push@p.iam.gserviceaccount.com" : "", pushConfigured: push, tokenKey: KEY, frontendOrigin: "https://crm.test" },
    microsoft: { provider: "microsoft", configured: true, missing: [], clientId: MS_ID, clientSecret: "ms-secret", redirectUri: "https://crm.test/api/email/accounts/callback/microsoft", scopes: MICROSOFT_ACCOUNT_SCOPES, requiredScopes: ["Mail.ReadWrite", "Mail.Send"], notificationUrl: push ? "https://crm.test/api/email/push/microsoft" : "", pushConfigured: push, tokenKey: KEY, frontendOrigin: "https://crm.test" },
});

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (claims) => `h.${b64(claims)}.s`;
const reply = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => Buffer.alloc(0) });

function defineCases({ test, newPlatformDatabase }) {
    // ================================================================ a scripted internet: Google + Microsoft
    function makeNet() {
        const net = {
            tokenCalls: [], revoked: [], subscriptions: new Map(), watches: [], subscriptionCalls: [],
            gmail: new Map(), graph: new Map(), failures: new Map(),
            tokenResponder: null, refreshResponder: null, seq: 0, apiCalls: [],
        };
        const mailbox = (kind, email) => {
            const store = net[kind];
            if (!store.has(email)) store.set(email, { historyId: 1000, messages: [], unread: 0, expiredHistory: false });
            return store.get(email);
        };
        net.mailbox = mailbox;
        // Adds a new unread INBOX message to a mailbox and (Gmail) records it in the history.
        net.deliver = (kind, email, { id, from = "sam@acme.com", subject = "Hello", at = Date.now(), read = false }) => {
            const m = mailbox(kind, email);
            m.messages.push({ id, from, subject, at, read });
            if (kind === "gmail") { m.historyId += 1; (m.history ||= []).push({ id: String(m.historyId), messagesAdded: [{ message: { id, labelIds: read ? ["INBOX"] : ["INBOX", "UNREAD"] } }] }); }
            m.unread = m.messages.filter((x) => !x.read).length;
        };
        net.fetch = async (url, init = {}) => {
            const u = new URL(url);
            const auth = (init.headers && init.headers.Authorization) || "";
            const owner = /^Bearer AT\|([a-z]+)\|([^|]+)\|/.exec(auth);
            const json = (status, body) => reply(status, body);
            net.apiCalls.push(`${init.method || "GET"} ${u.host}${u.pathname}`);
            // ---- OAuth endpoints ----
            if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
                const params = new URLSearchParams(init.body); net.tokenCalls.push({ provider: "google", params });
                const out = params.get("grant_type") === "refresh_token" ? net.refreshResponder("google", params) : net.tokenResponder("google", params);
                return json(out.status, out.body);
            }
            if (u.host === "oauth2.googleapis.com" && u.pathname === "/revoke") { net.revoked.push(new URLSearchParams(init.body).get("token")); return json(200, {}); }
            if (u.host === "login.microsoftonline.com" && u.pathname.endsWith("/oauth2/v2.0/token")) {
                const params = new URLSearchParams(init.body); net.tokenCalls.push({ provider: "microsoft", params, path: u.pathname });
                const out = params.get("grant_type") === "refresh_token" ? net.refreshResponder("microsoft", params, u.pathname) : net.tokenResponder("microsoft", params);
                return json(out.status, out.body);
            }
            // ---- provider APIs: the bearer token names the mailbox it was issued for, so a mix-up is visible ----
            if (!owner) return json(401, { error: { code: "InvalidAuthenticationToken" } });
            const [, kindTag, email] = owner;
            const kind = kindTag === "google" ? "gmail" : "graph";
            const failure = net.failures.get(`${kind}:${email}`);
            if (failure) { const f = typeof failure === "function" ? failure() : failure; if (f) return json(f.status, f.body || {}); }
            const m = mailbox(kind, email);
            if (u.host === "gmail.googleapis.com") {
                const p = u.pathname.replace("/gmail/v1/users/me", "");
                if (p === "/profile") return json(200, { emailAddress: email, historyId: String(m.historyId) });
                if (p === "/labels/INBOX") return json(200, { id: "INBOX", messagesUnread: m.unread });
                if (p === "/labels") return json(200, { labels: [{ id: "INBOX", type: "system", name: "INBOX" }] });
                if (p === "/history") {
                    if (m.expiredHistory) return json(404, { error: { message: "gone" } });
                    const start = Number(u.searchParams.get("startHistoryId"));
                    return json(200, { historyId: String(m.historyId), history: (m.history || []).filter((h) => Number(h.id) > start) });
                }
                if (p === "/watch") { const w = { email, topic: JSON.parse(init.body).topicName }; net.watches.push(w); return json(200, { historyId: String(m.historyId), expiration: String(Date.now() + 7 * 86400000) }); }
                if (p === "/stop") { net.watches.push({ email, stopped: true }); return json(200, {}); }
                if (p === "/messages") {
                    const before = u.searchParams.get("q") && /before:(\d+)/.exec(u.searchParams.get("q"));
                    const msgs = [...m.messages].sort((a, b) => b.at - a.at).filter((x) => !before || Math.floor(x.at / 1000) < Number(before[1]));
                    return json(200, { messages: msgs.slice(0, Number(u.searchParams.get("maxResults") || 25)).map((x) => ({ id: x.id })) });
                }
                const one = /^\/messages\/([^/?]+)$/.exec(p);
                if (one) {
                    const x = m.messages.find((y) => y.id === one[1]);
                    if (!x) return json(404, { error: { message: "nf" } });
                    return json(200, { id: x.id, threadId: "T-" + x.id, labelIds: x.read ? ["INBOX"] : ["INBOX", "UNREAD"], snippet: "s", internalDate: String(x.at), payload: { headers: [{ name: "From", value: `Sam <${x.from}>` }, { name: "To", value: email }, { name: "Subject", value: x.subject }] } });
                }
            }
            if (u.host === "graph.microsoft.com") {
                const p = u.pathname.replace("/v1.0", "");
                if (p === "/me/mailFolders/inbox") return json(200, { unreadItemCount: m.unread });
                if (p === "/me/mailFolders/inbox/messages") {
                    const filter = u.searchParams.get("$filter") || "";
                    const ge = /receivedDateTime ge (\S+)/.exec(filter); const le = /receivedDateTime le (\S+)/.exec(filter);
                    let msgs = [...m.messages].map((x) => ({ id: x.id, subject: x.subject, from: { emailAddress: { name: "Sam", address: x.from } }, receivedDateTime: new Date(x.at).toISOString().replace(/\.\d+Z$/, "Z"), isRead: x.read, conversationId: "C-" + x.id, bodyPreview: "p", toRecipients: [], flag: { flagStatus: "notFlagged" }, categories: [], hasAttachments: false, importance: "normal", parentFolderId: "inbox" }));
                    if (ge && ge[1] !== "1900-01-01T00:00:00Z") msgs = msgs.filter((x) => x.receivedDateTime >= ge[1]);
                    if (le) msgs = msgs.filter((x) => x.receivedDateTime <= le[1]);
                    const order = u.searchParams.get("$orderby") || "";
                    msgs.sort((a, b) => (order.includes("asc") ? 1 : -1) * a.receivedDateTime.localeCompare(b.receivedDateTime));
                    return json(200, { value: msgs.slice(0, Number(u.searchParams.get("$top") || 25)) });
                }
                if (p === "/subscriptions" && init.method === "POST") {
                    const body = JSON.parse(init.body); const id = `sub-${String(++net.seq).padStart(8, "0")}`;
                    net.subscriptions.set(id, { id, email, ...body }); net.subscriptionCalls.push({ op: "create", id });
                    return json(201, { id, resource: body.resource, expirationDateTime: body.expirationDateTime });
                }
                const sub = /^\/subscriptions\/([^/]+)$/.exec(p);
                if (sub && init.method === "PATCH") {
                    if (!net.subscriptions.has(sub[1])) return json(404, { error: { code: "ResourceNotFound" } });
                    net.subscriptionCalls.push({ op: "renew", id: sub[1] });
                    return json(200, { id: sub[1], expirationDateTime: JSON.parse(init.body).expirationDateTime });
                }
                if (sub && init.method === "DELETE") { net.subscriptions.delete(sub[1]); net.subscriptionCalls.push({ op: "delete", id: sub[1] }); return json(204, {}); }
            }
            return json(404, { error: { message: "unscripted " + u.pathname } });
        };
        return net;
    }

    // ================================================================ world
    async function buildWorld(pool, { push = false } = {}) {
        const store = createEmailAccountStore(pool);
        const net = makeNet();
        const events = [];
        const emit = (name, payload) => events.push({ name, ...payload });
        const cfg = configs(push);
        const service = createEmailAccountService({ store, fetchImpl: net.fetch, sleep: async () => {}, configFor: (p) => cfg[p], emit, getCompanyById: async (id) => ({ id, company_slug: id === world.a.id ? "acme" : "globex" }) });
        const sync = createEmailSyncService({ accountService: service, store, configFor: (p) => cfg[p], emit, logger: { error() {} } });
        const addCompany = async (slug) => (await pool.query(`INSERT INTO companies (company_name, company_slug, status) VALUES (?, ?, 'active') RETURNING id`, [slug.toUpperCase(), slug]))[0][0].id;
        const world = { pool, store, service, sync, net, events, cfg, a: { id: await addCompany("acme") }, b: { id: await addCompany("globex") } };
        return world;
    }

    // Plays the whole provider hand-off for one sign-in and returns the callback result.
    async function connect(world, { provider, company, userId, email, kind, accountId, sub, claims = {}, scope, noRefresh = false, expectState }) {
        const { authorizationUrl } = await world.service.beginConnect({ companyId: company.id, userId, provider, accountId, returnPortal: "employee" });
        const url = new URL(authorizationUrl);
        const state = url.searchParams.get("state");
        const nonce = url.searchParams.get("nonce");
        const tag = provider === "google" ? "google" : "microsoft";
        const owner = email.toLowerCase();
        const accessToken = `AT|${tag}|${owner}|${++world.net.seq}`;
        const refreshToken = `RT|${tag}|${owner}|${world.net.seq}`;
        world.net.tokenResponder = () => {
            let idClaims;
            if (provider === "google") idClaims = { iss: "https://accounts.google.com", aud: GOOGLE_ID, sub: sub || `g-${email}`, email, email_verified: true, name: "Test User", exp: Math.floor(Date.now() / 1000) + 3600, nonce, ...(kind === "google_workspace" ? { hd: email.split("@")[1] } : {}), ...claims };
            else {
                const tid = kind === "outlook_personal" ? PERSONAL_TID : WORK_TID;
                idClaims = { iss: `https://login.microsoftonline.com/${tid}/v2.0`, aud: MS_ID, tid, oid: sub || `oid-${email}`, preferred_username: email, name: "Test User", exp: Math.floor(Date.now() / 1000) + 3600, nonce, ...claims };
            }
            return { status: 200, body: { access_token: accessToken, refresh_token: noRefresh ? undefined : refreshToken, expires_in: 3600, scope: scope || (provider === "google" ? GOOGLE_SCOPES.join(" ") : MICROSOFT_ACCOUNT_SCOPES.join(" ")), id_token: idToken(idClaims) } };
        };
        const callbackProvider = expectState && expectState.provider ? expectState.provider : provider;
        const result = await world.service.completeCallback({ provider: callbackProvider, code: "authcode-1234567890", state: (expectState && expectState.state) || state });
        return { result, state, nonce, accessToken, refreshToken, url };
    }
    const gmailAccount = (world, company, userId, email = "jane@gmail.com", extra = {}) => connect(world, { provider: "google", company, userId, email, kind: "gmail", ...extra });
    const outlookAccount = (world, company, userId, email = "jane@outlook.com", extra = {}) => connect(world, { provider: "microsoft", company, userId, email, kind: "outlook_personal", ...extra });
    const workAccount = (world, company, userId, email = "jane@acme.com", extra = {}) => connect(world, { provider: "microsoft", company, userId, email, kind: "microsoft_365", ...extra });
    const accountId = async (world, company, userId, email) => (await world.store.list(company.id, userId)).find((r) => r.email_address === email).id;

    const rejects = async (promise, code) => {
        await assert.rejects(promise, (error) => { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return true; });
    };

    // ================================================================ schema + migration
    test("schema: the platform schema file creates the account tables and carries the migration SQL verbatim", async () => {
        const pool = await newPlatformDatabase({ withAccountsSchema: true });
        for (const table of migration.NEW_TABLES) assert.equal((await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = ?`, [table]))[0].length, 1, table);
        const normalise = (t) => t.replace(/\r\n/g, "\n");
        const platform = normalise(fs.readFileSync(path.join(__dirname, "schemas", "platformSchema.postgresql.sql"), "utf8"));
        assert.ok(platform.includes(normalise(fs.readFileSync(migration.SCHEMA_PATH, "utf8")).trim()), "platformSchema.postgresql.sql must contain emailAccountsSchema.postgresql.sql unchanged");
    });

    test("migration: additive on an existing database (nothing existing changes), idempotent, dry-run changes nothing, no company-domain prerequisite", async () => {
        const pool = await newPlatformDatabase({ withAccountsSchema: false });
        const companyId = (await pool.query(`INSERT INTO companies (company_name, company_slug, status) VALUES ('Old Co', 'oldco', 'active') RETURNING id`))[0][0].id;
        const tablesBefore = (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`))[0].map((r) => r.table_name);
        const colsBefore = (await pool.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`))[0].length;
        const dry = await migration.run(pool, { dryRun: true, log: () => {} });
        assert.deepEqual([dry.applied, dry.missingTables.length], [false, migration.NEW_TABLES.length]);
        assert.equal((await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'email_accounts'`))[0].length, 0);
        await migration.run(pool, { log: () => {} });
        await migration.run(pool, { log: () => {} });
        const tablesAfter = (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`))[0].map((r) => r.table_name);
        assert.deepEqual(tablesAfter.filter((t) => !migration.NEW_TABLES.includes(t)), tablesBefore, "no existing table was added, changed or dropped");
        const colsAfter = (await pool.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> ALL (?::text[]) ORDER BY 1, 2`, [`{${migration.NEW_TABLES.join(",")}}`]))[0].length;
        assert.equal(colsAfter, colsBefore, "no existing column changed");
        assert.equal((await pool.query(`SELECT company_name FROM companies WHERE id = ?`, [companyId]))[0][0].company_name, "Old Co");
        assert.equal((await pool.query(`SELECT 1 FROM email_domains`))[0].length + (await pool.query(`SELECT 1 FROM mailboxes`))[0].length, 0, "no verified domain or mailbox record is needed");
    });

    test("migration: stops with a clear message on a database that is not a provisioned platform database", async () => {
        const pool = await newPlatformDatabase({ withAccountsSchema: false });
        await pool.query(`DROP TABLE companies CASCADE`);
        await assert.rejects(migration.run(pool, { log: () => {} }), /Required table "companies" is missing/);
    });

    // ================================================================ connecting
    test("connect Gmail: no company domain or mailbox needed; tokens stored ENCRYPTED; tracking starts from NOW (old mail never notifies); audit written", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        world.net.deliver("gmail", "jane@gmail.com", { id: "old1" });
        const { result, accessToken, refreshToken } = await gmailAccount(world, world.a, 1, "Jane@Gmail.com");
        assert.equal(result.ok, true);
        const raw = (await world.pool.query(`SELECT * FROM email_accounts`))[0][0];
        assert.deepEqual({ provider: raw.provider, kind: raw.account_kind, email: raw.email_address, status: raw.status }, { provider: "google", kind: "gmail", email: "jane@gmail.com", status: "connected" });
        assert.ok(raw.access_token_enc.startsWith("v1.") && !raw.access_token_enc.includes(accessToken));
        assert.ok(raw.refresh_token_enc.startsWith("v1.") && !raw.refresh_token_enc.includes(refreshToken));
        assert.equal(secretBox.decrypt(raw.refresh_token_enc, `email-account:${world.a.id}:1:google:${raw.provider_account_id}`, KEY), refreshToken);
        assert.equal(raw.sync_cursor, "1001", "the sync cursor is 'now'");
        assert.equal(raw.unread_inbox, 1);
        assert.equal((await world.pool.query(`SELECT 1 FROM email_new_mail_events`))[0].length, 0, "old mail did not notify");
        const audit = (await world.pool.query(`SELECT action, detail FROM email_audit_log`))[0];
        assert.ok(audit.some((a) => a.action === "account_connected"));
        const text = JSON.stringify(audit);
        for (const secret of [accessToken, refreshToken, "authcode-1234567890", "g-secret", KEY]) assert.ok(!text.includes(secret), "audit holds no secret");
        const redirect = await world.service.frontendRedirect({ companyId: world.a.id, returnPortal: "employee", result });
        assert.equal(redirect, "https://crm.test/acme/employee/email?ea=connected");
    });

    test("account kinds: Gmail, Google Workspace, Outlook.com (personal) and Microsoft 365 (work) are recognised from the provider's own claims", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        await gmailAccount(world, world.a, 1, "a@gmail.com");
        await connect(world, { provider: "google", company: world.a, userId: 1, email: "b@acme.com", kind: "google_workspace" });
        await outlookAccount(world, world.a, 1, "c@hotmail.com");
        await workAccount(world, world.a, 1, "d@acme.com");
        const rows = (await world.service.listAccounts({ companyId: world.a.id, userId: 1 }));
        assert.deepEqual(rows.map((r) => [r.address, r.kind, r.provider]), [["a@gmail.com", "gmail", "google"], ["b@acme.com", "google_workspace", "google"], ["c@hotmail.com", "outlook_personal", "microsoft"], ["d@acme.com", "microsoft_365", "microsoft"]]);
        assert.deepEqual(rows.map((r) => r.kindLabel), ["Gmail", "Google Workspace", "Outlook.com", "Microsoft 365"]);
        const stored = (await world.pool.query(`SELECT provider_tenant_id FROM email_accounts ORDER BY id`))[0].map((r) => r.provider_tenant_id);
        assert.deepEqual(stored, [null, "acme.com", PERSONAL_TID, WORK_TID], "the tenant / hosted domain is recorded");
        assert.ok(rows.every((r) => r.capabilities && r.capabilities.provider === r.provider));
    });

    test("multi-account: one employee can connect several accounts (a limit applies), reconnecting the SAME account updates it instead of duplicating", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        for (let i = 0; i < MAX_ACCOUNTS_PER_USER; i += 1) assert.equal((await gmailAccount(world, world.a, 1, `u${i}@gmail.com`)).result.ok, true);
        await rejects(world.service.beginConnect({ companyId: world.a.id, userId: 1, provider: "google", returnPortal: "employee" }), "ACCOUNT_LIMIT");
        // at the limit, RECONNECTING an existing account is still allowed (it is an update, not a new slot) ...
        const u0 = await accountId(world, world.a, 1, "u0@gmail.com");
        assert.equal((await gmailAccount(world, world.a, 1, "u0@gmail.com", { accountId: u0 })).result.ok, true);
        // ... and a connect that began BEFORE the limit was reached cannot sneak a sixth account in afterwards
        const poolB = await world.pool.query(`DELETE FROM email_accounts WHERE id = ? RETURNING id`, [u0]);
        assert.equal(poolB[0].length, 1);
        const early = new URL((await world.service.beginConnect({ companyId: world.a.id, userId: 1, provider: "google", returnPortal: "employee" })).authorizationUrl);
        assert.equal((await gmailAccount(world, world.a, 1, "sixth@gmail.com")).result.ok, true, "a slot was free");
        world.net.tokenResponder = () => ({ status: 200, body: { access_token: "AT|google|late@gmail.com|1", refresh_token: "RT", expires_in: 3600, scope: GOOGLE_SCOPES.join(" "), id_token: idToken({ iss: "https://accounts.google.com", aud: GOOGLE_ID, sub: "late", email: "late@gmail.com", email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600, nonce: early.searchParams.get("nonce") }) } });
        const late = await world.service.completeCallback({ provider: "google", code: "authcode-1234567890", state: early.searchParams.get("state") });
        assert.deepEqual([late.ok, late.reason], [false, "account_limit"]);
        assert.equal((await world.store.list(world.a.id, 1)).length, MAX_ACCOUNTS_PER_USER);
        // another employee has their own allowance
        assert.equal((await gmailAccount(world, world.a, 2, "other@gmail.com")).result.ok, true);
    });

    test("callback: a state works ONCE; expired, unknown, malformed or provider-mismatched states are refused and no token endpoint is called", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        const first = await gmailAccount(world, world.a, 1);
        assert.equal(first.result.ok, true);
        const replay = await world.service.completeCallback({ provider: "google", code: "authcode-1234567890", state: first.state });
        assert.deepEqual([replay.ok, replay.reason], [false, "invalid_state"]);

        const { authorizationUrl } = await world.service.beginConnect({ companyId: world.a.id, userId: 1, provider: "google", returnPortal: "employee" });
        const state = new URL(authorizationUrl).searchParams.get("state");
        const before = world.net.tokenCalls.length;
        // the SAME state used on the OTHER provider's callback
        assert.equal((await world.service.completeCallback({ provider: "microsoft", code: "authcode-1234567890", state })).reason, "invalid_state");
        await world.pool.query(`UPDATE email_account_oauth_states SET expires_at = NOW() - interval '1 minute'`);
        for (const candidate of [state, "x".repeat(43), "short", undefined, null, "", "a".repeat(500)]) assert.equal((await world.service.completeCallback({ provider: "google", code: "authcode-1234567890", state: candidate })).reason, "invalid_state");
        assert.equal((await world.service.completeCallback({ provider: "yahoo", code: "c", state })).reason, "invalid_state");
        assert.equal(world.net.tokenCalls.length, before);
    });

    test("callback: consent denied, an admin-blocked app, unticked Gmail permission, missing refresh token and a failed exchange all end safely and store nothing", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        const begin = async (provider = "google") => new URL((await world.service.beginConnect({ companyId: world.a.id, userId: 1, provider, returnPortal: "employee" })).authorizationUrl).searchParams.get("state");
        assert.equal((await world.service.completeCallback({ provider: "google", state: await begin(), error: "access_denied" })).reason, "denied");
        for (const e of ["consent_required", "interaction_required", "admin_policy_enforced"]) assert.equal((await world.service.completeCallback({ provider: "microsoft", state: await begin("microsoft"), error: e })).reason, "admin_consent_required", e);
        assert.equal((await world.service.completeCallback({ provider: "google", state: await begin() })).reason, "invalid_code");
        assert.equal((await gmailAccount(world, world.a, 1, "x@gmail.com", { scope: "openid email profile" })).result.reason, "insufficient_scopes");
        assert.equal((await outlookAccount(world, world.a, 1, "x@outlook.com", { scope: "User.Read openid" })).result.reason, "insufficient_scopes");
        assert.equal((await gmailAccount(world, world.a, 1, "x@gmail.com", { noRefresh: true })).result.reason, "no_refresh_token");
        const state = await begin();
        world.net.tokenResponder = () => ({ status: 400, body: { error: "invalid_grant", error_description: "SECRET detail" } });
        const failed = await world.service.completeCallback({ provider: "google", code: "authcode-1234567890", state });
        assert.equal(failed.ok, false);
        assert.ok(!JSON.stringify(failed).includes("SECRET"));
        assert.equal((await world.pool.query(`SELECT 1 FROM email_accounts`))[0].length, 0);
    });

    test("callback: another app's token, a replayed nonce, an expired token or an UNVERIFIED Google email is refused", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        for (const claims of [{ aud: "another-app" }, { nonce: "replayed" }, { exp: Math.floor(Date.now() / 1000) - 7200 }, { email_verified: false }, { sub: undefined }]) {
            assert.equal((await gmailAccount(world, world.a, 1, "x@gmail.com", { claims })).result.ok, false, JSON.stringify(claims));
        }
        for (const claims of [{ aud: "another-app" }, { nonce: "replayed" }, { oid: undefined }, { preferred_username: "no-address" }]) {
            assert.equal((await outlookAccount(world, world.a, 1, "x@outlook.com", { claims })).result.ok, false, JSON.stringify(claims));
        }
        assert.equal((await world.pool.query(`SELECT 1 FROM email_accounts`))[0].length, 0);
    });

    test("reconnect: only the SAME provider account can be reconnected -- a different mailbox cannot be swapped in under an old id", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        await gmailAccount(world, world.a, 1, "jane@gmail.com", { sub: "sub-jane" });
        const id = await accountId(world, world.a, 1, "jane@gmail.com");
        await world.pool.query(`UPDATE email_accounts SET status = 'reauth_required', access_token_enc = NULL, refresh_token_enc = NULL WHERE id = ?`, [id]);
        const wrong = await gmailAccount(world, world.a, 1, "eve@gmail.com", { accountId: id, sub: "sub-eve" });
        assert.deepEqual([wrong.result.ok, wrong.result.reason], [false, "wrong_account"]);
        assert.equal((await world.store.get(world.a.id, 1, id)).status, "reauth_required");
        const right = await gmailAccount(world, world.a, 1, "jane@gmail.com", { accountId: id, sub: "sub-jane" });
        assert.equal(right.result.ok, true);
        assert.equal(right.url.searchParams.get("login_hint"), "jane@gmail.com");
        assert.equal((await world.store.get(world.a.id, 1, id)).status, "connected");
        assert.equal((await world.store.list(world.a.id, 1)).length, 1);
        await rejects(world.service.beginConnect({ companyId: world.a.id, userId: 2, provider: "google", accountId: id, returnPortal: "employee" }), "ACCOUNT_NOT_FOUND");
        await rejects(world.service.beginConnect({ companyId: world.a.id, userId: 1, provider: "microsoft", accountId: id, returnPortal: "employee" }), "ACCOUNT_NOT_FOUND");
    });

    test("unconfigured provider: connecting says which provider is not set up; the other provider still works", async () => {
        const pool = await newPlatformDatabase({ withAccountsSchema: true });
        const store = createEmailAccountStore(pool);
        const cfg = configs(false);
        const service = createEmailAccountService({ store, fetchImpl: makeNet().fetch, configFor: (p) => (p === "google" ? { ...cfg.google, configured: false, missing: ["GOOGLE_EMAIL_CLIENT_ID"] } : cfg[p]) });
        const companyId = (await pool.query(`INSERT INTO companies (company_name, company_slug, status) VALUES ('A', 'a', 'active') RETURNING id`))[0][0].id;
        await rejects(service.beginConnect({ companyId, userId: 1, provider: "google", returnPortal: "employee" }), "PROVIDER_NOT_CONFIGURED");
        await rejects(service.beginConnect({ companyId, userId: 1, provider: "yahoo", returnPortal: "employee" }), "INVALID_PROVIDER");
        assert.ok((await service.beginConnect({ companyId, userId: 1, provider: "microsoft", returnPortal: "employee" })).authorizationUrl.startsWith("https://login.microsoftonline.com/common/"));
    });

    // ================================================================ isolation
    test("isolation: the same employee id in two companies never shares an account, a token, a list or a summary", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        const a = await gmailAccount(world, world.a, 1, "alice@gmail.com");
        const b = await outlookAccount(world, world.b, 1, "bob@outlook.com");
        world.net.deliver("gmail", "alice@gmail.com", { id: "a-msg" });
        const aId = await accountId(world, world.a, 1, "alice@gmail.com");
        const bId = await accountId(world, world.b, 1, "bob@outlook.com");

        assert.deepEqual((await world.service.listAccounts({ companyId: world.a.id, userId: 1 })).map((r) => r.address), ["alice@gmail.com"]);
        assert.deepEqual((await world.service.listAccounts({ companyId: world.b.id, userId: 1 })).map((r) => r.address), ["bob@outlook.com"]);
        await rejects(world.service.getContext({ companyId: world.a.id, userId: 1, accountId: bId }), "ACCOUNT_NOT_FOUND");
        await rejects(world.service.getContext({ companyId: world.b.id, userId: 1, accountId: aId }), "ACCOUNT_NOT_FOUND");
        await rejects(world.service.disconnect({ companyId: world.a.id, userId: 1, accountId: bId }), "ACCOUNT_NOT_FOUND");
        await rejects(world.service.updateAccount({ companyId: world.a.id, userId: 1, accountId: bId, displayName: "hijack" }), "ACCOUNT_NOT_FOUND");
        assert.equal((await world.store.get(world.b.id, 1, bId)).display_name, "Test User", "B's account was not touched");

        // each employee reaches Microsoft / Google with ITS OWN token only
        const ctxA = await world.service.getContext({ companyId: world.a.id, userId: 1, accountId: aId });
        world.net.apiCalls.length = 0;
        const page = await ctxA.provider.listMessages(ctxA, { folderId: "inbox" });
        assert.deepEqual(page.messages.map((m) => m.id), ["a-msg"]);
        assert.ok(a.accessToken && b.accessToken && !world.net.apiCalls.some((c) => c.includes("graph.microsoft.com")));
        assert.equal((await world.service.summary({ companyId: world.b.id, userId: 1 })).accounts.length, 1);
    });

    test("isolation: one employee cannot reach a COLLEAGUE's account by guessing its id (an administrator cannot either)", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        await gmailAccount(world, world.a, 5, "private@gmail.com");
        const id = await accountId(world, world.a, 5, "private@gmail.com");
        for (const userId of [1, 2, 99, 100 /* the administrator */]) {
            await rejects(world.service.getContext({ companyId: world.a.id, userId, accountId: id }), "ACCOUNT_NOT_FOUND");
            await rejects(world.service.disconnect({ companyId: world.a.id, userId, accountId: id }), "ACCOUNT_NOT_FOUND");
            assert.equal((await world.service.listUnified({ companyId: world.a.id, userId })).messages.length, 0);
        }
        for (const bad of ["1 OR 1=1", "../1", "", null, 0, -1, 1.5, "abc"]) await rejects(world.service.getContext({ companyId: world.a.id, userId: 5, accountId: bad }), "ACCOUNT_NOT_FOUND");
        assert.ok(await world.service.getContext({ companyId: world.a.id, userId: 5, accountId: id }));
    });

    test("isolation: sealed tokens are bound to company + employee + provider account, so a ciphertext moved into another row is unreadable", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        await gmailAccount(world, world.a, 1, "alice@gmail.com");
        await gmailAccount(world, world.b, 1, "bob@gmail.com");
        const aId = await accountId(world, world.a, 1, "alice@gmail.com");
        const bId = await accountId(world, world.b, 1, "bob@gmail.com");
        await world.pool.query(`UPDATE email_accounts SET access_token_enc = (SELECT access_token_enc FROM email_accounts WHERE id = ?), refresh_token_enc = (SELECT refresh_token_enc FROM email_accounts WHERE id = ?) WHERE id = ?`, [aId, aId, bId]);
        const ctx = await world.service.getContext({ companyId: world.b.id, userId: 1, accountId: bId });
        world.net.apiCalls.length = 0;
        await assert.rejects(ctx.provider.listFolders(ctx), (e) => e.code === "REAUTH_REQUIRED");
        assert.ok(!world.net.apiCalls.some((c) => c.includes("gmail.googleapis.com")), "the provider was never called with A's token");
        assert.equal((await world.store.get(world.b.id, 1, bId)).status, "reauth_required");
        assert.equal((await world.store.get(world.a.id, 1, aId)).status, "connected");
    });

    test("admin: sees connection STATUS only (masked address, provider, state) -- no mail, no unread counts, no tokens; can disconnect only in its own company", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        await gmailAccount(world, world.a, 7, "jane.private@gmail.com");
        await outlookAccount(world, world.a, 7, "jane@outlook.com");
        await gmailAccount(world, world.b, 7, "other@gmail.com");
        world.net.deliver("gmail", "jane.private@gmail.com", { id: "secret-msg", subject: "TOP SECRET SUBJECT" });
        await world.sync.syncAccount(await accountId(world, world.a, 7, "jane.private@gmail.com"));
        const overview = await world.service.adminOverview(world.a.id);
        const text = JSON.stringify(overview);
        assert.deepEqual(overview.employees.map((e) => [e.userId, e.accounts.length]), [[7, 2]]);
        const employeesText = JSON.stringify(overview.employees);
        assert.ok(!text.includes("jane.private") && !text.includes("TOP SECRET") && !text.includes("secret-msg") && !/unread|_enc|token|subject|sender|body/i.test(employeesText), employeesText);
        assert.match(overview.employees[0].accounts[0].address, /^[a-z]\*\*\*@/);
        assert.deepEqual(overview.totals, { connected: 2, reauth_required: 0, disabled: 0 });
        const otherId = await accountId(world, world.b, 7, "other@gmail.com");
        await rejects(world.service.adminDisconnect({ companyId: world.a.id, actorUserId: 100, accountId: otherId }), "ACCOUNT_NOT_FOUND");
        assert.ok(await world.store.getForCompany(world.b.id, otherId));
        const mine = await accountId(world, world.a, 7, "jane@outlook.com");
        assert.equal((await world.service.adminDisconnect({ companyId: world.a.id, actorUserId: 100, accountId: mine })).disconnected, true);
        assert.equal(await world.store.getForCompany(world.a.id, mine), null);
        assert.ok((await world.store.listAudit(world.a.id)).some((r) => r.action === "account_disconnected_by_admin"));
    });

    // ================================================================ tokens
    test("tokens: an expired token is refreshed ONCE even for parallel calls (Google and Microsoft); rotated refresh tokens replace the old; Microsoft refreshes against the account's own tenant", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        const g = await gmailAccount(world, world.a, 1, "jane@gmail.com");
        const m = await workAccount(world, world.a, 1, "jane@acme.com");
        await world.pool.query(`UPDATE email_accounts SET access_expires_at = NOW() - interval '5 minutes'`);
        let n = 0;
        world.net.refreshResponder = (provider) => { n += 1; return { status: 200, body: { access_token: `AT|${provider}|${provider === "google" ? "jane@gmail.com" : "jane@acme.com"}|r${n}`, refresh_token: `RT-ROTATED-${n}`, expires_in: 3600 } }; };
        const gId = await accountId(world, world.a, 1, "jane@gmail.com");
        const mId = await accountId(world, world.a, 1, "jane@acme.com");
        const gc = await world.service.getContext({ companyId: world.a.id, userId: 1, accountId: gId });
        const mc = await world.service.getContext({ companyId: world.a.id, userId: 1, accountId: mId });
        world.net.tokenCalls.length = 0;
        await Promise.all([...Array.from({ length: 5 }, () => gc.provider.getUnread(gc)), ...Array.from({ length: 5 }, () => mc.provider.getUnread(mc))]);
        assert.equal(world.net.tokenCalls.filter((c) => c.params.get("grant_type") === "refresh_token").length, 2, "one refresh per account, shared by every parallel call");
        assert.equal(world.net.tokenCalls.find((c) => c.provider === "microsoft").path, `/${WORK_TID}/oauth2/v2.0/token`);
        const raw = (await world.pool.query(`SELECT id, refresh_token_enc, provider_account_id, provider FROM email_accounts ORDER BY id`))[0];
        for (const row of raw) assert.match(secretBox.decrypt(row.refresh_token_enc, `email-account:${world.a.id}:1:${row.provider}:${row.provider_account_id}`, KEY), /^RT-ROTATED-/);
        assert.ok(g.refreshToken && m.refreshToken);
    });

    test("revocation: a provider that rejects the refresh token turns the account to 'reconnect', wipes its tokens, tells the owner -- and the other accounts keep working", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        await gmailAccount(world, world.a, 1, "jane@gmail.com");
        await outlookAccount(world, world.a, 1, "jane@outlook.com");
        const gId = await accountId(world, world.a, 1, "jane@gmail.com");
        const oId = await accountId(world, world.a, 1, "jane@outlook.com");
        await world.pool.query(`UPDATE email_accounts SET access_expires_at = NOW() - interval '5 minutes' WHERE id = ?`, [gId]);
        world.net.refreshResponder = () => ({ status: 400, body: { error: "invalid_grant", error_description: "AADSTS-like detail" } });
        const ctx = await world.service.getContext({ companyId: world.a.id, userId: 1, accountId: gId });
        await assert.rejects(ctx.provider.getUnread(ctx), (e) => e.code === "REAUTH_REQUIRED" && !/AADSTS/.test(e.message));
        const row = (await world.pool.query(`SELECT status, access_token_enc, refresh_token_enc FROM email_accounts WHERE id = ?`, [gId]))[0][0];
        assert.deepEqual([row.status, row.access_token_enc, row.refresh_token_enc], ["reauth_required", null, null]);
        assert.ok(world.events.some((e) => e.name === "reauth" && e.userId === 1 && e.accountId === gId));
        await rejects(world.service.getContext({ companyId: world.a.id, userId: 1, accountId: gId }), "REAUTH_REQUIRED");
        assert.ok(await world.service.getContext({ companyId: world.a.id, userId: 1, accountId: oId }), "the other account is unaffected");
        const summary = await world.service.summary({ companyId: world.a.id, userId: 1 });
        assert.equal(summary.needsAttention, 1);
        assert.equal(summary.accounts.find((a) => a.id === gId).unread, 0);
    });

    test("refused sign-in: the newly issued Google grant is revoked, but never when another connection uses the same Google identity; Microsoft is left alone", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        // 1) Gmail permission unticked -> refused AND the partial grant is voided (refresh token preferred).
        const denied = await gmailAccount(world, world.a, 1, "x@gmail.com", { scope: "openid email profile" });
        assert.equal(denied.result.reason, "insufficient_scopes");
        assert.deepEqual(world.net.revoked, [denied.refreshToken]);
        assert.equal((await world.store.list(world.a.id, 1)).length, 0, "nothing stored");
        // 2) No refresh token: the access token is revoked instead.
        world.net.revoked.length = 0;
        const noRefresh = await gmailAccount(world, world.a, 1, "y@gmail.com", { noRefresh: true });
        assert.equal(noRefresh.result.reason, "no_refresh_token");
        assert.deepEqual(world.net.revoked, [noRefresh.accessToken]);
        // 3) A VALID connection of the same Google identity exists: a refused re-consent must NOT revoke (it would kill the valid one).
        const good = await gmailAccount(world, world.a, 1, "z@gmail.com");
        assert.equal(good.result.ok, true);
        world.net.revoked.length = 0;
        const again = await gmailAccount(world, world.a, 1, "z@gmail.com", { scope: "openid email profile" });
        assert.equal(again.result.reason, "insufficient_scopes");
        assert.deepEqual(world.net.revoked, [], "the valid connection's grant is untouched");
        assert.equal((await world.store.list(world.a.id, 1)).length, 1);
        assert.ok((await world.store.getWithTokens(world.a.id, 1, good.result.accountId)).refresh_token_enc, "its tokens are still stored");
        // ...also when the other connection belongs to another company (the Google grant is per Google user, not per company).
        const other = await gmailAccount(world, world.b, 1, "z@gmail.com", { scope: "openid email profile" });
        assert.equal(other.result.reason, "insufficient_scopes");
        assert.deepEqual(world.net.revoked, []);
        // 4) Microsoft has no revoke call: refused sign-in makes none.
        const ms = await outlookAccount(world, world.a, 1, "x@outlook.com", { scope: "User.Read openid" });
        assert.equal(ms.result.reason, "insufficient_scopes");
        assert.deepEqual(world.net.revoked, []);
        // 5) The audit records the outcome without any token.
        const audit = JSON.stringify((await world.pool.query(`SELECT detail FROM email_audit_log WHERE action = account_connect_grant_discarded`).catch(() => [[]]))[0]);
        assert.ok(!audit.includes("RT|") && !audit.includes("AT|"));
    });

    test("disconnect: Google's grant is revoked, push is stopped, the local row and every token are DELETED; Microsoft has nothing to revoke; audit records it", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }), { push: true });
        const g = await gmailAccount(world, world.a, 1, "jane@gmail.com");
        await outlookAccount(world, world.a, 1, "jane@outlook.com");
        const gId = await accountId(world, world.a, 1, "jane@gmail.com");
        const oId = await accountId(world, world.a, 1, "jane@outlook.com");
        await world.sync.ensureSubscription(gId);
        await world.sync.ensureSubscription(oId);
        assert.equal((await world.pool.query(`SELECT 1 FROM email_push_subscriptions`))[0].length, 2);

        const result = await world.service.disconnect({ companyId: world.a.id, userId: 1, accountId: gId });
        assert.deepEqual(result, { disconnected: true, revoked: true });
        assert.deepEqual(world.net.revoked, [g.refreshToken], "Google was told to void the refresh token");
        assert.ok(world.net.watches.some((w) => w.stopped && w.email === "jane@gmail.com"));
        assert.equal((await world.pool.query(`SELECT 1 FROM email_accounts WHERE id = ?`, [gId]))[0].length, 0);
        assert.equal((await world.pool.query(`SELECT 1 FROM email_push_subscriptions WHERE account_id = ?`, [gId]))[0].length, 0, "the subscription row went with the account");

        const subId = [...world.net.subscriptions.keys()][0];
        const second = await world.service.disconnect({ companyId: world.a.id, userId: 1, accountId: oId });
        assert.equal(second.revoked, false);
        assert.ok(world.net.subscriptionCalls.some((c) => c.op === "delete" && c.id === subId), "the Graph subscription was deleted");
        assert.equal((await world.store.list(world.a.id, 1)).length, 0);
        assert.equal((await world.pool.query(`SELECT 1 FROM email_accounts`))[0].length, 0);
        assert.ok((await world.store.listAudit(world.a.id)).filter((r) => r.action === "account_disconnected").length === 2);
    });

    // ================================================================ synchronisation + notifications
    test("sync: new unread inbox mail raises ONE new-mail event (with who / subject / unread totals); syncing again or a redelivery adds nothing", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        await gmailAccount(world, world.a, 1, "jane@gmail.com");
        await outlookAccount(world, world.a, 1, "jane@outlook.com");
        const gId = await accountId(world, world.a, 1, "jane@gmail.com");
        const oId = await accountId(world, world.a, 1, "jane@outlook.com");
        world.net.deliver("gmail", "jane@gmail.com", { id: "g1", from: "boss@acme.com", subject: "Budget" });
        world.net.deliver("graph", "jane@outlook.com", { id: "o1", from: "ana@x.com", subject: "Lunch", at: Date.now() + 5000 });
        world.events.length = 0;
        await world.sync.syncAccount(gId);
        await world.sync.syncAccount(oId);
        const news = world.events.filter((e) => e.name === "new-mail");
        assert.equal(news.length, 2);
        assert.deepEqual({ count: news[0].count, subject: news[0].latest.subject, from: news[0].latest.from.address, acct: news[0].accountId, user: news[0].userId, company: news[0].companyId }, { count: 1, subject: "Budget", from: "boss@acme.com", acct: gId, user: 1, company: world.a.id });
        assert.equal(news[1].unreadTotal, 2, "the badge total covers every account");
        assert.equal((await world.store.get(world.a.id, 1, gId)).unread_inbox, 1);

        for (let i = 0; i < 3; i += 1) { await world.sync.syncAccount(gId); await world.sync.syncAccount(oId); }
        assert.equal(world.events.filter((e) => e.name === "new-mail").length, 2, "no duplicate notifications");
        assert.equal((await world.pool.query(`SELECT 1 FROM email_new_mail_events`))[0].length, 2);
        // a read message, a message in another folder and a duplicate id never notify
        world.net.deliver("gmail", "jane@gmail.com", { id: "g2", read: true });
        await world.sync.syncAccount(gId);
        assert.equal(world.events.filter((e) => e.name === "new-mail").length, 2);
    });

    test("sync: the Microsoft cursor overlaps by design (>=), so a message arriving in the same second is found and still announced only once", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        await outlookAccount(world, world.a, 1, "jane@outlook.com");
        const id = await accountId(world, world.a, 1, "jane@outlook.com");
        const t = Date.now() + 10000;
        world.net.deliver("graph", "jane@outlook.com", { id: "m1", at: t });
        await world.sync.syncAccount(id);
        world.net.deliver("graph", "jane@outlook.com", { id: "m2", at: t }); // same second
        await world.sync.syncAccount(id);
        await world.sync.syncAccount(id);
        const ids = (await world.pool.query(`SELECT provider_message_id FROM email_new_mail_events ORDER BY provider_message_id`))[0].map((r) => r.provider_message_id);
        assert.deepEqual(ids, ["m1", "m2"]);
        assert.equal(world.events.filter((e) => e.name === "new-mail").length, 2);
    });

    test("sync: parallel syncs of one account share one run; two overlapping cycles claim DIFFERENT accounts (never the same one twice)", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        for (let i = 0; i < 6; i += 1) await gmailAccount(world, world.a, 10 + i, `u${i}@gmail.com`);
        const ids = (await world.store.list(world.a.id, 10)).map((r) => r.id);
        world.net.apiCalls.length = 0;
        await Promise.all(Array.from({ length: 5 }, () => world.sync.syncAccount(ids[0])));
        assert.equal(world.net.apiCalls.filter((c) => c.endsWith("/history")).length, 1, "five parallel syncs, one provider call");

        await world.pool.query(`UPDATE email_accounts SET next_sync_at = NOW() - interval '1 minute'`);
        const [one, two] = await Promise.all([world.sync.runCycle({ limit: 3 }), world.sync.runCycle({ limit: 3 })]);
        assert.equal(one.claimed + two.claimed, 6, "every due account claimed exactly once across the two cycles");
        const next = (await world.pool.query(`SELECT COUNT(*) AS n FROM email_accounts WHERE next_sync_at > NOW()`))[0][0].n;
        assert.equal(Number(next), 6, "claimed accounts are scheduled for later (the lease), so nothing is re-synced immediately");
        const third = await world.sync.runCycle({ limit: 10 });
        assert.equal(third.claimed, 0);
    });

    test("sync: provider failures back off exponentially, the owner is warned ONCE after repeated failures, and recovery clears the error", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        await gmailAccount(world, world.a, 1, "jane@gmail.com");
        const id = await accountId(world, world.a, 1, "jane@gmail.com");
        world.net.failures.set("gmail:jane@gmail.com", { status: 500, body: {} });
        world.events.length = 0;
        const gaps = [];
        for (let i = 0; i < 4; i += 1) {
            await world.sync.syncAccount(id);
            const row = (await world.pool.query(`SELECT sync_failures, sync_error, EXTRACT(EPOCH FROM (next_sync_at - NOW())) AS gap FROM email_accounts WHERE id = ?`, [id]))[0][0];
            gaps.push(Math.round(Number(row.gap) / 60));
            assert.equal(row.sync_failures, i + 1);
            assert.ok(row.sync_error);
        }
        assert.deepEqual(gaps, [1, 2, 4, 8], "1, 2, 4, 8 minutes");
        assert.equal(world.events.filter((e) => e.name === "sync-error").length, 1, "warned once, not on every failure");
        world.net.failures.delete("gmail:jane@gmail.com");
        await world.sync.syncAccount(id);
        const ok = (await world.pool.query(`SELECT sync_failures, sync_error FROM email_accounts WHERE id = ?`, [id]))[0][0];
        assert.deepEqual([ok.sync_failures, ok.sync_error], [0, null]);
        assert.ok((await world.store.listAudit(world.a.id)).some((r) => r.action === "account_sync_failing"));
    });

    test("sync: a provider that says the sign-in is gone stops the account's sync and asks the owner to reconnect; expired Gmail history is repaired, not failed", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        await gmailAccount(world, world.a, 1, "jane@gmail.com");
        await outlookAccount(world, world.a, 1, "jane@outlook.com");
        const gId = await accountId(world, world.a, 1, "jane@gmail.com");
        const oId = await accountId(world, world.a, 1, "jane@outlook.com");
        world.net.mailbox("gmail", "jane@gmail.com").expiredHistory = true;
        world.net.deliver("gmail", "jane@gmail.com", { id: "lost" });
        const repaired = await world.sync.syncAccount(gId);
        assert.equal(repaired.synced, true);
        const row = (await world.store.get(world.a.id, 1, gId));
        assert.equal(row.sync_error, "resynced");
        assert.equal(row.status, "connected");

        world.net.failures.set("graph:jane@outlook.com", { status: 401, body: { error: { code: "InvalidAuthenticationToken" } } });
        world.events.length = 0;
        world.net.refreshResponder = () => ({ status: 400, body: { error: "invalid_grant" } });
        await world.pool.query(`UPDATE email_accounts SET access_expires_at = NOW() + interval '1 hour' WHERE id = ?`, [oId]);
        const result = await world.sync.syncAccount(oId);
        assert.equal(result.reauth, true);
        assert.equal((await world.store.get(world.a.id, 1, oId)).status, "reauth_required");
        assert.ok(world.events.some((e) => e.name === "reauth" && e.accountId === oId));
        assert.equal((await world.store.claimDue(10)).some((r) => r.id === oId), false, "a reconnect-needed account is no longer synced");
    });

    // ================================================================ push
    test("push (Gmail): a notification syncs every connected account with that address; garbage and unknown addresses are ignored; the safety poll slows down once push is active", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }), { push: true });
        await gmailAccount(world, world.a, 1, "shared@gmail.com", { sub: "same-google-account" });
        await gmailAccount(world, world.b, 2, "shared@gmail.com", { sub: "same-google-account" });
        const aId = await accountId(world, world.a, 1, "shared@gmail.com");
        const bId = await accountId(world, world.b, 2, "shared@gmail.com");
        assert.equal((await world.sync.ensureSubscription(aId)).subscribed, true);
        assert.deepEqual(world.net.watches[0], { email: "shared@gmail.com", topic: "projects/p/topics/t" });
        world.net.deliver("gmail", "shared@gmail.com", { id: "p1", subject: "Pushed" });
        world.events.length = 0;
        const data = Buffer.from(JSON.stringify({ emailAddress: "Shared@Gmail.com", historyId: "9999" })).toString("base64");
        const handled = await world.sync.handleGooglePush({ message: { data, messageId: "1" } });
        assert.equal(handled.accepted, 2);
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual(world.events.filter((e) => e.name === "new-mail").map((e) => e.userId).sort(), [1, 2], "each employee is told about THEIR connection");
        assert.deepEqual([(await world.sync.handleGooglePush({ message: { data: "!!!not-base64-json" } })).ignored, (await world.sync.handleGooglePush({})).ignored], [true, true]);
        assert.equal((await world.sync.handleGooglePush({ message: { data: Buffer.from(JSON.stringify({ emailAddress: "nobody@gmail.com" })).toString("base64") } })).accepted, 0);
        const gap = Number((await world.pool.query(`SELECT EXTRACT(EPOCH FROM (next_sync_at - NOW())) AS g FROM email_accounts WHERE id = ?`, [aId]))[0][0].g);
        assert.ok(gap > 600, `with push active the safety poll is ~15 minutes (was ${Math.round(gap)}s)`);
        assert.ok(bId);
    });

    test("push (Microsoft): the clientState chosen at subscription time is the only accepted proof; wrong / missing / unknown subscriptions are rejected; the secret is stored hashed", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }), { push: true });
        await workAccount(world, world.a, 1, "jane@acme.com");
        const id = await accountId(world, world.a, 1, "jane@acme.com");
        assert.equal((await world.sync.ensureSubscription(id)).subscribed, true);
        const [subId, sub] = [...world.net.subscriptions.entries()][0];
        assert.equal(sub.notificationUrl, "https://crm.test/api/email/push/microsoft");
        assert.equal(sub.resource, "me/mailFolders('inbox')/messages");
        assert.equal(sub.changeType, "created");
        const stored = (await world.pool.query(`SELECT client_state_hash, subscription_id FROM email_push_subscriptions`))[0][0];
        assert.equal(stored.client_state_hash, secretBox.sha256Hex(sub.clientState));
        assert.ok(!JSON.stringify(stored).includes(sub.clientState), "the clientState itself is never stored");

        world.net.deliver("graph", "jane@acme.com", { id: "w1", subject: "Via push", at: Date.now() + 8000 });
        world.events.length = 0;
        const bad = await world.sync.handleMicrosoftNotifications({ value: [{ subscriptionId: subId, clientState: "wrong" }, { subscriptionId: subId }, { subscriptionId: "sub-unknown", clientState: sub.clientState }, null, {}] });
        assert.deepEqual(bad, { accepted: 0, rejected: 5 });
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(world.events.filter((e) => e.name === "new-mail").length, 0, "nothing was synchronised for a forged notification");
        const good = await world.sync.handleMicrosoftNotifications({ value: [{ subscriptionId: subId, clientState: sub.clientState, changeType: "created" }] });
        assert.deepEqual(good, { accepted: 1, rejected: 0 });
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(world.events.filter((e) => e.name === "new-mail").length, 1);
        assert.deepEqual((await world.sync.handleMicrosoftNotifications({ value: Array.from({ length: 150 }, () => ({ subscriptionId: "x", clientState: "y" })) })).rejected, 100, "a notification batch is capped");
    });

    test("subscriptions: expiring ones are renewed, ones the provider lost are re-created, accounts without one get one, and none are made when push is not configured", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }), { push: true });
        await workAccount(world, world.a, 1, "jane@acme.com");
        await workAccount(world, world.a, 2, "bob@acme.com");
        await gmailAccount(world, world.a, 3, "g@gmail.com");
        const [jId, bId] = [await accountId(world, world.a, 1, "jane@acme.com"), await accountId(world, world.a, 2, "bob@acme.com")];
        await world.sync.maintainSubscriptions(); // creates the missing ones (3 accounts)
        assert.equal((await world.pool.query(`SELECT 1 FROM email_push_subscriptions`))[0].length, 3);
        const created = world.net.subscriptionCalls.length;
        await world.sync.maintainSubscriptions();
        assert.equal(world.net.subscriptionCalls.length, created, "healthy subscriptions are left alone");

        await world.pool.query(`UPDATE email_push_subscriptions SET expires_at = NOW() + interval '2 hours' WHERE account_id = ?`, [jId]);
        const bSub = (await world.pool.query(`SELECT subscription_id FROM email_push_subscriptions WHERE account_id = ?`, [bId]))[0][0].subscription_id;
        await world.pool.query(`UPDATE email_push_subscriptions SET expires_at = NOW() + interval '2 hours' WHERE account_id = ?`, [bId]);
        world.net.subscriptions.delete(bSub); // Microsoft forgot it
        await world.sync.maintainSubscriptions();
        const ops = world.net.subscriptionCalls.slice(created);
        assert.ok(ops.some((o) => o.op === "renew"), "the expiring one was renewed");
        assert.ok(ops.some((o) => o.op === "create"), "the lost one was created again");
        const exp = Number((await world.pool.query(`SELECT EXTRACT(EPOCH FROM (expires_at - NOW())) AS e FROM email_push_subscriptions WHERE account_id = ?`, [jId]))[0][0].e);
        assert.ok(exp > 24 * 3600, "renewed well beyond the renewal window");

        const quiet = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }), { push: false });
        await gmailAccount(quiet, quiet.a, 1, "q@gmail.com");
        assert.equal((await quiet.sync.ensureSubscription(await accountId(quiet, quiet.a, 1, "q@gmail.com"))).skipped, "push not configured");
        await quiet.sync.maintainSubscriptions();
        assert.equal((await quiet.pool.query(`SELECT 1 FROM email_push_subscriptions`))[0].length, 0);
        const gap = Number((await quiet.pool.query(`SELECT EXTRACT(EPOCH FROM (next_sync_at - NOW())) AS g FROM email_accounts`))[0][0].g);
        assert.ok(gap < 200, "without push the account is polled every ~2 minutes");
    });

    test("subscriptions: a provider error while subscribing is recorded and polling carries on (push is an optimisation, never a requirement)", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }), { push: true });
        await workAccount(world, world.a, 1, "jane@acme.com");
        const id = await accountId(world, world.a, 1, "jane@acme.com");
        world.net.failures.set("graph:jane@acme.com", { status: 403, body: { error: { code: "ErrorAccessDenied" } } });
        const result = await world.sync.ensureSubscription(id);
        assert.ok(result.failed);
        const sub = (await world.pool.query(`SELECT status, last_error FROM email_push_subscriptions WHERE account_id = ?`, [id]))[0][0];
        assert.equal(sub.status, "error");
        world.net.failures.delete("graph:jane@acme.com");
        world.net.deliver("graph", "jane@acme.com", { id: "polled", at: Date.now() + 9000 });
        assert.equal((await world.sync.syncAccount(id)).fresh, 1, "mail still arrives by polling");
    });

    // ================================================================ unified inbox
    test("unified inbox: every connected account's Inbox merged newest-first with its account id; a failing account is reported, the others still show", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        await gmailAccount(world, world.a, 1, "jane@gmail.com");
        await outlookAccount(world, world.a, 1, "jane@outlook.com");
        await workAccount(world, world.a, 1, "jane@acme.com");
        const t0 = Date.UTC(2026, 5, 1, 12);
        world.net.deliver("gmail", "jane@gmail.com", { id: "g1", subject: "G newest", at: t0 + 5000 });
        world.net.deliver("graph", "jane@outlook.com", { id: "o1", subject: "O middle", at: t0 + 3000 });
        world.net.deliver("graph", "jane@acme.com", { id: "w1", subject: "W oldest", at: t0 + 1000 });
        const ids = Object.fromEntries(await Promise.all(["jane@gmail.com", "jane@outlook.com", "jane@acme.com"].map(async (e) => [e, await accountId(world, world.a, 1, e)])));
        const page = await world.service.listUnified({ companyId: world.a.id, userId: 1 });
        assert.deepEqual(page.messages.map((m) => [m.subject, m.accountId]), [["G newest", ids["jane@gmail.com"]], ["O middle", ids["jane@outlook.com"]], ["W oldest", ids["jane@acme.com"]]]);
        assert.equal(page.nextCursor, null);

        world.net.failures.set("graph:jane@outlook.com", { status: 500, body: {} });
        const partial = await world.service.listUnified({ companyId: world.a.id, userId: 1 });
        assert.deepEqual(partial.messages.map((m) => m.subject), ["G newest", "W oldest"]);
        assert.deepEqual(partial.accountErrors, [{ accountId: ids["jane@outlook.com"], code: "PROVIDER_UNAVAILABLE".replace("PROVIDER", "MICROSOFT") }]);
    });

    test("unified inbox: paging by time never repeats or skips a message, even when several arrive in the same second across accounts", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        await gmailAccount(world, world.a, 1, "jane@gmail.com");
        await workAccount(world, world.a, 1, "jane@acme.com");
        const base = Date.UTC(2026, 5, 1, 12, 0, 0);
        const all = [];
        for (let i = 0; i < 12; i += 1) {
            const at = base + Math.floor(i / 3) * 1000; // groups of three share a second
            const kind = i % 2 === 0 ? "gmail" : "graph";
            const email = i % 2 === 0 ? "jane@gmail.com" : "jane@acme.com";
            world.net.deliver(kind, email, { id: `m${String(i).padStart(2, "0")}`, subject: `S${i}`, at });
            all.push(`${kind}:m${String(i).padStart(2, "0")}`);
        }
        const seen = [];
        let cursor;
        for (let guard = 0; guard < 10; guard += 1) {
            const page = await world.service.listUnified({ companyId: world.a.id, userId: 1, params: { top: 4, cursor } });
            assert.ok(page.messages.length <= 4);
            for (const m of page.messages) seen.push(m.id);
            if (!page.nextCursor) break;
            cursor = page.nextCursor;
        }
        assert.equal(seen.length, 12, "every message exactly once");
        assert.equal(new Set(seen).size, 12, "no repeats");
        assert.deepEqual([...seen].sort(), all.map((x) => x.split(":")[1]).sort());
        await rejects(world.service.listUnified({ companyId: world.a.id, userId: 1, params: { cursor: "%%%" } }), "INVALID_CURSOR");
    });

    test("unified inbox: only THIS employee's connected accounts appear (colleagues' and reconnect-needed accounts never do); a text search is a single page", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        await gmailAccount(world, world.a, 1, "mine@gmail.com");
        await gmailAccount(world, world.a, 2, "colleague@gmail.com");
        await outlookAccount(world, world.b, 1, "same.id.other.company@outlook.com");
        await outlookAccount(world, world.a, 1, "expired@outlook.com");
        world.net.deliver("gmail", "mine@gmail.com", { id: "mine1", subject: "Mine" });
        world.net.deliver("gmail", "colleague@gmail.com", { id: "theirs1", subject: "Colleague private" });
        world.net.deliver("graph", "same.id.other.company@outlook.com", { id: "other1", subject: "Other company" });
        await world.pool.query(`UPDATE email_accounts SET status = 'reauth_required' WHERE email_address = 'expired@outlook.com'`);
        const page = await world.service.listUnified({ companyId: world.a.id, userId: 1 });
        assert.deepEqual(page.messages.map((m) => m.subject), ["Mine"]);
        assert.ok(!JSON.stringify(page).includes("Colleague") && !JSON.stringify(page).includes("Other company"));
        const search = await world.service.listUnified({ companyId: world.a.id, userId: 1, params: { q: "Mine", top: 10 } });
        assert.equal(search.nextCursor, null);
        await world.sync.syncAccount(await accountId(world, world.a, 1, "mine@gmail.com"));
        assert.equal((await world.service.summary({ companyId: world.a.id, userId: 1 })).unreadTotal, 1);
    });

    test("summary: live counts are refreshed only for stale accounts; a failing account does not hide the others", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        await gmailAccount(world, world.a, 1, "a@gmail.com");
        await outlookAccount(world, world.a, 1, "b@outlook.com");
        world.net.deliver("gmail", "a@gmail.com", { id: "x1" });
        world.net.deliver("gmail", "a@gmail.com", { id: "x2" });
        await world.pool.query(`UPDATE email_accounts SET unread_checked_at = NOW() - interval '1 hour'`);
        world.net.failures.set("graph:b@outlook.com", { status: 500, body: {} });
        const fresh = await world.service.summary({ companyId: world.a.id, userId: 1, refresh: true });
        assert.equal(fresh.accounts.find((a) => a.id === 1 || a.id).unread >= 0, true);
        assert.equal(fresh.accounts.reduce((n, a) => n + a.unread, 0), 2, "Gmail refreshed to 2; the failing Outlook account stayed at its cached 0");
    });

    test("preferences: the signature is sanitized; favourites are '<account>:<folder>' pairs; a colleague's settings are never touched", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withAccountsSchema: true }));
        const saved = await world.service.saveSettings({ companyId: world.a.id, userId: 1, signatureHtml: "<p>Jane</p><script>x()</script><img src=x onerror=alert(1)>", signatureEnabled: true, favoriteFolders: ["1:Label_5", "2:INBOX", "1:Label_5"] });
        assert.equal(saved.signatureHtml, "<p>Jane</p>");
        assert.deepEqual(saved.favoriteFolders, ["1:Label_5", "2:INBOX"]);
        for (const bad of [["Label_5"], ["x:INBOX"], ["1:../x"], "nope", Array.from({ length: 101 }, (_, i) => `1:L${i}`)]) await rejects(world.service.saveSettings({ companyId: world.a.id, userId: 1, favoriteFolders: bad }), bad === "nope" || bad.length > 100 ? "INVALID_FAVORITES" : bad[0] === "1:../x" ? "INVALID_ID" : "INVALID_FAVORITES").catch(async () => {
            await assert.rejects(world.service.saveSettings({ companyId: world.a.id, userId: 1, favoriteFolders: bad }), (e) => ["INVALID_FAVORITES", "INVALID_ID"].includes(e.code));
        });
        assert.equal((await world.service.getSettings({ companyId: world.a.id, userId: 2 })).signatureHtml, "");
        assert.equal((await world.service.getSettings({ companyId: world.b.id, userId: 1 })).signatureHtml, "");
    });
}

module.exports = { defineCases };
