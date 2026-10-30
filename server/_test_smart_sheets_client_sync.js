// Smart Sheets -- the browser-side synchronisation logic (client/src/utils/smartSheetSync.js).
// It is pure (no React, no Univer), so it is tested here directly, including a two-client
// convergence simulation. Run: node --test _test_smart_sheets_client_sync.js

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "client", "src", "utils", "smartSheetSync.js")).href);

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async (times = 8) => { for (let i = 0; i < times; i += 1) await tick(); };

test("normalizeCell keeps the full cell, drops empties and nulls, and makes nf the only number-format source", async () => {
  const { normalizeCell } = await load();
  assert.deepEqual(normalizeCell({ v: "a", t: 1 }, { bl: 1, cl: { rgb: "#000" }, extra: null }), { v: "a", t: 1, s: { bl: 1, cl: { rgb: "#000" } } });
  assert.deepEqual(normalizeCell({ v: 0, t: 2 }, null), { v: 0, t: 2 }, "zero is a real value");
  assert.deepEqual(normalizeCell({ v: false }, null), { v: false });
  assert.deepEqual(normalizeCell({ f: "=A1+1", v: 2, t: 2, si: null }, undefined), { f: "=A1+1", v: 2, t: 2 });
  assert.equal(normalizeCell({}, {}), null);
  assert.equal(normalizeCell(null, null), null);
  assert.equal(normalizeCell({ v: null, f: null }, { bl: null }), null);

  assert.deepEqual(normalizeCell({ v: 0.25, t: 2 }, { n: { pattern: "0%" } }, "0%"), { v: 0.25, t: 2, nf: "0%" }, "style.n is dropped; nf carries it");
  assert.deepEqual(normalizeCell({ v: 1, t: 2 }, null, "General"), { v: 1, t: 2 });
  assert.deepEqual(normalizeCell(null, null, "yyyy-mm-dd"), { nf: "yyyy-mm-dd" }, "a formatted empty cell is still a cell");
});

test("diffCell: what must change so that the current cell becomes exactly the wanted cell", async () => {
  const { diffCell } = await load();
  assert.equal(diffCell({ v: 1, t: 2 }, { v: 1, t: 2 }), null);
  assert.equal(diffCell(null, null), null);
  assert.equal(diffCell({ v: 1, s: { bl: 1, it: 1 } }, { s: { it: 1, bl: 1 }, v: 1 }), null, "key order is irrelevant");

  assert.deepEqual(diffCell(null, { v: "new", t: 1 }), { v: "new", t: 1 });
  assert.deepEqual(diffCell({ v: "old", t: 1 }, { v: "new", t: 1 }), { v: "new" });
  assert.deepEqual(diffCell({ v: "x", t: 1, f: "=A1" }, { v: "x", t: 1 }), { f: null }, "a removed field is explicitly nulled");
  assert.deepEqual(diffCell({ v: "x", t: 1, s: { bl: 1 } }, null), { v: null, t: null, s: null }, "clearing a cell nulls everything");
  assert.deepEqual(diffCell({ v: 1 }, { v: 0 }), { v: 0 }, "0 is a value, not 'no value'");

  // style: removed keys must be nulled, otherwise Univer keeps them
  assert.deepEqual(diffCell({ v: 1, s: { bl: 1, it: 1 } }, { v: 1, s: { it: 1 } }), { s: { it: 1, bl: null } });
  assert.deepEqual(diffCell({ v: 1 }, { v: 1, s: { bl: 1 } }), { s: { bl: 1 } });
  assert.deepEqual(diffCell({ v: 1, s: { bl: 1 } }, { v: 1 }), { s: null });
  assert.deepEqual(diffCell({ v: 1, s: { bg: { rgb: "#fff" } } }, { v: 1, s: { bg: { rgb: "#000" } } }), { s: { bg: { rgb: "#000" } } });

  // the number format never travels in the cell patch (it has its own mutation)
  assert.equal(diffCell({ v: 1, nf: "0%" }, { v: 1, nf: "0.00%" }), null);
});

