// Smart Sheets -- Excel import / export (ExcelJS): what is preserved, what is reported, what is
// refused. No database. Run: node --test _test_smart_sheets_xlsx.js

const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");

const xlsx = require("./services/smartSheetXlsxService");
const { LIMITS } = require("./utils/smartSheetValidation");

const toBuffer = async (workbook) => Buffer.from(await workbook.xlsx.writeBuffer());
const find = (sheet, r, c) => (sheet.cells.find((e) => e.r === r && e.c === c) || {}).cell;
const rejects = (promise, code) => assert.rejects(promise, (e) => { assert.equal(e.code, code); return true; });

test("values of every kind survive an import", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Types");
    ws.getCell("A1").value = "text";
    ws.getCell("A2").value = 3.14159;
    ws.getCell("A3").value = true;
    ws.getCell("A4").value = false;
    ws.getCell("A5").value = new Date(Date.UTC(2024, 1, 29)); // leap day
    ws.getCell("A6").value = { formula: "A2*2", result: 6.28318 };
    ws.getCell("A7").value = { richText: [{ text: "rich " }, { text: "text", font: { bold: true } }] };
    ws.getCell("A8").value = { text: "link text", hyperlink: "https://example.com" };
    ws.getCell("A9").value = { error: "#DIV/0!" };
    ws.getCell("A10").value = "héllo wörld ✓ 日本語";
    ws.getCell("A11").value = "multi\nline";
    ws.getCell("A12").value = "=NOT A FORMULA";
    ws.getCell("A13").value = 0;
    ws.getCell("A14").value = "";

    const { worksheets, warnings } = await xlsx.parseXlsxBuffer(await toBuffer(wb));
    const sheet = worksheets[0];
    assert.equal(find(sheet, 0, 0).v, "text");
    assert.deepEqual([find(sheet, 1, 0).v, find(sheet, 1, 0).t], [3.14159, 2]);
    assert.deepEqual([find(sheet, 2, 0).v, find(sheet, 2, 0).t], [1, 3]);
    assert.deepEqual([find(sheet, 3, 0).v, find(sheet, 3, 0).t], [0, 3]);
    assert.equal(find(sheet, 4, 0).v, 45351, "2024-02-29 as an Excel serial");
    assert.equal(typeof find(sheet, 4, 0).nf, "string", "a date format is attached so it displays as a date");
    assert.match(find(sheet, 4, 0).nf, /[ymd]/i);
    assert.deepEqual([find(sheet, 5, 0).f, find(sheet, 5, 0).v], ["=A2*2", 6.28318]);
    assert.equal(find(sheet, 6, 0).v, "rich text");
    assert.equal(find(sheet, 7, 0).v, "link text");
    assert.equal(find(sheet, 8, 0).v, "#DIV/0!");
    assert.equal(find(sheet, 9, 0).v, "héllo wörld ✓ 日本語");
    assert.equal(find(sheet, 10, 0).v, "multi\nline");
    assert.deepEqual([find(sheet, 11, 0).v, find(sheet, 11, 0).f], ["=NOT A FORMULA", undefined], "text that starts with = stays text");
    assert.equal(find(sheet, 12, 0).v, 0);
    assert.ok(warnings.some((w) => /rich text/i.test(w)));
});

