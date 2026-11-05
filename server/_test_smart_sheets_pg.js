// Smart Sheets against a REAL PostgreSQL server: the migration SQL, the tenant schema file, and the real store/service.
// The other Smart Sheets tests run the application code against an in-memory store (CI has no database for them);
// this file is the part that fake cannot prove -- the SQL itself, real constraints, real error codes, and how
// node-postgres actually hands values back.
//
// THREE DISPOSABLE DATABASES, because the migration meets three different situations in production:
//   * "legacy, integer ids": a legacy-style database whose users table is the canonical definition.
//   * "legacy, bigint ids":  the same, but users.id is BIGINT. The legacy database was converted from MySQL, where
//     users.id is `int unsigned` (see schemas/tenantSchema.mysql-source.sql); converters such as pgloader turn that
//     into bigint, and node-postgres returns bigint as a STRING. This variant proves the foreign keys accept it and
//     that every id the store hands back is still a number.
//   * "tenant": the full tenant schema file applied statement by statement exactly as tenantProvisioningService does.
//
// SAFETY -- identical rules to _test_password_change_pg.js: only a DISPOSABLE server is ever contacted. The server comes
// only from PG_TEST_* variables; the host must be loopback; the user and maintenance database must be named wh_ci*; the
// variables must not match the application's own DB_* / PLATFORM_DB_* settings; every database on the server must be
// postgres, a template, wh_ci* or a wh_test_* one this run created; all work happens in throw-away wh_test_* databases
// that are dropped at the end. Nothing in a failure message repeats a host, user, database name or password.
//
// Runs in the pr-checks "migration-postgres" job (PG_TEST_REQUIRED=1: missing configuration FAILS there). Without
// PG_TEST_* variables the database tests are skipped (the guard tests still run).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const ExcelJS = require("exceljs");

const { createCompatPool } = require("./config/pgCompat");
const migration = require("./_migrate_add_smart_sheets");
const { SMART_SHEETS_TABLES } = require("./schemas/smartSheetsDdl");
const { createPgStore } = require("./services/smartSheetStore");
const { createSmartSheetService } = require("./services/smartSheetService");
const { LIMITS } = require("./utils/smartSheetValidation");
const { SmartSheetError } = require("./utils/smartSheetErrors");

const REQUIRED = process.env.PG_TEST_REQUIRED === "1";
const VARIABLES = ["PG_TEST_HOST", "PG_TEST_PORT", "PG_TEST_USER", "PG_TEST_PASSWORD", "PG_TEST_ADMIN_DB"];
const MISSING = VARIABLES.filter((name) => !process.env[name]);
const SKIP = !REQUIRED && MISSING.length > 0 ? "PG_TEST_* variables are not set (this test runs in the pr-checks migration-postgres job)" : false;

// ---------------------------------------------------------------- the guard (no connection is made by these)
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