test("local edits become server operations: set-range-values, with the FULL cell read back", async () => {
  const { opsFromMutation, SET_RANGE_VALUES, MAX_CELLS_PER_OPERATION } = await load();
  const store = { "0:0": { v: "Hello", t: 1, s: { bl: 1 } }, "0:1": null, "3:2": { f: "=A1", v: 5, t: 2 } };
  const io = { readCell: (ws, r, c) => (ws === "w1" ? store[`${r}:${c}`] ?? null : "WRONG SHEET") };

  const ops = opsFromMutation(SET_RANGE_VALUES, { unitId: "u", subUnitId: "w1", cellValue: { 0: { 0: { v: "x" }, 1: { v: null } }, 3: { 2: { f: "=A1" } } } }, io);
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0], { type: "cells", ws: "w1", cells: [
    { r: 0, c: 0, cell: { v: "Hello", t: 1, s: { bl: 1 } } },
    { r: 0, c: 1, cell: null },
    { r: 3, c: 2, cell: { f: "=A1", v: 5, t: 2 } },
  ] });

  // large pastes are split into server-sized operations
  const big = {};
  for (let r = 0; r < 120; r += 1) { big[r] = {}; for (let c = 0; c < 60; c += 1) big[r][c] = { v: r * c }; }
  const chunks = opsFromMutation(SET_RANGE_VALUES, { subUnitId: "w1", cellValue: big }, { readCell: () => ({ v: 1 }) });
  assert.equal(chunks.length, Math.ceil((120 * 60) / MAX_CELLS_PER_OPERATION));
  assert.ok(chunks.every((op) => op.cells.length <= MAX_CELLS_PER_OPERATION));
  assert.equal(chunks.reduce((n, op) => n + op.cells.length, 0), 7200);

  for (const junk of [null, undefined, "x", {}, { subUnitId: "w1" }, { subUnitId: "w1", cellValue: null }, { cellValue: { 0: { 0: {} } } }]) {
    assert.deepEqual(opsFromMutation(SET_RANGE_VALUES, junk, io), [], JSON.stringify(junk));
  }
  assert.deepEqual(opsFromMutation("sheet.mutation.set-selections", { subUnitId: "w1" }, io), [], "view-only mutations are ignored");
});

test("tabs, column widths and row heights become operations", async () => {
  const { opsFromMutation, INSERT_SHEET, SET_WORKSHEET_NAME, SET_COL_WIDTH, SET_ROW_HEIGHT } = await load();
  const io = { readCell: () => null };

  assert.deepEqual(opsFromMutation(INSERT_SHEET, { unitId: "u", index: 2, sheet: { id: "newTab", name: "Sheet3", rowCount: 1000 } }, io), [{ type: "addWorksheet", ws: "newTab", name: "Sheet3", index: 2 }]);
  assert.deepEqual(opsFromMutation(INSERT_SHEET, { sheet: { id: "t", name: "N" } }, io), [{ type: "addWorksheet", ws: "t", name: "N", index: undefined }]);
  assert.deepEqual(opsFromMutation(INSERT_SHEET, { sheet: { name: "no id" } }, io), []);
  assert.deepEqual(opsFromMutation(SET_WORKSHEET_NAME, { unitId: "u", subUnitId: "w1", name: "Forecast" }, io), [{ type: "renameWorksheet", ws: "w1", name: "Forecast" }]);
  assert.deepEqual(opsFromMutation(SET_WORKSHEET_NAME, { subUnitId: "w1" }, io), []);

  assert.deepEqual(opsFromMutation(SET_COL_WIDTH, { subUnitId: "w1", ranges: [{ startColumn: 2, endColumn: 3, startRow: 0, endRow: 0 }], colWidth: 150 }, io), [{ type: "layout", ws: "w1", columnWidths: { 2: 150, 3: 150 }, rowHeights: {} }]);
  assert.deepEqual(opsFromMutation(SET_COL_WIDTH, { subUnitId: "w1", ranges: [{ startColumn: 0, endColumn: 1 }, { startColumn: 5, endColumn: 5 }], colWidth: [100, 120.4, 90] }, io)[0].columnWidths, { 0: 100, 1: 120, 5: 90 }, "per-column arrays, rounded");
  assert.deepEqual(opsFromMutation(SET_ROW_HEIGHT, { subUnitId: "w1", ranges: [{ startRow: 4, endRow: 4 }], rowHeight: 60 }, io), [{ type: "layout", ws: "w1", columnWidths: {}, rowHeights: { 4: 60 } }]);
  assert.deepEqual(opsFromMutation(SET_ROW_HEIGHT, { subUnitId: "w1", ranges: [{ startRow: "x" }], rowHeight: 60 }, io), []);
});

test("number-format changes become cell operations (the pattern rides on the cell as nf)", async () => {
  const { opsFromMutation, SET_NUMFMT, REMOVE_NUMFMT, MAX_NUMFMT_CELLS } = await load();
  const reads = [];
  const io = { readCell: (ws, r, c) => { reads.push(`${ws}:${r}:${c}`); return { v: 1, t: 2, nf: "0.00%" }; } };

  const set = opsFromMutation(SET_NUMFMT, { unitId: "u", subUnitId: "w1", values: { a: { ranges: [{ startRow: 1, endRow: 2, startColumn: 0, endColumn: 1 }] } }, refMap: { a: { pattern: "0.00%" } } }, io);
  assert.equal(set.length, 1);
  assert.deepEqual(set[0].cells.map((e) => [e.r, e.c]), [[1, 0], [1, 1], [2, 0], [2, 1]]);
  assert.deepEqual(set[0].cells[0].cell, { v: 1, t: 2, nf: "0.00%" });

  // overlapping ranges read each cell once
  reads.length = 0;
  opsFromMutation(SET_NUMFMT, { subUnitId: "w1", values: { a: { ranges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 0 }] }, b: { ranges: [{ startRow: 1, endRow: 2, startColumn: 0, endColumn: 0 }] } } }, io);
  assert.deepEqual(reads, ["w1:0:0", "w1:1:0", "w1:2:0"]);

  const removed = opsFromMutation(REMOVE_NUMFMT, { unitId: "u", subUnitId: "w1", ranges: [{ startRow: 5, endRow: 5, startColumn: 2, endColumn: 3 }] }, { readCell: () => ({ v: 1 }) });
  assert.deepEqual(removed[0].cells, [{ r: 5, c: 2, cell: { v: 1 } }, { r: 5, c: 3, cell: { v: 1 } }]);

  // an absurd range is bounded rather than flooding the server
  const huge = opsFromMutation(SET_NUMFMT, { subUnitId: "w1", values: { a: { ranges: [{ startRow: 0, endRow: 99999, startColumn: 0, endColumn: 99 }] } } }, { readCell: () => null });
  assert.equal(huge.reduce((n, op) => n + op.cells.length, 0), MAX_NUMFMT_CELLS);
  assert.deepEqual(opsFromMutation(SET_NUMFMT, { values: { a: { ranges: [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }] } } }, io), [], "no worksheet id");
});

