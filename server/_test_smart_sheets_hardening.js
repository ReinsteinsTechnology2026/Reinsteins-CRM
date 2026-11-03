// Smart Sheets -- regression tests for the PR #15 review findings H1, H4 (server side), M1 and M2.
// Real Socket.IO server + real handlers + real service/validation; only the database is in memory.
// (The PostgreSQL side of the same limits is covered by _test_smart_sheets_pg.js; the browser side of H2/H3/H4 by
// _test_smart_sheets_resilience.js.)  Run: node --test _test_smart_sheets_hardening.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const ExcelJS = require("exceljs");

const { createMemoryStore, startRealtimeHarness, emitAck, waitForEvent, expectNoEvent } = require("./_smart_sheets_test_support");
const { LIMITS } = require("./utils/smartSheetValidation");
const { smartSheetRoom, userRoom, presenceRoom } = require("./utils/socketRooms");
const { evictUser } = require("./services/smartSheetRealtime");
const { createWindowLimiter, createConcurrencyGate } = require("./utils/smartSheetLimiter");
const { inspectZipBuffer, inspectZipFile } = require("./utils/zipInspect");
const { parseXlsxFileIsolated, importGate } = require("./services/smartSheetImportRunner");
const xlsx = require("./services/smartSheetXlsxService");
const { createSmartSheetService } = require("./services/smartSheetService");
const { roomScopeOf, LEGACY_ROOM_SCOPE } = require("./utils/socketRooms");

const ADMIN = 1;
const ALICE = 2;

const people = () => [
    { id: ADMIN, full_name: "Ada Admin", role: "admin", system_access: "super_admin" },
    { id: ALICE, full_name: "Alice", role: "employee" },
];

async function sheetFor(harnessService) {
    const { id } = await harnessService.createBlankSheet(ADMIN, "Budget");
    await harnessService.assign(ADMIN, id, { userIds: [ALICE], permission: "edit" });
    const ws = (await harnessService.getWorkbook(ADMIN, id)).workbook.sheetOrder[0];
    return { id, ws };
}

const setCell = (ws, r, c, v) => ({ type: "cells", ws, cells: [{ r, c, cell: { v, t: 1 } }] });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ss-hardening-"));

// ------------------------------------------------------------------------------------------------ H1

test("H1: room names for the legacy database and a tenant with the SAME slug can never be equal", () => {
    const legacy = roomScopeOf(null);
    assert.equal(legacy, LEGACY_ROOM_SCOPE);
    assert.equal(roomScopeOf({ companySlug: "reinsteins" }), LEGACY_ROOM_SCOPE, "no pool + legacy slug = the legacy database");
    assert.equal(roomScopeOf({ companySlug: "reinsteins", tenantPool: {} }), "reinsteins", "a registered tenant keeps its slug");
    assert.throws(() => roomScopeOf({ tenantPool: {} }), /no company slug/);

    assert.notEqual(smartSheetRoom(legacy, 1), smartSheetRoom("reinsteins", 1));
    assert.notEqual(userRoom(legacy, 3), userRoom("reinsteins", 3));
    assert.notEqual(presenceRoom(legacy), presenceRoom("reinsteins"));
    assert.ok(LEGACY_ROOM_SCOPE.includes("-"), "contains a hyphen, so it can never equal a company slug");
});

