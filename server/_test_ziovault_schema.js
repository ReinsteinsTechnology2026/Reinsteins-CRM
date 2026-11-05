// ZioVault -- everything that can be checked WITHOUT a database: schema/migration consistency, the SQL splitter the tenant
// provisioner now uses, request validation, the authorization rules, the feature wiring, and a static proof that the server code
// has no way to decrypt anything. (The real-PostgreSQL behaviour is _test_ziovault_pg.js.)
// Run: node --test _test_ziovault_schema.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ddl = require("./schemas/ziovaultDdl");
const { splitSqlStatements } = require("./utils/sqlStatements");
const migration = require("./_migrate_add_ziovault");
const V = require("./utils/vaultValidation");
const authz = require("./services/vaultAuthz");
const features = require("./config/tenantFeatures");

const read = (...parts) => fs.readFileSync(path.join(__dirname, ...parts), "utf8").replace(/\r\n/g, "\n");
const schemaFile = read("schemas", "tenantSchema.postgresql.sql");
const squash = (sql) => sql.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------------------------- schema file / migration form

test("every ZioVault statement is in tenantSchema.postgresql.sql, verbatim and in order", () => {
    const fileStatements = splitSqlStatements(schemaFile);
    const start = fileStatements.findIndex((statement) => statement === ddl.ZIOVAULT_SCHEMA_STATEMENTS[0]);
    assert.ok(start >= 0, "the first ZioVault statement is in the schema file");
    assert.deepEqual(fileStatements.slice(start, start + ddl.ZIOVAULT_SCHEMA_STATEMENTS.length), ddl.ZIOVAULT_SCHEMA_STATEMENTS);
    assert.equal(start + ddl.ZIOVAULT_SCHEMA_STATEMENTS.length, fileStatements.length, "nothing follows the ZioVault section");
});

test("the tables, with the keys, constraints and indexes the design needs", () => {
    const sql = ddl.ZIOVAULT_SCHEMA_STATEMENTS.map(squash).join("\n");
    for (const table of ddl.ZIOVAULT_TABLES) assert.match(sql, new RegExp(`CREATE TABLE "${table}" \\(`), table);
    assert.equal(ddl.ZIOVAULT_TABLES.length, 10);

    // envelope sizes are exact: version(1) + nonce(24) + 32-byte key + tag(16) = 73; public key = 32; salt = 16
    assert.match(sql, /"vault_key_envelope" bytea NOT NULL CHECK \(octet_length\("vault_key_envelope"\) = 73\)/);
    assert.match(sql, /"public_key" bytea NOT NULL CHECK \(octet_length\("public_key"\) = 32\)/);
    assert.match(sql, /"kdf_salt" bytea NOT NULL CHECK \(octet_length\("kdf_salt"\) = 16\)/);
    assert.match(sql, /"kdf_alg" varchar\(16\) NOT NULL DEFAULT 'argon2id13' CHECK \("kdf_alg" = 'argon2id13'\)/);
    assert.match(sql, /"kdf_mem" integer NOT NULL CHECK \("kdf_mem" BETWEEN 33554432 AND 268435456\)/);

    // personal XOR company; reveal <-> secret key; manager holds everything; unique public keys; one active grant per (item, person)
    assert.match(sql, /CHECK \(\("owner_user_id" IS NULL\) <> \("collection_id" IS NULL\)\)/);
    assert.match(sql, /CHECK \(\("can_reveal" = \("wrapped_secret_key" IS NOT NULL\)\)\)/);
    assert.match(sql, /CHECK \(NOT "is_manager" OR \("can_reveal" AND "can_edit" AND "can_share"\)\)/);
    assert.match(sql, /CONSTRAINT "uq_zv_accounts_public_key" UNIQUE \("public_key"\)/);
    assert.match(sql, /CREATE UNIQUE INDEX "uq_zv_grants_active" ON "zv_grants" \("item_id", "recipient_user_id"\) WHERE "revoked_at" IS NULL/);
    assert.match(sql, /CREATE UNIQUE INDEX "uq_zv_item_keys_holder"/);

    // attachment ciphertext is bounded (10 MiB + framing) and stored as bytea
    assert.match(sql, /"content" bytea NOT NULL CHECK \(octet_length\("content"\) BETWEEN 41 AND 10489856\)/);
});

