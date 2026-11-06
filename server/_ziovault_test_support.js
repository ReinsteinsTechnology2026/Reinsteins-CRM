// Test support for ZioVault integration tests: the disposable-PostgreSQL guard, real tenant databases built from the real
// tenant schema, an HTTP server around the REAL router/controller/service, and a "browser" that talks to it using the REAL
// client-side cryptography (client/src/vault/crypto). Nothing here weakens the code under test.

const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const express = require("express");
const { Pool } = require("pg");

const { createCompatPool } = require("./config/pgCompat");
const { loadSchemaStatements } = require("./services/tenantProvisioningService");
const { createVaultService } = require("./services/vaultService");
const { createVaultController } = require("./controllers/vaultController");
const { createVaultRouter } = require("./routes/vaultRoutes");

const loadCrypto = () => import(pathToFileURL(path.join(__dirname, "..", "client", "src", "vault", "crypto", "index.js")).href);

// ---------------------------------------------------------------- the guard (same rules as the other *_pg tests)
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const TEST_NAME = /^wh_ci(_[a-z0-9]+)*$/;
const DISPOSABLE_DATABASE = /^(postgres|template0|template1|wh_ci(_[a-z0-9]+)*|wh_test_[0-9a-f]{10}(_[a-z]+)?)$/;

function assertDisposableTarget(config, appEnv = process.env) {
    if (!LOOPBACK.has(config.host)) throw new Error("PG_TEST_HOST must be a loopback address");
    if (!/^\d{1,5}$/.test(String(config.port)) || Number(config.port) < 1 || Number(config.port) > 65535) throw new Error("PG_TEST_PORT must be a port number");
    if (!TEST_NAME.test(config.user || "")) throw new Error("PG_TEST_USER must be a wh_ci* test user");
    if (!TEST_NAME.test(config.adminDb || "")) throw new Error("PG_TEST_ADMIN_DB must be a wh_ci* test database");
    for (const [host, port, user] of [["PLATFORM_DB_HOST", "PLATFORM_DB_PORT", "PLATFORM_DB_USER"], ["DB_HOST", "DB_PORT", "DB_USER"]]) {
        const sameServer = appEnv[host] && appEnv[host] === config.host && String(appEnv[port] || 5432) === String(config.port);
        if (sameServer || (appEnv[user] && appEnv[user] === config.user)) throw new Error("the PG_TEST_* settings match the application's own database settings");
    }
}
function assertOnlyDisposableDatabases(names) {
    const unexpected = names.filter((name) => !DISPOSABLE_DATABASE.test(name));
    if (unexpected.length) throw new Error(`the server holds ${unexpected.length} database(s) that are not disposable test databases`);
}

const VARIABLES = ["PG_TEST_HOST", "PG_TEST_PORT", "PG_TEST_USER", "PG_TEST_PASSWORD", "PG_TEST_ADMIN_DB"];

