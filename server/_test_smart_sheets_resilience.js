// Smart Sheets -- regression tests for the PR #15 review findings H2 (reconnect), H3 (ack timeout) and H4 (large paste),
// browser side. The logic lives in pure modules (client/src/utils/smartSheetSync.js, smartSheetSession.js), so it is
// exercised directly here, with scripted servers and fake timers' worth of injected waits.
// Run: node --test _test_smart_sheets_resilience.js

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const clientFile = (name) => import(pathToFileURL(path.join(__dirname, "..", "client", "src", "utils", name)).href);
const loadSync = () => clientFile("smartSheetSync.js");
const loadSession = () => clientFile("smartSheetSession.js");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async (times = 12) => { for (let i = 0; i < times; i += 1) await tick(); };
const cellsOp = (r, c, v) => ({ type: "cells", ws: "w1", cells: [{ r, c, cell: { v } }] });
const noWait = () => Promise.resolve();

// ------------------------------------------------------------------------------------------------ H4 (chunking)

test("H4: a large paste is split by SERIALIZED SIZE, every piece well under the server limit, nothing lost or reordered", async () => {
  const { chunkCellsByBytes, byteLength, OPERATION_TARGET_BYTES } = await loadSync();
  const cells = Array.from({ length: 4000 }, (_, index) => ({ r: Math.floor(index / 10), c: index % 10, cell: { v: `${index}:` + "long text ".repeat(32), t: 1 } }));
  const total = byteLength(cells);
  assert.ok(total > 1024 * 1024, `test input is a big paste (${total} bytes)`);

  const chunks = chunkCellsByBytes(cells);
  assert.ok(chunks.length >= 5);
  for (const piece of chunks) {
    assert.ok(byteLength({ type: "cells", ws: "w1", cells: piece }) <= OPERATION_TARGET_BYTES + 1024, "each message stays near 256 KB");
    assert.ok(piece.length <= 5000);
  }
  assert.deepEqual(chunks.flat(), cells, "same cells, same order");
});

test("H4: a single huge cell still travels alone, and many tiny cells still respect the per-operation cell cap", async () => {
  const { chunkCellsByBytes } = await loadSync();
  const huge = { r: 0, c: 0, cell: { v: "h".repeat(60 * 1024), t: 1 } };
  const tiny = Array.from({ length: 12000 }, (_, i) => ({ r: i, c: 0, cell: { v: 1, t: 2 } }));
  const chunks = chunkCellsByBytes([huge, ...tiny]);
  assert.ok(chunks.every((piece) => piece.length <= 5000));
  assert.deepEqual(chunks.flat().length, 12001);
  assert.equal(chunkCellsByBytes([]).length, 0);
});

test("H4: an operation that can never fit is refused locally, not retried forever", async () => {
  const { createSaveQueue } = await loadSync();
  const sent = [];
  const rejected = [];
  const queue = createSaveQueue({ send: async (op) => { sent.push(op); return { ok: true }; }, onRejected: (op, error) => rejected.push(error), maxOperationBytes: 1000, wait: noWait });
  queue.setConnected(true);
  queue.enqueue(cellsOp(0, 0, "x".repeat(5000)));
  queue.enqueue(cellsOp(1, 1, "small"));
  await queue.whenDrained();
  assert.equal(sent.length, 1, "only the small one was sent");
  assert.equal(rejected[0].code, "OPERATION_TOO_LARGE");
});

