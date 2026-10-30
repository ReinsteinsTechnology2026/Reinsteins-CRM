const ExcelJS = require("exceljs");

const { LIMITS, sanitizeCell } = require("../utils/smartSheetValidation");
const { invalid } = require("../utils/smartSheetErrors");

// ==========================================
// SMART SHEETS -- EXCEL (.xlsx) IMPORT / EXPORT (ExcelJS)
//
// import: .xlsx bytes  -> { worksheets:[{ name, rowCount, columnCount, cells:[{r,c,cell}], layout }], warnings }
// export: stored state  -> .xlsx bytes
//
// What is preserved (both directions): worksheet names and order; text, numbers, booleans and
// dates; formulas (with their last calculated value); number formats (cell.nf); bold / italic / underline /
// strikethrough; font name, size and colour; solid fills; horizontal / vertical alignment and text
// wrap; cell borders; column widths and row heights.
//
// What is NOT preserved, and is reported to the user as a warning on import rather than silently
// dropped (where ExcelJS can detect it): merged cells, images, data validation, conditional
// formatting, tables, cell comments, defined names, hidden sheets, rich-text runs (flattened to
// plain text), theme/indexed colours (skipped). Charts, pivot tables and macros are discarded by
// the reader and cannot be detected. Macro-enabled (.xlsm) and legacy (.xls) files, and
// password-protected workbooks, are rejected with an error.
//
// The editor's cell format is Univer's ICellData: v value, t type (1 string, 2 number, 3 boolean),
// f formula, s style, nf number format pattern. Colours are "#RRGGBB".
// ==========================================

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]); // legacy .xls and password-protected workbooks

const T_STRING = 1;
const T_NUMBER = 2;
const T_BOOLEAN = 3;

const BORDER_STYLE_TO_UNIVER = {
    thin: 1, hair: 2, dotted: 3, dashed: 4, dashDot: 5, dashDotDot: 6, double: 7,
    medium: 8, mediumDashed: 9, mediumDashDot: 10, mediumDashDotDot: 11, slantDashDot: 12, thick: 13,
};
const BORDER_STYLE_FROM_UNIVER = Object.fromEntries(Object.entries(BORDER_STYLE_TO_UNIVER).map(([name, id]) => [id, name]));

const H_ALIGN_TO_UNIVER = { left: 1, center: 2, right: 3 };
const H_ALIGN_FROM_UNIVER = { 1: "left", 2: "center", 3: "right" };
const V_ALIGN_TO_UNIVER = { top: 1, middle: 2, center: 2, bottom: 3 };
const V_ALIGN_FROM_UNIVER = { 1: "top", 2: "middle", 3: "bottom" };
const WRAP = 3; // Univer WrapStrategy.WRAP

// pixel <-> Excel unit conversions (Calibri 11 default: ~7px per character + 5px padding; 96 dpi)
const widthToPixels = (chars) => Math.round(chars * 7 + 5);
const pixelsToWidth = (px) => Math.max(0, (px - 5) / 7);
const heightToPixels = (points) => Math.round((points * 96) / 72);
const pixelsToHeight = (px) => (px * 72) / 96;

const EXCEL_EPOCH_OFFSET_DAYS = 25569; // days from 1899-12-30 to 1970-01-01
const dateToSerial = (date) => date.getTime() / 86400000 + EXCEL_EPOCH_OFFSET_DAYS;
const serialToDate = (serial) => new Date(Math.round((serial - EXCEL_EPOCH_OFFSET_DAYS) * 86400000));

const DATE_PATTERN = "yyyy-mm-dd";

// ---------- helpers ----------

// `isFont`: theme colour 1 is Excel's default text colour (black on a light theme) -- present in
// almost every workbook -- so it is not worth a warning; any other theme/indexed colour is.
function colorToHex(color, flags, isFont = false) {
    if (!color) return null;
    if (isFont && color.theme === 1) return null;
    if (typeof color.argb === "string" && /^[0-9a-fA-F]{8}$/.test(color.argb)) {
        return `#${color.argb.slice(2).toUpperCase()}`;
    }
    if (typeof color.argb === "string" && /^[0-9a-fA-F]{6}$/.test(color.argb)) {
        return `#${color.argb.toUpperCase()}`;
    }
    if (color.theme !== undefined || color.indexed !== undefined) {
        flags.themeColors = true;
    }
    return null;
}

function hexToArgb(hex) {
    return typeof hex === "string" && /^#[0-9a-fA-F]{6}$/.test(hex) ? `FF${hex.slice(1).toUpperCase()}` : null;
}

function plainText(value) {
    if (value && typeof value === "object" && Array.isArray(value.richText)) {
        return value.richText.map((run) => run.text).join("");
    }
    return value;
}