test("guard: only a loopback server with wh_ci* names that is not the application database is accepted", () => {
    const good = { host: "127.0.0.1", port: "5432", user: "wh_ci", adminDb: "wh_ci_admin" };
    assert.doesNotThrow(() => assertDisposableTarget(good, {}));
    for (const [setting, value] of [["host", "db.example.com"], ["host", "10.0.0.5"], ["port", "0"], ["user", "postgres"], ["adminDb", "postgres"], ["adminDb", undefined]]) {
        assert.throws(() => assertDisposableTarget({ ...good, [setting]: value }, {}));
    }
    assert.throws(() => assertDisposableTarget(good, { DB_HOST: "127.0.0.1" }), /application's own/);
    assert.throws(() => assertDisposableTarget(good, { DB_USER: "wh_ci" }), /application's own/);
});

test("guard: a server that holds any non-test database is refused, and the message never names it", () => {
    assert.doesNotThrow(() => assertOnlyDisposableDatabases(["postgres", "template0", "template1", "wh_ci_admin", "wh_test_0123456789", "wh_test_0123456789_x"]));
    for (const bad of ["groworgs_platform_db", "tenant_reinsteins", "reinsteins_workhub"]) {
        assert.throws(() => assertOnlyDisposableDatabases(["postgres", bad]), (error) => !error.message.includes(bad) && /1 database/.test(error.message));
    }
});

// ---------------------------------------------------------------- connection to the disposable server
let target = null;
let admin = null;
const databases = [];
const pools = [];

const real = { log: console.log, error: console.error };
let silenced = 0;
const quiet = async (work) => {
    silenced += 1;
    console.log = () => {};
    console.error = () => {};
    try { return await work(); } finally {
        silenced -= 1;
        if (silenced === 0) { console.log = real.log; console.error = real.error; }
    }
};

const newName = (suffix = "") => `wh_test_${crypto.randomBytes(5).toString("hex")}${suffix}`;
const compat = (database) => {
    const pool = createCompatPool({ host: target.host, port: Number(target.port), user: target.user, password: target.password, database, max: 4, connectionTimeoutMillis: 10000 });
    pool.on("error", () => {});
    pools.push(pool);
    return pool;
};
async function createDatabase() {
    const name = newName();
    await admin.query(`CREATE DATABASE ${name}`);
    databases.push(name);
    return name;
}

test("setup: the configured server is the disposable PostgreSQL service (guard + database list)", { skip: SKIP }, async () => {
    assert.deepEqual(MISSING, [], `missing configuration: ${MISSING.join(", ")}`);
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
    target = config;
    admin = pool;
});

test.after(async () => {
    for (const pool of pools) await Promise.resolve(pool.end()).catch(() => {});
    if (!admin) return;
    for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
});

// ---------------------------------------------------------------- schema fixtures
const schemaText = fs.readFileSync(path.join(__dirname, "schemas", "tenantSchema.postgresql.sql"), "utf8");
// exactly what tenantProvisioningService.loadSchemaStatements does (dollar-quoted trigger bodies contain semicolons)
const schemaStatements = require("./utils/sqlStatements").splitSqlStatements(schemaText);
const USERS_DDL = schemaStatements.find((statement) => statement.startsWith('CREATE TABLE "users"'));
const ID_COLUMN = '"id" integer GENERATED BY DEFAULT AS IDENTITY';
const unique = (statement) => assert.ok(statement && statement.includes(ID_COLUMN), "the users table definition changed: update this test's fixtures");

async function legacyDatabase(idType) {
    unique(USERS_DDL);
    const name = await createDatabase();
    const pool = compat(name);
    await pool.query(USERS_DDL.replace(ID_COLUMN, `"id" ${idType} GENERATED BY DEFAULT AS IDENTITY`));
    return pool;
}

async function tenantDatabase() {
    const name = await createDatabase();
    const pool = compat(name);
    for (const statement of schemaStatements) await pool.query(statement);
    return pool;
}

// ---------------------------------------------------------------- exercising one database
async function tableCount(pool) {
    const [rows] = await pool.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'smart_sheet%'`);
    return rows[0].n;
}

async function addUser(pool, name, { role = "employee", access = "employee", status = "active" } = {}) {
    const [rows] = await pool.query(
        `INSERT INTO users (employee_id, full_name, password, role, system_access, employment_status, designation, email)
         VALUES (?, ?, 'x', ?, ?, ?, 'Analyst', ?) RETURNING id`,
        [`E-${name}`.slice(0, 30), name, role, access, status, `${name.toLowerCase().replace(/\W/g, "")}@example.com`]
    );
    return rows[0].id;
}

const cellsOp = (ws, entries) => ({ type: "cells", ws, cells: entries.map(([r, c, cell]) => ({ r, c, cell })) });
const rejectsWith = (promise, code, status) => assert.rejects(promise, (error) => {
    assert.ok(error instanceof SmartSheetError, `expected a SmartSheetError, got ${error && error.stack}`);
    assert.equal(error.code, code);
    if (status) assert.equal(error.status, status);
    return true;
});

async function exercise(t, pool, { expectNumericIds }) {
    // ---- migration: the real SQL on this database
    await t.test("migration: dry run changes nothing, the first run creates the four tables, the second is a no-op", async () => {
        const dry = await quiet(() => migration.migrateDatabase("db", pool, { dryRun: true }));
        assert.deepEqual(dry.missing.sort(), [...SMART_SHEETS_TABLES].sort());
        assert.equal(await tableCount(pool), 0);

        const first = await quiet(() => migration.migrateDatabase("db", pool));
        assert.equal(first.action, "migrated");
        assert.equal(await tableCount(pool), 4);
        assert.equal((await quiet(() => migration.migrateDatabase("db", pool))).action, "skipped");

        const [constraints] = await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid::regclass::text LIKE 'smart_sheet%'`);
        for (const name of ["fk_smart_sheets_created_by", "fk_smart_sheet_access_user", "fk_smart_sheet_access_sheet", "fk_smart_sheet_cells_worksheet", "uq_smart_sheet_access_sheet_user"]) {
            assert.ok(constraints.some((row) => row.conname === name), name);
        }
        const [columns] = await pool.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('cell_count', 'data_bytes', 'bytes') ORDER BY 1, 2`);
        assert.deepEqual(columns.map((row) => `${row.table_name}.${row.column_name}`), ["smart_sheet_cells.bytes", "smart_sheets.cell_count", "smart_sheets.data_bytes"]);
    });

    const store = createPgStore({ pool });
    const service = createSmartSheetService({ store, scopeKey: () => "pg-test" });

    const admin1 = await addUser(pool, "Ada Admin", { role: "admin", access: "super_admin" });
    const alice = await addUser(pool, "Alice Rao");
    const bob = await addUser(pool, "Bob Singh");
    const carol = await addUser(pool, "Carol Das");
    const gone = await addUser(pool, "Gone Person", { status: "resigned" });
    let sheetId;
    let ws;

    await t.test("ids: every id the store returns is a NUMBER, even when users.id is bigint (node-postgres sends bigint as text)", async () => {
        const [raw] = await pool.query("SELECT id FROM users WHERE full_name = 'Alice Rao'");
        assert.equal(typeof raw[0].id, expectNumericIds ? "number" : "string", "the fixture really has the id type this scenario claims");

        const account = await store.getAccount(alice);
        assert.equal(typeof account.id, "number");
        const created = await service.createBlankSheet(admin1, "Budget");
        sheetId = created.id;
        await service.assign(admin1, sheetId, { userIds: [alice, bob], permission: "edit" });
        const context = await store.getAccessContext(alice, sheetId);
        assert.equal(typeof context.account.id, "number");
        assert.equal(context.assignment.permission, "edit");
        assert.ok((await store.searchEmployees("alice")).every((employee) => typeof employee.id === "number"));
        assert.ok((await store.listAccess(sheetId)).every((entry) => typeof entry.user_id === "number"));
        // so the admin UI's "already has access" check (list ids vs search ids) compares like with like
        const assigned = new Set((await store.listAccess(sheetId)).map((entry) => entry.user_id));
        assert.ok((await store.searchEmployees("alice")).some((employee) => assigned.has(employee.id)));
        ws = (await store.loadWorkbook(sheetId)).worksheets[0].key;
    });

    await t.test("access: assigned / unassigned / inactive accounts, grant upsert, revoke", async () => {
        assert.equal((await service.getWorkbook(alice, sheetId)).permission, "edit");
        await rejectsWith(service.getWorkbook(carol, sheetId), "NOT_FOUND", 404);
        const result = await service.assign(admin1, sheetId, { userIds: [alice, gone, 424242], permission: "view" });
        assert.deepEqual(result.granted, [Number(alice)]); // ids from a bigint users table arrive as strings; the store returns numbers
        assert.equal((await service.getWorkbook(alice, sheetId)).permission, "view");
        await service.assign(admin1, sheetId, { userIds: [alice], permission: "edit" });
        await service.revoke(admin1, sheetId, bob);
        await rejectsWith(service.getWorkbook(bob, sheetId), "NOT_FOUND");
        await service.assign(admin1, sheetId, { userIds: [bob], permission: "edit" });
    });

    await t.test("cells: upsert, whole-cell replace, delete, a 4,500-cell paste, revisions", async () => {
        const before = (await store.getSheet(sheetId)).revision;
        await service.applyOperation(alice, sheetId, cellsOp(ws, [[0, 0, { v: "Hi", t: 1, s: { bl: 1 }, nf: "0%" }], [1, 2, { f: "=A1", v: 1, t: 2 }]]));
        await service.applyOperation(alice, sheetId, cellsOp(ws, [[0, 0, { v: "Replaced", t: 1 }]]));
        let cells = (await store.loadWorkbook(sheetId)).worksheets[0].cells;
        assert.deepEqual(cells.find((e) => e.r === 0 && e.c === 0).cell, { v: "Replaced", t: 1 });
        await service.applyOperation(alice, sheetId, cellsOp(ws, [[0, 0, null]]));
        cells = (await store.loadWorkbook(sheetId)).worksheets[0].cells;
        assert.equal(cells.some((e) => e.r === 0 && e.c === 0), false);
        assert.equal((await store.getSheet(sheetId)).revision, before + 3);

        const paste = [];
        for (let r = 10; r < 190; r += 1) for (let c = 0; c < 25; c += 1) paste.push([r, c, { v: `r${r}c${c}`, t: 1 }]);
        await service.applyOperation(bob, sheetId, cellsOp(ws, paste));
        const loaded = (await store.loadWorkbook(sheetId)).worksheets[0].cells.filter((e) => e.r >= 10);
        assert.equal(loaded.length, 4500);
        assert.deepEqual(loaded.find((e) => e.r === 189 && e.c === 24).cell, { v: "r189c24", t: 1 });
    });

    await t.test("a rejected change leaves no trace: no partial cells, no revision consumed, totals unchanged", async () => {
        const before = await store.getSheet(sheetId);
        await rejectsWith(service.applyOperation(alice, sheetId, cellsOp(ws, [[500, 0, { v: "valid" }], [5000, 0, { v: "outside the grid" }]])), "INVALID_CELL_COORDINATE");
        await rejectsWith(service.applyOperation(alice, sheetId, cellsOp(ws, [[1, 1, { v: "bad \u0000 char" }]])), "INVALID_CELL");
        const after = await store.getSheet(sheetId);
        assert.deepEqual([after.revision, after.cell_count, after.data_bytes], [before.revision, before.cell_count, before.data_bytes]);
    });

    await t.test("worksheets: add (positions shift), idempotent re-add, rename, duplicate names, layout merge", async () => {
        await service.applyOperation(admin1, sheetId, { type: "addWorksheet", ws: "tabB", name: "Second" });
        await service.applyOperation(admin1, sheetId, { type: "addWorksheet", ws: "tabC", name: "Inserted", index: 1 });
        await service.applyOperation(admin1, sheetId, { type: "addWorksheet", ws: "tabC", name: "Inserted", index: 1 });
        assert.deepEqual((await store.loadWorkbook(sheetId)).worksheets.map((w) => w.name), ["Sheet1", "Inserted", "Second"]);
        await rejectsWith(service.applyOperation(admin1, sheetId, { type: "renameWorksheet", ws: "tabC", name: "SECOND" }), "WORKSHEET_NAME_EXISTS", 409);
        await service.applyOperation(admin1, sheetId, { type: "layout", ws, columnWidths: { 0: 210, 3: 99 }, rowHeights: { 4: 60 } });
        await service.applyOperation(admin1, sheetId, { type: "layout", ws, columnWidths: { 3: null, 5: 140 }, rowHeights: {} });
        assert.deepEqual((await store.loadWorkbook(sheetId)).worksheets[0].layout, { columnWidths: { 0: 210, 5: 140 }, rowHeights: { 4: 60 } });
    });

    await t.test("CONCURRENCY: 40 simultaneous edits of one cell get 40 distinct, gap-free revisions; the highest revision wins", async () => {
        const base = (await store.getSheet(sheetId)).revision;
        const results = await Promise.all(Array.from({ length: 40 }, (_, i) =>
            service.applyOperation(i % 2 ? alice : bob, sheetId, cellsOp(ws, [[300, 7, { v: `writer-${i}`, t: 1 }]])).then((r) => ({ i, revision: r.revision }))));
        assert.deepEqual(results.map((r) => r.revision).sort((a, b) => a - b), Array.from({ length: 40 }, (_, k) => base + 1 + k));
        const winner = results.reduce((a, b) => (b.revision > a.revision ? b : a));
        const stored = (await store.loadWorkbook(sheetId)).worksheets[0].cells.find((e) => e.r === 300 && e.c === 7).cell;
        assert.equal(stored.v, `writer-${winner.i}`);
    });

    await t.test("GROWTH LIMITS: the cap is enforced BEFORE anything is stored, overwrites and deletes are always allowed, totals never drift", async () => {
        const small = { ...LIMITS, MAX_CELLS_PER_SHEET: 30, MAX_SHEET_DATA_BYTES: 4000 };
        const limited = createSmartSheetService({ store: createPgStore({ pool, limits: small }), scopeKey: () => "pg-test", limits: small });
        const sheet = (await limited.createBlankSheet(admin1, "Limited")).id;
        const key = (await store.loadWorkbook(sheet)).worksheets[0].key;
        const totals = async () => {
            const [row] = (await pool.query(`SELECT cell_count, data_bytes, revision FROM smart_sheets WHERE id = ?`, [sheet]))[0];
            const [actual] = (await pool.query(`SELECT count(*)::int AS n, COALESCE(sum(bytes), 0)::bigint AS b FROM smart_sheet_cells WHERE sheet_id = ?`, [sheet]))[0];
            return { counted: Number(row.cell_count), bytes: Number(row.data_bytes), revision: Number(row.revision), actualCount: actual.n, actualBytes: Number(actual.b) };
        };

        await limited.applyOperation(admin1, sheet, cellsOp(key, Array.from({ length: 30 }, (_, i) => [i, 0, { v: i, t: 2 }])));
        let state = await totals();
        assert.deepEqual([state.counted, state.actualCount], [30, 30]);
        assert.equal(state.bytes, state.actualBytes);

        await rejectsWith(limited.applyOperation(admin1, sheet, cellsOp(key, [[99, 0, { v: "one too many" }]])), "SHEET_FULL", 413);
        const afterReject = await totals();
        assert.deepEqual(afterReject, state, "a refused change stores nothing and consumes no revision");

        await limited.applyOperation(admin1, sheet, cellsOp(key, [[0, 0, { v: "overwrite at the cap" }], [1, 0, { v: "again" }]])); // replacing is not growth
        await limited.applyOperation(admin1, sheet, cellsOp(key, [[0, 0, null], [1, 0, null], [2, 0, null]])); // deleting frees room
        state = await totals();
        assert.deepEqual([state.counted, state.actualCount], [27, 27]);
        assert.equal(state.bytes, state.actualBytes, "the running byte total equals the real stored total");
        await limited.applyOperation(admin1, sheet, cellsOp(key, [[90, 0, { v: "fits" }], [91, 0, { v: "fits" }], [92, 0, { v: "fits" }]]));
        assert.equal((await totals()).counted, 30);

        // the byte cap: a handful of fat cells
        const bytesSheet = (await limited.createBlankSheet(admin1, "Bytes")).id;
        const bytesKey = (await store.loadWorkbook(bytesSheet)).worksheets[0].key;
        await limited.applyOperation(admin1, bytesSheet, cellsOp(bytesKey, [[0, 0, { v: "x".repeat(1500), t: 1 }], [1, 0, { v: "x".repeat(1500), t: 1 }]]));
        await rejectsWith(limited.applyOperation(admin1, bytesSheet, cellsOp(bytesKey, [[2, 0, { v: "x".repeat(1500), t: 1 }]])), "SHEET_FULL", 413);

        // an oversized import is refused by the service before it is stored
        const workbook = new ExcelJS.Workbook();
        const sheet1 = workbook.addWorksheet("Many");
        for (let r = 1; r <= 31; r += 1) sheet1.getCell(r, 1).value = r;
        const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
        await rejectsWith(limited.importSheet(admin1, "Too many", { buffer, originalName: "many.xlsx" }), "IMPORT_TOO_LARGE");
    });

    await t.test("an over-limit sheet (only possible by editing the database) is refused BEFORE any cell is loaded", async () => {
        const sheet = (await service.createBlankSheet(admin1, "Huge")).id;
        await pool.query(`UPDATE smart_sheets SET cell_count = ? WHERE id = ?`, [LIMITS.MAX_CELLS_PER_SHEET + 1, sheet]);
        await rejectsWith(service.getWorkbook(admin1, sheet), "WORKBOOK_TOO_LARGE", 413);
        await rejectsWith(service.exportXlsx(admin1, sheet), "WORKBOOK_TOO_LARGE", 413);
        await rejectsWith(store.loadWorkbook(sheet), "WORKBOOK_TOO_LARGE", 413);
    });

    await t.test("archive blocks writes at the database level; restore reopens; soft delete hides", async () => {
        await service.updateSheet(admin1, sheetId, { status: "archived" });
        await assert.rejects(store.applyOperation(sheetId, alice, cellsOp(ws, [[0, 0, { v: "x" }]])), (e) => e.code === "SHEET_NOT_WRITABLE");
        assert.equal((await service.listSheets(alice)).sheets.length, 0);
        await service.updateSheet(admin1, sheetId, { status: "active" });
        const second = (await service.createBlankSheet(admin1, "To delete")).id;
        await service.deleteSheet(admin1, second);
        assert.equal((await service.listSheets(admin1)).sheets.some((s) => s.id === second), false);
    });

    await t.test("import + export: a real .xlsx goes into PostgreSQL with exact totals and comes back out", async () => {
        const workbook = new ExcelJS.Workbook();
        const report = workbook.addWorksheet("Report");
        report.getCell("A1").value = "Date";
        report.getCell("A2").value = new Date(Date.UTC(2024, 1, 29));
        report.getCell("A2").numFmt = "yyyy-mm-dd";
        report.getCell("B2").value = 0.256;
        report.getCell("B2").numFmt = "0.0%";
        for (let r = 3; r < 200; r += 1) for (let c = 1; c <= 10; c += 1) report.getCell(r, c).value = r * c;
        workbook.addWorksheet("Notes").getCell("A1").value = "héllo ✓";
        const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
        const imported = await service.importSheet(admin1, "", { buffer, originalName: "Quarterly.xlsx" });
        const meta = await store.getSheet(imported.id);
        const [actual] = (await pool.query(`SELECT count(*)::int AS n, COALESCE(sum(bytes), 0)::bigint AS b FROM smart_sheet_cells WHERE sheet_id = ?`, [imported.id]))[0];
        assert.deepEqual([meta.cell_count, meta.data_bytes], [actual.n, Number(actual.b)], "import totals equal the stored rows");
        const exported = await service.exportXlsx(admin1, imported.id);
        const reopened = new ExcelJS.Workbook();
        await reopened.xlsx.load(exported.buffer);
        assert.deepEqual(reopened.worksheets.map((s) => s.name), ["Report", "Notes"]);
        assert.equal(reopened.getWorksheet("Report").getCell("B2").value, 0.256);
    });

    await t.test("cascades: deleting a user removes their assignments; deleting a sheet removes everything under it", async () => {
        const sheet = (await service.createBlankSheet(admin1, "Cascade")).id;
        const key = (await store.loadWorkbook(sheet)).worksheets[0].key;
        await service.assign(admin1, sheet, { userIds: [carol, alice], permission: "edit" });
        await service.applyOperation(admin1, sheet, cellsOp(key, [[0, 0, { v: 1 }]]));
        await pool.query(`DELETE FROM users WHERE id = ?`, [carol]);
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM smart_sheet_access WHERE sheet_id = ?`, [sheet]))[0][0].n, 1);
        await pool.query(`DELETE FROM smart_sheets WHERE id = ?`, [sheet]);
        for (const table of ["smart_sheet_access", "smart_sheet_worksheets", "smart_sheet_cells"]) {
            assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE sheet_id = ?`, [sheet]))[0][0].n, 0, table);
        }
    });
}

// ---------------------------------------------------------------- the three databases
test("LEGACY database, users.id INTEGER: migration + store + service on real PostgreSQL", { skip: SKIP }, async (t) => {
    await exercise(t, await legacyDatabase("integer"), { expectNumericIds: true });
});

test("LEGACY database, users.id BIGINT (a MySQL `int unsigned` conversion): the same, and ids are still numbers", { skip: SKIP }, async (t) => {
    await exercise(t, await legacyDatabase("bigint"), { expectNumericIds: false });
});

test("TENANT database: the full tenant schema file (as the provisioner applies it) already contains the tables; the migration is a no-op there", { skip: SKIP }, async (t) => {
    const pool = await tenantDatabase();
    assert.equal(await tableCount(pool), 4, "a freshly provisioned tenant gets the tables from the schema file");
    assert.equal((await quiet(() => migration.migrateDatabase("tenant", pool))).action, "skipped");

    const store = createPgStore({ pool });
    const service = createSmartSheetService({ store, scopeKey: () => "pg-test" });
    const [rows] = await pool.query(
        `INSERT INTO users (employee_id, full_name, password, role, system_access, employment_status) VALUES ('E1', 'Tenant Admin', 'x', 'admin', 'super_admin', 'active') RETURNING id`
    );
    const created = await service.createBlankSheet(rows[0].id, "Tenant sheet");
    const key = (await store.loadWorkbook(created.id)).worksheets[0].key;
    await service.applyOperation(rows[0].id, created.id, cellsOp(key, [[0, 0, { v: "ok", t: 1 }]]));
    assert.equal((await service.getWorkbook(rows[0].id, created.id)).workbook.sheets[key].cellData[0][0].v, "ok");
    assert.ok(t);
});

// ---------------------------------------------------------------- migration failure + concurrency
test("migration: a database that cannot take the tables is left exactly as it was (all-or-nothing)", { skip: SKIP }, async () => {
    const pool = compat(await createDatabase()); // no users table: the foreign keys must fail
    await assert.rejects(quiet(() => migration.migrateDatabase("broken", pool)));
    assert.equal(await tableCount(pool), 0, "rolled back: no half-created tables");
});

test("migration: two runs at the same moment both succeed and leave exactly one set of tables (advisory lock)", { skip: SKIP }, async () => {
    const pool = await legacyDatabase("integer");
    const results = await quiet(() => Promise.all([migration.migrateDatabase("a", pool), migration.migrateDatabase("b", pool), migration.migrateDatabase("c", pool)]));
    assert.equal(results.length, 3);
    assert.equal(await tableCount(pool), 4);
});