test("H1: identical sheet ids and user ids in the legacy database and a tenant database stay completely separate", async () => {
    const legacyStore = createMemoryStore(people());
    const tenantStore = createMemoryStore(people());
    const harness = await startRealtimeHarness(null, {
        databases: {
            legacy: { store: legacyStore, scope: LEGACY_ROOM_SCOPE },
            tenant: { store: tenantStore, scope: "reinsteins" },
        },
    });
    try {
        const legacy = await sheetFor(harness.databases.legacy.service);
        const tenant = await sheetFor(harness.databases.tenant.service);
        assert.equal(legacy.id, tenant.id, "the collision precondition: the very same sheet id in both databases");

        const legacyAlice = await harness.client(ALICE, { db: "legacy" });
        const tenantAlice = await harness.client(ALICE, { db: "tenant" });
        const legacyJoin = await emitAck(legacyAlice, "smartsheet:join", { sheetId: legacy.id });
        const tenantJoin = await emitAck(tenantAlice, "smartsheet:join", { sheetId: tenant.id });
        assert.equal(legacyJoin.ok, true);
        assert.equal(tenantJoin.ok, true);
        assert.equal(legacyJoin.users.length, 1, "presence shows only this database's collaborators");
        assert.equal(tenantJoin.users.length, 1);

        const legacyAdmin = await harness.client(ADMIN, { db: "legacy" });
        await emitAck(legacyAdmin, "smartsheet:join", { sheetId: legacy.id });

        // a change in the TENANT database is never delivered to the legacy sheet with the same id ...
        const heardByLegacy = expectNoEvent(legacyAdmin, "smartsheet:op", 400);
        const ack = await emitAck(tenantAlice, "smartsheet:op", { sheetId: tenant.id, op: setCell(tenant.ws, 0, 0, "tenant only") });
        assert.equal(ack.ok, true);
        assert.equal(await heardByLegacy, true, "heardByLegacy: nothing crossed over");
        assert.equal(legacyStore.sheets.get(legacy.id).revision, 0, "and nothing was written to the legacy database");

        // ... and the other way round
        const heardByTenant = expectNoEvent(tenantAlice, "smartsheet:op", 400);
        assert.equal((await emitAck(legacyAdmin, "smartsheet:op", { sheetId: legacy.id, op: setCell(legacy.ws, 0, 0, "legacy only") })).ok, true);
        assert.equal(await heardByTenant, true, "heardByTenant: nothing crossed over");

        // eviction in one database does not touch the other's sockets (user room + sheet room)
        const revoked = expectNoEvent(tenantAlice, "smartsheet:access-revoked", 400);
        await evictUser(harness.io, LEGACY_ROOM_SCOPE, legacy.id, ALICE, "unassigned");
        assert.equal(await revoked, true, "revoked: nothing crossed over");
        assert.ok(tenantAlice.connected);
        assert.equal((await emitAck(tenantAlice, "smartsheet:op", { sheetId: tenant.id, op: setCell(tenant.ws, 1, 1, "still joined") })).ok, true);
    } finally {
        await harness.close();
    }
});

// ------------------------------------------------------------------------------------------------ H4 (server)

test("H4: a change above the validator's limit but below the transport limit gets a proper error, not a dropped connection", async () => {
    const store = createMemoryStore(people());
    const harness = await startRealtimeHarness(store);
    try {
        const { id, ws } = await sheetFor(harness.service);
        const alice = await harness.client(ALICE);
        await emitAck(alice, "smartsheet:join", { sheetId: id });

        const big = "x".repeat(60 * 1024);
        const cells = Array.from({ length: 12 }, (_, index) => ({ r: index, c: 0, cell: { v: big, t: 1 } })); // ~720 KB > MAX_OPERATION_BYTES
        assert.ok(JSON.stringify(cells).length > LIMITS.MAX_OPERATION_BYTES && JSON.stringify(cells).length < LIMITS.MAX_SOCKET_MESSAGE_BYTES);
        const ack = await emitAck(alice, "smartsheet:op", { sheetId: id, op: { type: "cells", ws, cells } }, 8000);
        assert.equal(ack.ok, false);
        assert.ok(ack.code && ack.message, "the server's validator answered");
        assert.equal(alice.connected, true, "and the connection survived");
        assert.equal(store.sheets.get(id).revision, 0, "nothing was stored");
    } finally {
        await harness.close();
    }
});

test("H4: a message beyond the transport limit is refused by Socket.IO itself and the editor can tell (disconnect), without anything stored", async () => {
    const store = createMemoryStore(people());
    const harness = await startRealtimeHarness(store);
    try {
        const { id, ws } = await sheetFor(harness.service);
        const alice = await harness.client(ALICE);
        await emitAck(alice, "smartsheet:join", { sheetId: id });
        const closed = waitForEvent(alice, "disconnect", { timeoutMs: 8000 });
        alice.emit("smartsheet:op", { sheetId: id, op: setCell(ws, 0, 0, "y".repeat(LIMITS.MAX_SOCKET_MESSAGE_BYTES + 1024)) });
        await closed;
        assert.equal(store.sheets.get(id).revision, 0);
    } finally {
        await harness.close();
    }
});

