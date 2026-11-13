// Microsoft 365 email on a REAL PostgreSQL: the schema, the additive migration, tenant isolation, the OAuth callback
// (state, nonce, tenant and account checks), encrypted token storage, refresh / revocation, mailbox ownership, audit.
//
// This file only DEFINES the cases; it is loaded by _test_ms_email_pg.js, which supplies a disposable database
// (PG_TEST_* guard, run in the pr-checks migration-postgres job).
//
// `newPlatformDatabase({ withMicrosoftSchema })` must return a pool with query(sql, params) -> [rows] (the repo's
// compat shape) and nativePool.query(multiStatementSql).

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { createMsEmailStore } = require("./services/msEmailStore");
const { createMsEmailService } = require("./services/msEmailService");
const secretBox = require("./utils/secretBox");
const migration = require("./_migrate_add_microsoft_email");
const { MS_SCOPES } = require("./config/microsoftEmailConfig");

const KEY = crypto.randomBytes(32).toString("base64");
const CLIENT_ID = "test-client-id";
const TENANT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const TENANT_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const TENANT_OTHER = "cccccccc-0000-4000-8000-00000000000c";

const CONFIG = {
    configured: true,
    missing: [],
    clientId: CLIENT_ID,
    clientSecret: "test-secret",
    redirectUri: "https://crm.test/api/email/ms/callback",
    tokenKey: KEY,
    frontendOrigin: "https://crm.test",
    scopes: MS_SCOPES,
};

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const idToken = (claims) => `h.${b64(claims)}.s`;