test("formatting that the editor supports is preserved on import and on export", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Style");
    const cell = ws.getCell("B2");
    cell.value = 1234.5;
    cell.font = { bold: true, italic: true, underline: true, strike: true, size: 14, name: "Arial", color: { argb: "FFFF0000" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = { top: { style: "thin", color: { argb: "FF000000" } }, bottom: { style: "double" }, left: { style: "dashed" }, right: { style: "thick" } };
    cell.numFmt = "#,##0.00";

    const imported = await xlsx.parseXlsxBuffer(await toBuffer(wb));
    const importedCell = find(imported.worksheets[0], 1, 1);
    const s = importedCell.s;
    assert.equal(s.bl, 1);
    assert.equal(s.it, 1);
    assert.deepEqual(s.ul, { s: 1 });
    assert.deepEqual(s.st, { s: 1 });
    assert.equal(s.fs, 14);
    assert.equal(s.ff, "Arial");
    assert.deepEqual(s.cl, { rgb: "#FF0000" });
    assert.deepEqual(s.bg, { rgb: "#FFFF00" });
    assert.equal(s.ht, 2);
    assert.equal(s.vt, 2);
    assert.equal(s.tb, 3);
    assert.equal(importedCell.nf, "#,##0.00", "the number format travels as its own field");
    assert.equal(s.n, undefined);
    assert.equal(s.bd.t.s, 1);
    assert.equal(s.bd.b.s, 7);
    assert.equal(s.bd.l.s, 4);
    assert.equal(s.bd.r.s, 13);

    // and back out again
    const exported = await xlsx.buildXlsxBuffer({ worksheets: [{ key: "k", name: "Style", position: 0, layout: {}, cells: [{ r: 1, c: 1, cell: { v: 1234.5, t: 2, s, nf: importedCell.nf } }] }] });
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(exported);
    const out = reopened.getWorksheet("Style").getCell("B2");
    assert.equal(out.value, 1234.5);
    assert.equal(out.font.bold, true);
    assert.equal(out.font.italic, true);
    assert.equal(out.font.size, 14);
    assert.equal(out.font.name, "Arial");
    assert.equal(out.font.color.argb, "FFFF0000");
    assert.equal(out.fill.fgColor.argb, "FFFFFF00");
    assert.equal(out.alignment.horizontal, "center");
    assert.equal(out.alignment.wrapText, true);
    assert.equal(out.border.bottom.style, "double");
    assert.equal(out.border.right.style, "thick");
    assert.equal(out.numFmt, "#,##0.00");
});

test("worksheet names, order, column widths and row heights survive; names are made valid and unique", async () => {
    const wb = new ExcelJS.Workbook();
    const first = wb.addWorksheet("Zebra");
    wb.addWorksheet("Alpha");
    wb.addWorksheet("Third");
    first.getCell("A1").value = "x";
    first.getColumn(2).width = 30;
    first.getRow(3).height = 45;
    first.getCell("B3").value = "tall";

    const { worksheets } = await xlsx.parseXlsxBuffer(await toBuffer(wb));
    assert.deepEqual(worksheets.map((w) => w.name), ["Zebra", "Alpha", "Third"], "order and names kept");
    assert.ok(worksheets[0].layout.columnWidths[1] >= 200, "30 characters is roughly 215 px");
    assert.ok(worksheets[0].layout.rowHeights[2] >= 55, "45 pt is 60 px");
    assert.equal(worksheets[0].rowCount, LIMITS.DEFAULT_ROWS);
    assert.equal(worksheets[0].columnCount, LIMITS.DEFAULT_COLUMNS);

    // export: names are valid and unique even if the stored state were not
    const out = await xlsx.buildXlsxBuffer({
        worksheets: [
            { key: "1", name: "Dup", position: 1, layout: {}, cells: [] },
            { key: "2", name: "dup", position: 0, layout: { columnWidths: { 0: 215 }, rowHeights: { 0: 40 } }, cells: [{ r: 0, c: 0, cell: { v: 1, t: 2 } }] },
            { key: "3", name: "a/b:c", position: 2, layout: {}, cells: [] },
        ],
    });
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(out);
    assert.deepEqual(reopened.worksheets.map((s) => s.name), ["dup", "Dup (2)", "a_b_c"]);
    assert.ok(Math.abs(reopened.worksheets[0].getColumn(1).width - 30) < 1);
    assert.ok(Math.abs(reopened.worksheets[0].getRow(1).height - 30) < 1);
});

test("big workbooks: a larger sheet round-trips quickly and exactly", async () => {
    const cells = [];
    for (let r = 0; r < 500; r += 1) for (let c = 0; c < 40; c += 1) cells.push({ r, c, cell: r % 2 ? { v: r * c, t: 2 } : { v: `row ${r} col ${c}`, t: 1 } });
    const started = Date.now();
    const buffer = await xlsx.buildXlsxBuffer({ worksheets: [{ key: "k", name: "Big", position: 0, layout: {}, cells }] });
    const { worksheets } = await xlsx.parseXlsxBuffer(buffer);
    const elapsed = Date.now() - started;
    assert.equal(worksheets[0].cells.length, 20000);
    assert.equal(find(worksheets[0], 499, 39).v, 499 * 39);
    assert.equal(find(worksheets[0], 498, 0).v, "row 498 col 0");
    assert.ok(elapsed < 15000, `20k cells took ${elapsed} ms`);
});

test("features the editor cannot keep are REPORTED on import, never silently dropped", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Fancy");
    ws.getCell("A1").value = "merged title";
    ws.mergeCells("A1:C1");
    ws.getCell("A3").value = 5;
    ws.getCell("A3").note = "a comment";
    ws.getCell("A4").value = "x";
    ws.getCell("A4").dataValidation = { type: "list", allowBlank: true, formulae: ['"a,b,c"'] };
    ws.addConditionalFormatting({ ref: "A3:A3", rules: [{ type: "cellIs", operator: "greaterThan", formulae: [1], style: { font: { bold: true } } }] });
    wb.addWorksheet("Hidden").state = "hidden";
    ws.getCell("A5").font = { color: { theme: 4 } };
    ws.getCell("A5").value = "themed";

    const { warnings, worksheets } = await xlsx.parseXlsxBuffer(await toBuffer(wb));
    const text = warnings.join(" | ");
    for (const expected of [/merged/i, /comment/i, /data validation/i, /conditional formatting/i, /hidden/i, /theme/i]) {
        assert.match(text, expected);
    }
    assert.equal(worksheets.length, 2, "the content itself was still imported");
    assert.equal(find(worksheets[0], 0, 0).v, "merged title");

    const plain = new ExcelJS.Workbook();
    plain.addWorksheet("Plain").getCell("A1").value = "ok";
    assert.deepEqual((await xlsx.parseXlsxBuffer(await toBuffer(plain))).warnings, [], "a simple workbook produces no warnings");
});

