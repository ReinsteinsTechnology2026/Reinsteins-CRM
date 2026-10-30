// ==========================================
// SMART SHEETS -- SYNC LOGIC (pure; no React, no Univer imports)
//
// Everything that decides WHAT is sent to / applied from the server lives here, so it can be tested
// without a browser. The editor component (components/SmartSheets/SmartSheetEditor.jsx) only
// connects these functions to Univer's public API and to Socket.IO.
//
// The model is deliberately simple (no CRDT/OT):
//   * Every local edit becomes a small "operation": the FULL new value of each changed cell
//     (value, formula, style), or a worksheet add / rename, or a column-width / row-height change.
//   * The server persists the operation, THEN broadcasts it. Other clients apply it.
//   * If two people change the same cell at nearly the same moment, the server orders them; the
//     one it processes last wins, and every client ends up with that value (last write wins,
//     whole cell). A client never overwrites a cell it still has an unsaved local edit for
//     (isPending) -- the server's later ordering will decide, and the winner's value is then
//     announced to everyone.
//
// What is synchronised: cell values, formulas, cell formatting, worksheet tabs (add, rename),
// column widths, row heights. NOT synchronised (blocked in the editor, see isBlockedCommand):
// inserting/deleting/moving rows and columns, merging cells, deleting/reordering/copying tabs.
// ==========================================

export const SET_RANGE_VALUES = "sheet.mutation.set-range-values";
export const INSERT_SHEET = "sheet.mutation.insert-sheet";
export const SET_WORKSHEET_NAME = "sheet.mutation.set-worksheet-name";
export const SET_COL_WIDTH = "sheet.mutation.set-worksheet-col-width";
export const SET_ROW_HEIGHT = "sheet.mutation.set-worksheet-row-height";
// Number formats (currency, percent, dates, ...) live in their own model in Univer, not in cell data,
// so they have their own mutations. They are carried as the cell field "nf" (the pattern string).
export const SET_NUMFMT = "sheet.mutation.set.numfmt";
export const REMOVE_NUMFMT = "sheet.mutation.remove.numfmt";

// Mirrors server/utils/smartSheetValidation.js LIMITS (the server is the authority).
export const MAX_CELLS_PER_OPERATION = 5000;
export const MAX_LAYOUT_ENTRIES_PER_OPERATION = 1000;
// A number-format change over a huge range is cut off here rather than flooding the server.
export const MAX_NUMFMT_CELLS = 50000;
export const DEFAULT_ROWS = 1000;
export const DEFAULT_COLUMNS = 26;

const CELL_FIELDS = ["v", "t", "f", "si", "p"];

// A complete worksheet definition for Univer's insert-sheet mutation. (createWorkbook fills these
// defaults in itself, but the mutation clones the object as given and needs every field: a partial
// object fails inside Univer with "Cannot read properties of undefined (reading 'xSplit')".)
export function buildWorksheetData(id, name) {
  return {
    id,
    name,
    tabColor: "",
    hidden: 0,
    rowCount: DEFAULT_ROWS,
    columnCount: DEFAULT_COLUMNS,
    zoomRatio: 1,
    scrollTop: 0,
    scrollLeft: 0,
    defaultColumnWidth: 88,
    defaultRowHeight: 24,
    showGridlines: 1,
    rightToLeft: 0,
    freeze: { xSplit: 0, ySplit: 0, startRow: -1, startColumn: -1 },
    mergeData: [],
    cellData: {},
    rowData: {},
    columnData: {},
    rowHeader: { width: 46, hidden: 0 },
    columnHeader: { height: 20, hidden: 0 },
  };
}

// ---------- small helpers ----------

export function pruneNulls(value) {
  if (Array.isArray(value)) return value.map(pruneNulls);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child === null || child === undefined) continue;
      out[key] = pruneNulls(child);
    }
    return out;
  }
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export const deepEqual = (a, b) => stable(a) === stable(b);

export const cellKey = (worksheetKey, row, column) => `${worksheetKey}:${row}:${column}`;

const isDefaultNumberFormat = (pattern) => !pattern || String(pattern).toLowerCase() === "general";

