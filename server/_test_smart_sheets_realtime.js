// Smart Sheets -- real-time collaboration over Socket.IO.
//
// Runs a REAL Socket.IO server with the REAL handlers (services/smartSheetRealtime.js), the real
// service/validation/access policy, and real socket.io-client connections; only the database is an
// in-memory store (see _smart_sheets_test_support.js). Run: node --test _test_smart_sheets_realtime.js

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    COMPANY_SLUG,
    createMemoryStore,
    startRealtimeHarness,
    emitAck,
    waitForEvent,
    expectNoEvent,
} = require("./_smart_sheets_test_support");
const { evictUser, evictAll } = require("./services/smartSheetRealtime");
const { smartSheetRoom } = require("./utils/socketRooms");

const ADMIN = 1;
const ALICE = 2; // assigned, edit
const BOB = 3; // assigned, edit
const CAROL = 4; // NOT assigned
const DAVE = 5; // assigned, view only

function makeStore() {
    return createMemoryStore([
        { id: ADMIN, full_name: "Ada Admin", role: "admin", system_access: "super_admin" },
        { id: ALICE, full_name: "Alice", role: "employee" },
        { id: BOB, full_name: "Bob", role: "employee" },
        { id: CAROL, full_name: "Carol", role: "employee" },
        { id: DAVE, full_name: "Dave", role: "employee" },
    ]);
}

// admin creates a sheet and assigns Alice+Bob (edit) and Dave (view)
async function setup(options) {
    const store = makeStore();
    const harness = await startRealtimeHarness(store, options);
    const { id } = await harness.service.createBlankSheet(ADMIN, "Budget");
    await harness.service.assign(ADMIN, id, { userIds: [ALICE, BOB], permission: "edit" });
    await harness.service.assign(ADMIN, id, { userIds: [DAVE], permission: "view" });
    const workbook = await harness.service.getWorkbook(ADMIN, id);
    const ws = workbook.workbook.sheetOrder[0];
    return { store, harness, sheetId: id, ws };
}

const cellOp = (ws, r, c, v) => ({ type: "cells", ws, cells: [{ r, c, cell: { v, t: typeof v === "number" ? 2 : 1 } }] });
const storedCell = async (store, sheetId, ws, r, c) => {
    const state = await store.loadWorkbook(sheetId);
    const sheet = state.worksheets.find((w) => w.key === ws);
    const hit = sheet.cells.find((e) => e.r === r && e.c === c);
    return hit ? hit.cell : null;
};

test("an assigned employee joins and receives permission, revision and presence", async () => {
    const { harness, sheetId } = await setup();
    try {
        const alice = await harness.client(ALICE);
        const answer = await emitAck(alice, "smartsheet:join", { sheetId });
        assert.equal(answer.ok, true);
        assert.equal(answer.permission, "edit");
        assert.equal(answer.canManage, false);
        assert.equal(answer.revision, 0);
        assert.deepEqual(answer.users.map((u) => u.name), ["Alice"]);
    } finally {
        await harness.close();
    }
});

test("an unassigned employee cannot join, and the failure is identical to a spreadsheet that does not exist", async () => {
    const { harness, sheetId } = await setup();
    try {
        const carol = await harness.client(CAROL);
        const guessed = await emitAck(carol, "smartsheet:join", { sheetId });
        const missing = await emitAck(carol, "smartsheet:join", { sheetId: 9999 });
        assert.equal(guessed.ok, false);
        assert.equal(guessed.code, "NOT_FOUND");
        assert.deepEqual({ ...guessed }, { ...missing }, "must not reveal whether the id exists");

        // and she receives nothing from the room
        const alice = await harness.client(ALICE);
        await emitAck(alice, "smartsheet:join", { sheetId });
        const quiet = expectNoEvent(carol, "smartsheet:op");
        await emitAck(alice, "smartsheet:op", { sheetId, op: cellOp((await harness.service.getWorkbook(ADMIN, sheetId)).workbook.sheetOrder[0], 0, 0, "secret") });
        assert.equal(await quiet, true);
    } finally {
        await harness.close();
    }
});