// ------------------------------------------------------------------------------------------------ M2

test("M2: the cell cap per spreadsheet is enforced before anything is stored; clearing cells frees room", async () => {
    const store = createMemoryStore(people());
    store.limits = { ...LIMITS, MAX_CELLS_PER_SHEET: 5 };
    const harness = await startRealtimeHarness(store);
    try {
        const { id, ws } = await sheetFor(harness.service);
        const alice = await harness.client(ALICE);
        await emitAck(alice, "smartsheet:join", { sheetId: id });
        const op = (n, from = 0) => ({ type: "cells", ws, cells: Array.from({ length: n }, (_, i) => ({ r: from + i, c: 0, cell: { v: `v${from + i}`, t: 1 } })) });

        assert.equal((await emitAck(alice, "smartsheet:op", { sheetId: id, op: op(5) })).ok, true);
        const refused = await emitAck(alice, "smartsheet:op", { sheetId: id, op: op(1, 5) });
        assert.equal(refused.ok, false);
        assert.equal(refused.code, "SHEET_FULL");
        assert.equal(store.sheets.get(id).cell_count, 5, "the refused change stored nothing");

        // overwriting existing cells does not grow the sheet; clearing frees capacity
        assert.equal((await emitAck(alice, "smartsheet:op", { sheetId: id, op: op(5) })).ok, true);
        const clear = { type: "cells", ws, cells: [0, 1].map((r) => ({ r, c: 0, cell: null })) };
        assert.equal((await emitAck(alice, "smartsheet:op", { sheetId: id, op: clear })).ok, true);
        assert.equal((await emitAck(alice, "smartsheet:op", { sheetId: id, op: op(2, 5) })).ok, true);
    } finally {
        await harness.close();
    }
});

test("M2: the stored-bytes cap per spreadsheet bounds the workbook response", async () => {
    const store = createMemoryStore(people());
    store.limits = { ...LIMITS, MAX_SHEET_DATA_BYTES: 4096 };
    const harness = await startRealtimeHarness(store);
    try {
        const { id, ws } = await sheetFor(harness.service);
        const alice = await harness.client(ALICE);
        await emitAck(alice, "smartsheet:join", { sheetId: id });
        const text = (r) => ({ type: "cells", ws, cells: [{ r, c: 0, cell: { v: "z".repeat(1500), t: 1 } }] });
        assert.equal((await emitAck(alice, "smartsheet:op", { sheetId: id, op: text(0) })).ok, true);
        assert.equal((await emitAck(alice, "smartsheet:op", { sheetId: id, op: text(1) })).ok, true);
        const full = await emitAck(alice, "smartsheet:op", { sheetId: id, op: text(2) });
        assert.equal(full.code, "SHEET_FULL");
    } finally {
        await harness.close();
    }
});

test("M2: write limits are per USER across all of that user's sockets, not per socket", async () => {
    const store = createMemoryStore(people());
    const userLimits = {
        operations: createWindowLimiter({ limit: 4, windowMs: 60000 }),
        cells: createWindowLimiter({ limit: 1000, windowMs: 60000 }),
    };
    const harness = await startRealtimeHarness(store, { userLimits });
    try {
        const { id, ws } = await sheetFor(harness.service);
        const tabs = [];
        for (let i = 0; i < 3; i += 1) {
            const socket = await harness.client(ALICE);
            await emitAck(socket, "smartsheet:join", { sheetId: id });
            tabs.push(socket);
        }
        const answers = [];
        for (let i = 0; i < 8; i += 1) answers.push(await emitAck(tabs[i % 3], "smartsheet:op", { sheetId: id, op: setCell(ws, i, 0, `v${i}`) }));
        assert.equal(answers.filter((a) => a.ok).length, 4, "three fresh tabs do not triple the allowance");
        const limited = answers.find((a) => !a.ok);
        assert.equal(limited.code, "RATE_LIMITED");
        assert.ok(limited.retryAfterMs > 0, "the client is told when to retry");
    } finally {
        await harness.close();
    }
});