// Univer rich text (cell.p) -> plain string, for export.
function richTextToPlain(p) {
    const stream = p && p.body && typeof p.body.dataStream === "string" ? p.body.dataStream : "";
    return stream.replace(/\r\n$/, "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
}

function styleFromExcel(cell, flags) {
    const style = {};
    const font = cell.font || {};
    const fill = cell.fill;
    const alignment = cell.alignment || {};
    const border = cell.border || {};

    if (font.bold) style.bl = 1;
    if (font.italic) style.it = 1;
    if (font.underline) style.ul = { s: 1 };
    if (font.strike) style.st = { s: 1 };
    if (typeof font.size === "number") style.fs = font.size;
    if (typeof font.name === "string" && font.name) style.ff = font.name;

    const fontColor = colorToHex(font.color, flags, true);
    if (fontColor) style.cl = { rgb: fontColor };

    if (fill && fill.type === "pattern" && fill.pattern === "solid") {
        const bg = colorToHex(fill.fgColor, flags);
        if (bg) style.bg = { rgb: bg };
    }

    if (H_ALIGN_TO_UNIVER[alignment.horizontal]) style.ht = H_ALIGN_TO_UNIVER[alignment.horizontal];
    if (V_ALIGN_TO_UNIVER[alignment.vertical]) style.vt = V_ALIGN_TO_UNIVER[alignment.vertical];
    if (alignment.wrapText) style.tb = WRAP;

    const bd = {};
    for (const [side, key] of [["top", "t"], ["bottom", "b"], ["left", "l"], ["right", "r"]]) {
        const edge = border[side];
        if (edge && BORDER_STYLE_TO_UNIVER[edge.style]) {
            bd[key] = { s: BORDER_STYLE_TO_UNIVER[edge.style], cl: { rgb: colorToHex(edge.color, flags) || "#000000" } };
        }
    }
    if (Object.keys(bd).length) style.bd = bd;

    return style;
}

function cellFromExcel(excelCell, flags) {
    // Cells swallowed by a merge repeat the top-left value; keep only the master.
    if (excelCell.type === ExcelJS.ValueType.Merge) {
        return null;
    }

    const cell = {};
    const style = styleFromExcel(excelCell, flags);
    let numberFormat = typeof excelCell.numFmt === "string" && excelCell.numFmt && excelCell.numFmt !== "General" ? excelCell.numFmt : null;
    let value = excelCell.value;

    const setScalar = (scalar) => {
        if (scalar === null || scalar === undefined) return;
        if (scalar instanceof Date) {
            cell.v = dateToSerial(scalar);
            cell.t = T_NUMBER;
            if (!numberFormat) numberFormat = DATE_PATTERN;
        } else if (typeof scalar === "number") {
            cell.v = scalar;
            cell.t = T_NUMBER;
        } else if (typeof scalar === "boolean") {
            cell.v = scalar ? 1 : 0;
            cell.t = T_BOOLEAN;
        } else if (typeof scalar === "object" && typeof scalar.error === "string") {
            cell.v = scalar.error;
            cell.t = T_STRING;
        } else {
            cell.v = String(plainText(scalar));
            cell.t = T_STRING;
        }
    };

    if (excelCell.type === ExcelJS.ValueType.Formula) {
        const formula = excelCell.formula;
        if (typeof formula === "string" && formula) {
            cell.f = `=${formula}`;
        }
        setScalar(excelCell.result);
    } else if (excelCell.type === ExcelJS.ValueType.Hyperlink) {
        setScalar(plainText(value && value.text !== undefined ? value.text : value));
    } else if (excelCell.type === ExcelJS.ValueType.RichText) {
        flags.richText = true;
        setScalar(plainText(value));
    } else {
        setScalar(value);
    }

    if (excelCell.note) flags.comments = true;
    if (Object.keys(style).length) cell.s = style;
    if (numberFormat) cell.nf = numberFormat;

    return Object.keys(cell).length ? cell : null;
}

function uniqueWorksheetName(rawName, used) {
    const base = (String(rawName || "").replace(/[\\/?*[\]:]/g, "_").replace(/^'+|'+$/g, "").trim() || "Sheet").slice(0, LIMITS.MAX_WORKSHEET_NAME_LENGTH);
    let name = base;
    let counter = 2;
    while (used.has(name.toLowerCase())) {
        const suffix = ` (${counter++})`;
        name = base.slice(0, LIMITS.MAX_WORKSHEET_NAME_LENGTH - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
}

function nonEmpty(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") return Object.keys(value).length > 0;
    return Boolean(value);
}

// ---------- import ----------

function assertLooksLikeXlsx(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
        throw invalid("INVALID_XLSX", "The file is empty or is not an Excel workbook.");
    }
    if (buffer.subarray(0, 4).equals(OLE_MAGIC)) {
        throw invalid(
            "UNSUPPORTED_XLSX",
            "This looks like a password-protected or legacy .xls workbook. Remove the password or save it as .xlsx and try again."
        );
    }
    if (!buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
        throw invalid("INVALID_XLSX", "The file content is not an Excel (.xlsx) workbook.");
    }
}

async function parseXlsxBuffer(buffer) {
    assertLooksLikeXlsx(buffer);

    const workbook = new ExcelJS.Workbook();
    try {
        await workbook.xlsx.load(buffer);
    } catch (_error) {
        throw invalid("INVALID_XLSX", "The file could not be read as an Excel (.xlsx) workbook. It may be corrupt.");
    }

    const sheets = workbook.worksheets;
    if (sheets.length === 0) {
        throw invalid("INVALID_XLSX", "The workbook has no worksheets.");
    }
    if (sheets.length > LIMITS.MAX_WORKSHEETS) {
        throw invalid("TOO_MANY_WORKSHEETS", `The workbook has more than ${LIMITS.MAX_WORKSHEETS} worksheets.`);
    }

    const flags = {};
    const unsupported = { merged: 0, images: 0, validation: 0, conditional: 0, tables: 0, hidden: 0 };
    const usedNames = new Set();
    const worksheets = [];
    let totalCells = 0;
    let iterationBudget = LIMITS.MAX_IMPORT_CELLS * 10;

    for (const sheet of sheets) {
        if (sheet.rowCount > LIMITS.MAX_ROWS || sheet.columnCount > LIMITS.MAX_COLUMNS) {
            throw invalid(
                "WORKSHEET_TOO_LARGE",
                `Worksheet "${sheet.name}" is larger than the supported ${LIMITS.MAX_ROWS} rows x ${LIMITS.MAX_COLUMNS} columns.`
            );
        }

        const cells = [];
        let lastRow = 0;
        let lastColumn = 0;

        sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
            row.eachCell({ includeEmpty: true }, (excelCell, columnNumber) => {
                iterationBudget -= 1;
                if (iterationBudget < 0) {
                    throw invalid("WORKSHEET_TOO_LARGE", "The workbook is too large to import.");
                }

                const converted = cellFromExcel(excelCell, flags);
                if (!converted) return;

                const clean = sanitizeCell(converted); // the exact same rules as live edits
                if (!clean) return;

                totalCells += 1;
                if (totalCells > LIMITS.MAX_IMPORT_CELLS) {
                    throw invalid("WORKSHEET_TOO_LARGE", `The workbook has more than ${LIMITS.MAX_IMPORT_CELLS} non-empty cells.`);
                }

                cells.push({ r: rowNumber - 1, c: columnNumber - 1, cell: clean });
                lastRow = Math.max(lastRow, rowNumber);
                lastColumn = Math.max(lastColumn, columnNumber);
            });
        });

        const layout = { columnWidths: {}, rowHeights: {} };
        for (let index = 1; index <= sheet.columnCount; index += 1) {
            const width = sheet.getColumn(index).width;
            if (typeof width === "number" && width > 0) {
                layout.columnWidths[index - 1] = Math.min(LIMITS.MAX_COLUMN_WIDTH, Math.max(LIMITS.MIN_COLUMN_WIDTH, widthToPixels(width)));
            }
        }
        sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (typeof row.height === "number" && row.height > 0) {
                layout.rowHeights[rowNumber - 1] = Math.min(LIMITS.MAX_ROW_HEIGHT, Math.max(LIMITS.MIN_ROW_HEIGHT, heightToPixels(row.height)));
            }
        });

        unsupported.merged += (sheet.model.merges || []).length;
        unsupported.images += (sheet.getImages ? sheet.getImages().length : 0);
        unsupported.validation += nonEmpty(sheet.dataValidations && sheet.dataValidations.model) ? 1 : 0;
        unsupported.conditional += (sheet.conditionalFormattings || []).length;
        unsupported.tables += Object.keys(sheet.tables || {}).length;
        unsupported.hidden += sheet.state && sheet.state !== "visible" ? 1 : 0;

        worksheets.push({
            name: uniqueWorksheetName(sheet.name, usedNames),
            rowCount: Math.min(LIMITS.MAX_ROWS, Math.max(LIMITS.DEFAULT_ROWS, lastRow + 50)),
            columnCount: Math.min(LIMITS.MAX_COLUMNS, Math.max(LIMITS.DEFAULT_COLUMNS, lastColumn + 5)),
            cells,
            layout,
        });
    }

    const warnings = [];
    if (unsupported.merged) warnings.push(`${unsupported.merged} merged cell range(s) were not preserved (the text is kept in the top-left cell).`);
    if (unsupported.images) warnings.push(`${unsupported.images} image(s) were not imported.`);
    if (unsupported.validation) warnings.push("Data validation rules were not imported.");
    if (unsupported.conditional) warnings.push("Conditional formatting was not imported.");
    if (unsupported.tables) warnings.push("Excel tables were imported as plain cells.");
    if (unsupported.hidden) warnings.push("Hidden worksheets were imported as visible.");
    if (flags.comments) warnings.push("Cell comments were not imported.");
    if (flags.richText) warnings.push("Rich text inside cells was converted to plain text.");
    if (flags.themeColors) warnings.push("Some theme-based colours could not be preserved.");

    return { worksheets, warnings };
}

