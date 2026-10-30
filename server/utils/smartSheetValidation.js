const { invalid } = require("./smartSheetErrors");

// ==========================================
// SMART SHEETS -- LIMITS AND INPUT VALIDATION
//
// Everything that arrives from a browser (REST body or socket payload) goes through this file
// before it reaches the database. Nothing here trusts the client: ids, worksheet keys, cell
// coordinates, strings and payload sizes are all checked, unknown cell fields are dropped, and
// objects that could poison prototypes are rejected.
//
// The numbers are product limits, not Excel's: they keep one sheet from exhausting the single
// Node process or the database. (Excel itself allows 1,048,576 rows x 16,384 columns.)
// ==========================================

const LIMITS = Object.freeze({
    MAX_SHEET_NAME_LENGTH: 150,
    MAX_WORKSHEET_NAME_LENGTH: 31, // Excel's own limit, so export never has to truncate
    MAX_WORKSHEETS: 50,
    MAX_ROWS: 100000,
    MAX_COLUMNS: 1000,
    DEFAULT_ROWS: 1000,
    DEFAULT_COLUMNS: 26,
    MAX_CELLS_PER_OPERATION: 5000,
    MAX_OPERATION_BYTES: 512 * 1024,
    MAX_CELL_BYTES: 64 * 1024,
    MAX_CELL_TEXT_LENGTH: 32767, // Excel's per-cell text limit
    MAX_FORMULA_LENGTH: 8192,
    MAX_NUMBER_FORMAT_LENGTH: 256,
    MAX_STYLE_BYTES: 4 * 1024,
    MAX_LAYOUT_ENTRIES_PER_OPERATION: 2000,
    MIN_COLUMN_WIDTH: 8,
    MAX_COLUMN_WIDTH: 2000,
    MIN_ROW_HEIGHT: 4,
    MAX_ROW_HEIGHT: 2000,
    MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
    MAX_IMPORT_CELLS: 200000,
    MAX_ASSIGNEES_PER_REQUEST: 200,
});

const WORKSHEET_KEY_PATTERN = /^[A-Za-z0-9_-]{1,36}$/;
const FORBIDDEN_WORKSHEET_NAME_CHARS = /[\\/?*[\]:]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const isPlainObject = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const isIntegerInRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function parsePositiveId(value, code = "INVALID_ID", label = "id") {
    const text = typeof value === "number" ? String(value) : value;
    if (typeof text !== "string" || !/^[1-9]\d{0,9}$/.test(text) || Number(text) > 2147483647) {
        throw invalid(code, `Invalid ${label}.`);
    }
    return Number(text);
}

const parseSheetId = (value) => parsePositiveId(value, "INVALID_SHEET_ID", "spreadsheet id");

function validateSheetName(value) {
    if (typeof value !== "string") {
        throw invalid("INVALID_NAME", "Enter a spreadsheet name.");
    }
    const name = value.trim().replace(/\s+/g, " ");
    if (!name) {
        throw invalid("INVALID_NAME", "Enter a spreadsheet name.");
    }
    if (name.length > LIMITS.MAX_SHEET_NAME_LENGTH) {
        throw invalid("INVALID_NAME", `The name must be ${LIMITS.MAX_SHEET_NAME_LENGTH} characters or fewer.`);
    }
    if (CONTROL_CHARS.test(name)) {
        throw invalid("INVALID_NAME", "The name contains invalid characters.");
    }
    return name;
}

// Excel's rules, so an exported workbook always opens: 1-31 chars, none of \ / ? * [ ] :, and no
// leading/trailing apostrophe.
function validateWorksheetName(value) {
    if (typeof value !== "string") {
        throw invalid("INVALID_WORKSHEET_NAME", "Enter a worksheet name.");
    }
    const name = value.trim();
    if (!name) {
        throw invalid("INVALID_WORKSHEET_NAME", "Enter a worksheet name.");
    }
    if (name.length > LIMITS.MAX_WORKSHEET_NAME_LENGTH) {
        throw invalid("INVALID_WORKSHEET_NAME", `A worksheet name must be ${LIMITS.MAX_WORKSHEET_NAME_LENGTH} characters or fewer.`);
    }
    if (FORBIDDEN_WORKSHEET_NAME_CHARS.test(name) || CONTROL_CHARS.test(name)) {
        throw invalid("INVALID_WORKSHEET_NAME", "A worksheet name cannot contain \\ / ? * [ ] :");
    }
    if (name.startsWith("'") || name.endsWith("'")) {
        throw invalid("INVALID_WORKSHEET_NAME", "A worksheet name cannot start or end with an apostrophe.");
    }
    return name;
}

function validateWorksheetKey(value) {
    if (typeof value !== "string" || !WORKSHEET_KEY_PATTERN.test(value)) {
        throw invalid("INVALID_WORKSHEET_ID", "Invalid worksheet id.");
    }
    return value;
}