function context(overrides = {}) {
  const cells = overrides.cells || {};
  const sheets = new Set(overrides.sheets || ["w1"]);
  const pending = new Set(overrides.pending || []);
  return {
    unitId: "u",
    readCell: (ws, r, c) => cells[`${ws}:${r}:${c}`] ?? null,
    hasWorksheet: (ws) => sheets.has(ws),
    worksheetCount: () => sheets.size,
    getWorksheetName: (ws) => (overrides.names || {})[ws] ?? null,
    isPending: (ws, r, c) => pending.has(`${ws}:${r}:${c}`),
  };
}

test("remote operations become Univer mutations that turn the local cell into exactly the saved cell", async () => {
  const { mutationsFromRemoteOp, SET_RANGE_VALUES, SET_NUMFMT, REMOVE_NUMFMT } = await load();

  const same = mutationsFromRemoteOp({ type: "cells", ws: "w1", cells: [{ r: 0, c: 0, cell: { v: "a", t: 1 } }] }, context({ cells: { "w1:0:0": { v: "a", t: 1 } } }));
  assert.deepEqual(same, [], "an identical cell causes no work and no echo");

  const changed = mutationsFromRemoteOp(
    { type: "cells", ws: "w1", cells: [{ r: 0, c: 0, cell: { v: "new", t: 1 } }, { r: 1, c: 1, cell: null }] },
    context({ cells: { "w1:0:0": { v: "old", t: 1 }, "w1:1:1": { v: "gone", t: 1, s: { bl: 1 } } } })
  );
  assert.deepEqual(changed, [{ id: SET_RANGE_VALUES, params: { unitId: "u", subUnitId: "w1", cellValue: { 0: { 0: { v: "new" } }, 1: { 1: { v: null, t: null, s: null } } } } }]);

  // number formats use their own mutations, after the values
  const formats = mutationsFromRemoteOp(
    { type: "cells", ws: "w1", cells: [{ r: 0, c: 0, cell: { v: 1, nf: "0.00%" } }, { r: 0, c: 1, cell: { v: 2, nf: "0.00%" } }, { r: 0, c: 2, cell: { v: 3 } }, { r: 0, c: 3, cell: { v: 4, nf: "$#,##0" } }] },
    context({ cells: { "w1:0:0": { v: 1 }, "w1:0:1": { v: 2 }, "w1:0:2": { v: 3, nf: "0%" }, "w1:0:3": { v: 4 } } })
  );
  assert.deepEqual(formats.map((m) => m.id), [REMOVE_NUMFMT, SET_NUMFMT]);
  assert.deepEqual(formats[0].params.ranges, [{ startRow: 0, endRow: 0, startColumn: 2, endColumn: 2 }]);
  const refMap = formats[1].params.refMap;
  const patterns = Object.fromEntries(Object.entries(refMap).map(([id, v]) => [v.pattern, formats[1].params.values[id].ranges.map((r) => r.startColumn)]));
  assert.deepEqual(patterns, { "0.00%": [0, 1], "$#,##0": [3] });

  // a cell this client has an unsaved edit for is left alone
  const pendingSkip = mutationsFromRemoteOp(
    { type: "cells", ws: "w1", cells: [{ r: 0, c: 0, cell: { v: "theirs" } }, { r: 0, c: 1, cell: { v: "theirs too" } }] },
    context({ pending: ["w1:0:0"], cells: { "w1:0:0": { v: "mine" } } })
  );
  assert.deepEqual(pendingSkip[0].params.cellValue, { 0: { 1: { v: "theirs too" } } });

  assert.deepEqual(mutationsFromRemoteOp({ type: "cells", ws: "nope", cells: [{ r: 0, c: 0, cell: { v: 1 } }] }, context()), [], "unknown worksheet");
  assert.deepEqual(mutationsFromRemoteOp(null, context()), []);
  assert.deepEqual(mutationsFromRemoteOp({ type: "mystery" }, context()), []);
});