test("malformed spreadsheet ids are rejected before any database access", async () => {
    const { harness, store } = await setup();
    try {
        const alice = await harness.client(ALICE);
        let lookups = 0;
        const original = store.getAccessContext;
        store.getAccessContext = async (...args) => { lookups += 1; return original(...args); };

        for (const bad of ["abc", -1, 0, "1;DROP TABLE users", {}, [], null, 1.5, "99999999999", "1 OR 1=1"]) {
            const answer = await emitAck(alice, "smartsheet:join", { sheetId: bad });
            assert.equal(answer.ok, false);
            assert.equal(answer.code, "INVALID_SHEET_ID", `sheetId ${JSON.stringify(bad)}`);
        }
        const notAnObject = await emitAck(alice, "smartsheet:join", "5");
        assert.equal(notAnObject.code, "INVALID_SHEET_ID");
        assert.equal(lookups, 0);
    } finally {
        await harness.close();
    }
});

test("a socket with a bad or missing token cannot connect", async () => {
    const { harness } = await setup();
    try {
        await assert.rejects(() => harness.client(ALICE, { token: "garbage" }), /Invalid or expired authentication token/);
        await assert.rejects(() => harness.client(ALICE, { token: "user:424242" }), /Invalid or expired/);
    } finally {
        await harness.close();
    }
});

test("two users: a cell edit is saved, then reaches the other user without a refresh", async () => {
    const { store, harness, sheetId, ws } = await setup();
    try {
        const alice = await harness.client(ALICE);
        const bob = await harness.client(BOB);
        await emitAck(alice, "smartsheet:join", { sheetId });
        await emitAck(bob, "smartsheet:join", { sheetId });

        const received = waitForEvent(bob, "smartsheet:op");
        const ack = await emitAck(alice, "smartsheet:op", { sheetId, op: cellOp(ws, 2, 3, "Hello Bob") });
        assert.equal(ack.ok, true);
        assert.equal(ack.revision, 1);

        const message = await received;
        assert.equal(message.sheetId, sheetId);
        assert.equal(message.revision, 1);
        assert.deepEqual(message.by, { id: ALICE, name: "Alice" });
        assert.deepEqual(message.op.cells, [{ r: 2, c: 3, cell: { v: "Hello Bob", t: 1 } }]);

        // it is in the database, so a refresh/reconnect shows it
        assert.deepEqual(await storedCell(store, sheetId, ws, 2, 3), { v: "Hello Bob", t: 1 });
        const reloaded = await harness.service.getWorkbook(BOB, sheetId);
        assert.deepEqual(reloaded.workbook.sheets[ws].cellData[2][3], { v: "Hello Bob", t: 1 });
        assert.equal(reloaded.revision, 1);
    } finally {
        await harness.close();
    }
});

test("PERSIST BEFORE BROADCAST: when the save fails nothing is announced and the sender is told", async () => {
    const { store, harness, sheetId, ws } = await setup();
    try {
        const alice = await harness.client(ALICE);
        const bob = await harness.client(BOB);
        await emitAck(alice, "smartsheet:join", { sheetId });
        await emitAck(bob, "smartsheet:join", { sheetId });

        store.failWrites = true;
        const silent = expectNoEvent(bob, "smartsheet:op", 400);
        const ack = await emitAck(alice, "smartsheet:op", { sheetId, op: cellOp(ws, 0, 0, "never saved") });
        assert.equal(ack.ok, false);
        assert.equal(ack.code, "SERVER_ERROR");
        assert.doesNotMatch(JSON.stringify(ack), /simulated database failure/, "internal errors must not leak");
        assert.equal(await silent, true, "a change that was not committed must never be broadcast");
        assert.equal(await storedCell(store, sheetId, ws, 0, 0), null);

        // after recovery the same socket keeps working
        store.failWrites = false;
        const retry = await emitAck(alice, "smartsheet:op", { sheetId, op: cellOp(ws, 0, 0, "saved now") });
        assert.equal(retry.ok, true);
    } finally {
        await harness.close();
    }
});