function validateCoordinate(row, column) {
    if (!isIntegerInRange(row, 0, LIMITS.MAX_ROWS - 1) || !isIntegerInRange(column, 0, LIMITS.MAX_COLUMNS - 1)) {
        throw invalid("INVALID_CELL_COORDINATE", "A cell is outside the supported grid.");
    }
}

// Plain JSON only (what an editor produces): bounded depth, no prototype-poisoning keys, no
// non-finite numbers. Returns the byte size so callers can enforce their own cap.
function assertPlainJson(value, depth = 0) {
    if (depth > 8) {
        throw invalid("INVALID_CELL", "A cell is too deeply nested.");
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw invalid("INVALID_CELL", "A cell contains a number that is not valid.");
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item) => assertPlainJson(item, depth + 1));
        return;
    }
    if (isPlainObject(value)) {
        for (const key of Object.keys(value)) {
            if (POISON_KEYS.has(key)) {
                throw invalid("INVALID_CELL", "A cell contains a reserved key.");
            }
            assertPlainJson(value[key], depth + 1);
        }
        return;
    }
    throw invalid("INVALID_CELL", "A cell contains an unsupported value.");
}

const byteLength = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

// "|" is not an Excel operator (concatenation is &); outside a quoted string it only appears in
// DDE payloads such as =cmd|'/c calc'!A0, which Excel can be talked into running when an exported
// workbook is opened. Such formulas are refused instead of stored.
function hasDdeLikePipe(formula) {
    return formula.replace(/"(?:[^"]|"")*"/g, "").includes("|");
}

// One FULL cell as the editor holds it (value, type, formula, style), or null for an empty cell.
// Unknown fields are dropped rather than stored. The result is what gets persisted and
// broadcast, so every client converges on the same sanitized cell.
function sanitizeCell(raw) {
    if (raw === null || raw === undefined) {
        return null;
    }
    if (!isPlainObject(raw)) {
        throw invalid("INVALID_CELL", "A cell is not valid.");
    }

    const cell = {};

    if (raw.v !== undefined && raw.v !== null) {
        if (typeof raw.v === "string") {
            if (raw.v.length > LIMITS.MAX_CELL_TEXT_LENGTH) {
                throw invalid("CELL_TOO_LARGE", `A cell can hold at most ${LIMITS.MAX_CELL_TEXT_LENGTH} characters.`);
            }
            cell.v = raw.v;
        } else if ((typeof raw.v === "number" && Number.isFinite(raw.v)) || typeof raw.v === "boolean") {
            cell.v = raw.v;
        } else {
            throw invalid("INVALID_CELL", "A cell value is not valid.");
        }
    }

    if (raw.t !== undefined && raw.t !== null) {
        if (!isIntegerInRange(raw.t, 1, 4)) {
            throw invalid("INVALID_CELL", "A cell type is not valid.");
        }
        cell.t = raw.t;
    }

    if (raw.f !== undefined && raw.f !== null) {
        if (typeof raw.f !== "string" || !raw.f.startsWith("=") || raw.f.length > LIMITS.MAX_FORMULA_LENGTH) {
            throw invalid("INVALID_CELL", "A formula is not valid.");
        }
        if (hasDdeLikePipe(raw.f)) {
            throw invalid("INVALID_CELL", "That formula is not allowed.");
        }
        cell.f = raw.f;
    }

    // Number format pattern (e.g. "0.00%", "yyyy-mm-dd"). Univer keeps it in its own model, not in the
    // cell style, so it travels as its own field. "General" is the default and is not stored.
    if (raw.nf !== undefined && raw.nf !== null) {
        if (typeof raw.nf !== "string" || raw.nf.length > LIMITS.MAX_NUMBER_FORMAT_LENGTH || CONTROL_CHARS.test(raw.nf)) {
            throw invalid("INVALID_CELL", "A number format is not valid.");
        }
        if (raw.nf !== "" && raw.nf.toLowerCase() !== "general") {
            cell.nf = raw.nf;
        }
    }

    if (raw.si !== undefined && raw.si !== null) {
        if (typeof raw.si !== "string" || !/^[A-Za-z0-9_-]{1,36}$/.test(raw.si)) {
            throw invalid("INVALID_CELL", "A cell formula id is not valid.");
        }
        cell.si = raw.si;
    }

    if (raw.s !== undefined && raw.s !== null) {
        if (!isPlainObject(raw.s)) {
            throw invalid("INVALID_CELL", "A cell style is not valid.");
        }
        assertPlainJson(raw.s);
        if (byteLength(raw.s) > LIMITS.MAX_STYLE_BYTES) {
            throw invalid("CELL_TOO_LARGE", "A cell style is too large.");
        }
        if (Object.keys(raw.s).length > 0) {
            cell.s = raw.s;
        }
    }

    if (raw.p !== undefined && raw.p !== null) {
        if (!isPlainObject(raw.p)) {
            throw invalid("INVALID_CELL", "Cell rich text is not valid.");
        }
        assertPlainJson(raw.p);
        cell.p = raw.p;
    }

    if (Object.keys(cell).length === 0) {
        return null;
    }
    if (byteLength(cell) > LIMITS.MAX_CELL_BYTES) {
        throw invalid("CELL_TOO_LARGE", "A cell is too large.");
    }

    return cell;
}