test("remote tabs and layout: add (complete worksheet object), rename, widths, heights", async () => {
  const { mutationsFromRemoteOp, buildWorksheetData, INSERT_SHEET, SET_WORKSHEET_NAME, SET_COL_WIDTH, SET_ROW_HEIGHT, DEFAULT_ROWS, DEFAULT_COLUMNS } = await load();

  assert.deepEqual(mutationsFromRemoteOp({ type: "addWorksheet", ws: "w1", name: "Dup" }, context()), [], "already there");
  const add = mutationsFromRemoteOp({ type: "addWorksheet", ws: "w2", name: "Sheet2", index: 5 }, context());
  assert.equal(add[0].id, INSERT_SHEET);
  assert.equal(add[0].params.index, 1, "an out-of-range index is clamped to the end");
  const sheet = add[0].params.sheet;
  assert.deepEqual({ id: sheet.id, name: sheet.name, rows: sheet.rowCount, cols: sheet.columnCount }, { id: "w2", name: "Sheet2", rows: DEFAULT_ROWS, cols: DEFAULT_COLUMNS });
  assert.deepEqual(sheet.freeze, { xSplit: 0, ySplit: 0, startRow: -1, startColumn: -1 }, "Univer's insert-sheet needs every field, e.g. freeze");
  assert.deepEqual(buildWorksheetData("a", "B").cellData, {});
  assert.equal(mutationsFromRemoteOp({ type: "addWorksheet", ws: "w2", name: "S" }, context())[0].params.index, 1, "no index -> appended");

  assert.deepEqual(mutationsFromRemoteOp({ type: "renameWorksheet", ws: "w1", name: "Q3" }, context({ names: { w1: "Sheet1" } })), [{ id: SET_WORKSHEET_NAME, params: { unitId: "u", subUnitId: "w1", name: "Q3" } }]);
  assert.deepEqual(mutationsFromRemoteOp({ type: "renameWorksheet", ws: "w1", name: "Same" }, context({ names: { w1: "Same" } })), []);
  assert.deepEqual(mutationsFromRemoteOp({ type: "renameWorksheet", ws: "gone", name: "X" }, context()), []);

  const layout = mutationsFromRemoteOp({ type: "layout", ws: "w1", columnWidths: { 2: 180, 3: null }, rowHeights: { 7: 45 } }, context());
  assert.deepEqual(layout.map((m) => m.id), [SET_COL_WIDTH, SET_ROW_HEIGHT]);
  assert.deepEqual(layout[0].params.ranges, [{ startRow: 0, endRow: 0, startColumn: 2, endColumn: 2 }]);
  assert.equal(layout[0].params.colWidth, 180);
  assert.equal(layout[1].params.rowHeight, 45);
});

test("a saved workbook's number formats are handed to Univer in compact ranges", async () => {
  const { numfmtMutationsForWorkbook, SET_NUMFMT } = await load();
  const workbook = {
    sheetOrder: ["a", "b", "c"],
    sheets: {
      a: { cellData: { 0: { 0: { nf: "0%" }, 1: { nf: "0%" }, 2: { nf: "0%" }, 4: { nf: "0%" } }, 1: { 0: { nf: "0%" }, 1: { v: 1 }, 2: { nf: "yyyy-mm-dd" } } } },
      b: { cellData: { 0: { 0: { v: "no format" } } } },
      c: {},
    },
  };
  const mutations = numfmtMutationsForWorkbook(workbook, "u");
  assert.equal(mutations.length, 1, "only the worksheet that has formats");
  assert.equal(mutations[0].id, SET_NUMFMT);
  assert.equal(mutations[0].params.subUnitId, "a");
  const byPattern = Object.fromEntries(Object.entries(mutations[0].params.refMap).map(([id, v]) => [v.pattern, mutations[0].params.values[id].ranges]));
  assert.deepEqual(byPattern["0%"], [
    { startRow: 0, endRow: 0, startColumn: 0, endColumn: 2 }, // a run of three neighbours is one range
    { startRow: 0, endRow: 0, startColumn: 4, endColumn: 4 },
    { startRow: 1, endRow: 1, startColumn: 0, endColumn: 0 },
  ]);
  assert.deepEqual(byPattern["yyyy-mm-dd"], [{ startRow: 1, endRow: 1, startColumn: 2, endColumn: 2 }]);
  assert.deepEqual(numfmtMutationsForWorkbook({ sheetOrder: [], sheets: {} }, "u"), []);
});