test("the broadcast happens only after the commit (the data is already stored when the other user is told)", async () => {
    const { store, harness, sheetId, ws } = await setup();
    try {
        const alice = await harness.client(ALICE);
        const bob = await harness.client(BOB);
        await emitAck(alice, "smartsheet:join", { sheetId });
        await emitAck(bob, "smartsheet:join", { sheetId });
        store.writeDelayMs = 150; // commit takes a while

        let bobHeardAt = null;
        const t0 = Date.now();
        bob.once("smartsheet:op", () => { bobHeardAt = Date.now() - t0; });
        await emitAck(alice, "smartsheet:op", { sheetId, op: cellOp(ws, 1, 1, "slow commit") }, 5000);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.ok(bobHeardAt !== null, "bob was told");
        assert.ok(bobHeardAt >= 140, `bob must not hear it before the commit finished (heard after ${bobHeardAt}ms)`);
    } finally {
        await harness.close();
    }
});

test("the sender does not get its own change back, but the same user's other tab does", async () => {
    const { harness, sheetId, ws } = await setup();
    try {
        const tab1 = await harness.client(ALICE);
        const tab2 = await harness.client(ALICE);
        await emitAck(tab1, "smartsheet:join", { sheetId });
        await emitAck(tab2, "smartsheet:join", { sheetId });

        const selfEcho = expectNoEvent(tab1, "smartsheet:op");
        const otherTab = waitForEvent(tab2, "smartsheet:op");
        await emitAck(tab1, "smartsheet:op", { sheetId, op: cellOp(ws, 0, 1, "x") });
        assert.equal(await selfEcho, true);
        assert.equal((await otherTab).op.cells[0].cell.v, "x");
    } finally {
        await harness.close();
    }
});

test("SIMULTANEOUS EDITS of the same cell: last write wins in database order and every client converges on it", async () => {
    const { store, harness, sheetId, ws } = await setup();
    try {
        store.writeDelayMs = 25;
        const alice = await harness.client(ALICE);
        const bob = await harness.client(BOB);
        await emitAck(alice, "smartsheet:join", { sheetId });
        await emitAck(bob, "smartsheet:join", { sheetId });

        const seenByAlice = [];
        const seenByBob = [];
        alice.on("smartsheet:op", (m) => seenByAlice.push(m));
        bob.on("smartsheet:op", (m) => seenByBob.push(m));

        // fired in the same tick: both target cell (5,5)
        const [a, b] = await Promise.all([
            emitAck(alice, "smartsheet:op", { sheetId, op: cellOp(ws, 5, 5, "from Alice") }, 5000),
            emitAck(bob, "smartsheet:op", { sheetId, op: cellOp(ws, 5, 5, "from Bob") }, 5000),
        ]);
        assert.equal(a.ok && b.ok, true, "neither edit is rejected");
        assert.notEqual(a.revision, b.revision, "the database gave them a strict order");

        const winner = a.revision > b.revision ? "from Alice" : "from Bob";
        const loserSocketSaw = a.revision > b.revision ? seenByBob : seenByAlice; // the client whose own edit lost
        await new Promise((resolve) => setTimeout(resolve, 150));

        // 1. the database holds exactly the later write
        assert.equal((await storedCell(store, sheetId, ws, 5, 5)).v, winner);
        // 2. the announcements carry the revisions in commit order, so the last one a client hears is the database's value
        assert.deepEqual(seenByAlice.map((m) => m.revision), [b.revision]);
        assert.deepEqual(seenByBob.map((m) => m.revision), [a.revision]);
        // 3. the client whose edit lost is told the winner LAST
        assert.equal(loserSocketSaw[loserSocketSaw.length - 1].op.cells[0].cell.v, winner);
        // 4. a refresh shows the same value for everyone
        for (const user of [ADMIN, ALICE, BOB]) {
            const sheet = await harness.service.getWorkbook(user, sheetId);
            assert.equal(sheet.workbook.sheets[ws].cellData[5][5].v, winner);
        }
    } finally {
        await harness.close();
    }
});