test("files that are not usable workbooks are refused with a specific error", async () => {
    await rejects(xlsx.parseXlsxBuffer(Buffer.alloc(0)), "INVALID_XLSX");
    await rejects(xlsx.parseXlsxBuffer(Buffer.from("PK")), "INVALID_XLSX");
    await rejects(xlsx.parseXlsxBuffer(Buffer.from("plain text, not a workbook")), "INVALID_XLSX");
    await rejects(xlsx.parseXlsxBuffer(Buffer.from("<html><body>hi</body></html>")), "INVALID_XLSX");
    await rejects(xlsx.parseXlsxBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])), "INVALID_XLSX"); // JPEG
    await rejects(xlsx.parseXlsxBuffer(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), "UNSUPPORTED_XLSX"); // .xls / password-protected
    await rejects(xlsx.parseXlsxBuffer(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100, 7)])), "INVALID_XLSX"); // zip header, garbage body
    await rejects(xlsx.parseXlsxBuffer(null), "INVALID_XLSX");
    await rejects(xlsx.parseXlsxBuffer("PK\u0003\u0004"), "INVALID_XLSX");

    const good = await toBuffer((() => { const wb = new ExcelJS.Workbook(); wb.addWorksheet("S").getCell("A1").value = 1; return wb; })());
    await rejects(xlsx.parseXlsxBuffer(good.subarray(0, Math.floor(good.length / 2))), "INVALID_XLSX"); // truncated download
});