// The FULL cell as the editor holds it: value, type, formula, rich text + the RESOLVED style +
// number format. (Univer keeps styles in a shared table and refers to them by id, and number formats
// in a separate model; the server stores both inline on the cell.)
export function normalizeCell(cellData, styleData, numberFormat) {
  const cell = {};
  for (const field of CELL_FIELDS) {
    const value = cellData ? cellData[field] : undefined;
    if (value !== undefined && value !== null) cell[field] = pruneNulls(value);
  }
  const style = styleData ? pruneNulls(styleData) : null;
  // Univer mirrors the number format into style.n as well; the cell field "nf" is the single source of truth
  // (so a style diff can never disturb a number format).
  if (style) delete style.n;
  if (style && Object.keys(style).length > 0) cell.s = style;
  if (!isDefaultNumberFormat(numberFormat)) cell.nf = String(numberFormat);
  return Object.keys(cell).length > 0 ? cell : null;
}

// What to hand to Univer's set-range-values mutation so that `current` becomes exactly `next`.
// (Univer treats null as "remove this field", also inside a style, and leaves absent fields alone.)
export function diffCell(current, next) {
  const patch = {};

  for (const field of CELL_FIELDS) {
    const a = current ? current[field] : undefined;
    const b = next ? next[field] : undefined;
    if (!deepEqual(a, b)) patch[field] = b === undefined ? null : b;
  }

  const a = current && current.s;
  const b = next && next.s;
  if (!deepEqual(a, b)) {
    if (!b) {
      patch.s = null;
    } else {
      const style = { ...b };
      if (a) for (const key of Object.keys(a)) if (!(key in b)) style[key] = null;
      patch.s = style;
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function chunk(list, size) {
  const out = [];
  for (let start = 0; start < list.length; start += size) out.push(list.slice(start, start + size));
  return out;
}

// ---------- local edit -> operations ----------

// Univer mutation -> zero or more server operations. `io.readCell(worksheetKey, row, column)` must
// return the cell AFTER the mutation was applied locally (see normalizeCell).
export function opsFromMutation(commandId, params, io) {
  if (!params || typeof params !== "object") return [];

  if (commandId === SET_RANGE_VALUES) {
    const worksheetKey = params.subUnitId;
    const values = params.cellValue;
    if (!worksheetKey || !values || typeof values !== "object") return [];

    const cells = [];
    for (const row of Object.keys(values)) {
      const columns = values[row];
      if (!columns || typeof columns !== "object") continue;
      for (const column of Object.keys(columns)) {
        cells.push({ r: Number(row), c: Number(column), cell: io.readCell(worksheetKey, Number(row), Number(column)) });
      }
    }
    return chunk(cells, MAX_CELLS_PER_OPERATION).map((part) => ({ type: "cells", ws: worksheetKey, cells: part }));
  }

  if (commandId === SET_NUMFMT || commandId === REMOVE_NUMFMT) {
    const worksheetKey = params.subUnitId;
    if (!worksheetKey) return [];
    const ranges = commandId === REMOVE_NUMFMT
      ? params.ranges
      : Object.values(params.values || {}).flatMap((entry) => (entry && entry.ranges) || []);
    const cells = [];
    const seen = new Set();
    for (const range of Array.isArray(ranges) ? ranges : []) {
      for (let row = range.startRow; row <= range.endRow; row += 1) {
        for (let column = range.startColumn; column <= range.endColumn; column += 1) {
          if (!Number.isInteger(row) || !Number.isInteger(column) || seen.has(row + ":" + column) || cells.length >= MAX_NUMFMT_CELLS) continue;
          seen.add(row + ":" + column);
          cells.push({ r: row, c: column, cell: io.readCell(worksheetKey, row, column) });
        }
      }
    }
    return chunk(cells, MAX_CELLS_PER_OPERATION).map((part) => ({ type: "cells", ws: worksheetKey, cells: part }));
  }

  if (commandId === INSERT_SHEET) {
    const sheet = params.sheet;
    if (!sheet || !sheet.id || typeof sheet.name !== "string") return [];
    return [{ type: "addWorksheet", ws: sheet.id, name: sheet.name, index: Number.isInteger(params.index) ? params.index : undefined }];
  }

  if (commandId === SET_WORKSHEET_NAME) {
    if (!params.subUnitId || typeof params.name !== "string") return [];
    return [{ type: "renameWorksheet", ws: params.subUnitId, name: params.name }];
  }

  if (commandId === SET_COL_WIDTH || commandId === SET_ROW_HEIGHT) {
    const isColumn = commandId === SET_COL_WIDTH;
    const sizes = {};
    let position = 0;
    for (const range of Array.isArray(params.ranges) ? params.ranges : []) {
      const start = isColumn ? range.startColumn : range.startRow;
      const end = isColumn ? range.endColumn : range.endRow;
      if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
      for (let index = start; index <= end && Object.keys(sizes).length < 100000; index += 1) {
        const raw = isColumn ? params.colWidth : params.rowHeight;
        const size = Array.isArray(raw) ? raw[position] : raw;
        position += 1;
        if (typeof size === "number" && Number.isFinite(size)) sizes[index] = Math.round(size);
      }
    }
    const entries = Object.entries(sizes);
    return chunk(entries, MAX_LAYOUT_ENTRIES_PER_OPERATION).map((part) => ({
      type: "layout",
      ws: params.subUnitId,
      columnWidths: isColumn ? Object.fromEntries(part) : {},
      rowHeights: isColumn ? {} : Object.fromEntries(part),
    }));
  }

  return [];
}

// ---------- remote operation -> mutations ----------

// Operation received from the server -> the Univer mutations to execute locally (with
// {onlyLocal:true}, so they are never sent back). ctx:
//   unitId                      the workbook id
//   readCell(ws, r, c)          current local cell (normalizeCell shape)
//   hasWorksheet(ws)            boolean
//   worksheetCount()            number
//   getWorksheetName(ws)        string | null
//   isPending(ws, r, c)         true while this client has an unsaved edit of that cell
export function mutationsFromRemoteOp(op, ctx) {
  if (!op || typeof op !== "object") return [];

  if (op.type === "cells") {
    if (!ctx.hasWorksheet(op.ws)) return [];
    const cellValue = {};
    const setFormats = new Map(); // pattern -> single-cell ranges
    const clearFormats = [];
    for (const { r, c, cell } of op.cells || []) {
      if (ctx.isPending(op.ws, r, c)) continue; // our own newer edit is still on its way; the server's order decides
      const current = ctx.readCell(op.ws, r, c);
      const patch = diffCell(current, cell || null);
      if (patch) {
        if (!cellValue[r]) cellValue[r] = {};
        cellValue[r][c] = patch;
      }
      const wanted = cell && cell.nf ? cell.nf : null;
      const has = current && current.nf ? current.nf : null;
      if (wanted !== has) {
        const range = { startRow: r, endRow: r, startColumn: c, endColumn: c };
        if (wanted) {
          if (!setFormats.has(wanted)) setFormats.set(wanted, []);
          setFormats.get(wanted).push(range);
        } else {
          clearFormats.push(range);
        }
      }
    }

    const mutations = [];
    if (Object.keys(cellValue).length > 0) {
      mutations.push({ id: SET_RANGE_VALUES, params: { unitId: ctx.unitId, subUnitId: op.ws, cellValue } });
    }
    if (clearFormats.length > 0) {
      mutations.push({ id: REMOVE_NUMFMT, params: { unitId: ctx.unitId, subUnitId: op.ws, ranges: clearFormats } });
    }
    if (setFormats.size > 0) {
      mutations.push(numfmtSetMutation(ctx.unitId, op.ws, setFormats));
    }
    return mutations;
  }

  if (op.type === "addWorksheet") {
    if (ctx.hasWorksheet(op.ws)) return [];
    const index = Number.isInteger(op.index) ? Math.min(op.index, ctx.worksheetCount()) : ctx.worksheetCount();
    return [{
      id: INSERT_SHEET,
      params: { unitId: ctx.unitId, index, sheet: buildWorksheetData(op.ws, op.name) },
    }];
  }

  if (op.type === "renameWorksheet") {
    if (!ctx.hasWorksheet(op.ws) || ctx.getWorksheetName(op.ws) === op.name) return [];
    return [{ id: SET_WORKSHEET_NAME, params: { unitId: ctx.unitId, subUnitId: op.ws, name: op.name } }];
  }

  if (op.type === "layout") {
    if (!ctx.hasWorksheet(op.ws)) return [];
    const mutations = [];
    for (const [index, width] of Object.entries(op.columnWidths || {})) {
      if (typeof width !== "number") continue; // null = "back to default": left to the next full reload
      const column = Number(index);
      mutations.push({
        id: SET_COL_WIDTH,
        params: { unitId: ctx.unitId, subUnitId: op.ws, ranges: [{ startRow: 0, endRow: 0, startColumn: column, endColumn: column }], colWidth: width },
      });
    }
    for (const [index, height] of Object.entries(op.rowHeights || {})) {
      if (typeof height !== "number") continue;
      const row = Number(index);
      mutations.push({
        id: SET_ROW_HEIGHT,
        params: { unitId: ctx.unitId, subUnitId: op.ws, ranges: [{ startRow: row, endRow: row, startColumn: 0, endColumn: 0 }], rowHeight: height },
      });
    }
    return mutations;
  }

  return [];
}

function numfmtSetMutation(unitId, worksheetKey, patternToRanges) {
  const values = {};
  const refMap = {};
  let index = 0;
  for (const [pattern, ranges] of patternToRanges) {
    const id = "nf" + index++;
    values[id] = { ranges };
    refMap[id] = { pattern };
  }
  return { id: SET_NUMFMT, params: { unitId, subUnitId: worksheetKey, values, refMap } };
}

// When a saved workbook is loaded, its number formats (cell.nf) still have to be handed to Univer's
// number-format model. One mutation per worksheet; neighbouring cells with the same pattern in a
// row are merged into one range so a formatted column is a handful of ranges, not thousands.
export function numfmtMutationsForWorkbook(workbookData, unitId) {
  const mutations = [];
  for (const worksheetKey of workbookData.sheetOrder || []) {
    const cellData = (workbookData.sheets[worksheetKey] || {}).cellData || {};
    const byPattern = new Map();
    for (const row of Object.keys(cellData).map(Number).sort((a, b) => a - b)) {
      const columns = Object.keys(cellData[row]).map(Number).sort((a, b) => a - b);
      let open = null;
      const flush = () => {
        if (!open) return;
        if (!byPattern.has(open.pattern)) byPattern.set(open.pattern, []);
        byPattern.get(open.pattern).push({ startRow: row, endRow: row, startColumn: open.start, endColumn: open.end });
        open = null;
      };
      for (const column of columns) {
        const pattern = cellData[row][column] && cellData[row][column].nf;
        if (!pattern) {
          flush();
        } else if (open && open.pattern === pattern && open.end === column - 1) {
          open.end = column;
        } else {
          flush();
          open = { pattern, start: column, end: column };
        }
      }
      flush();
    }
    if (byPattern.size > 0) mutations.push(numfmtSetMutation(unitId, worksheetKey, byPattern));
  }
  return mutations;
}

// The mutations that change SHARED data (everything this module synchronises). A user who may not edit
// has exactly these vetoed in the editor (see SmartSheetEditor.jsx), so a view-only spreadsheet cannot
// even be changed locally. The server refuses such edits independently; this only keeps the screen honest.
export const SHARED_DATA_MUTATIONS = new Set([
  SET_RANGE_VALUES,
  INSERT_SHEET,
  SET_WORKSHEET_NAME,
  SET_COL_WIDTH,
  SET_ROW_HEIGHT,
  SET_NUMFMT,
  REMOVE_NUMFMT,
]);

export const READ_ONLY_MESSAGE = "You have view-only access to this spreadsheet, so it can't be changed.";

// ---------- unsupported (unsynchronised) edits ----------

const BLOCKED_COMMAND_PATTERNS = [
  /^sheet\.command\.(insert|remove|delete)-(row|col|range|multi)/, // insert/remove/delete rows, columns, cells (and ...-confirm / -by-range)
  /^sheet\.command\.insert-(multi-)?(cols|rows)/,
  /^sheet\.command\.move-(rows|cols|range)/,
  /^sheet\.command\.(add|remove)-worksheet-merge/, // merge / unmerge cells
  /^sheet\.command\.remove-sheet/, // delete a tab
  /^sheet\.command\.copy-sheet$/,
  /^sheet\.command\.set-worksheet-order$/,
  /^sheet\.command\.reorder-range$/,
  /^sheet\.command\.hide-(row|col)/,
  /^sheet\.command\.set-tab-color$/,
  /^sheet\.command\.(insert|remove)-defined-name$/,
];

export function isBlockedCommand(commandId) {
  return typeof commandId === "string" && BLOCKED_COMMAND_PATTERNS.some((pattern) => pattern.test(commandId));
}

export const BLOCKED_MESSAGE =
  "That change isn't available in shared spreadsheets yet (inserting, deleting, moving or merging rows, columns or cells, and deleting or reordering sheets). Cell values, formulas, formatting, sheet tabs, column widths and row heights are saved and shared.";

// ---------- the save queue ----------

const RETRYABLE_CODES = new Set(["SERVER_ERROR", "RATE_LIMITED", "CONFLICT"]);

// Sends operations to the server strictly in order, one at a time, keeps them until the server
// confirms they were SAVED, resumes after a reconnect, and tells the UI the state:
//   'connecting' | 'saved' | 'saving' | 'offline' | 'error'
//
// send(op) must resolve to the server's ack ({ ok:true, revision } | { ok:false, code, message }) or
// reject (no connection / timeout). A rejected operation is DROPPED (never retried forever) and
// reported through onRejected, because the editor's local state may no longer match the server.
export function createSaveQueue({ send, onStatus = () => {}, onRejected = () => {}, onNeedsRejoin = () => {}, retryDelaysMs = [400, 1200, 3000], wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const queue = [];
  const pending = new Map();
  let connected = false;
  let everConnected = false;
  let running = false;
  let failed = null;
  let drainWaiters = [];

  const status = () => {
    if (!connected) return everConnected ? "offline" : "connecting";
    if (failed) return "error";
    return queue.length > 0 ? "saving" : "saved";
  };
  const publish = () => onStatus(status(), { pendingOperations: queue.length, error: failed });

  const release = (item) => {
    for (const key of item.cellKeys) {
      const left = (pending.get(key) || 0) - 1;
      if (left > 0) pending.set(key, left); else pending.delete(key);
    }
  };

  const settleDrain = () => {
    if (queue.length === 0 && drainWaiters.length > 0) {
      const waiters = drainWaiters;
      drainWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  };

  async function run() {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0 && connected) {
        const item = queue[0];
        let ack;
        try {
          ack = await send(item.op);
        } catch {
          ack = { ok: false, code: "NETWORK" };
        }

        if (ack && ack.ok) {
          queue.shift();
          release(item);
          item.attempts = 0;
          failed = null;
          publish();
          continue;
        }

        const code = ack && ack.code;

        if (code === "NETWORK" || !connected) {
          break; // keep it; the next connect resumes from here
        }
        if (code === "NOT_JOINED") {
          onNeedsRejoin();
          break;
        }
        if (RETRYABLE_CODES.has(code) && item.attempts < retryDelaysMs.length) {
          const delay = retryDelaysMs[item.attempts];
          item.attempts += 1;
          await wait(delay);
          continue;
        }

        // refused for good (validation, no access, read-only, archived, ...)
        queue.shift();
        release(item);
        failed = { code: code || "UNKNOWN", message: (ack && ack.message) || "The change could not be saved." };
        onRejected(item.op, failed);
        publish();
      }
    } finally {
      running = false;
      publish();
      settleDrain();
    }
  }

  return {
    enqueue(op) {
      const cellKeys = op.type === "cells" ? op.cells.map((entry) => cellKey(op.ws, entry.r, entry.c)) : [];
      for (const key of cellKeys) pending.set(key, (pending.get(key) || 0) + 1);
      queue.push({ op, cellKeys, attempts: 0 });
      publish();
      run();
    },
    setConnected(value) {
      connected = Boolean(value);
      if (connected) everConnected = true;
      publish();
      if (connected) run();
    },
    resume() {
      run();
    },
    clearError() {
      failed = null;
      publish();
    },
    isPending: (worksheetKey, row, column) => pending.has(cellKey(worksheetKey, row, column)),
    // resolves when everything queued so far has been saved (or immediately when nothing is queued)
    whenDrained() {
      if (queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => drainWaiters.push(resolve));
    },
    get size() {
      return queue.length;
    },
    get status() {
      return status();
    },
  };
}

// ---------- presentation helpers ----------

export const SAVE_STATUS_LABELS = {
  connecting: "Connecting…",
  saving: "Saving…",
  saved: "Saved",
  offline: "Offline — changes are kept and will save when you reconnect",
  error: "Not saved",
};

export function collaboratorInitials(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || "?").slice(0, 2);
  return letters.toUpperCase();
}

// No blue/cyan: the portal's design system is green with no blue anywhere (enforced by _test_portal_design.js).
const COLLABORATOR_COLORS = ["#0d9488", "#16a34a", "#d97706", "#9333ea", "#dc2626", "#c2410c", "#be185d", "#4d7c0f"];

export function collaboratorColor(userId) {
  const number = Math.abs(Number(userId) || 0);
  return COLLABORATOR_COLORS[number % COLLABORATOR_COLORS.length];
}