test("structural edits that are not synchronised are vetoed; everything that is synchronised is allowed", async () => {
  const { isBlockedCommand, BLOCKED_MESSAGE, SHARED_DATA_MUTATIONS } = await load();
  const blocked = [
    "sheet.command.insert-row", "sheet.command.insert-col", "sheet.command.insert-row-before", "sheet.command.insert-row-after", "sheet.command.insert-col-before", "sheet.command.insert-col-after",
    "sheet.command.insert-row-by-range", "sheet.command.insert-col-by-range", "sheet.command.insert-multi-rows-above", "sheet.command.insert-multi-rows-after", "sheet.command.insert-multi-cols-before", "sheet.command.insert-multi-cols-right",
    "sheet.command.insert-range-move-down", "sheet.command.insert-range-move-down-confirm", "sheet.command.insert-range-move-right", "sheet.command.insert-range-move-right-confirm",
    "sheet.command.remove-row", "sheet.command.remove-col", "sheet.command.remove-row-confirm", "sheet.command.remove-col-confirm", "sheet.command.remove-row-by-range", "sheet.command.remove-col-by-range",
    "sheet.command.delete-range-move-left", "sheet.command.delete-range-move-up", "sheet.command.delete-range-move-left-confirm", "sheet.command.delete-range-move-up-confirm",
    "sheet.command.move-rows", "sheet.command.move-cols", "sheet.command.move-range", "sheet.command.move-range-confirm",
    "sheet.command.add-worksheet-merge", "sheet.command.add-worksheet-merge-all", "sheet.command.add-worksheet-merge-horizontal", "sheet.command.add-worksheet-merge-vertical", "sheet.command.remove-worksheet-merge",
    "sheet.command.remove-sheet", "sheet.command.remove-sheet-confirm", "sheet.command.copy-sheet", "sheet.command.set-worksheet-order", "sheet.command.reorder-range",
    "sheet.command.hide-row-confirm", "sheet.command.hide-col-confirm", "sheet.command.set-tab-color", "sheet.command.insert-defined-name", "sheet.command.remove-defined-name",
  ];
  for (const id of blocked) assert.equal(isBlockedCommand(id), true, id);

  const allowed = [
    "sheet.command.set-range-values", "sheet.command.set-style", "sheet.command.clear-selection-content", "sheet.command.clear-selection-all", "sheet.command.clear-selection-format",
    "sheet.command.paste", "sheet.command.paste-value", "sheet.command.paste-format", "sheet.command.cut", "sheet.command.auto-fill", "sheet.command.refill",
    "sheet.command.insert-sheet", "sheet.command.set-worksheet-name", "sheet.command.set-worksheet-col-width", "sheet.command.set-row-height", "sheet.command.delta-row-height",
    "sheet.command.set-border", "sheet.command.set-border-basic", "sheet.command.numfmt.set.numfmt", "sheet.command.move-selection", "sheet.command.set-frozen", "sheet.command.set-selection-frozen",
    "sheet.mutation.set-range-values", "sheet.operation.set-selections", "univer.command.undo", "univer.command.redo", "doc.command.insert-text",
  ];
  for (const id of allowed) assert.equal(isBlockedCommand(id), false, id);
  assert.equal(isBlockedCommand(undefined), false);
  assert.equal(isBlockedCommand(5), false);
  assert.match(BLOCKED_MESSAGE, /isn't available in shared spreadsheets yet/);

  assert.deepEqual([...SHARED_DATA_MUTATIONS].sort(), [
    "sheet.mutation.insert-sheet", "sheet.mutation.remove.numfmt", "sheet.mutation.set-range-values", "sheet.mutation.set-worksheet-col-width",
    "sheet.mutation.set-worksheet-name", "sheet.mutation.set-worksheet-row-height", "sheet.mutation.set.numfmt",
  ]);
});

// ---------------------------------------------------------------- the save queue

function makeQueue(QueueFactory, behaviour = {}) {
  const sent = [];
  const statuses = [];
  const rejected = [];
  const rejoins = [];
  const queue = QueueFactory({
    send: async (op) => {
      sent.push(op);
      if (behaviour.delayMs) await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
      return behaviour.answer ? behaviour.answer(op, sent.length) : { ok: true, revision: sent.length };
    },
    onStatus: (state, details) => statuses.push([state, details.pendingOperations]),
    onRejected: (op, error) => rejected.push([op, error]),
    onNeedsRejoin: () => rejoins.push(true),
    retryDelaysMs: [1, 1, 1],
    wait: () => Promise.resolve(),
  });
  return { queue, sent, statuses, rejected, rejoins };
}

const cellsOp = (r, c, v) => ({ type: "cells", ws: "w1", cells: [{ r, c, cell: { v } }] });

test("save queue: strictly in order, one at a time, status goes connecting -> saving -> saved", async () => {
  const { createSaveQueue } = await load();
  const { queue, sent, statuses } = makeQueue(createSaveQueue, { delayMs: 5 });
  assert.equal(queue.status, "connecting");

  queue.setConnected(true);
  assert.equal(queue.status, "saved");
  queue.enqueue(cellsOp(0, 0, "a"));
  queue.enqueue(cellsOp(0, 1, "b"));
  queue.enqueue(cellsOp(0, 2, "c"));
  assert.equal(queue.status, "saving");
  assert.equal(queue.size, 3);

  await queue.whenDrained();
  assert.deepEqual(sent.map((op) => op.cells[0].cell.v), ["a", "b", "c"], "sent in the order they were made");
  assert.equal(queue.status, "saved");
  assert.equal(queue.size, 0);
  assert.deepEqual([...new Set(statuses.map((s) => s[0]))], ["connecting", "saved", "saving"].filter((s) => statuses.some((x) => x[0] === s)));
  assert.equal(statuses[statuses.length - 1][0], "saved");
  await queue.whenDrained(); // resolves immediately when empty
});

test("save queue: 'Saved' is only claimed after the server acknowledged; a pending cell is tracked until then", async () => {
  const { createSaveQueue } = await load();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { queue } = makeQueue(createSaveQueue, { answer: async () => { await gate; return { ok: true }; } });
  queue.setConnected(true);

  queue.enqueue(cellsOp(2, 3, "unsaved"));
  await settle();
  assert.equal(queue.status, "saving", "still waiting for the server");
  assert.equal(queue.isPending("w1", 2, 3), true, "a remote update must not overwrite this cell yet");
  assert.equal(queue.isPending("w1", 0, 0), false);
  assert.equal(queue.isPending("other", 2, 3), false);

  release();
  await queue.whenDrained();
  assert.equal(queue.status, "saved");
  assert.equal(queue.isPending("w1", 2, 3), false);
});

test("save queue: offline edits are kept and sent, in order, when the connection returns", async () => {
  const { createSaveQueue } = await load();
  const { queue, sent } = makeQueue(createSaveQueue);
  queue.setConnected(true);
  queue.setConnected(false);
  assert.equal(queue.status, "offline");

  queue.enqueue(cellsOp(0, 0, "offline 1"));
  queue.enqueue(cellsOp(0, 1, "offline 2"));
  await settle();
  assert.equal(sent.length, 0, "nothing is sent while offline");
  assert.equal(queue.size, 2);
  assert.equal(queue.isPending("w1", 0, 0), true);
  assert.equal(queue.status, "offline");

  queue.setConnected(true);
  await queue.whenDrained();
  assert.deepEqual(sent.map((op) => op.cells[0].cell.v), ["offline 1", "offline 2"]);
  assert.equal(queue.status, "saved");
});

test("save queue: a connection that drops mid-send keeps the operation for the retry", async () => {
  const { createSaveQueue } = await load();
  let attempts = 0;
  const sent = [];
  let queue;
  queue = createSaveQueue({
    send: async (op) => {
      attempts += 1;
      sent.push(op);
      if (attempts === 1) {
        queue.setConnected(false); // the socket dies while the request is in flight
        throw new Error("timeout");
      }
      return { ok: true };
    },
    retryDelaysMs: [1],
    wait: () => Promise.resolve(),
  });
  queue.setConnected(true);
  queue.enqueue(cellsOp(1, 1, "in flight"));
  await settle();
  assert.equal(queue.size, 1, "not lost");
  assert.equal(queue.status, "offline");
  queue.setConnected(true);
  await queue.whenDrained();
  assert.equal(queue.size, 0);
  assert.equal(sent.length, 2, "the same operation was resent");
  assert.deepEqual(sent[0], sent[1]);
});

test("save queue: transient server errors are retried a few times, then reported", async () => {
  const { createSaveQueue } = await load();

  const flaky = makeQueue(createSaveQueue, { answer: (op, n) => (n < 3 ? { ok: false, code: "SERVER_ERROR", message: "temporary" } : { ok: true }) });
  flaky.queue.setConnected(true);
  flaky.queue.enqueue(cellsOp(0, 0, "retry me"));
  await flaky.queue.whenDrained();
  assert.equal(flaky.sent.length, 3);
  assert.equal(flaky.rejected.length, 0);
  assert.equal(flaky.queue.status, "saved");

  const broken = makeQueue(createSaveQueue, { answer: () => ({ ok: false, code: "SERVER_ERROR", message: "still down" }) });
  broken.queue.setConnected(true);
  broken.queue.enqueue(cellsOp(0, 0, "never works"));
  broken.queue.enqueue(cellsOp(0, 1, "behind it"));
  await settle(30);
  assert.equal(broken.sent.filter((op) => op.cells[0].c === 0).length, 4, "1 try + 3 retries, then give up");
  assert.equal(broken.rejected[0][1].code, "SERVER_ERROR");
  assert.equal(broken.queue.isPending("w1", 0, 0), false, "a given-up cell is released");
});

test("save queue: a refused change is dropped, reported, shown as 'Not saved', and does not block the next one", async () => {
  const { createSaveQueue } = await load();
  const { queue, sent, rejected } = makeQueue(createSaveQueue, {
    answer: (op) => (op.cells[0].cell.v === "bad" ? { ok: false, code: "INVALID_CELL", message: "A formula is not valid." } : { ok: true }),
  });
  queue.setConnected(true);
  queue.enqueue(cellsOp(0, 0, "bad"));
  queue.enqueue(cellsOp(0, 1, "good"));
  await queue.whenDrained();

  assert.equal(sent.length, 2, "validation errors are NOT retried");
  assert.deepEqual(rejected.map(([op, error]) => [op.cells[0].cell.v, error.code, error.message]), [["bad", "INVALID_CELL", "A formula is not valid."]]);
  assert.equal(queue.size, 0);
  assert.equal(queue.status, "saved", "the later good change cleared the error");

  // an error with nothing after it stays visible until acknowledged
  const lone = makeQueue(createSaveQueue, { answer: () => ({ ok: false, code: "READ_ONLY", message: "view only" }) });
  lone.queue.setConnected(true);
  lone.queue.enqueue(cellsOp(0, 0, "x"));
  await lone.queue.whenDrained();
  assert.equal(lone.queue.status, "error");
  lone.queue.clearError();
  assert.equal(lone.queue.status, "saved");
});

test("save queue: NOT_JOINED asks the editor to rejoin and keeps the change", async () => {
  const { createSaveQueue } = await load();
  let joined = false;
  const { queue, sent, rejoins } = makeQueue(createSaveQueue, { answer: () => (joined ? { ok: true } : { ok: false, code: "NOT_JOINED" }) });
  queue.setConnected(true);
  queue.enqueue(cellsOp(0, 0, "x"));
  await settle();
  assert.equal(rejoins.length, 1);
  assert.equal(queue.size, 1, "kept");
  joined = true;
  queue.resume();
  await queue.whenDrained();
  assert.equal(sent.length, 2);
  assert.equal(queue.size, 0);
});

test("save queue: worksheet and layout operations are queued like cells", async () => {
  const { createSaveQueue } = await load();
  const { queue, sent } = makeQueue(createSaveQueue);
  queue.setConnected(true);
  queue.enqueue({ type: "addWorksheet", ws: "w2", name: "Two" });
  queue.enqueue({ type: "renameWorksheet", ws: "w2", name: "Deux" });
  queue.enqueue({ type: "layout", ws: "w2", columnWidths: { 0: 120 }, rowHeights: {} });
  await queue.whenDrained();
  assert.deepEqual(sent.map((op) => op.type), ["addWorksheet", "renameWorksheet", "layout"]);
});

// ---------------------------------------------------------------- convergence

// A tiny model of how Univer applies a set-range-values patch (verified in a real browser):
// null removes a field (also inside a style), anything else sets it, absent fields are untouched.
function applyPatch(model, key, patch) {
  const cell = { ...(model.get(key) || {}) };
  for (const [field, value] of Object.entries(patch)) {
    if (field === "s") {
      if (value === null) { delete cell.s; continue; }
      const style = { ...(cell.s || {}) };
      for (const [k, v] of Object.entries(value)) { if (v === null) delete style[k]; else style[k] = v; }
      if (Object.keys(style).length) cell.s = style; else delete cell.s;
    } else if (value === null) delete cell[field]; else cell[field] = value;
  }
  if (Object.keys(cell).length) model.set(key, cell); else model.delete(key);
}

test("CONVERGENCE: two clients and a server that orders writes end up with identical sheets", async () => {
  const { mutationsFromRemoteOp, createSaveQueue, SET_RANGE_VALUES } = await load();

  // the "database": applies whole-cell writes in the order they arrive, then broadcasts to everyone else
  const db = new Map();
  const clients = [];
  let revision = 0;
  const broadcast = (from, op) => clients.forEach((client) => { if (client !== from) client.receive(op); });
  const server = async (from, op) => {
    await tick(); // network latency
    revision += 1;
    for (const { r, c, cell } of op.cells) { if (cell === null) db.delete(`${r}:${c}`); else db.set(`${r}:${c}`, JSON.parse(JSON.stringify(cell))); }
    broadcast(from, op);
    return { ok: true, revision };
  };

  const makeClient = (name) => {
    const model = new Map();
    const client = { name, model };
    client.queue = createSaveQueue({ send: (op) => server(client, op), retryDelaysMs: [], wait: () => Promise.resolve() });
    client.queue.setConnected(true);
    client.edit = (r, c, cell) => { // a local edit: applied immediately, queued for saving
      if (cell === null) model.delete(`${r}:${c}`); else model.set(`${r}:${c}`, JSON.parse(JSON.stringify(cell)));
      client.queue.enqueue({ type: "cells", ws: "w1", cells: [{ r, c, cell }] });
    };
    client.receive = (op) => {
      const mutations = mutationsFromRemoteOp(op, {
        unitId: "u",
        readCell: (ws, r, c) => model.get(`${r}:${c}`) || null,
        hasWorksheet: () => true, worksheetCount: () => 1, getWorksheetName: () => "x",
        isPending: (ws, r, c) => client.queue.isPending(ws, r, c),
      });
      for (const m of mutations) {
        assert.equal(m.id, SET_RANGE_VALUES);
        for (const [r, columns] of Object.entries(m.params.cellValue)) for (const [c, patch] of Object.entries(columns)) applyPatch(model, `${r}:${c}`, patch);
      }
    };
    clients.push(client);
    return client;
  };

  const alice = makeClient("alice");
  const bob = makeClient("bob");

  // 1. same cell, same instant, different values and different formatting
  alice.edit(0, 0, { v: "ALICE", t: 1, s: { bl: 1 } });
  bob.edit(0, 0, { v: "BOB", t: 1, s: { it: 1, bg: { rgb: "#ff0" } } });
  // 2. different cells at the same time
  alice.edit(1, 0, { v: 10, t: 2 });
  bob.edit(1, 1, { v: 20, t: 2 });
  // 3. one clears what the other just wrote nearby
  alice.edit(2, 2, { v: "temp", t: 1 });
  await alice.queue.whenDrained();
  bob.edit(2, 2, null);
  await Promise.all([alice.queue.whenDrained(), bob.queue.whenDrained()]);
  await settle(20);

  const snapshot = (model) => JSON.stringify([...model.entries()].sort(([a], [b]) => a.localeCompare(b)));
  assert.equal(snapshot(alice.model), snapshot(bob.model), "both screens are identical");
  assert.equal(snapshot(alice.model), snapshot(db), "and identical to what is saved");
  assert.deepEqual(db.get("1:0"), { v: 10, t: 2 });
  assert.deepEqual(db.get("1:1"), { v: 20, t: 2 });
  assert.equal(db.has("2:2"), false);
  // whichever write the server applied last owns the WHOLE cell, formatting included -- no mixed state
  const winner = db.get("0:0");
  assert.ok(winner.v === "ALICE" ? winner.s.bl === 1 && !winner.s.it : winner.s.it === 1 && !winner.s.bl, JSON.stringify(winner));
});

test("CONVERGENCE: a burst of random concurrent edits always converges", async () => {
  const { mutationsFromRemoteOp, createSaveQueue } = await load();
  let seed = 1234567;
  const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

  for (let round = 0; round < 25; round += 1) {
    const db = new Map();
    const clients = [];
    const server = async (from, op) => {
      await new Promise((resolve) => setTimeout(resolve, Math.floor(random() * 3)));
      for (const { r, c, cell } of op.cells) { if (cell === null) db.delete(`${r}:${c}`); else db.set(`${r}:${c}`, cell); }
      clients.forEach((client) => { if (client !== from) client.receive(op); });
      return { ok: true };
    };
    const make = () => {
      const model = new Map();
      const client = { model, queue: null };
      client.queue = createSaveQueue({ send: (op) => server(client, op), retryDelaysMs: [], wait: () => Promise.resolve() });
      client.queue.setConnected(true);
      client.edit = (r, c, cell) => { if (cell === null) model.delete(`${r}:${c}`); else model.set(`${r}:${c}`, cell); client.queue.enqueue({ type: "cells", ws: "w1", cells: [{ r, c, cell }] }); };
      client.receive = (op) => {
        for (const m of mutationsFromRemoteOp(op, { unitId: "u", readCell: (ws, r, c) => model.get(`${r}:${c}`) || null, hasWorksheet: () => true, worksheetCount: () => 1, getWorksheetName: () => "x", isPending: (ws, r, c) => client.queue.isPending(ws, r, c) })) {
          for (const [r, columns] of Object.entries(m.params.cellValue)) for (const [c, patch] of Object.entries(columns)) applyPatch(model, `${r}:${c}`, patch);
        }
      };
      clients.push(client);
      return client;
    };
    const [a, b, c] = [make(), make(), make()];
    const actors = [a, b, c];
    for (let i = 0; i < 24; i += 1) {
      const actor = actors[Math.floor(random() * 3)];
      const cell = random() < 0.2 ? null : { v: `r${round}-${i}`, t: 1, ...(random() < 0.4 ? { s: { bl: 1 } } : {}) };
      actor.edit(Math.floor(random() * 3), Math.floor(random() * 3), cell); // a tiny grid, so collisions are constant
      if (random() < 0.3) await tick();
    }
    await Promise.all(actors.map((client) => client.queue.whenDrained()));
    await settle(30);
    const snap = (model) => JSON.stringify([...model.entries()].sort(([x], [y]) => x.localeCompare(y)));
    assert.equal(snap(a.model), snap(db), `round ${round}: client a diverged from the database`);
    assert.equal(snap(b.model), snap(db), `round ${round}: client b diverged from the database`);
    assert.equal(snap(c.model), snap(db), `round ${round}: client c diverged from the database`);
  }
});

test("presentation helpers", async () => {
  const { collaboratorInitials, collaboratorColor, SAVE_STATUS_LABELS } = await load();
  assert.equal(collaboratorInitials("Alice Rao"), "AR");
  assert.equal(collaboratorInitials("  madonna "), "MA");
  assert.equal(collaboratorInitials("Jean Claude Van Damme"), "JD");
  assert.equal(collaboratorInitials(""), "?");
  assert.equal(collaboratorInitials(null), "?");
  assert.equal(collaboratorColor(3), collaboratorColor(3), "stable per person");
  assert.match(collaboratorColor(1), /^#[0-9a-f]{6}$/);
  assert.match(collaboratorColor(undefined), /^#[0-9a-f]{6}$/);
  for (const state of ["connecting", "saving", "saved", "offline", "error"]) assert.ok(SAVE_STATUS_LABELS[state], state);
  assert.equal(SAVE_STATUS_LABELS.saved, "Saved");
  assert.equal(SAVE_STATUS_LABELS.saving, "Saving…");
});