test("H4: repeated transport failures do not loop forever -- a controlled reconnect is requested, then the change is reported", async () => {
  const { createSaveQueue } = await loadSync();
  let reconnects = 0;
  const rejected = [];
  const queue = createSaveQueue({
    send: async () => { throw new Error("ack timeout"); },
    onRejected: (op, error) => rejected.push(error),
    onTransportFailure: () => { reconnects += 1; },
    transportRetryDelaysMs: [1, 1],
    maxTransportFailures: 5,
    idleResumeMs: 5,
    wait: noWait,
  });
  queue.setConnected(true);
  queue.enqueue(cellsOp(0, 0, "never arrives"));
  for (let i = 0; i < 200 && rejected.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  queue.dispose();
  assert.ok(reconnects >= 1, "asked the owner for a controlled reconnect");
  assert.equal(rejected.length, 1, "gave up on the change instead of retrying for ever");
  assert.equal(rejected[0].code, "TRANSPORT_FAILED");
  assert.equal(queue.size, 0, "the queue is not stuck behind it");
});

// ------------------------------------------------------------------------------------------------ H3 (stuck queue)

test("H3: a lost acknowledgement is retried with the SAME opId, so the server can recognise the repeat", async () => {
  const { createSaveQueue } = await loadSync();
  const seen = [];
  let calls = 0;
  const queue = createSaveQueue({
    send: async (op, opId) => { seen.push(opId); calls += 1; if (calls < 3) throw new Error("ack timeout"); return { ok: true, revision: 7 }; },
    transportRetryDelaysMs: [1, 1, 1],
    wait: noWait,
  });
  queue.setConnected(true);
  queue.enqueue(cellsOp(0, 0, "once"));
  await queue.whenDrained();
  assert.equal(seen.length, 3);
  assert.ok(seen[0] && seen.every((id) => id === seen[0]), "one operation, one opId, across retries");
  assert.match(seen[0], /^[A-Za-z0-9_-]{8,64}$/, "an opId the server accepts");
});

test("H3: a failed change never blocks the ones behind it, and order is kept for the rest", async () => {
  const { createSaveQueue } = await loadSync();
  const delivered = [];
  const queue = createSaveQueue({
    send: async (op) => { if (op.cells[0].cell.v === "poison") throw new Error("timeout"); delivered.push(op.cells[0].cell.v); return { ok: true }; },
    transportRetryDelaysMs: [1],
    maxTransportFailures: 2,
    onRejected: () => {},
    wait: noWait,
  });
  queue.setConnected(true);
  queue.enqueue(cellsOp(0, 0, "a"));
  queue.enqueue(cellsOp(0, 1, "poison"));
  queue.enqueue(cellsOp(0, 2, "b"));
  assert.equal(await queue.whenDrained({ timeoutMs: 3000 }), true);
  assert.deepEqual(delivered, ["a", "b"]);
});

test("H3: draining has a timeout -- a stuck queue cannot hang the caller", async () => {
  const { createSaveQueue } = await loadSync();
  const queue = createSaveQueue({ send: () => new Promise(() => {}), wait: noWait }); // never answers
  queue.setConnected(true);
  queue.enqueue(cellsOp(0, 0, "x"));
  const started = Date.now();
  assert.equal(await queue.whenDrained({ timeoutMs: 50 }), false);
  assert.ok(Date.now() - started < 1000);
  assert.equal(queue.size, 1, "the change is still kept");
  queue.dispose();
});

test("H3: a queue left idle (e.g. after a failed rejoin) resumes by itself", async () => {
  const { createSaveQueue } = await loadSync();
  let rejoinAsked = 0;
  let answers = 0;
  const queue = createSaveQueue({
    send: async () => { answers += 1; return answers === 1 ? { ok: false, code: "NOT_JOINED" } : { ok: true }; },
    onNeedsRejoin: () => { rejoinAsked += 1; }, // the owner does nothing at all
    idleResumeMs: 10,
    wait: noWait,
  });
  queue.setConnected(true);
  queue.enqueue(cellsOp(0, 0, "x"));
  assert.equal(await queue.whenDrained({ timeoutMs: 3000 }), true);
  assert.equal(rejoinAsked, 1);
  queue.dispose();
});

test("H3: RATE_LIMITED answers are waited out using the server's retryAfterMs, then the same change goes through", async () => {
  const { createSaveQueue } = await loadSync();
  const waits = [];
  let calls = 0;
  const queue = createSaveQueue({
    send: async () => { calls += 1; return calls === 1 ? { ok: false, code: "RATE_LIMITED", retryAfterMs: 4000 } : { ok: true }; },
    wait: async (ms) => { waits.push(ms); },
  });
  queue.setConnected(true);
  queue.enqueue(cellsOp(0, 0, "x"));
  await queue.whenDrained();
  assert.deepEqual(waits, [4000]);
  assert.equal(calls, 2);
});

// ------------------------------------------------------------------------------------------------ server side of H3 (duplicates)

test("H3: the server applies a retried opId once and answers the original revision", async () => {
  const { createOpDedupe } = require("./services/smartSheetRealtime");
  let time = 0;
  const dedupe = createOpDedupe({ ttlMs: 1000, max: 3, now: () => time });
  dedupe.set("k1", 5);
  assert.equal(dedupe.get("k1").revision, 5);
  time = 2000;
  assert.equal(dedupe.get("k1"), null, "forgotten after the time-to-live");
  for (const key of ["a", "b", "c", "d"]) dedupe.set(key, 1);
  assert.equal(dedupe.get("a"), null, "bounded: the oldest go first");
  assert.ok(dedupe.get("d"));
});

// ------------------------------------------------------------------------------------------------ H2 (reconnect = same sync path)

function harnessFor(createSyncController, overrides = {}) {
  const log = [];
  const statuses = [];
  const editing = [];
  let mounted = null;
  const applied = [];
  let queueDrained = true;
  const queue = {
    setConnected: (value) => log.push(`connected:${value}`),
    whenDrained: async () => { log.push("drain"); return queueDrained; },
  };
  const controller = createSyncController({
    join: async () => { log.push("join"); },
    fetchState: async () => { log.push("fetch"); return { revision: 10, tag: "saved-state" }; },
    mount: (state) => { log.push("mount"); mounted = state; },
    applyOp: (op) => { log.push(`apply:${op.id}`); applied.push(op.id); },
    queue,
    setEditing: (open) => { editing.push(open); },
    onStatus: (status) => statuses.push(status.phase),
    wait: tick, // yields to the event loop so a permanently failing sync cannot starve the test
    backoffMs: [1, 1, 1],
    ...overrides,
  });
  return { controller, log, statuses, editing, applied, getMounted: () => mounted, setDrained: (value) => { queueDrained = value; } };
}

test("H2: first load and reconnect run the same steps: join -> flush unsaved edits -> load saved state -> replay missed changes", async () => {
  const { createSyncController } = await loadSession();
  const h = harnessFor(createSyncController);

  const p = h.controller.synchronise("open");
  h.controller.receive({ revision: 11, op: { id: "live-11" } }); // arrives while loading
  h.controller.receive({ revision: 9, op: { id: "old-9" } }); // already contained in the saved state
  await p;
  assert.deepEqual(h.log.filter((entry) => !entry.startsWith("connected")), ["join", "drain", "fetch", "mount", "apply:live-11"]);
  assert.deepEqual(h.applied, ["live-11"], "only changes newer than the loaded state are replayed");
  assert.equal(h.controller.phase, "live");

  const firstRun = h.log.length;
  h.log.length = 0;
  h.controller.receive({ revision: 12, op: { id: "live-12" } }); // live: applied straight away
  assert.deepEqual(h.log, ["apply:live-12"]);

  h.log.length = 0;
  await h.controller.synchronise("reconnect");
  assert.deepEqual(h.log.filter((entry) => !entry.startsWith("connected")), ["join", "drain", "fetch", "mount"], "a reconnect goes through exactly the same path");
  assert.ok(firstRun > 0);
});

test("H2: remote changes that arrive in any order while syncing are replayed in revision order", async () => {
  const { createSyncController } = await loadSession();
  const h = harnessFor(createSyncController);
  const p = h.controller.synchronise("reconnect");
  for (const revision of [14, 11, 13, 12]) h.controller.receive({ revision, op: { id: `r${revision}` } });
  await p;
  assert.deepEqual(h.applied, ["r11", "r12", "r13", "r14"]);
});

test("H2: editing is closed from the start of a sync until the new state is mounted and replayed", async () => {
  const { createSyncController } = await loadSession();
  const events = [];
  const h = harnessFor(createSyncController, {
    setEditing: (open) => events.push(`editing:${open}`),
    mount: () => events.push("mount"),
    applyOp: () => events.push("apply"),
  });
  h.controller.synchronise("reconnect");
  h.controller.receive({ revision: 11, op: { id: "x" } });
  await settle();
  assert.deepEqual(events, ["editing:false", "mount", "apply", "editing:true"]);
});

test("H2: local unsaved edits are NEVER discarded -- if they cannot be flushed the workbook is not replaced", async () => {
  const { createSyncController } = await loadSession();
  const h = harnessFor(createSyncController);
  h.setDrained(false); // the queue cannot drain
  const p = h.controller.synchronise("reconnect");
  await settle(40);
  assert.equal(h.getMounted(), null, "workbook untouched: the user's typing is still on screen");
  assert.ok(!h.log.includes("fetch"), "did not even load the saved state while edits are unsaved");
  assert.equal(h.controller.phase, "stale", "flagged out of date");
  assert.deepEqual(h.editing.filter((open) => open), [], "editing stays closed");

  h.setDrained(true); // the connection recovers; the next retry flushes and then syncs
  await p;
  assert.equal(h.controller.phase, "live");
  assert.deepEqual(h.getMounted(), { revision: 10, tag: "saved-state" });
});

test("H2: a failing sync is retried with backoff and shows an out-of-date indicator until it works", async () => {
  const { createSyncController } = await loadSession();
  const waits = [];
  let failures = 3;
  const h = harnessFor(createSyncController, {
    wait: async (ms) => { waits.push(ms); },
    backoffMs: [100, 200, 400],
    fetchState: async () => { if (failures > 0) { failures -= 1; throw new Error("offline"); } return { revision: 1 }; },
  });
  await h.controller.synchronise("reconnect");
  assert.deepEqual(waits, [100, 200, 400], "growing delays");
  assert.deepEqual([...new Set(h.statuses)], ["syncing", "stale", "live"]);
  assert.equal(h.controller.phase, "live");
});

test("H2: the backoff is capped, so a long outage keeps retrying at a steady pace instead of giving up", async () => {
  const { createSyncController, SYNC_BACKOFF_MS } = await loadSession();
  const waits = [];
  let failures = SYNC_BACKOFF_MS.length + 3;
  const h = harnessFor(createSyncController, {
    wait: async (ms) => { waits.push(ms); },
    backoffMs: SYNC_BACKOFF_MS,
    join: async () => { if (failures > 0) { failures -= 1; throw new Error("down"); } },
  });
  await h.controller.synchronise("reconnect");
  assert.equal(waits.length, SYNC_BACKOFF_MS.length + 3);
  assert.equal(Math.max(...waits), SYNC_BACKOFF_MS[SYNC_BACKOFF_MS.length - 1]);
});

test("H2: losing access ends the sync with 'revoked' instead of retrying for ever", async () => {
  const { createSyncController } = await loadSession();
  let revoked = 0;
  const h = harnessFor(createSyncController, {
    join: async () => { const error = new Error("gone"); error.code = "NOT_FOUND"; throw error; },
    onRevoked: () => { revoked += 1; },
  });
  await h.controller.synchronise("reconnect");
  assert.equal(h.controller.phase, "revoked");
  assert.equal(revoked, 1);
});

test("H2: reconnects that happen during a sync collapse into one extra run, never overlapping runs", async () => {
  const { createSyncController } = await loadSession();
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  const h = harnessFor(createSyncController, {
    fetchState: async () => { active += 1; maxActive = Math.max(maxActive, active); runs += 1; await tick(); active -= 1; return { revision: 1 }; },
  });
  const a = h.controller.synchronise("reconnect");
  h.controller.synchronise("reconnect");
  h.controller.synchronise("reconnect");
  await a;
  assert.equal(maxActive, 1);
  assert.equal(runs, 2, "the first run plus ONE follow-up");
});

test("H2: 'Retry now' cuts the backoff wait short", async () => {
  const { createSyncController } = await loadSession();
  let failures = 1;
  let release;
  const h = harnessFor(createSyncController, {
    wait: () => new Promise((resolve) => { release = resolve; setTimeout(resolve, 60000).unref(); }),
    join: async () => { if (failures > 0) { failures -= 1; throw new Error("down"); } },
  });
  const p = h.controller.synchronise("reconnect");
  await settle();
  assert.equal(h.controller.phase, "stale");
  h.controller.retryNow();
  await p;
  assert.equal(h.controller.phase, "live");
  assert.ok(release);
});

test("H2: the editor uses the controller for BOTH the first load and every reconnect (static wiring check)", () => {
  const fs = require("fs");
  const editor = fs.readFileSync(path.join(__dirname, "..", "client", "src", "components", "SmartSheets", "SmartSheetEditor.jsx"), "utf8");
  assert.ok(editor.includes('controller.synchronise("open")'));
  assert.ok(editor.includes('controller.synchronise("reconnect")'));
  assert.ok(editor.includes("controller.receive("), "live changes always go through the controller's buffer");
  assert.ok(editor.includes("onTransportFailure"), "a silent connection triggers a controlled reconnect");
  assert.ok(editor.includes("smart-sheet-stale-banner"), "an out-of-date indicator exists");
  assert.ok(editor.includes("canEditNow()"), "edits are vetoed while the sync gate is closed");
});