test("many simultaneous edits are announced in exactly the order they were committed", async () => {
    const { store, harness, sheetId, ws } = await setup();
    try {
        store.writeDelayMs = 5;
        const alice = await harness.client(ALICE);
        const bob = await harness.client(BOB);
        const dave = await harness.client(DAVE); // watcher
        for (const s of [alice, bob, dave]) await emitAck(s, "smartsheet:join", { sheetId });

        const heard = [];
        dave.on("smartsheet:op", (m) => heard.push(m.revision));

        await Promise.all(
            Array.from({ length: 20 }, (_, i) =>
                emitAck(i % 2 ? alice : bob, "smartsheet:op", { sheetId, op: cellOp(ws, i, 0, `v${i}`) }, 5000)
            )
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(heard.length, 20);
        assert.deepEqual(heard, [...heard].sort((x, y) => x - y), "announcements arrive in commit order");
        assert.equal(new Set(heard).size, 20, "every revision is unique");
    } finally {
        await harness.close();
    }
});

test("UNASSIGN removes socket access immediately: no more updates are received and edits are refused", async () => {
    const { harness, sheetId, ws } = await setup();
    try {
        const alice = await harness.client(ALICE);
        const bob = await harness.client(BOB);
        await emitAck(alice, "smartsheet:join", { sheetId });
        await emitAck(bob, "smartsheet:join", { sheetId });

        // admin removes Alice: REST commit, then the controller's eviction call
        await harness.service.revoke(ADMIN, sheetId, ALICE);
        const told = waitForEvent(alice, "smartsheet:access-revoked");
        await evictUser(harness.io, COMPANY_SLUG, sheetId, ALICE, "unassigned");
        assert.deepEqual(await told, { sheetId, reason: "unassigned" });

        // Bob keeps working; Alice hears nothing
        const quiet = expectNoEvent(alice, "smartsheet:op");
        const bobAck = await emitAck(bob, "smartsheet:op", { sheetId, op: cellOp(ws, 0, 0, "after revoke") });
        assert.equal(bobAck.ok, true);
        assert.equal(await quiet, true, "an unassigned employee must not receive further changes");

        // Alice's own edits and re-joins are refused
        const edit = await emitAck(alice, "smartsheet:op", { sheetId, op: cellOp(ws, 9, 9, "sneaky") });
        assert.equal(edit.ok, false);
        const rejoin = await emitAck(alice, "smartsheet:join", { sheetId });
        assert.equal(rejoin.code, "NOT_FOUND");

        // presence shown to Bob no longer lists Alice
        const room = harness.io.sockets.adapter.rooms.get(smartSheetRoom(COMPANY_SLUG, sheetId));
        assert.equal(room.size, 1);
    } finally {
        await harness.close();
    }
});

test("every update re-checks the database: revoked access is refused even if the socket was never evicted", async () => {
    const { store, harness, sheetId, ws } = await setup();
    try {
        const alice = await harness.client(ALICE);
        await emitAck(alice, "smartsheet:join", { sheetId });
        assert.equal((await emitAck(alice, "smartsheet:op", { sheetId, op: cellOp(ws, 0, 0, "ok while assigned") })).ok, true);

        await store.revokeAccess(sheetId, ALICE); // database changed, no socket eviction at all
        const told = waitForEvent(alice, "smartsheet:access-revoked");
        const refused = await emitAck(alice, "smartsheet:op", { sheetId, op: cellOp(ws, 0, 0, "should fail") });
        assert.equal(refused.ok, false);
        assert.equal(refused.code, "NOT_FOUND");
        assert.equal((await told).reason, "no_access");
        assert.equal((await storedCell(store, sheetId, ws, 0, 0)).v, "ok while assigned", "the refused edit changed nothing");
    } finally {
        await harness.close();
    }
});

test("an employee who is demoted to view-only can no longer save, and a deactivated account is cut off", async () => {
    const { store, harness, sheetId, ws } = await setup();
    try {
        const alice = await harness.client(ALICE);
        await emitAck(alice, "smartsheet:join", { sheetId });

        await harness.service.assign(ADMIN, sheetId, { userIds: [ALICE], permission: "view" });
        const viewOnly = await emitAck(alice, "smartsheet:op", { sheetId, op: cellOp(ws, 0, 0, "x") });
        assert.equal(viewOnly.code, "READ_ONLY");

        await harness.service.assign(ADMIN, sheetId, { userIds: [ALICE], permission: "edit" });
        assert.equal((await emitAck(alice, "smartsheet:op", { sheetId, op: cellOp(ws, 0, 0, "x") })).ok, true);

        store.users.get(ALICE).employment_status = "resigned";
        assert.equal((await emitAck(alice, "smartsheet:op", { sheetId, op: cellOp(ws, 0, 1, "y") })).code, "NOT_FOUND");
        const fresh = await harness.client(BOB);
        store.users.get(BOB).employment_status = "terminated";
        assert.equal((await emitAck(fresh, "smartsheet:join", { sheetId })).code, "NOT_FOUND");
    } finally {
        await harness.close();
    }
});

test("a view-only employee can open the sheet but cannot change it", async () => {
    const { store, harness, sheetId, ws } = await setup();
    try {
        const dave = await harness.client(DAVE);
        const joined = await emitAck(dave, "smartsheet:join", { sheetId });
        assert.equal(joined.ok, true);
        assert.equal(joined.permission, "view");
        const refused = await emitAck(dave, "smartsheet:op", { sheetId, op: cellOp(ws, 0, 0, "nope") });
        assert.equal(refused.ok, false);
        assert.equal(refused.code, "READ_ONLY");
        assert.equal(await storedCell(store, sheetId, ws, 0, 0), null);
    } finally {
        await harness.close();
    }
});

test("an update from a socket that has not joined the spreadsheet is refused, even for an assigned user", async () => {
    const { store, harness, sheetId, ws } = await setup();
    try {
        const alice = await harness.client(ALICE);
        const refused = await emitAck(alice, "smartsheet:op", { sheetId, op: cellOp(ws, 0, 0, "x") });
        assert.equal(refused.code, "NOT_JOINED");
        assert.equal(store.writes, 0);

        await emitAck(alice, "smartsheet:join", { sheetId });
        await emitAck(alice, "smartsheet:leave", { sheetId });
        assert.equal((await emitAck(alice, "smartsheet:op", { sheetId, op: cellOp(ws, 0, 0, "x") })).code, "NOT_JOINED");
    } finally {
        await harness.close();
    }
});

test("payloads are validated: ids, worksheet ids, coordinates, sizes, types and formulas", async () => {
    const { store, harness, sheetId, ws } = await setup();
    try {
        const alice = await harness.client(ALICE);
        await emitAck(alice, "smartsheet:join", { sheetId });
        const send = (op, extra = {}) => emitAck(alice, "smartsheet:op", { sheetId, op, ...extra });

        const cases = [
            ["a non-object op", "oops", "INVALID_OPERATION"],
            ["an unknown operation type", { type: "dropTable" }, "UNKNOWN_OPERATION"],
            ["a worksheet id with illegal characters", { type: "cells", ws: "a b;--", cells: [{ r: 0, c: 0, cell: { v: 1 } }] }, "INVALID_WORKSHEET_ID"],
            ["a worksheet that is not in this spreadsheet", { type: "cells", ws: "other", cells: [{ r: 0, c: 0, cell: { v: 1 } }] }, "WORKSHEET_NOT_FOUND"],
            ["a negative row", cellOp(ws, -1, 0, "x"), "INVALID_CELL_COORDINATE"],
            ["a fractional column", { type: "cells", ws, cells: [{ r: 0, c: 1.5, cell: { v: 1 } }] }, "INVALID_CELL_COORDINATE"],
            ["a row beyond the product limit", cellOp(ws, 100000, 0, "x"), "INVALID_CELL_COORDINATE"],
            ["a column beyond the product limit", cellOp(ws, 0, 1000, "x"), "INVALID_CELL_COORDINATE"],
            ["a cell outside this worksheet's grid", cellOp(ws, 5000, 0, "x"), "INVALID_CELL_COORDINATE"],
            ["no cells", { type: "cells", ws, cells: [] }, "INVALID_OPERATION"],
            ["too many cells in one change", { type: "cells", ws, cells: Array.from({ length: 5001 }, (_, i) => ({ r: i % 900, c: i % 20, cell: { v: i } })) }, "PAYLOAD_TOO_LARGE"],
            ["a payload over the byte limit", { type: "cells", ws, cells: Array.from({ length: 40 }, (_, i) => ({ r: i, c: 0, cell: { v: "x".repeat(20000) } })) }, "PAYLOAD_TOO_LARGE"],
            ["text longer than a cell may hold", cellOp(ws, 0, 0, "x".repeat(32768)), "CELL_TOO_LARGE"],
            ["an object as a value", { type: "cells", ws, cells: [{ r: 0, c: 0, cell: { v: { a: 1 } } }] }, "INVALID_CELL"],
            ["a formula that is not a formula", { type: "cells", ws, cells: [{ r: 0, c: 0, cell: { f: "SUM(1)" } }] }, "INVALID_CELL"],
            ["a DDE-style formula", { type: "cells", ws, cells: [{ r: 0, c: 0, cell: { f: "=cmd|'/c calc'!A0" } }] }, "INVALID_CELL"],
            ["a prototype-poisoning style", { type: "cells", ws, cells: [{ r: 0, c: 0, cell: { v: 1, s: JSON.parse('{"__proto__":{"x":1}}') } }] }, "INVALID_CELL"],
            ["an invalid worksheet name", { type: "addWorksheet", ws: "new1", name: "bad/name" }, "INVALID_WORKSHEET_NAME"],
            ["a too-long worksheet name", { type: "addWorksheet", ws: "new1", name: "x".repeat(32) }, "INVALID_WORKSHEET_NAME"],
            ["a column width out of range", { type: "layout", ws, columnWidths: { 0: 99999 } }, "INVALID_LAYOUT"],
        ];

        for (const [label, op, code] of cases) {
            const answer = await send(op);
            assert.equal(answer.ok, false, label);
            assert.equal(answer.code, code, label);
        }
        assert.equal(store.writes, 0, "nothing invalid was ever written");

        // a harmless formula with a pipe inside a string literal is fine
        const fine = await send({ type: "cells", ws, cells: [{ r: 0, c: 0, cell: { f: '=IF(A2="a|b",1,2)', v: 1, t: 2 } }] });
        assert.equal(fine.ok, true);
        // unknown cell fields are dropped, not stored
        assert.equal((await send({ type: "cells", ws, cells: [{ r: 1, c: 0, cell: { v: "k", evil: "<script>", __proto__x: 1 } }] })).ok, true);
        assert.deepEqual(await storedCell(store, sheetId, ws, 1, 0), { v: "k" });
    } finally {
        await harness.close();
    }
});

test("updates are rate limited per socket", async () => {
    const { harness, sheetId, ws } = await setup({ rateLimit: { limit: 3, windowMs: 60000 } });
    try {
        const alice = await harness.client(ALICE);
        await emitAck(alice, "smartsheet:join", { sheetId });
        const results = [];
        for (let i = 0; i < 5; i += 1) {
            results.push(await emitAck(alice, "smartsheet:op", { sheetId, op: cellOp(ws, i, 0, `v${i}`) }));
        }
        assert.deepEqual(results.map((r) => r.ok), [true, true, true, false, false]);
        assert.equal(results[3].code, "RATE_LIMITED");
    } finally {
        await harness.close();
    }
});

test("collaborator presence: joins, duplicate tabs, leave and disconnect are all reflected", async () => {
    const { harness, sheetId } = await setup();
    try {
        const alice = await harness.client(ALICE);
        const bob = await harness.client(BOB);
        await emitAck(alice, "smartsheet:join", { sheetId });

        const sawBob = waitForEvent(alice, "smartsheet:presence", { predicate: (p) => p.users.some((u) => u.name === "Bob") });
        const bobJoin = await emitAck(bob, "smartsheet:join", { sheetId });
        assert.deepEqual(bobJoin.users.map((u) => u.name), ["Alice", "Bob"]);
        assert.deepEqual((await sawBob).users.map((u) => u.name), ["Alice", "Bob"]);

        // a second tab of Bob is still one collaborator
        const bobTab2 = await harness.client(BOB);
        const tab2Join = await emitAck(bobTab2, "smartsheet:join", { sheetId });
        assert.deepEqual(tab2Join.users.map((u) => u.name), ["Alice", "Bob"]);

        // leaving one tab keeps Bob present, closing the last tab removes him
        bobTab2.close();
        await new Promise((resolve) => setTimeout(resolve, 150));
        const stillThere = await harness.io.in(smartSheetRoom(COMPANY_SLUG, sheetId)).fetchSockets();
        assert.equal(stillThere.length, 2);

        const wentAway = waitForEvent(alice, "smartsheet:presence", { predicate: (p) => !p.users.some((u) => u.name === "Bob") });
        bob.close();
        assert.deepEqual((await wentAway).users.map((u) => u.name), ["Alice"]);
    } finally {
        await harness.close();
    }
});

test("archiving or deleting a spreadsheet evicts everyone", async () => {
    const { harness, sheetId, ws } = await setup();
    try {
        const alice = await harness.client(ALICE);
        const bob = await harness.client(BOB);
        await emitAck(alice, "smartsheet:join", { sheetId });
        await emitAck(bob, "smartsheet:join", { sheetId });

        await harness.service.updateSheet(ADMIN, sheetId, { status: "archived" });
        const told = Promise.all([waitForEvent(alice, "smartsheet:access-revoked"), waitForEvent(bob, "smartsheet:access-revoked")]);
        await evictAll(harness.io, COMPANY_SLUG, sheetId, "archived");
        const [a, b] = await told;
        assert.equal(a.reason, "archived");
        assert.equal(b.reason, "archived");

        assert.equal((await emitAck(alice, "smartsheet:op", { sheetId, op: cellOp(ws, 0, 0, "x") })).ok, false);
        assert.equal((await emitAck(bob, "smartsheet:join", { sheetId })).code, "NOT_FOUND", "employees cannot open an archived spreadsheet");
    } finally {
        await harness.close();
    }
});

test("worksheet tabs sync: add, rename, duplicate-name conflict and layout", async () => {
    const { store, harness, sheetId } = await setup();
    try {
        const alice = await harness.client(ALICE);
        const bob = await harness.client(BOB);
        await emitAck(alice, "smartsheet:join", { sheetId });
        await emitAck(bob, "smartsheet:join", { sheetId });

        const heardAdd = waitForEvent(bob, "smartsheet:op");
        const add = await emitAck(alice, "smartsheet:op", { sheetId, op: { type: "addWorksheet", ws: "tab-2", name: "Forecast", index: 1 } });
        assert.equal(add.ok, true);
        assert.equal((await heardAdd).op.name, "Forecast");

        // resending the same add (a retry after reconnect) is idempotent
        assert.equal((await emitAck(alice, "smartsheet:op", { sheetId, op: { type: "addWorksheet", ws: "tab-2", name: "Forecast", index: 1 } })).ok, true);

        const heardRename = waitForEvent(alice, "smartsheet:op");
        assert.equal((await emitAck(bob, "smartsheet:op", { sheetId, op: { type: "renameWorksheet", ws: "tab-2", name: "Q3 Forecast" } })).ok, true);
        assert.equal((await heardRename).op.name, "Q3 Forecast");

        const clash = await emitAck(bob, "smartsheet:op", { sheetId, op: { type: "addWorksheet", ws: "tab-3", name: "q3 forecast" } });
        assert.equal(clash.code, "WORKSHEET_NAME_EXISTS");

        assert.equal((await emitAck(alice, "smartsheet:op", { sheetId, op: { type: "layout", ws: "tab-2", columnWidths: { 0: 180 }, rowHeights: { 2: 40 } } })).ok, true);

        const names = (await harness.service.getWorkbook(ADMIN, sheetId)).workbook;
        assert.deepEqual(names.sheetOrder.map((key) => names.sheets[key].name), ["Sheet1", "Q3 Forecast"]);
        assert.deepEqual(names.sheets["tab-2"].columnData, { 0: { w: 180 } });
        assert.deepEqual(names.sheets["tab-2"].rowData, { 2: { h: 40 } });
    } finally {
        await harness.close();
    }
});

test("room names are namespaced by company, so two tenants can never share a spreadsheet room", () => {
    assert.equal(smartSheetRoom("acme", 7), "tenant:acme:smartsheet:7");
    assert.notEqual(smartSheetRoom("acme", 7), smartSheetRoom("globex", 7));
    assert.match(smartSheetRoom("globex", 7), /^tenant:globex:/);
});