// ---------- export ----------

function styleToExcel(style, target) {
    if (!style) return;

    const font = {};
    if (style.bl === 1) font.bold = true;
    if (style.it === 1) font.italic = true;
    if (style.ul && style.ul.s === 1) font.underline = true;
    if (style.st && style.st.s === 1) font.strike = true;
    if (typeof style.fs === "number") font.size = style.fs;
    if (typeof style.ff === "string") font.name = style.ff;
    const fontArgb = hexToArgb(style.cl && style.cl.rgb);
    if (fontArgb) font.color = { argb: fontArgb };
    if (Object.keys(font).length) target.font = font;

    const bgArgb = hexToArgb(style.bg && style.bg.rgb);
    if (bgArgb) target.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgArgb } };

    const alignment = {};
    if (H_ALIGN_FROM_UNIVER[style.ht]) alignment.horizontal = H_ALIGN_FROM_UNIVER[style.ht];
    if (V_ALIGN_FROM_UNIVER[style.vt]) alignment.vertical = V_ALIGN_FROM_UNIVER[style.vt];
    if (style.tb === WRAP) alignment.wrapText = true;
    if (Object.keys(alignment).length) target.alignment = alignment;

    if (style.bd && typeof style.bd === "object") {
        const border = {};
        for (const [key, side] of [["t", "top"], ["b", "bottom"], ["l", "left"], ["r", "right"]]) {
            const edge = style.bd[key];
            const name = edge && BORDER_STYLE_FROM_UNIVER[edge.s];
            if (name) {
                const argb = hexToArgb(edge.cl && edge.cl.rgb);
                border[side] = argb ? { style: name, color: { argb } } : { style: name };
            }
        }
        if (Object.keys(border).length) target.border = border;
    }

}