test("DATA SAFETY: nothing in the schema can hold or derive a plaintext secret", () => {
    const sql = ddl.ZIOVAULT_SCHEMA_STATEMENTS.join("\n");
    assert.doesNotMatch(sql, /jsonb?\b/i, "no JSON column that could carry plaintext");
    assert.doesNotMatch(sql, /\b(password|plaintext|secret_text|title|username|url|notes?)\b"? +(varchar|text)/i, "no readable column for a credential field");
    assert.doesNotMatch(sql, /tsvector|USING\s+(gin|gist)|pg_trgm/i, "no search index over item content");
    // every column that carries user content is bytea
    for (const column of ["meta_ciphertext", "secret_ciphertext", "name_ciphertext", "wrapped_key", "wrapped_meta_key", "wrapped_secret_key", "vault_key_envelope", "private_key_envelope", "recovery_envelope", "content"]) {
        assert.match(sql, new RegExp(`"${column}" bytea`), column);
    }
    // the audit trail has a fixed vocabulary and a character-restricted detail: it cannot carry a title, note or secret
    assert.match(sql, /"detail" varchar\(120\) NOT NULL DEFAULT '' CHECK \("detail" ~ '\^\[a-z0-9_\.:,=-\]\*\$'\)/);
    assert.ok(ddl.AUDIT_KINDS.includes("secret_delivered") && ddl.AUDIT_KINDS.includes("reveal_reported"), "server-observed and client-reported are different kinds");
});

test("DELETION POLICY: users that own personal data are RESTRICT, only pure access rows cascade", () => {
    const sql = ddl.ZIOVAULT_SCHEMA_STATEMENTS.map(squash).join("\n");
    for (const owner of ["fk_zv_accounts_user", "fk_zv_items_owner", "fk_zv_folders_owner", "fk_zv_account_history_user"]) {
        assert.match(sql, new RegExp(`"${owner}" FOREIGN KEY \\("\\w+"\\) REFERENCES "users" \\("id"\\) ON DELETE RESTRICT`), owner);
    }
    assert.match(sql, /"fk_zv_items_collection" FOREIGN KEY \("collection_id"\) REFERENCES "zv_collections" \("id"\) ON DELETE RESTRICT/, "a collection with items cannot be deleted");
    assert.match(sql, /"fk_zv_grants_recipient" FOREIGN KEY \("recipient_user_id"\) REFERENCES "users" \("id"\) ON DELETE CASCADE/);
});

test("the migration form is the same text, re-runnable; triggers are dropped first; functions are CREATE OR REPLACE", () => {
    const migrationStatements = ddl.ZIOVAULT_MIGRATION_STATEMENTS;
    for (const statement of migrationStatements) {
        assert.match(statement, /^(CREATE TABLE IF NOT EXISTS "|CREATE (UNIQUE )?INDEX IF NOT EXISTS "|CREATE OR REPLACE FUNCTION |DROP TRIGGER IF EXISTS "|CREATE TRIGGER ")/, statement.slice(0, 60));
    }
    const triggers = ddl.ZIOVAULT_SCHEMA_STATEMENTS.filter((s) => s.startsWith("CREATE TRIGGER"));
    assert.equal(triggers.length, 3);
    assert.equal(migrationStatements.length, ddl.ZIOVAULT_SCHEMA_STATEMENTS.length + triggers.length, "one extra DROP per trigger");
    // identical apart from the idempotency wording
    const stripped = migrationStatements.filter((s) => !s.startsWith("DROP TRIGGER")).map((s) => s.replace(" IF NOT EXISTS", ""));
    assert.deepEqual(stripped, ddl.ZIOVAULT_SCHEMA_STATEMENTS);
    assert.doesNotMatch(ddl.ZIOVAULT_SCHEMA_STATEMENTS.join("\n"), /IF NOT EXISTS/);
});

test("the tenant provisioner can read the schema: the new tables are listed, no 'IF' table, function bodies are intact", () => {
    const names = [];
    const re = /CREATE TABLE\s+"?([a-zA-Z0-9_]+)"?/g;
    let match;
    while ((match = re.exec(schemaFile)) !== null) names.push(match[1]);
    for (const table of ddl.ZIOVAULT_TABLES) assert.ok(names.includes(table), table);
    assert.ok(!names.includes("IF"));

    const { loadSchemaStatements } = require("./services/tenantProvisioningService");
    const statements = loadSchemaStatements();
    const offboard = statements.find((s) => s.startsWith("CREATE OR REPLACE FUNCTION zv_offboard_user"));
    assert.ok(offboard && offboard.includes("RETURN NEW;") && offboard.trim().endsWith("LANGUAGE plpgsql"), "a function body with semicolons survives as ONE statement");
    assert.ok(statements.length > 290);
    assert.match(read("services", "tenantProvisioningService.js"), /splitSqlStatements\(raw\)/);
});

// ---------------------------------------------------------------------------------------------- the splitter

test("SPLITTER: identical to the old 'strip comments, split on ;' for every statement of the schema as it was before ZioVault", () => {
    const before = schemaFile.slice(0, schemaFile.indexOf("-- ZIOVAULT"));
    const old = before.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter((s) => s.length > 0);
    // (the comment banner of the ZioVault section starts one line earlier; cut at its "-- ====" rule)
    const cut = before.slice(0, before.lastIndexOf("-- ==========================================\n"));
    const oldCut = cut.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter((s) => s.length > 0);
    assert.deepEqual(splitSqlStatements(cut), oldCut);
    assert.ok(old.length >= oldCut.length && oldCut.length > 250);
});

test("SPLITTER: dollar-quoted bodies, tagged bodies, string literals with semicolons and escaped quotes", () => {
    assert.deepEqual(splitSqlStatements("select 1; select 2;"), ["select 1", "select 2"]);
    assert.deepEqual(splitSqlStatements("create function f() returns int as $$ begin return 1; end; $$ language plpgsql; select 3;"), ["create function f() returns int as $$ begin return 1; end; $$ language plpgsql", "select 3"]);
    assert.deepEqual(splitSqlStatements("do $body$ begin perform 1; end $body$; select 4"), ["do $body$ begin perform 1; end $body$", "select 4"]);
    assert.deepEqual(splitSqlStatements("select 'a;b', 'it''s; fine'; select 5"), ["select 'a;b', 'it''s; fine'", "select 5"]);
    assert.deepEqual(splitSqlStatements("-- a comment; with a semicolon\nselect 6;"), ["select 6"]);
    assert.deepEqual(splitSqlStatements("  ;; ; "), []);
    assert.deepEqual(splitSqlStatements("select '^[a-z]*$' ~ x; select 7"), ["select '^[a-z]*$' ~ x", "select 7"], "a $ inside a string is not a dollar quote");
});

// ---------------------------------------------------------------------------------------------- migration script (recording fake pool)

function fakePool({ columns = ["id", "status", "employment_status"], tables = [] } = {}) {
    const log = [];
    const connection = {
        query: async (sql, params) => { log.push({ sql, params }); return [[]]; },
        beginTransaction: async () => log.push({ sql: "BEGIN" }),
        commit: async () => log.push({ sql: "COMMIT" }),
        rollback: async () => log.push({ sql: "ROLLBACK" }),
        release: () => log.push({ sql: "RELEASE" }),
    };
    return {
        log,
        query: async (sql) => {
            if (/information_schema\.columns/.test(sql)) return [columns.map((column_name) => ({ column_name }))];
            if (/information_schema\.tables/.test(sql)) return [tables.map((table_name) => ({ table_name }))];
            throw new Error("unexpected query " + sql.slice(0, 40));
        },
        getConnection: async () => connection,
    };
}

test("MIGRATION: one transaction per database, advisory lock first, every statement in order, then commit", async () => {
    const pool = fakePool();
    const result = await migration.migrateDatabase("tenant a", pool);
    assert.equal(result.action, "migrated");
    const sqls = pool.log.map((entry) => entry.sql);
    assert.equal(sqls[0], "BEGIN");
    assert.match(sqls[1], /pg_advisory_xact_lock/);
    assert.deepEqual(sqls.slice(2, 2 + ddl.ZIOVAULT_MIGRATION_STATEMENTS.length), ddl.ZIOVAULT_MIGRATION_STATEMENTS);
    assert.deepEqual(sqls.slice(-2), ["COMMIT", "RELEASE"]);
});

test("MIGRATION: a database whose users table lacks a column the trigger needs is NOT changed, and the run fails clearly", async () => {
    const pool = fakePool({ columns: ["id", "status"] });
    await assert.rejects(() => migration.migrateDatabase("legacy", pool), /lacks column\(s\) employment_status.*nothing was changed/);
    assert.equal(pool.log.length, 0, "no transaction was even opened");
    const { failures } = await migration.runTargets([{ label: "legacy", getPool: () => pool }]);
    assert.equal(failures, 1, "counted as a failure so deploy.yml stops before the restart");
});

test("MIGRATION: a failure rolls back and is reported; dry-run writes nothing; a missing legacy database is skipped", async () => {
    const pool = fakePool();
    const failing = { ...pool, getConnection: async () => ({ ...(await pool.getConnection()), query: async (sql) => { if (/CREATE TABLE IF NOT EXISTS "zv_items"/.test(sql)) throw new Error("boom"); } }) };
    await assert.rejects(() => migration.migrateDatabase("x", failing), /boom/);

    const dry = fakePool({ tables: ["zv_accounts"] });
    const result = await migration.migrateDatabase("x", dry, { dryRun: true });
    assert.equal(result.action, "dry-run");
    assert.ok(result.missing.length === 9 && !result.missing.includes("zv_accounts"));
    assert.equal(dry.log.length, 0);

    const noDb = { query: async () => { const error = new Error("nope"); error.code = "3D000"; throw error; } };
    const outcome = await migration.runTargets([{ label: "legacy", getPool: () => noDb, skipIfMissing: true }]);
    assert.deepEqual(outcome, { failures: 0, skipped: 1 });
});

test("DEPLOY: the migration runs in deploy.yml AFTER smart sheets and BEFORE the build/restart; the new tests are in CI", () => {
    const deploy = read("..", ".github", "workflows", "deploy.yml");
    const at = (needle) => deploy.indexOf(needle);
    assert.ok(at("node server/_migrate_add_ziovault.js") > at("node server/_migrate_add_smart_sheets.js"));
    assert.ok(at("node server/_migrate_add_ziovault.js") < at("npm run build"));
    assert.ok(at("node server/_migrate_add_ziovault.js") < at("systemctl restart"));
    const ci = read("..", ".github", "workflows", "pr-checks.yml");
    for (const file of ["_test_ziovault_crypto.js", "_test_ziovault_schema.js"]) assert.ok(ci.includes(file), `${file} runs in server-tests`);
    for (const file of ["_test_ziovault_pg.js", "_test_ziovault_db_pg.js"]) assert.ok(ci.includes(file), `${file} runs in the migration-postgres job`);
});

// ---------------------------------------------------------------------------------------------- feature wiring

test("FEATURE: ziovault is in the central catalog, every vault route is gated by it, and there are NO socket events", () => {
    assert.ok(features.FEATURE_BY_ID.ziovault);
    assert.deepEqual(features.featuresForApiPath("/api/ziovault/items"), { gated: true, features: ["ziovault"] });
    assert.deepEqual(features.featuresForApiPath("/api/ziovault/collections/x/members/3"), { gated: true, features: ["ziovault"] });
    assert.deepEqual(features.featuresForApiPath("/api/ziovault"), { gated: true, features: ["ziovault"] });
    assert.equal(features.featureForSocketEvent("ziovault:anything"), null);
    for (const file of ["app.js", path.join("services", "smartSheetRealtime.js")]) assert.doesNotMatch(read(file), /onTenantEvent\(\s*"ziovault/i, "secrets never travel over Socket.IO");
    assert.doesNotMatch(read("app.js"), /io\.(to|in)\([^)]*\)\.emit\(\s*"ziovault/i);
    const mount = read("app.js").match(/app\.use\(\s*"\/api\/ziovault",\s*require\("\.\/routes\/vaultRoutes"\)\.createDefaultVaultRouter\(\)\s*\)/);
    assert.ok(mount, "mounted once, behind the gate that precedes every /api route");
    assert.ok(read("app.js").indexOf('app.use("/api", featureGate)') < read("app.js").indexOf('"/api/ziovault"'), "the feature gate is registered before the vault routes");
});

test("FEATURE: every route of the vault router sits under the gated prefix and requires authentication first", () => {
    const routes = read("routes", "vaultRoutes.js");
    assert.match(routes, /router\.use\(\.\.\.authenticate\);\n\n\s*\/\/ account/, "authentication is the first thing on the router");
    const verbs = [...routes.matchAll(/router\.(get|post|put|patch|delete)\("([^"]+)"/g)];
    assert.ok(verbs.length >= 33, `found ${verbs.length} routes`);
    for (const [, , route] of verbs) assert.ok(route.startsWith("/"), route);
    assert.ok(routes.includes('router.get("/items/trash"') && routes.indexOf('"/items/trash"') < routes.indexOf('"/items/:uid"'), "/items/trash is declared before /items/:uid");
});

test("the client's route table knows ziovault (so its pages are gated the moment they exist)", async () => {
    const { pathToFileURL } = require("node:url");
    const client = await import(pathToFileURL(path.join(__dirname, "..", "client", "src", "utils", "tenantFeatures.js")).href);
    assert.equal(client.featureForSubPath("ziovault"), "ziovault");
    assert.equal(client.featureForSubPath("ziovault/company"), "ziovault");
});

// ---------------------------------------------------------------------------------------------- the server cannot decrypt

test("THE SERVER HAS NO WAY TO DECRYPT: vault server code imports no cryptography and never mentions decryption or private keys", () => {
    const files = ["services/vaultService.js", "services/vaultStore.js", "services/vaultAuthz.js", "controllers/vaultController.js", "routes/vaultRoutes.js", "utils/vaultValidation.js", "utils/vaultErrors.js", "middleware/vaultRateLimiters.js"];
    for (const file of files) {
        const code = read(file).split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*")).map((line) => line.replace(/\s\/\/ .*$/, "")).join("\n");
        assert.doesNotMatch(code, /require\(["'](node:)?crypto["']\)/, `${file}: no crypto module`);
        // (field names such as privateKeyEnvelope and the algorithm label 'argon2id13' are fine: they name ENCRYPTED data and a parameter)
        assert.doesNotMatch(code, /libsodium|createDecipher|createCipher|decrypt\w*\(|\bprivateKey\b|masterKey|recoverySecret|require\(["']argon2|bcrypt/i, `${file}: no decryption capability`);
        assert.doesNotMatch(code, /process\.env\.[A-Z_]*(KEY|SECRET)/, `${file}: no server-side key material`);
        assert.doesNotMatch(code, /console\.(log|info|debug)\(/, `${file}: nothing is logged except a bare error code`);
        assert.doesNotMatch(code, /JSON\.stringify\(req\.body|console\.\w+\([^)]*req\.(body|headers)/, `${file}: never logs a request`);
    }
    const controller = read("controllers/vaultController.js");
    assert.match(controller, /Cache-Control", "no-store"/, "responses are not cached");
    assert.equal((controller.match(/console\.error/g) || []).length, 1, "exactly one log line, with an error code only");
});

// ---------------------------------------------------------------------------------------------- request validation

test("VALIDATION: base64url is strict and canonical; sizes are exact; the envelope version byte is checked", () => {
    const b = (n, fill = 1) => Buffer.alloc(n, fill).toString("base64url");
    assert.equal(V.bytes(b(16), "x", { exact: 16 }).length, 16);
    for (const bad of [b(15), b(17), "!!", "AAAA=", "a+b/", "", 5, null, undefined, {}]) assert.throws(() => V.bytes(bad, "x", { exact: 16 }), /invalid|too large|size/i);
    assert.throws(() => V.bytes("AB", "x", { exact: 1 }), /invalid/, "non-canonical encoding (trailing bits) is refused");
    assert.throws(() => V.bytes(b(5000), "x", { max: 100 }), /too large/);

    const envelope = (n, version = 1) => Buffer.concat([Buffer.from([version]), Buffer.alloc(n - 1, 7)]).toString("base64url");
    assert.equal(V.wrappedKey(envelope(73), "k").length, 73);
    assert.throws(() => V.wrappedKey(envelope(72), "k"), /size/);
    assert.throws(() => V.wrappedKey(envelope(73, 2), "k"), /version/);
    assert.throws(() => V.aeadEnvelope(envelope(40), "m", { max: 100 }), /size/, "shorter than version+nonce+tag");
    assert.equal(V.boxedKey(envelope(200), "b").length, 200);
    assert.throws(() => V.boxedKey(envelope(600), "b"), /too large|size/);
});

test("VALIDATION: uuid v4 only, whitelists for enumerations, positive integers, optional day counts", () => {
    assert.equal(V.uuid("3f6c9d2e-1b7a-4c53-9e4d-7a1b2c3d4e5f"), "3f6c9d2e-1b7a-4c53-9e4d-7a1b2c3d4e5f");
    for (const bad of ["3F6C9D2E-1B7A-4C53-9E4D-7A1B2C3D4E5F", "3f6c9d2e-1b7a-1c53-9e4d-7a1b2c3d4e5f", "x", "", null, "3f6c9d2e-1b7a-4c53-9e4d-7a1b2c3d4e5f; drop"]) assert.throws(() => V.uuid(bad));
    assert.equal(V.oneOf("login", V.LIMITS.ITEM_KINDS, "kind"), "login");
    assert.throws(() => V.oneOf("admin", V.LIMITS.ITEM_KINDS, "kind"));
    assert.equal(V.positiveInteger("12", "id"), 12);
    for (const bad of [0, -1, 1.5, "1e3", "abc", 2147483648, null, undefined]) assert.throws(() => V.positiveInteger(bad, "id"));
    assert.equal(V.optionalDays(null, "d", 10), null);
    assert.equal(V.optionalDays(30, "d", 3650), 30);
    assert.throws(() => V.optionalDays(0, "d", 10));
    assert.throws(() => V.optionalDays(11, "d", 10));
});

test("VALIDATION: rights keep the invariants (copy/edit need reveal, manager holds everything, unknown keys refused)", () => {
    assert.deepEqual(V.rights(undefined), { reveal: false, copy: false, edit: false, share: false, manager: false });
    assert.deepEqual(V.rights({ reveal: true, copy: true }), { reveal: true, copy: true, edit: false, share: false, manager: false });
    assert.deepEqual(V.rights({ manager: true }), { reveal: true, copy: false, edit: true, share: true, manager: true });
    assert.throws(() => V.rights({ copy: true }), /reveal/);
    assert.throws(() => V.rights({ edit: true }), /reveal/);
    assert.throws(() => V.rights({ admin: true }), /invalid/);
    assert.throws(() => V.rights({ reveal: "yes" }), /invalid/);
    assert.throws(() => V.rights([]), /invalid/);
});

test("VALIDATION: KDF parameters and expiry timestamps", () => {
    const salt = Buffer.alloc(16, 1).toString("base64url");
    const good = { alg: "argon2id13", ops: 3, mem: 64 * 1024 * 1024, salt };
    assert.equal(V.kdfParams(good).ops, 3);
    for (const bad of [{ ...good, alg: "argon2i" }, { ...good, ops: 1 }, { ...good, ops: 11 }, { ...good, mem: 1024 }, { ...good, mem: 512 * 1024 * 1024 }, { ...good, salt: "AA" }, null, "x"]) assert.throws(() => V.kdfParams(bad));
    assert.equal(V.expiresAt(undefined), null);
    assert.equal(V.expiresAt("2030-01-02T03:04:05Z"), "2030-01-02T03:04:05.000Z");
    for (const bad of ["tomorrow", 5, "x".repeat(50), {}]) assert.throws(() => V.expiresAt(bad));
});

// ---------------------------------------------------------------------------------------------- authorization rules (pure)

const row = (over = {}) => ({ is_owner: false, m_user: null, g_id: null, ...over });

test("AUTHZ: no path to an item = 404, exactly like an item that does not exist", () => {
    assert.throws(() => authz.resolveItemRights(row()), (error) => error.status === 404 && error.code === "NOT_FOUND");
});

test("AUTHZ: the owner of a personal item holds everything; a grantee holds exactly the grant; view is always implied", () => {
    const owner = authz.resolveItemRights(row({ is_owner: true }));
    assert.deepEqual(owner.rights, { view: true, reveal: true, copy: true, edit: true, share: true, manage: true });
    assert.equal(owner.via, "owner");

    const viewer = authz.resolveItemRights(row({ g_id: 4, g_reveal: false, g_copy: false, g_edit: false, g_share: false }));
    assert.deepEqual(viewer.rights, { view: true, reveal: false, copy: false, edit: false, share: false, manage: false });
    assert.equal(viewer.via, "grant");

    const editor = authz.resolveItemRights(row({ g_id: 4, g_reveal: true, g_copy: true, g_edit: true, g_share: false, g_expires: new Date("2030-01-01") }));
    assert.equal(editor.rights.edit, true);
    assert.equal(editor.rights.manage, false, "a grantee never manages");
    assert.equal(editor.expiresAt.toISOString(), "2030-01-01T00:00:00.000Z");
});

test("AUTHZ: collection members get the membership rights; only a manager manages; paths combine without widening beyond their union", () => {
    const member = authz.resolveItemRights(row({ m_user: 9, m_reveal: false, m_copy: false, m_edit: false, m_share: false, m_manager: false }));
    assert.deepEqual(member.rights, { view: true, reveal: false, copy: false, edit: false, share: false, manage: false });
    const manager = authz.resolveItemRights(row({ m_user: 9, m_reveal: true, m_copy: false, m_edit: true, m_share: true, m_manager: true }));
    assert.equal(manager.rights.manage, true);
    const both = authz.resolveItemRights(row({ m_user: 9, m_reveal: false, g_id: 2, g_reveal: true, g_copy: false, g_edit: false, g_share: false }));
    assert.equal(both.rights.reveal, true, "a share can add reveal to a view-only membership");
    assert.equal(both.rights.edit, false);
    assert.equal(both.via, "collection");
});

test("AUTHZ: require* helpers fail closed; only an owner or manager deletes/rotates; sharers can never hand on more than they hold", () => {
    const viewer = authz.resolveItemRights(row({ g_id: 4 }));
    assert.throws(() => authz.requireRight(viewer, "reveal"), (e) => e.status === 403);
    assert.throws(() => authz.requireOwnerOrManager(viewer), (e) => e.status === 403);
    const owner = authz.resolveItemRights(row({ is_owner: true }));
    assert.doesNotThrow(() => authz.requireOwnerOrManager(owner));

    const sharer = authz.resolveItemRights(row({ g_id: 4, g_reveal: true, g_copy: false, g_edit: false, g_share: true }));
    assert.doesNotThrow(() => authz.assertGrantable(sharer, { reveal: true, copy: false, edit: false, share: false }));
    assert.throws(() => authz.assertGrantable(sharer, { reveal: true, copy: true, edit: false, share: false }), (e) => e.status === 403);
    assert.throws(() => authz.assertGrantable(sharer, { reveal: true, copy: false, edit: true, share: false }), (e) => e.status === 403);
    assert.throws(() => authz.assertGrantable(sharer, { reveal: false, copy: false, edit: false, share: true }), (e) => e.status === 403, "a grantee cannot create further sharers");
    assert.doesNotThrow(() => authz.assertGrantable(owner, { reveal: true, copy: true, edit: true, share: true }));
});

test("AUTHZ: only active users; a vault account is required; only a company administrator creates collections", () => {
    assert.doesNotThrow(() => authz.assertActiveUser({ status: "active", employment_status: "active" }));
    assert.doesNotThrow(() => authz.assertActiveUser({ status: "active", employment_status: null }));
    for (const user of [null, { status: "inactive", employment_status: "active" }, { status: "active", employment_status: "resigned" }, { status: "pending", employment_status: "active" }]) {
        assert.throws(() => authz.assertActiveUser(user), (e) => e.status === 403 && e.code === "ACCOUNT_INACTIVE");
    }
    assert.throws(() => authz.assertAccountExists(null), (e) => e.status === 409 && e.code === "ACCOUNT_REQUIRED");
    assert.equal(authz.canCreateCollections({ role: "admin" }), true);
    assert.equal(authz.canCreateCollections({ role: "employee", system_access: "super_admin" }), false, "role decides, not a label");
    assert.equal(authz.canCreateCollections(null), false);
});