function createLab() {
    const lab = { target: null, admin: null, databases: [], pools: [], servers: [] };

    lab.missing = VARIABLES.filter((name) => !process.env[name]);
    lab.required = process.env.PG_TEST_REQUIRED === "1";
    lab.skip = !lab.required && lab.missing.length > 0 ? "PG_TEST_* variables are not set (this test runs in the pr-checks migration-postgres job)" : false;

    lab.connect = async () => {
        if (lab.missing.length) throw new Error(`missing configuration: ${lab.missing.join(", ")}`);
        const config = { host: process.env.PG_TEST_HOST, port: process.env.PG_TEST_PORT, user: process.env.PG_TEST_USER, password: process.env.PG_TEST_PASSWORD, adminDb: process.env.PG_TEST_ADMIN_DB };
        assertDisposableTarget(config);
        const pool = new Pool({ host: config.host, port: Number(config.port), user: config.user, password: config.password, database: config.adminDb, max: 2, connectionTimeoutMillis: 10000 });
        pool.on("error", () => {});
        try {
            const { rows } = await pool.query("SELECT datname FROM pg_database");
            assertOnlyDisposableDatabases(rows.map((row) => row.datname));
        } catch (error) {
            await pool.end().catch(() => {});
            if (/not disposable test databases/.test(error.message)) throw error;
            throw new Error(`could not use the disposable PostgreSQL service (${error.code || "error"})`);
        }
        lab.target = config;
        lab.admin = pool;
    };

    lab.pool = (database) => {
        const pool = createCompatPool({ host: lab.target.host, port: Number(lab.target.port), user: lab.target.user, password: lab.target.password, database, max: 6, connectionTimeoutMillis: 10000 });
        pool.on("error", () => {});
        lab.pools.push(pool);
        return pool;
    };

    // A brand-new tenant database built EXACTLY as the provisioner builds one: every statement of the real tenant schema file.
    lab.tenantDatabase = async () => {
        const name = `wh_test_${crypto.randomBytes(5).toString("hex")}`;
        await lab.admin.query(`CREATE DATABASE ${name}`);
        lab.databases.push(name);
        const pool = lab.pool(name);
        for (const statement of loadSchemaStatements()) await pool.query(statement);
        return pool;
    };

    // A legacy-style database: only a users table (the canonical definition, with the requested id type), like the Smart Sheets tests.
    lab.legacyDatabase = async (idType, { withZioVault = false } = {}) => {
        const name = `wh_test_${crypto.randomBytes(5).toString("hex")}`;
        await lab.admin.query(`CREATE DATABASE ${name}`);
        lab.databases.push(name);
        const pool = lab.pool(name);
        const users = loadSchemaStatements().find((statement) => statement.startsWith('CREATE TABLE "users"'));
        const idColumn = '"id" integer GENERATED BY DEFAULT AS IDENTITY';
        if (!users.includes(idColumn)) throw new Error("the users table definition changed: update this fixture");
        await pool.query(users.replace(idColumn, `"id" ${idType} GENERATED BY DEFAULT AS IDENTITY`));
        if (withZioVault) for (const statement of require("./schemas/ziovaultDdl").ZIOVAULT_SCHEMA_STATEMENTS) await pool.query(statement);
        return pool;
    };

    lab.addUser = async (pool, name, { role = "employee", access = "employee", status = "active", employmentStatus = "active", type = "employee" } = {}) => {
        const [rows] = await pool.query(
            `INSERT INTO users (employee_id, full_name, password, role, system_access, employment_status, employment_type, status, email)
             VALUES (?, ?, 'x', ?, ?, ?, ?, ?, ?) RETURNING id`,
            [`E-${name}`.slice(0, 30), name, role, access, employmentStatus, type, status, `${name.toLowerCase().replace(/\W/g, "")}@example.test`]
        );
        return rows[0].id;
    };

    // An HTTP server around the real router; authentication is a stand-in that trusts the x-test-user header (the real chain is
    // exercised in the tenant-feature tests), but the tenant is whatever DATABASE this server was built on -- nothing in a request can change it.
    lab.startApi = async (pool, { limiters, gate, tenantId = 1 } = {}) => {
        const service = createVaultService({ pool });
        const controller = createVaultController(service);
        const authenticate = [
            (req, res, next) => {
                const id = Number(req.get("x-test-user"));
                if (!id) return res.status(401).json({ success: false, message: "Authentication required" });
                req.user = { id };
                req.tenantCompany = { id: tenantId };
                next();
            },
        ];
        const noLimit = (_req, _res, next) => next();
        const app = express();
        app.use(express.json({ limit: "2mb", type: require("./utils/vaultUpload").appJsonType }));
        if (gate) app.use("/api", gate);
        app.use("/api/ziovault", createVaultRouter({ controller, authenticate, limiters: limiters || { unlock: noLimit, recovery: noLimit, share: noLimit, secret: noLimit, write: noLimit, upload: noLimit } }));
        const server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        lab.servers.push(server);
        return { service, url: `http://127.0.0.1:${server.address().port}`, tenantId };
    };

    lab.close = async () => {
        for (const server of lab.servers) await new Promise((resolve) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(resolve); }); // keep-alive connections would otherwise delay every close
        for (const pool of lab.pools) await Promise.resolve(pool.end()).catch(() => {});
        if (!lab.admin) return;
        for (const name of lab.databases) await lab.admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
        await lab.admin.end().catch(() => {});
    };

    return lab;
}