test("M2: a per-user CELL budget stops many small writes that add up", async () => {
    const store = createMemoryStore(people());
    const userLimits = {
        operations: createWindowLimiter({ limit: 1000, windowMs: 60000 }),
        cells: createWindowLimiter({ limit: 10, windowMs: 60000 }),
    };
    const harness = await startRealtimeHarness(store, { userLimits });
    try {
        const { id, ws } = await sheetFor(harness.service);
        const alice = await harness.client(ALICE);
        await emitAck(alice, "smartsheet:join", { sheetId: id });
        const op = (from) => ({ type: "cells", ws, cells: Array.from({ length: 6 }, (_, i) => ({ r: from + i, c: 0, cell: { v: "a", t: 1 } })) });
        assert.equal((await emitAck(alice, "smartsheet:op", { sheetId: id, op: op(0) })).ok, true);
        assert.equal((await emitAck(alice, "smartsheet:op", { sheetId: id, op: op(6) })).code, "RATE_LIMITED");
    } finally {
        await harness.close();
    }
});

// ------------------------------------------------------------------------------------------------ M1

// A syntactically valid zip whose single entry DECLARES `declared` bytes (and really holds that many zeros, deflated).
function zipDeclaring(declared, { really = true } = {}) {
    const name = Buffer.from("xl/worksheets/sheet1.xml");
    const data = really ? zlib.deflateRawSync(Buffer.alloc(declared)) : zlib.deflateRawSync(Buffer.alloc(10));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    const directoryOffset = local.length + name.length + data.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + name.length, 12);
    eocd.writeUInt32LE(directoryOffset, 16);
    return Buffer.concat([local, name, data, central, name, eocd]);
}