test("size limits: too many worksheets, rows or columns are refused", async () => {
    const many = new ExcelJS.Workbook();
    for (let i = 0; i < LIMITS.MAX_WORKSHEETS + 1; i += 1) many.addWorksheet(`S${i}`).getCell("A1").value = i;
    await rejects(xlsx.parseXlsxBuffer(await toBuffer(many)), "TOO_MANY_WORKSHEETS");

    const tall = new ExcelJS.Workbook();
    tall.addWorksheet("Tall").getCell(`A${LIMITS.MAX_ROWS + 1}`).value = "far below";
    await rejects(xlsx.parseXlsxBuffer(await toBuffer(tall)), "WORKSHEET_TOO_LARGE");

    const wide = new ExcelJS.Workbook();
    wide.addWorksheet("Wide").getCell(1, LIMITS.MAX_COLUMNS + 1).value = "far right";
    await rejects(xlsx.parseXlsxBuffer(await toBuffer(wide)), "WORKSHEET_TOO_LARGE");

    const edge = new ExcelJS.Workbook();
    edge.addWorksheet("Edge").getCell(LIMITS.MAX_ROWS, LIMITS.MAX_COLUMNS).value = "last allowed cell";
    const { worksheets } = await xlsx.parseXlsxBuffer(await toBuffer(edge));
    assert.deepEqual([worksheets[0].rowCount, worksheets[0].columnCount], [LIMITS.MAX_ROWS, LIMITS.MAX_COLUMNS]);
});

test("a cell at Excel's own maximum text length imports intact", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("S").getCell("A1").value = "x".repeat(32767); // Excel's own maximum: fine
    assert.equal(find((await xlsx.parseXlsxBuffer(await toBuffer(wb))).worksheets[0], 0, 0).v.length, 32767);
});

test("EXPORT never turns data into formulas, and a missing result still exports the formula", async () => {
    const buffer = await xlsx.buildXlsxBuffer({
        worksheets: [{
            key: "k", name: "Safe", position: 0, layout: {},
            cells: [
                { r: 0, c: 0, cell: { v: "=1+1", t: 1 } },
                { r: 1, c: 0, cell: { v: "+SUM(A1)", t: 1 } },
                { r: 2, c: 0, cell: { v: "@cmd", t: 1 } },
                { r: 3, c: 0, cell: { f: "=SUM(1,2)" } },
                { r: 4, c: 0, cell: { f: "=SUM(1,2)", v: 3, t: 2 } },
                { r: 5, c: 0, cell: { p: { body: { dataStream: "rich\r\n" } } } },
                { r: 6, c: 0, cell: { v: 1, t: 3 } },
            ],
        }],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet("Safe");
    assert.equal(ws.getCell("A1").type, ExcelJS.ValueType.String);
    assert.equal(ws.getCell("A1").value, "=1+1");
    assert.equal(ws.getCell("A2").type, ExcelJS.ValueType.String);
    assert.equal(ws.getCell("A3").type, ExcelJS.ValueType.String);
    assert.equal(ws.getCell("A4").formula, "SUM(1,2)");
    assert.equal(ws.getCell("A5").result, 3);
    assert.equal(ws.getCell("A6").value, "rich");
    assert.equal(ws.getCell("A7").value, true);

    const empty = await xlsx.buildXlsxBuffer({ worksheets: [] });
    const emptyBook = new ExcelJS.Workbook();
    await emptyBook.xlsx.load(empty);
    assert.equal(emptyBook.worksheets.length, 1, "an export always has at least one worksheet");
});

test("dates and booleans keep their meaning through a full import -> export -> import cycle", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Cycle");
    ws.getCell("A1").value = new Date(Date.UTC(2020, 11, 31));
    ws.getCell("A2").value = true;
    ws.getCell("A3").value = 0.1 + 0.2;
    const first = await xlsx.parseXlsxBuffer(await toBuffer(wb));
    const second = await xlsx.parseXlsxBuffer(await xlsx.buildXlsxBuffer({ worksheets: first.worksheets.map((w, i) => ({ ...w, key: `k${i}`, position: i })) }));
    assert.deepEqual(find(second.worksheets[0], 0, 0).v, find(first.worksheets[0], 0, 0).v);
    assert.deepEqual(find(second.worksheets[0], 1, 0).v, 1);
    assert.equal(find(second.worksheets[0], 1, 0).t, 3);
    assert.equal(find(second.worksheets[0], 2, 0).v, 0.1 + 0.2);
    assert.equal(xlsx.dateToSerial(xlsx.serialToDate(45351)), 45351);
});