// ---------------------------------------------------------------- the "browser"
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const unb64 = (text) => new Uint8Array(Buffer.from(text, "base64url"));
const uuid = () => crypto.randomUUID();

// Records every response body so a test can prove no plaintext ever came back.
const transcript = [];

class Browser {
    constructor({ url, userId, tenantId, vault }) {
        Object.assign(this, { url, userId, tenantId, vault, session: null, server: null });
    }

    async call(method, route, body, headers = {}) {
        const res = await fetch(`${this.url}/api/ziovault${route}`, {
            method,
            headers: { "Content-Type": "application/json", "x-test-user": String(this.userId), ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        transcript.push(text);
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, body: json, data: json && json.data, text };
    }

    // ---- account
    async register(password, kdf) {
        const account = await this.vault.createAccount({ password, tenantId: this.tenantId, userId: this.userId, kdf });
        const res = await this.call("POST", "/account", this.wire(account.server));
        this.session = account.session;
        this.server = account.server;
        this.accountVersion = res.data && res.data.accountVersion;
        this.recoverySecret = account.recoverySecretText;
        this.password = password;
        return { account, res };
    }

    wire(server) {
        return {
            kdf: { alg: server.kdf.alg, ops: server.kdf.ops, mem: server.kdf.mem, salt: b64(server.kdf.salt) },
            vaultKeyEnvelope: b64(server.vaultKeyEnvelope),
            privateKeyEnvelope: b64(server.privateKeyEnvelope),
            publicKey: b64(server.publicKey),
            recoveryEnvelope: b64(server.recoveryEnvelope),
        };
    }

    fromWire(data) {
        return {
            kdf: { alg: data.kdf.alg, ops: data.kdf.ops, mem: data.kdf.mem, salt: unb64(data.kdf.salt) },
            vaultKeyEnvelope: unb64(data.vaultKeyEnvelope),
            privateKeyEnvelope: unb64(data.privateKeyEnvelope),
            publicKey: unb64(data.publicKey),
            ...(data.recoveryEnvelope ? { recoveryEnvelope: unb64(data.recoveryEnvelope) } : {}),
        };
    }

    async unlock(password = this.password) {
        const res = await this.call("GET", "/account/unlock");
        if (res.status !== 200 || !res.data.exists) return { res };
        this.server = this.fromWire(res.data);
        this.accountVersion = res.data.accountVersion;
        this.session = await this.vault.unlockAccount({ password, server: this.server, tenantId: this.tenantId, userId: this.userId });
        return { res, session: this.session };
    }

    async directory() {
        return (await this.call("GET", "/directory")).data;
    }

    // ---- personal items
    async createItem({ uid = uuid(), kind = "login", meta, secret, rotationIntervalDays } = {}) {
        const v = this.vault;
        const keys = await v.newItemKeys();
        const sealed = await v.encryptItem({ tenantId: this.tenantId, itemUid: uid, keys, meta, secret });
        const wrapped = await v.wrapItemKeysForOwner({ tenantId: this.tenantId, itemUid: uid, ownerUserId: this.userId, vaultKey: this.session.vaultKey, keys });
        const res = await this.call("POST", "/items", {
            uid, kind, meta: b64(sealed.metaCiphertext), secret: sealed.secretCiphertext ? b64(sealed.secretCiphertext) : null,
            keys: { meta: b64(wrapped.wrappedMetaKey), secret: secret === undefined ? undefined : b64(wrapped.wrappedSecretKey) }, rotationIntervalDays,
        });
        return { uid, keys, res };
    }

    // Open an item the way a browser does, from whatever key source the server offered. Returns { meta, secret, keys }.
    async openItem(item, { secretResponse } = {}) {
        const v = this.vault;
        let metaKey = null;
        let secretKey = null;
        const sources = secretResponse ? secretResponse.keys : item.keys;
        for (const source of sources) {
            if (source.source === "owner") {
                const k = await v.unwrapItemKeysForOwner({ tenantId: this.tenantId, itemUid: item.uid, keyVersion: item.keyVersion, ownerUserId: this.userId, vaultKey: this.session.vaultKey, wrappedMetaKey: source.meta && unb64(source.meta), wrappedSecretKey: source.secret && unb64(source.secret) });
                metaKey ||= k.metaKey;
                secretKey ||= k.secretKey;
            } else if (source.source === "box") {
                const k = await v.openItemKeysFromSender({ tenantId: this.tenantId, itemUid: item.uid, keyVersion: item.keyVersion, recipientUserId: this.userId, senderPublicKey: unb64(source.sender.publicKey), recipientPrivateKey: this.session.privateKey, boxedMetaKey: source.meta && unb64(source.meta), boxedSecretKey: source.secret && unb64(source.secret) });
                metaKey ||= k.metaKey;
                secretKey ||= k.secretKey;
            } else if (source.source === "collection") {
                const ck = await v.openCollectionKeys({ tenantId: this.tenantId, collectionUid: source.collection.uid, keyVersion: source.collection.keyVersion, memberUserId: this.userId, senderPublicKey: unb64(source.collection.sender.publicKey), recipientPrivateKey: this.session.privateKey, wrappedMetaKey: unb64(source.collection.wrappedMetaKey), wrappedSecretKey: source.collection.wrappedSecretKey && unb64(source.collection.wrappedSecretKey) });
                const k = await v.unwrapItemKeysFromCollection({ tenantId: this.tenantId, collectionUid: source.collection.uid, itemUid: item.uid, itemKeyVersion: item.keyVersion, collectionKeys: ck, wrapped: { meta: unb64(source.meta), secret: source.secret && unb64(source.secret) } });
                metaKey ||= k.metaKey;
                secretKey ||= k.secretKey;
            }
        }
        const out = { keys: { metaKey, secretKey } };
        if (metaKey) out.meta = await v.decryptItemMeta({ tenantId: this.tenantId, itemUid: item.uid, keyVersion: item.keyVersion, metaKey, metaCiphertext: unb64(item.meta) });
        if (secretKey && secretResponse) out.secret = await v.decryptItemSecret({ tenantId: this.tenantId, itemUid: item.uid, keyVersion: item.keyVersion, secretKey, secretCiphertext: unb64(secretResponse.secret) });
        return out;
    }

    async readItem(uid) {
        const res = await this.call("GET", `/items/${uid}`);
        if (res.status !== 200) return { res };
        const item = res.data;
        const meta = await this.openItem(item);
        return { res, item, ...meta };
    }

    async revealItem(uid) {
        const listing = await this.call("GET", `/items/${uid}`);
        if (listing.status !== 200) return { res: listing };
        const secretRes = await this.call("POST", `/items/${uid}/secret`);
        if (secretRes.status !== 200) return { res: secretRes, item: listing.data };
        const opened = await this.openItem(listing.data, { secretResponse: secretRes.data });
        return { res: secretRes, item: listing.data, ...opened };
    }

    // ---- sharing: wrap an item's keys for someone (the browser does this; the server only stores it)
    async shareItem(uid, recipient, { rights = {}, expiresAt, itemKeys } = {}) {
        const v = this.vault;
        const opened = itemKeys ? { keys: itemKeys } : await this.revealItem(uid);
        const keys = opened.keys;
        const item = opened.item || (await this.call("GET", `/items/${uid}`)).data;
        const wantsReveal = Boolean(rights.reveal || rights.edit || rights.copy);
        const boxes = await v.wrapItemKeysForRecipient({
            tenantId: this.tenantId, itemUid: uid, keyVersion: item.keyVersion, recipientUserId: recipient.userId, recipientPublicKey: unb64(recipient.publicKey),
            senderPrivateKey: this.session.privateKey, keys, include: { meta: true, secret: wantsReveal },
        });
        return this.call("POST", `/items/${uid}/grants`, {
            recipientUserId: recipient.userId, rights: { ...rights, reveal: wantsReveal }, expiresAt,
            boxedMetaKey: b64(boxes.boxedMetaKey), boxedSecretKey: boxes.boxedSecretKey ? b64(boxes.boxedSecretKey) : undefined,
        });
    }

    // ---- collections
    async createCollection({ uid = uuid(), kind = "general", name = "IT Infrastructure" } = {}) {
        const v = this.vault;
        const keys = await v.newCollectionKeys();
        const nameEnvelope = await v.encryptCollectionName({ tenantId: this.tenantId, collectionUid: uid, key: keys.metaKey, name });
        const self = await v.sealCollectionKeysForMember({ tenantId: this.tenantId, collectionUid: uid, keyVersion: 1, memberUserId: this.userId, memberPublicKey: this.session.publicKey, senderPrivateKey: this.session.privateKey, keys, include: { meta: true, secret: true } });
        const res = await this.call("POST", "/collections", { uid, kind, name: b64(nameEnvelope), keys: { meta: b64(self.wrappedMetaKey), secret: b64(self.wrappedSecretKey) } });
        return { uid, keys, res };
    }

    async openCollection(collection) {
        const k = collection.keys;
        return this.vault.openCollectionKeys({ tenantId: this.tenantId, collectionUid: collection.uid, keyVersion: k.keyVersion, memberUserId: this.userId, senderPublicKey: unb64(k.sender.publicKey), recipientPrivateKey: this.session.privateKey, wrappedMetaKey: unb64(k.wrappedMetaKey), wrappedSecretKey: k.wrappedSecretKey && unb64(k.wrappedSecretKey) });
    }

    async addMember(collectionUid, collectionKeys, keyVersion, member, rights = {}, expiresAt) {
        const wantsReveal = Boolean(rights.reveal || rights.copy || rights.edit || rights.manager);
        const sealed = await this.vault.sealCollectionKeysForMember({ tenantId: this.tenantId, collectionUid, keyVersion, memberUserId: member.userId, memberPublicKey: unb64(member.publicKey), senderPrivateKey: this.session.privateKey, keys: collectionKeys, include: { meta: true, secret: wantsReveal } });
        return this.call("POST", `/collections/${collectionUid}/members`, {
            userId: member.userId, rights: { ...rights, reveal: wantsReveal || rights.reveal }, expiresAt,
            wrappedMetaKey: b64(sealed.wrappedMetaKey), wrappedSecretKey: sealed.wrappedSecretKey ? b64(sealed.wrappedSecretKey) : undefined,
        });
    }

    async createCompanyItem(collectionUid, collectionKeys, { uid = uuid(), kind = "login", meta, secret } = {}) {
        const v = this.vault;
        const keys = await v.newItemKeys();
        const sealed = await v.encryptItem({ tenantId: this.tenantId, itemUid: uid, keys, meta, secret });
        const wrapped = await v.wrapItemKeysForCollection({ tenantId: this.tenantId, collectionUid, itemUid: uid, collectionKeys, itemKeys: keys });
        const res = await this.call("POST", `/collections/${collectionUid}/items`, {
            uid, kind, meta: b64(sealed.metaCiphertext), secret: sealed.secretCiphertext ? b64(sealed.secretCiphertext) : null,
            keys: { meta: b64(wrapped.meta), secret: wrapped.secret ? b64(wrapped.secret) : undefined },
        });
        return { uid, keys, res };
    }
}

async function makeBrowser(api, userId, vault) {
    return new Browser({ url: api.url, userId, tenantId: api.tenantId, vault });
}

module.exports = { createLab, loadCrypto, makeBrowser, Browser, b64, unb64, uuid, transcript, assertDisposableTarget, assertOnlyDisposableDatabases };