function cellToExcel(cell, excelCell) {
    const numberFormat = typeof cell.nf === "string" ? cell.nf : "";
    const looksLikeDate = /[ymd]/i.test(numberFormat) && !/^0|#/.test(numberFormat);

    let value = cell.v;
    if (value === undefined && cell.p) {
        value = richTextToPlain(cell.p);
    }

    if (cell.t === T_BOOLEAN && (value === 0 || value === 1)) {
        value = value === 1;
    } else if (typeof value === "number" && looksLikeDate) {
        value = serialToDate(value);
    }

    if (typeof cell.f === "string" && cell.f.startsWith("=")) {
        // The formula is the user's own; a computed result lets viewers that do not recalculate show a value.
        excelCell.value = value === undefined ? { formula: cell.f.slice(1) } : { formula: cell.f.slice(1), result: value };
    } else if (value !== undefined) {
        // Always a plain value: text that merely starts with "=" is stored as text, never as a formula.
        excelCell.value = value;
    }

    styleToExcel(cell.s, excelCell);
    if (numberFormat) excelCell.numFmt = numberFormat;
}

async function buildXlsxBuffer(state) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Reinsteins Smart Sheets";
    workbook.created = new Date();

    const worksheets = [...state.worksheets].sort((a, b) => a.position - b.position);
    const usedNames = new Set();

    for (const sheet of worksheets) {
        const excelSheet = workbook.addWorksheet(uniqueWorksheetName(sheet.name, usedNames));
        const layout = sheet.layout || {};

        for (const [index, px] of Object.entries(layout.columnWidths || {})) {
            if (typeof px === "number") excelSheet.getColumn(Number(index) + 1).width = pixelsToWidth(px);
        }
        for (const [index, px] of Object.entries(layout.rowHeights || {})) {
            if (typeof px === "number") excelSheet.getRow(Number(index) + 1).height = pixelsToHeight(px);
        }

        for (const { r, c, cell } of sheet.cells) {
            cellToExcel(cell, excelSheet.getCell(r + 1, c + 1));
        }
    }

    if (workbook.worksheets.length === 0) {
        workbook.addWorksheet("Sheet1");
    }

    return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = {
    parseXlsxBuffer,
    buildXlsxBuffer,
    assertLooksLikeXlsx,
    // exposed for tests
    cellFromExcel,
    richTextToPlain,
    dateToSerial,
    serialToDate,
};