function defineCases({ test, newPlatformDatabase }) {
    // ---------------------------------------------------------------- world builder
    async function buildWorld(pool) {
        const store = createMsEmailStore(pool);
        const ms = { tokenCalls: [], graphCalls: [], respondToken: null, domains: { "acme.com": TENANT_A, "globex.com": TENANT_B } };

        const fetchImpl = async (url, init = {}) => {
            const u = new URL(url);
            const reply = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body, text: async () => JSON.stringify(body) });
            const discovery = /^\/([^/]+)\/v2\.0\/\.well-known\/openid-configuration$/.exec(u.pathname);
            if (u.host === "login.microsoftonline.com" && discovery) {
                const tenant = ms.domains[decodeURIComponent(discovery[1])];
                return tenant ? reply(200, { issuer: `https://login.microsoftonline.com/${tenant}/v2.0` }) : reply(400, {});
            }
            if (u.host === "login.microsoftonline.com" && u.pathname.endsWith("/oauth2/v2.0/token")) {
                const params = new URLSearchParams(init.body);
                ms.tokenCalls.push({ tenant: u.pathname.split("/")[1], params });
                assert.ok(ms.respondToken, "a token response must be scripted");
                const out = ms.respondToken(params, u.pathname.split("/")[1]);
                return reply(out.status, out.body);
            }
            if (u.host === "graph.microsoft.com") {
                ms.graphCalls.push({ path: u.pathname, authorization: init.headers && init.headers.Authorization });
                return reply(200, { value: [], ok: true });
            }
            throw new Error("unexpected fetch " + url);
        };

        const domainService = {
            async listDomainsForCompany(companyId) {
                const [rows] = await pool.query(`SELECT * FROM email_domains WHERE company_id = ? ORDER BY id`, [companyId]);
                return rows;
            },
            async getDomainForCompany(domainId, companyId) {
                const [rows] = await pool.query(`SELECT * FROM email_domains WHERE id = ? AND company_id = ? LIMIT 1`, [domainId, companyId]);
                return rows[0] || null;
            },
        };
        const service = createMsEmailService({
            store,
            fetchImpl,
            sleep: async () => {},
            getConfig: () => CONFIG,
            emailDomainService: domainService,
            getCompanyById: async (id) => ({ id, company_slug: id === world.a.id ? "acme" : "globex" }),
        });

        const addCompany = async (slug) => (await pool.query(`INSERT INTO companies (company_name, company_slug, status) VALUES (?, ?, 'active') RETURNING id`, [slug.toUpperCase(), slug]))[0][0].id;
        const addDomain = async (companyId, domain) => (await pool.query(`INSERT INTO email_domains (company_id, domain, verification_status, verification_token, verified_at) VALUES (?, ?, 'verified', ?, NOW()) RETURNING id`, [companyId, domain, crypto.randomBytes(32).toString("hex")]))[0][0].id;
        const addMailbox = async (companyId, domainId, userId, address) => (await pool.query(`INSERT INTO mailboxes (company_id, domain_id, tenant_user_id, email_address) VALUES (?, ?, ?, ?) RETURNING id`, [companyId, domainId, userId, address]))[0][0].id;

        const a = { id: await addCompany("acme") };
        const b = { id: await addCompany("globex") };
        a.domainId = await addDomain(a.id, "acme.com");
        b.domainId = await addDomain(b.id, "globex.com");
        // The SAME tenant_user_id (1) exists in both companies' own databases: ids are per-tenant, so they collide on purpose.
        a.mailbox1 = await addMailbox(a.id, a.domainId, 1, "jane@acme.com");
        a.mailbox2 = await addMailbox(a.id, a.domainId, 2, "bob@acme.com");
        b.mailbox1 = await addMailbox(b.id, b.domainId, 1, "zed@globex.com");
        const world = { pool, store, service, ms, a, b, fetchImpl };
        return world;
    }

    // Drives a full employee sign-in: begin -> (Microsoft) -> callback, returning the callback result.
    async function signIn(world, { company, userId, account, tenant, tamper = {}, claimsOverride = {}, tokenOverrides = {} }) {
        const { authorizationUrl } = await world.service.beginConnect({ companyId: company.id, userId, returnPortal: "employee" });
        const url = new URL(authorizationUrl);
        const state = url.searchParams.get("state");
        const nonce = url.searchParams.get("nonce");
        const loginTenant = url.pathname.split("/")[1];
        const accessToken = `AT-${crypto.randomBytes(8).toString("hex")}`;
        const refreshToken = `RT-${crypto.randomBytes(8).toString("hex")}`;
        world.ms.respondToken = (params) => ({
            status: 200,
            body: {
                access_token: accessToken,
                refresh_token: refreshToken,
                expires_in: 3600,
                scope: MS_SCOPES.join(" "),
                id_token: idToken({ aud: CLIENT_ID, tid: tenant || loginTenant, iss: `https://login.microsoftonline.com/${tenant || loginTenant}/v2.0`, exp: Math.floor(Date.now() / 1000) + 3600, nonce, oid: `oid-${userId}`, preferred_username: account, ...claimsOverride }),
                ...tokenOverrides,
            },
        });
        const result = await world.service.completeCallback({ code: "authcode-1234567890", state: tamper.state || state });
        return { result, url, state, accessToken, refreshToken, nonce };
    }

    const connectAndLink = async (world) => {
        await world.service.connectCompany({ companyId: world.a.id, actorUserId: 100, domainId: world.a.domainId });
        await world.service.connectCompany({ companyId: world.b.id, actorUserId: 200, domainId: world.b.domainId });
        await world.service.linkMailbox({ companyId: world.a.id, actorUserId: 100, mailboxId: world.a.mailbox1 });
        await world.service.linkMailbox({ companyId: world.a.id, actorUserId: 100, mailboxId: world.a.mailbox2 });
        await world.service.linkMailbox({ companyId: world.b.id, actorUserId: 200, mailboxId: world.b.mailbox1 });
    };

    const rejects = async (promise, code) => {
        await assert.rejects(promise, (error) => {
            assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
            return true;
        });
    };

    // ================================================================ schema + migration
    test("schema: the platform schema file creates the Microsoft tables and the new columns, and carries the migration SQL verbatim", async () => {
        const pool = await newPlatformDatabase({ withMicrosoftSchema: true });
        for (const table of migration.NEW_TABLES) {
            const [rows] = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = ?`, [table]);
            assert.equal(rows.length, 1, table);
        }
        for (const [table, column] of migration.NEW_COLUMNS) {
            const [rows] = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ?`, [table, column]);
            assert.equal(rows.length, 1, `${table}.${column}`);
        }
        const normalise = (text) => text.replace(/\r\n/g, "\n");
        const platform = normalise(fs.readFileSync(path.join(__dirname, "schemas", "platformSchema.postgresql.sql"), "utf8"));
        const own = normalise(fs.readFileSync(migration.SCHEMA_PATH, "utf8"));
        assert.ok(platform.includes(own.trim()), "platformSchema.postgresql.sql must contain emailMicrosoftSchema.postgresql.sql unchanged");
    });

    test("migration: additive on an existing database -- old rows keep their data, new columns get safe defaults, re-running changes nothing", async () => {
        const pool = await newPlatformDatabase({ withMicrosoftSchema: false });
        const companyId = (await pool.query(`INSERT INTO companies (company_name, company_slug, status) VALUES ('Old Co', 'oldco', 'active') RETURNING id`))[0][0].id;
        const domainId = (await pool.query(`INSERT INTO email_domains (company_id, domain, verification_token) VALUES (?, 'old.example', 'tok') RETURNING id`, [companyId]))[0][0].id;
        await pool.query(`INSERT INTO mailboxes (company_id, domain_id, tenant_user_id, email_address, provisioning_status, status) VALUES (?, ?, 7, 'a@old.example', 'pending_infrastructure', 'suspended')`, [companyId, domainId]);
        const before = (await pool.query(`SELECT id, company_id, domain_id, tenant_user_id, email_address, provisioning_status, status FROM mailboxes`))[0];

        const dry = await migration.run(pool, { dryRun: true, log: () => {} });
        assert.equal(dry.applied, false);
        assert.ok(dry.missingTables.length === migration.NEW_TABLES.length);
        assert.equal((await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'email_audit_log'`))[0].length, 0, "a dry run changes nothing");

        await migration.run(pool, { log: () => {} });
        await migration.run(pool, { log: () => {} }); // idempotent

        const after = (await pool.query(`SELECT id, company_id, domain_id, tenant_user_id, email_address, provisioning_status, status FROM mailboxes`))[0];
        assert.deepEqual(after, before, "existing mailbox rows are untouched");
        const row = (await pool.query(`SELECT provider, link_state, linked_at FROM mailboxes`))[0][0];
        assert.deepEqual({ ...row }, { provider: "none", link_state: "unlinked", linked_at: null });
        assert.equal((await pool.query(`SELECT mail_hosting FROM email_domains`))[0][0].mail_hosting, "external");
        await assert.rejects(pool.query(`UPDATE mailboxes SET link_state = 'bogus'`), /chk_mailboxes_link_state|violates check/);
    });

    test("migration: stops with a clear message when the earlier email tables are missing", async () => {
        const pool = await newPlatformDatabase({ withMicrosoftSchema: false });
        await pool.query(`DROP TABLE mailboxes CASCADE`);
        await assert.rejects(migration.run(pool, { log: () => {} }), /Required table "mailboxes" is missing/);
    });

    // ================================================================ connection, linking
    test("company connection: the tenant is discovered from the company's OWN verified domain; unverified or foreign domains are refused", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        const connection = await world.service.connectCompany({ companyId: world.a.id, actorUserId: 100, domainId: world.a.domainId });
        assert.equal(connection.ms_tenant_id, TENANT_A);
        assert.equal(connection.status, "ready");

        // Company A cannot use company B's domain id.
        await rejects(world.service.connectCompany({ companyId: world.a.id, actorUserId: 100, domainId: world.b.domainId }), "DOMAIN_NOT_FOUND");
        // An unverified domain cannot be used.
        const pending = (await world.pool.query(`INSERT INTO email_domains (company_id, domain, verification_status, verification_token) VALUES (?, 'pending.test', 'pending', 'x') RETURNING id`, [world.a.id]))[0][0].id;
        await rejects(world.service.connectCompany({ companyId: world.a.id, actorUserId: 100, domainId: pending }), "DOMAIN_NOT_VERIFIED");
        // A domain Microsoft does not know is recorded as an error, with a clear code.
        const unknown = (await world.pool.query(`INSERT INTO email_domains (company_id, domain, verification_status, verification_token) VALUES (?, 'no-microsoft.test', 'verified', 'y') RETURNING id`, [world.a.id]))[0][0].id;
        await rejects(world.service.connectCompany({ companyId: world.a.id, actorUserId: 100, domainId: unknown }), "DOMAIN_NOT_IN_MICROSOFT");
        assert.equal((await world.store.getCompanyConnection(world.a.id)).status, "error");
        // Company B is unaffected by any of this.
        assert.equal(await world.store.getCompanyConnection(world.b.id), null);
    });

    test("linking: needs a ready company connection; a mailbox of another company cannot be linked; domain must be in the same Microsoft organisation", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await rejects(world.service.linkMailbox({ companyId: world.a.id, actorUserId: 100, mailboxId: world.a.mailbox1 }), "COMPANY_NOT_READY");
        await world.service.connectCompany({ companyId: world.a.id, actorUserId: 100, domainId: world.a.domainId });

        await rejects(world.service.linkMailbox({ companyId: world.a.id, actorUserId: 100, mailboxId: world.b.mailbox1 }), "MAILBOX_NOT_FOUND");
        const linked = await world.service.linkMailbox({ companyId: world.a.id, actorUserId: 100, mailboxId: world.a.mailbox1 });
        assert.equal(linked.provider, "microsoft365");
        assert.equal(linked.link_state, "awaiting_user");
        assert.equal(linked.provisioning_status, "pending_infrastructure", "a CRM record does not pretend a Microsoft mailbox exists");

        // A mailbox on a domain that Microsoft places in a DIFFERENT organisation is refused.
        const foreignDomain = (await world.pool.query(`INSERT INTO email_domains (company_id, domain, verification_status, verification_token) VALUES (?, 'elsewhere.test', 'verified', 'z') RETURNING id`, [world.a.id]))[0][0].id;
        world.ms.domains["elsewhere.test"] = TENANT_OTHER;
        const stray = (await world.pool.query(`INSERT INTO mailboxes (company_id, domain_id, tenant_user_id, email_address) VALUES (?, ?, 3, 'x@elsewhere.test') RETURNING id`, [world.a.id, foreignDomain]))[0][0].id;
        await rejects(world.service.linkMailbox({ companyId: world.a.id, actorUserId: 100, mailboxId: stray }), "DOMAIN_TENANT_MISMATCH");

        // One Microsoft mailbox per employee.
        const second = (await world.pool.query(`INSERT INTO mailboxes (company_id, domain_id, tenant_user_id, email_address) VALUES (?, ?, 1, 'jane2@acme.com') RETURNING id`, [world.a.id, world.a.domainId]))[0][0].id;
        await rejects(world.service.linkMailbox({ companyId: world.a.id, actorUserId: 100, mailboxId: second }), "EMPLOYEE_ALREADY_LINKED");
        // A disabled mailbox cannot be linked.
        await world.pool.query(`UPDATE mailboxes SET status = 'disabled' WHERE id = ?`, [world.a.mailbox2]);
        await rejects(world.service.linkMailbox({ companyId: world.a.id, actorUserId: 100, mailboxId: world.a.mailbox2 }), "MAILBOX_DISABLED");
    });

    // ================================================================ OAuth callback
    test("connect: a correct sign-in stores ENCRYPTED tokens, links the mailbox and marks it provisioned; the browser is sent back to the CRM", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await connectAndLink(world);
        const flow = await signIn(world, { company: world.a, userId: 1, account: "Jane@Acme.com" });
        assert.equal(flow.result.ok, true);
        assert.equal(flow.url.pathname, `/${TENANT_A}/oauth2/v2.0/authorize`);
        assert.equal(flow.url.searchParams.get("login_hint"), "jane@acme.com");
        assert.equal(flow.url.searchParams.get("code_challenge_method"), "S256");

        // The code exchange used the company's own tenant endpoint and the PKCE verifier matching the challenge.
        const call = world.ms.tokenCalls.at(-1);
        assert.equal(call.tenant, TENANT_A);
        assert.equal(crypto.createHash("sha256").update(call.params.get("code_verifier")).digest("base64url"), flow.url.searchParams.get("code_challenge"));

        const raw = (await world.pool.query(`SELECT * FROM email_ms_user_connections WHERE company_id = ?`, [world.a.id]))[0];
        assert.equal(raw.length, 1);
        assert.equal(raw[0].status, "connected");
        assert.equal(raw[0].ms_account, "jane@acme.com");
        assert.equal(raw[0].ms_tenant_id, TENANT_A);
        assert.ok(raw[0].access_token_enc.startsWith("v1.") && !raw[0].access_token_enc.includes(flow.accessToken), "tokens are not stored in the clear");
        assert.ok(raw[0].refresh_token_enc.startsWith("v1.") && !raw[0].refresh_token_enc.includes(flow.refreshToken));
        assert.equal(secretBox.decrypt(raw[0].refresh_token_enc, `ms-user:${world.a.id}:1`, KEY), flow.refreshToken);

        const mailbox = await world.store.getMailbox(world.a.id, world.a.mailbox1);
        assert.equal(mailbox.link_state, "linked");
        assert.equal(mailbox.provisioning_status, "provisioned");
        assert.ok(mailbox.linked_at);

        const status = await world.service.employeeStatus({ companyId: world.a.id, userId: 1 });
        assert.equal(status.state, "connected");
        assert.equal(status.connection.account, "jane@acme.com");
        assert.ok(!JSON.stringify(status).match(/_enc|AT-|RT-/), "no token field ever appears in a status response");

        const redirect = await world.service.frontendRedirect({ companyId: world.a.id, returnPortal: "employee", result: flow.result });
        assert.equal(redirect, "https://crm.test/acme/employee/email?ms=connected");
    });

    test("callback: a state works ONCE -- a replay finds nothing", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await connectAndLink(world);
        const flow = await signIn(world, { company: world.a, userId: 1, account: "jane@acme.com" });
        assert.equal(flow.result.ok, true);
        const replay = await world.service.completeCallback({ code: "authcode-1234567890", state: flow.state });
        assert.deepEqual({ ok: replay.ok, reason: replay.reason }, { ok: false, reason: "invalid_state" });
    });

    test("callback: an expired, unknown, malformed or missing state is rejected and no token endpoint is called", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await connectAndLink(world);
        const calls = () => world.ms.tokenCalls.length;
        const { authorizationUrl } = await world.service.beginConnect({ companyId: world.a.id, userId: 1, returnPortal: "employee" });
        const state = new URL(authorizationUrl).searchParams.get("state");
        await world.pool.query(`UPDATE email_ms_oauth_states SET expires_at = NOW() - interval '1 minute'`);
        const before = calls();
        for (const candidate of [state, "x".repeat(43), "short", undefined, null, "", "a".repeat(500)]) {
            const result = await world.service.completeCallback({ code: "authcode-1234567890", state: candidate });
            assert.equal(result.ok, false);
            assert.equal(result.reason, "invalid_state");
        }
        assert.equal(calls(), before);
    });

    test("callback: the user denying consent, or a missing code, ends the attempt without storing anything", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await connectAndLink(world);
        let begin = await world.service.beginConnect({ companyId: world.a.id, userId: 1, returnPortal: "employee" });
        let state = new URL(begin.authorizationUrl).searchParams.get("state");
        const denied = await world.service.completeCallback({ state, error: "access_denied" });
        assert.equal(denied.reason, "denied");
        begin = await world.service.beginConnect({ companyId: world.a.id, userId: 1, returnPortal: "employee" });
        state = new URL(begin.authorizationUrl).searchParams.get("state");
        assert.equal((await world.service.completeCallback({ state })).reason, "invalid_code");
        assert.equal((await world.pool.query(`SELECT 1 FROM email_ms_user_connections`))[0].length, 0);
    });

    test("callback: an account from ANOTHER organisation (or a personal account) is refused, and nothing is stored", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await connectAndLink(world);
        for (const tenant of [TENANT_B, TENANT_OTHER, "9188040d-6c67-4c5b-b112-36a304b66dad"]) {
            const { result } = await signIn(world, { company: world.a, userId: 1, account: "jane@acme.com", tenant });
            assert.equal(result.ok, false, tenant);
            assert.equal(result.reason, "wrong_organisation");
        }
        assert.equal((await world.pool.query(`SELECT 1 FROM email_ms_user_connections`))[0].length, 0);
        assert.equal((await world.store.getMailbox(world.a.id, world.a.mailbox1)).link_state, "awaiting_user");
    });

    test("callback: signing in as someone ELSE's mailbox in the right organisation is refused (the account must be the mailbox)", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await connectAndLink(world);
        const { result } = await signIn(world, { company: world.a, userId: 1, account: "bob@acme.com" }); // Jane's CRM user, Bob's Microsoft account
        assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: "wrong_account" });
        assert.equal((await world.pool.query(`SELECT 1 FROM email_ms_user_connections`))[0].length, 0);
        const audit = await world.store.listAudit(world.a.id);
        assert.ok(audit.some((entry) => entry.action === "connect_wrong_account"));
    });

    test("callback: a replayed nonce, a token for another app, or an expired token is refused", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await connectAndLink(world);
        for (const claimsOverride of [{ nonce: "someone-elses-nonce" }, { aud: "another-app" }, { exp: Math.floor(Date.now() / 1000) - 7200 }, { oid: undefined }]) {
            const { result } = await signIn(world, { company: world.a, userId: 1, account: "jane@acme.com", claimsOverride });
            assert.equal(result.ok, false, JSON.stringify(claimsOverride));
        }
        const noRefresh = await signIn(world, { company: world.a, userId: 1, account: "jane@acme.com", tokenOverrides: { refresh_token: undefined } });
        assert.equal(noRefresh.result.reason, "no_refresh_token");
        assert.equal((await world.pool.query(`SELECT 1 FROM email_ms_user_connections`))[0].length, 0);
    });

    test("callback: a Microsoft outage or rejected code ends cleanly (generic failure), and the state is already spent", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await connectAndLink(world);
        const { authorizationUrl } = await world.service.beginConnect({ companyId: world.a.id, userId: 1, returnPortal: "employee" });
        const state = new URL(authorizationUrl).searchParams.get("state");
        world.ms.respondToken = () => ({ status: 400, body: { error: "invalid_grant", error_description: "AADSTS70008 secret detail" } });
        const result = await world.service.completeCallback({ code: "authcode-1234567890", state });
        assert.equal(result.ok, false);
        assert.ok(!JSON.stringify(result).includes("AADSTS"));
        assert.equal((await world.service.completeCallback({ code: "authcode-1234567890", state })).reason, "invalid_state");
    });

    test("begin: only the mailbox's own employee, on a linked, active mailbox, in a ready company -- and the server must be configured", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await rejects(world.service.beginConnect({ companyId: world.a.id, userId: 1, returnPortal: "employee" }), "COMPANY_NOT_READY");
        await connectAndLink(world);
        await rejects(world.service.beginConnect({ companyId: world.a.id, userId: 99, returnPortal: "employee" }), "NO_MAILBOX"); // an employee with no mailbox
        await world.pool.query(`UPDATE mailboxes SET provider = 'none', link_state = 'unlinked' WHERE id = ?`, [world.a.mailbox2]);
        await rejects(world.service.beginConnect({ companyId: world.a.id, userId: 2, returnPortal: "employee" }), "NOT_LINKED");
        await world.pool.query(`UPDATE mailboxes SET status = 'disabled' WHERE id = ?`, [world.a.mailbox1]);
        await rejects(world.service.beginConnect({ companyId: world.a.id, userId: 1, returnPortal: "employee" }), "MAILBOX_DISABLED");

        const unconfigured = createMsEmailService({ store: world.store, fetchImpl: world.fetchImpl, getConfig: () => ({ ...CONFIG, configured: false, missing: ["MS_EMAIL_CLIENT_ID"] }) });
        await rejects(unconfigured.beginConnect({ companyId: world.a.id, userId: 1, returnPortal: "employee" }), "MS_NOT_CONFIGURED");
        assert.equal((await unconfigured.employeeStatus({ companyId: world.a.id, userId: 1 })).state, "server_not_configured");
    });

    // ================================================================ isolation
    test("isolation: the same employee id in two companies never shares a connection, a mailbox, a token or a settings row", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await connectAndLink(world);
        const a = await signIn(world, { company: world.a, userId: 1, account: "jane@acme.com" });
        const b = await signIn(world, { company: world.b, userId: 1, account: "zed@globex.com" });
        assert.equal(a.result.ok && b.result.ok, true);

        // Each company's user 1 reaches Microsoft with ITS OWN token only.
        const ctxA = await world.service.getMailContext({ companyId: world.a.id, userId: 1 });
        const ctxB = await world.service.getMailContext({ companyId: world.b.id, userId: 1 });
        assert.notEqual(ctxA.mailbox.id, ctxB.mailbox.id);
        assert.equal(ctxA.mailbox.email_address, "jane@acme.com");
        assert.equal(ctxB.mailbox.email_address, "zed@globex.com");
        world.ms.graphCalls.length = 0;
        await ctxA.graph.get("/me/messages");
        await ctxB.graph.get("/me/messages");
        assert.deepEqual(world.ms.graphCalls.map((c) => c.authorization), [`Bearer ${a.accessToken}`, `Bearer ${b.accessToken}`]);

        // Readers are scoped: company A's lists never contain B's rows, and token columns are never returned.
        const listedA = await world.service.listMailboxes(world.a.id);
        assert.ok(listedA.every((row) => row.company_id === world.a.id));
        assert.ok(listedA.some((row) => row.connection_status === "connected"));
        assert.ok(!listedA.some((row) => row.email_address.endsWith("@globex.com")));
        assert.ok(!JSON.stringify(listedA).includes("_enc"));
        assert.ok(!Object.keys(await world.store.getConnection(world.a.id, 1)).some((key) => key.endsWith("_enc")));

        // Settings are per company + employee.
        await world.service.saveSettings({ companyId: world.a.id, userId: 1, signatureHtml: "<b>A-sig</b>", signatureEnabled: true });
        assert.equal((await world.service.getSettings({ companyId: world.b.id, userId: 1 })).signatureHtml, "");
        assert.equal((await world.service.getSettings({ companyId: world.a.id, userId: 1 })).signatureHtml, "<b>A-sig</b>");

        // Audit is per company.
        assert.ok((await world.store.listAudit(world.a.id)).every((row) => row.id));
        const auditA = await world.pool.query(`SELECT company_id FROM email_audit_log WHERE company_id = ?`, [world.a.id]);
        assert.ok(auditA[0].length > 0);
        assert.equal((await world.store.listAudit(world.a.id)).length, auditA[0].length);
    });

    test("isolation: an admin acting for company A cannot touch company B's mailbox, link, connection or tokens", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await connectAndLink(world);
        await signIn(world, { company: world.b, userId: 1, account: "zed@globex.com" });
        await rejects(world.service.unlinkMailbox({ companyId: world.a.id, actorUserId: 100, mailboxId: world.b.mailbox1 }), "MAILBOX_NOT_FOUND");
        await rejects(world.service.setMailboxEnabled({ companyId: world.a.id, actorUserId: 100, mailboxId: world.b.mailbox1, enabled: false }), "MAILBOX_NOT_FOUND");
        assert.equal((await world.store.getConnection(world.b.id, 1)).status, "connected", "B's connection is untouched");
        assert.equal((await world.store.getMailbox(world.b.id, world.b.mailbox1)).link_state, "linked");

        // Disconnecting company A removes A's connections only.
        await signIn(world, { company: world.a, userId: 1, account: "jane@acme.com" });
        const result = await world.service.disconnectCompany({ companyId: world.a.id, actorUserId: 100 });
        assert.equal(result.removed, 1);
        assert.equal(await world.store.getConnection(world.a.id, 1), null);
        assert.equal((await world.store.getMailbox(world.a.id, world.a.mailbox1)).provider, "none");
        assert.equal((await world.store.getConnection(world.b.id, 1)).status, "connected");
        assert.equal((await world.store.getCompanyConnection(world.a.id)).status, "disabled");
        await rejects(world.service.getMailContext({ companyId: world.a.id, userId: 1 }), "COMPANY_NOT_READY");
    });

    test("isolation: a token ciphertext copied into another company's row cannot be decrypted there (bound to company and user)", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await connectAndLink(world);
        await signIn(world, { company: world.a, userId: 1, account: "jane@acme.com" });
        await signIn(world, { company: world.b, userId: 1, account: "zed@globex.com" });
        // A database-level mix-up: B's row now holds A's sealed tokens.
        await world.pool.query(
            `UPDATE email_ms_user_connections SET access_token_enc = (SELECT access_token_enc FROM email_ms_user_connections WHERE company_id = ?),
                    refresh_token_enc = (SELECT refresh_token_enc FROM email_ms_user_connections WHERE company_id = ?) WHERE company_id = ?`,
            [world.a.id, world.a.id, world.b.id]
        );
        const ctx = await world.service.getMailContext({ companyId: world.b.id, userId: 1 });
        world.ms.graphCalls.length = 0;
        await assert.rejects(ctx.graph.get("/me/messages"), (error) => error.code === "REAUTH_REQUIRED");
        assert.equal(world.ms.graphCalls.length, 0, "Microsoft was never called with A's token");
        assert.equal((await world.store.getConnection(world.b.id, 1)).status, "reauth_required");
        assert.equal((await world.store.getConnection(world.a.id, 1)).status, "connected");
    });

    // ================================================================ access, refresh, revocation
    test("access: no mailbox / not connected / disabled mailbox / disabled company are each refused with their own code", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await rejects(world.service.getMailContext({ companyId: world.a.id, userId: 1 }), "COMPANY_NOT_READY");
        await connectAndLink(world);
        await rejects(world.service.getMailContext({ companyId: world.a.id, userId: 99 }), "NO_MAILBOX");
        await rejects(world.service.getMailContext({ companyId: world.a.id, userId: 1 }), "NOT_CONNECTED");
        await signIn(world, { company: world.a, userId: 1, account: "jane@acme.com" });
        assert.ok(await world.service.getMailContext({ companyId: world.a.id, userId: 1 }));
        await world.pool.query(`UPDATE mailboxes SET status = 'suspended' WHERE id = ?`, [world.a.mailbox1]);
        await rejects(world.service.getMailContext({ companyId: world.a.id, userId: 1 }), "MAILBOX_DISABLED");
        await world.pool.query(`UPDATE mailboxes SET status = 'active' WHERE id = ?`, [world.a.mailbox1]);
        await world.pool.query(`UPDATE email_ms_company_connections SET status = 'error', last_error = 'TENANT_CHANGED' WHERE company_id = ?`, [world.a.id]);
        await rejects(world.service.getMailContext({ companyId: world.a.id, userId: 1 }), "COMPANY_NOT_READY");
        await world.pool.query(`UPDATE email_ms_company_connections SET status = 'ready', last_error = NULL WHERE company_id = ?`, [world.a.id]);
        assert.ok(await world.service.getMailContext({ companyId: world.a.id, userId: 1 }));
    });

    test("tokens: an expired access token is refreshed ONCE even for parallel requests; the rotated refresh token replaces the old one", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await connectAndLink(world);
        const first = await signIn(world, { company: world.a, userId: 1, account: "jane@acme.com" });
        await world.pool.query(`UPDATE email_ms_user_connections SET access_expires_at = NOW() - interval '5 minutes'`);

        let refreshes = 0;
        world.ms.respondToken = (params) => {
            assert.equal(params.get("grant_type"), "refresh_token");
            assert.equal(params.get("refresh_token"), first.refreshToken);
            refreshes += 1;
            return { status: 200, body: { access_token: "AT-REFRESHED", refresh_token: "RT-ROTATED", expires_in: 3600, scope: "Mail.ReadWrite" } };
        };
        const ctx = await world.service.getMailContext({ companyId: world.a.id, userId: 1 });
        world.ms.graphCalls.length = 0;
        await Promise.all(Array.from({ length: 6 }, () => ctx.graph.get("/me/messages")));
        assert.equal(refreshes, 1, "one refresh, shared by every parallel request");
        assert.ok(world.ms.graphCalls.every((call) => call.authorization === "Bearer AT-REFRESHED"));

        const raw = (await world.pool.query(`SELECT * FROM email_ms_user_connections WHERE company_id = ?`, [world.a.id]))[0][0];
        assert.equal(secretBox.decrypt(raw.refresh_token_enc, `ms-user:${world.a.id}:1`, KEY), "RT-ROTATED");
        assert.equal(raw.status, "connected");

        // A fresh token is used as is: no further refresh.
        const again = await world.service.getMailContext({ companyId: world.a.id, userId: 1 });
        await again.graph.get("/me/messages");
        assert.equal(refreshes, 1);
    });

    test("revocation: when Microsoft rejects the refresh token the connection becomes reauth_required, the stored tokens are wiped, and the employee is told to reconnect", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await connectAndLink(world);
        await signIn(world, { company: world.a, userId: 1, account: "jane@acme.com" });
        await world.pool.query(`UPDATE email_ms_user_connections SET access_expires_at = NOW() - interval '5 minutes'`);
        world.ms.respondToken = () => ({ status: 400, body: { error: "invalid_grant", error_description: "AADSTS50173 detail" } });

        const ctx = await world.service.getMailContext({ companyId: world.a.id, userId: 1 });
        await assert.rejects(ctx.graph.get("/me/messages"), (error) => error.code === "REAUTH_REQUIRED" && !/AADSTS/.test(error.message));
        const raw = (await world.pool.query(`SELECT status, access_token_enc, refresh_token_enc, last_error FROM email_ms_user_connections`))[0][0];
        assert.equal(raw.status, "reauth_required");
        assert.equal(raw.access_token_enc, null);
        assert.equal(raw.refresh_token_enc, null);
        assert.equal((await world.service.employeeStatus({ companyId: world.a.id, userId: 1 })).state, "reauth_required");
        await rejects(world.service.getMailContext({ companyId: world.a.id, userId: 1 }), "REAUTH_REQUIRED");

        // Reconnecting restores access.
        const again = await signIn(world, { company: world.a, userId: 1, account: "jane@acme.com" });
        assert.equal(again.result.ok, true);
        assert.equal((await world.service.employeeStatus({ companyId: world.a.id, userId: 1 })).state, "connected");
    });

    test("revocation: a Graph 401 that a refresh cannot fix marks the connection reauth_required", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await connectAndLink(world);
        await signIn(world, { company: world.a, userId: 1, account: "jane@acme.com" });
        const failing = createMsEmailService({
            store: world.store, getConfig: () => CONFIG, sleep: async () => {},
            fetchImpl: async (url) => (new URL(url).host === "graph.microsoft.com"
                ? { ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: { code: "InvalidAuthenticationToken" } }), text: async () => "" }
                : { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 }), text: async () => "" }),
        });
        await world.pool.query(`UPDATE email_ms_user_connections SET access_expires_at = NOW() + interval '1 hour'`);
        const ctx = await failing.getMailContext({ companyId: world.a.id, userId: 1 });
        const error = await ctx.graph.get("/me/messages").catch((e) => e);
        assert.equal(error.code, "REAUTH_REQUIRED");
        await failing.noteGraphFailure({ companyId: world.a.id, userId: 1 }, error);
        assert.equal((await world.store.getConnection(world.a.id, 1)).status, "reauth_required");
    });

    test("admin controls: disabling a mailbox deletes its tokens at once; unlinking clears the link; the employee can disconnect themselves", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await connectAndLink(world);
        await signIn(world, { company: world.a, userId: 1, account: "jane@acme.com" });
        await signIn(world, { company: world.a, userId: 2, account: "bob@acme.com" });

        await world.service.setMailboxEnabled({ companyId: world.a.id, actorUserId: 100, mailboxId: world.a.mailbox1, enabled: false });
        assert.equal(await world.store.getConnection(world.a.id, 1), null, "tokens are gone the moment the admin disables the mailbox");

        await world.service.unlinkMailbox({ companyId: world.a.id, actorUserId: 100, mailboxId: world.a.mailbox2 });
        assert.equal(await world.store.getConnection(world.a.id, 2), null);
        const unlinked = await world.store.getMailbox(world.a.id, world.a.mailbox2);
        assert.deepEqual({ provider: unlinked.provider, link_state: unlinked.link_state, provisioning_status: unlinked.provisioning_status }, { provider: "none", link_state: "unlinked", provisioning_status: "pending_infrastructure" });

        await world.service.linkMailbox({ companyId: world.a.id, actorUserId: 100, mailboxId: world.a.mailbox2 });
        await signIn(world, { company: world.a, userId: 2, account: "bob@acme.com" });
        assert.deepEqual(await world.service.disconnectOwn({ companyId: world.a.id, userId: 2 }), { disconnected: true });
        assert.equal(await world.store.getConnection(world.a.id, 2), null);
        assert.equal((await world.store.getMailbox(world.a.id, world.a.mailbox2)).link_state, "awaiting_user");
        assert.deepEqual(await world.service.disconnectOwn({ companyId: world.a.id, userId: 2 }), { disconnected: false });
    });

    test("company health check: a domain that moves to another Microsoft organisation is flagged and mail access stops until an admin re-checks", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await connectAndLink(world);
        await signIn(world, { company: world.a, userId: 1, account: "jane@acme.com" });
        assert.equal((await world.service.checkCompanyConnection({ companyId: world.a.id, actorUserId: 100 })).status, "ready");
        world.ms.domains["acme.com"] = TENANT_OTHER;
        const flagged = await world.service.checkCompanyConnection({ companyId: world.a.id, actorUserId: 100 });
        assert.equal(flagged.status, "error");
        assert.equal(flagged.last_error, "TENANT_CHANGED");
        await rejects(world.service.getMailContext({ companyId: world.a.id, userId: 1 }), "COMPANY_NOT_READY");
        world.ms.domains["acme.com"] = TENANT_A;
        assert.equal((await world.service.checkCompanyConnection({ companyId: world.a.id, actorUserId: 100 })).status, "ready");
        assert.ok(await world.service.getMailContext({ companyId: world.a.id, userId: 1 }));
    });

    // ================================================================ audit + secrets
    test("audit: records who did what, never a token, a code, a nonce or any message content", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        await connectAndLink(world);
        const flow = await signIn(world, { company: world.a, userId: 1, account: "jane@acme.com" });
        await signIn(world, { company: world.a, userId: 2, account: "jane@acme.com" }); // wrong account
        await world.service.auditMailEvent({ companyId: world.a.id, userId: 1, action: "message_sent" });
        const rows = (await world.pool.query(`SELECT action, detail, target_id FROM email_audit_log`))[0];
        const text = JSON.stringify(rows);
        for (const secret of [flow.accessToken, flow.refreshToken, flow.state, flow.nonce, "authcode-1234567890", CONFIG.clientSecret, KEY]) assert.ok(!text.includes(secret), "audit must not contain a secret");
        const actions = rows.map((row) => row.action);
        for (const expected of ["company_connected", "mailbox_link_started", "connect_started", "connected", "connect_wrong_account", "message_sent"]) assert.ok(actions.includes(expected), expected);
    });

    test("settings: the signature is sanitized and limited; favourites must be real ids", async () => {
        const world = await buildWorld(await newPlatformDatabase({ withMicrosoftSchema: true }));
        const saved = await world.service.saveSettings({ companyId: world.a.id, userId: 1, signatureHtml: '<p>Jane</p><script>x()</script><img src=x onerror=alert(1)>', signatureEnabled: true, favoriteFolders: ["AAMk1=", "AAMk2=", "AAMk1="] });
        assert.equal(saved.signatureHtml, "<p>Jane</p>");
        assert.deepEqual(saved.favoriteFolders, ["AAMk1=", "AAMk2="]);
        await rejects(world.service.saveSettings({ companyId: world.a.id, userId: 1, favoriteFolders: ["../x"] }), "INVALID_ID");
        await rejects(world.service.saveSettings({ companyId: world.a.id, userId: 1, signatureHtml: "x".repeat(20_001) }), "SIGNATURE_TOO_LARGE");
        const keep = await world.service.saveSettings({ companyId: world.a.id, userId: 1, signatureEnabled: false });
        assert.equal(keep.signatureHtml, "<p>Jane</p>", "changing one setting keeps the others");
    });

    test("domain DNS instructions never ask for MX, SPF, DKIM or DMARC changes for a Microsoft-hosted domain", async () => {
        const { buildDnsInstructions } = require("./services/emailDomainService");
        const withHost = (() => { const old = process.env.MAIL_SERVER_HOSTNAME; process.env.MAIL_SERVER_HOSTNAME = "mail.zioventure.test"; return old; })();
        try {
            const instructions = buildDnsInstructions({ domain: "reinsteins.com", verification_token: "abc" });
            assert.equal(instructions.records.length, 1);
            assert.equal(instructions.records[0].type, "TXT");
            assert.match(instructions.records[0].host, /^_zioventure-verify\./);
            assert.ok(!JSON.stringify(instructions.records).match(/\bMX\b|spf1|_dmarc|_domainkey|mail\.zioventure\.test/));
            assert.equal(instructions.managedByProvider, true);
        } finally {
            if (withHost === undefined) delete process.env.MAIL_SERVER_HOSTNAME; else process.env.MAIL_SERVER_HOSTNAME = withHost;
        }
    });
}

module.exports = { defineCases };