function sanitizeSizeMap(raw, { max, min, maxIndex, label }) {
    if (raw === undefined || raw === null) {
        return {};
    }
    if (!isPlainObject(raw)) {
        throw invalid("INVALID_LAYOUT", `${label} is not valid.`);
    }
    const out = {};
    for (const key of Object.keys(raw)) {
        if (!/^\d{1,6}$/.test(key) || Number(key) > maxIndex) {
            throw invalid("INVALID_LAYOUT", `${label} refers to a position outside the grid.`);
        }
        const size = raw[key];
        if (size === null) {
            out[key] = null; // reset to default
        } else if (typeof size === "number" && Number.isFinite(size) && size >= min && size <= max) {
            out[key] = Math.round(size);
        } else {
            throw invalid("INVALID_LAYOUT", `${label} contains an invalid size.`);
        }
    }
    return out;
}

// Normalizes ONE client operation or throws. The returned object is the only thing the store ever
// sees, and the only thing that is broadcast to other users.
function validateOperation(raw) {
    if (!isPlainObject(raw)) {
        throw invalid("INVALID_OPERATION", "Invalid change.");
    }
    if (byteLength(raw) > LIMITS.MAX_OPERATION_BYTES) {
        throw invalid("PAYLOAD_TOO_LARGE", "That change is too large to save in one step.");
    }

    switch (raw.type) {
        case "cells": {
            const ws = validateWorksheetKey(raw.ws);
            if (!Array.isArray(raw.cells) || raw.cells.length === 0) {
                throw invalid("INVALID_OPERATION", "No cells to save.");
            }
            if (raw.cells.length > LIMITS.MAX_CELLS_PER_OPERATION) {
                throw invalid("PAYLOAD_TOO_LARGE", `At most ${LIMITS.MAX_CELLS_PER_OPERATION} cells can be saved in one step.`);
            }
            const byPosition = new Map(); // a repeated position keeps its LAST value
            for (const entry of raw.cells) {
                if (!isPlainObject(entry)) {
                    throw invalid("INVALID_OPERATION", "Invalid change.");
                }
                validateCoordinate(entry.r, entry.c);
                byPosition.set(`${entry.r}:${entry.c}`, { r: entry.r, c: entry.c, cell: sanitizeCell(entry.cell) });
            }
            return { type: "cells", ws, cells: [...byPosition.values()] };
        }

        case "addWorksheet": {
            const ws = validateWorksheetKey(raw.ws);
            const name = validateWorksheetName(raw.name);
            const index = raw.index === undefined || raw.index === null ? null : raw.index;
            if (index !== null && !isIntegerInRange(index, 0, LIMITS.MAX_WORKSHEETS)) {
                throw invalid("INVALID_OPERATION", "Invalid worksheet position.");
            }
            return { type: "addWorksheet", ws, name, index };
        }

        case "renameWorksheet": {
            return { type: "renameWorksheet", ws: validateWorksheetKey(raw.ws), name: validateWorksheetName(raw.name) };
        }

        case "layout": {
            const ws = validateWorksheetKey(raw.ws);
            const columnWidths = sanitizeSizeMap(raw.columnWidths, {
                min: LIMITS.MIN_COLUMN_WIDTH, max: LIMITS.MAX_COLUMN_WIDTH, maxIndex: LIMITS.MAX_COLUMNS - 1, label: "Column widths",
            });
            const rowHeights = sanitizeSizeMap(raw.rowHeights, {
                min: LIMITS.MIN_ROW_HEIGHT, max: LIMITS.MAX_ROW_HEIGHT, maxIndex: LIMITS.MAX_ROWS - 1, label: "Row heights",
            });
            const entries = Object.keys(columnWidths).length + Object.keys(rowHeights).length;
            if (entries === 0) {
                throw invalid("INVALID_OPERATION", "No layout change to save.");
            }
            if (entries > LIMITS.MAX_LAYOUT_ENTRIES_PER_OPERATION) {
                throw invalid("PAYLOAD_TOO_LARGE", "That layout change is too large.");
            }
            return { type: "layout", ws, columnWidths, rowHeights };
        }

        default:
            throw invalid("UNKNOWN_OPERATION", "That kind of change is not supported.");
    }
}

module.exports = {
    LIMITS,
    parsePositiveId,
    parseSheetId,
    validateSheetName,
    validateWorksheetName,
    validateWorksheetKey,
    validateCoordinate,
    sanitizeCell,
    validateOperation,
    isPlainObject,
};