async function smallWorkbookBuffer() {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Data");
    sheet.addRow(["a", 1, 2]);
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("M1: a decompression bomb is refused from the zip directory alone, before any byte is inflated", async () => {
    const bomb = zipDeclaring(LIMITS.MAX_UNCOMPRESSED_IMPORT_BYTES + 1024 * 1024);
    assert.ok(bomb.length < 200 * 1024, "tiny on disk");
    assert.throws(() => inspectZipBuffer(bomb), (error) => error.code === "IMPORT_TOO_LARGE");

    // a LYING archive (declares far more than it holds) is refused on its declaration too
    assert.throws(() => inspectZipBuffer(zipDeclaring(LIMITS.MAX_UNCOMPRESSED_IMPORT_BYTES * 4, { really: false })), (error) => error.code === "IMPORT_TOO_LARGE");

    // the file-based inspector reads only the directory and agrees
    const dir = tmpDir();
    try {
        const file = path.join(dir, "bomb.xlsx");
        fs.writeFileSync(file, bomb);
        await assert.rejects(() => inspectZipFile(file), (error) => error.code === "IMPORT_TOO_LARGE");
        const started = Date.now();
        await assert.rejects(() => xlsx.parseXlsxFile(file), (error) => error.code === "IMPORT_TOO_LARGE");
        assert.ok(Date.now() - started < 2000, "rejected immediately");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    await assert.rejects(() => xlsx.parseXlsxBuffer(bomb), (error) => error.code === "IMPORT_TOO_LARGE", "the in-process parser has the same guard");
});

test("M1: an archive just under the declared-size limit passes inspection; garbage and encrypted/ZIP64 archives are refused", async () => {
    assert.deepEqual(inspectZipBuffer(zipDeclaring(1024 * 1024)).uncompressedBytes, 1024 * 1024);
    assert.throws(() => inspectZipBuffer(Buffer.from("not a zip at all, just text padding".repeat(4))), (error) => error.code === "INVALID_XLSX");
    const encrypted = zipDeclaring(100);
    const flagsAt = encrypted.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8;
    encrypted.writeUInt16LE(encrypted.readUInt16LE(flagsAt) | 1, flagsAt);
    assert.throws(() => inspectZipBuffer(encrypted), (error) => error.code === "UNSUPPORTED_XLSX");
});

test("M1: a legitimate workbook imports through the isolated child process", async () => {
    const dir = tmpDir();
    try {
        const file = path.join(dir, "ok.xlsx");
        fs.writeFileSync(file, await smallWorkbookBuffer());
        const parsed = await parseXlsxFileIsolated(file);
        assert.equal(parsed.worksheets[0].name, "Data");
        assert.equal(parsed.worksheets[0].cells.length, 3);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("M1: a worker that runs out of memory or never finishes is stopped; the CRM process is untouched", async () => {
    const dir = tmpDir();
    try {
        const file = path.join(dir, "ok.xlsx");
        fs.writeFileSync(file, await smallWorkbookBuffer());

        const hog = path.join(dir, "hog.js");
        fs.writeFileSync(hog, "process.on('message', () => { const keep = []; for (;;) keep.push(new Array(200000).fill('x'.repeat(50) + keep.length)); });");
        await assert.rejects(() => parseXlsxFileIsolated(file, { workerPath: hog, memoryMb: 64, timeoutMs: 20000 }), (error) => error.code === "IMPORT_TOO_LARGE");

        const spin = path.join(dir, "spin.js");
        fs.writeFileSync(spin, "process.on('message', () => { for (;;) {} });");
        const started = Date.now();
        await assert.rejects(() => parseXlsxFileIsolated(file, { workerPath: spin, timeoutMs: 400 }), (error) => error.code === "IMPORT_TIMEOUT");
        assert.ok(Date.now() - started < 5000);

        // the main event loop stayed responsive while the worker spun
        let beats = 0;
        const timer = setInterval(() => { beats += 1; }, 20);
        await assert.rejects(() => parseXlsxFileIsolated(file, { workerPath: spin, timeoutMs: 500 }));
        clearInterval(timer);
        assert.ok(beats >= 10, `the CRM event loop kept running (${beats} beats)`);
        assert.equal(importGate.active, 0, "slots are always released");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("M1: only a few imports run at once; the rest are told to retry (IMPORT_BUSY)", async () => {
    const dir = tmpDir();
    try {
        const file = path.join(dir, "ok.xlsx");
        fs.writeFileSync(file, await smallWorkbookBuffer());
        const held = [];
        for (let i = 0; i < LIMITS.MAX_CONCURRENT_IMPORTS; i += 1) held.push(importGate.acquire("global"));
        assert.ok(held.every(Boolean));
        await assert.rejects(() => parseXlsxFileIsolated(file), (error) => error.code === "IMPORT_BUSY" && error.retryAfterMs > 0);
        held.forEach((release) => release());
        assert.ok((await parseXlsxFileIsolated(file)).worksheets.length > 0, "works again once a slot is free");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    const gate = createConcurrencyGate({ max: 2 });
    const a = gate.acquire("k");
    const b = gate.acquire("k");
    assert.equal(gate.acquire("k"), null);
    a();
    a(); // releasing twice frees only one slot
    assert.ok(gate.acquire("k"));
    b();
});

test("M1: imports are rate limited per user (and per database), and a refused import reports when to retry", async () => {
    const store = createMemoryStore(people());
    const importLimiter = createWindowLimiter({ limit: 2, windowMs: 60000 });
    const service = createSmartSheetService({ store, importLimiter, scopeKey: () => "tenant-a" });
    const dir = tmpDir();
    try {
        const file = path.join(dir, "ok.xlsx");
        fs.writeFileSync(file, await smallWorkbookBuffer());
        const upload = () => ({ path: file, originalName: "ok.xlsx", size: fs.statSync(file).size });
        assert.ok((await service.importSheet(ADMIN, "One", upload())).id);
        assert.ok((await service.importSheet(ADMIN, "Two", upload())).id);
        await assert.rejects(() => service.importSheet(ADMIN, "Three", upload()), (error) => error.code === "IMPORT_RATE_LIMITED" && error.retryAfterMs > 0);
        assert.equal(store.sheets.size, 2, "the refused import created nothing");

        const other = createSmartSheetService({ store, importLimiter, scopeKey: () => "tenant-b" });
        assert.ok((await other.importSheet(ADMIN, "Other tenant, same user id", upload())).id, "another database's user 1 has its own budget");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
