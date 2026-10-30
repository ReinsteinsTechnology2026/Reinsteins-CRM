// Smart Sheets -- the REST API over real HTTP: the real Express router, controller, upload
// middleware (pointed at a temp directory) and service, with fake authentication and an in-memory
// store. Run: node --test _test_smart_sheets_http.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ExcelJS = require("exceljs");

const { createMemoryStore, startHttpHarness } = require("./_smart_sheets_test_support");
const tenantUploadPath = require("./utils/tenantUploadPath");
const { uploadSmartSheetFile } = require("./middleware/smartSheetUploadMiddleware");
const { LIMITS } = require("./utils/smartSheetValidation");

const SUPER = 1;
const EMP_A = 2;
const EMP_B = 3;
const EMP_C = 4;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const accounts = () => [
    { id: SUPER, full_name: "Super", role: "admin", system_access: "super_admin" },
    { id: EMP_A, full_name: "Emp A" },
    { id: EMP_B, full_name: "Emp B" },
    { id: EMP_C, full_name: "Emp C" },
];

// All uploads go to a throw-away directory; the real function is substituted for the test only.
async function withHarness(run) {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-sheets-test-"));
    const original = tenantUploadPath.tenantUploadAbsoluteDir;
    tenantUploadPath.tenantUploadAbsoluteDir = () => uploadDir;
    const store = createMemoryStore(accounts());
    const harness = await startHttpHarness(store, { upload: uploadSmartSheetFile });
    try {
        await run({ harness, store, uploadDir, files: () => fs.readdirSync(uploadDir) });
    } finally {
        await harness.close();
        tenantUploadPath.tenantUploadAbsoluteDir = original;
        fs.rmSync(uploadDir, { recursive: true, force: true });
    }
}

async function sampleWorkbook() {
    const workbook = new ExcelJS.Workbook();
    const sales = workbook.addWorksheet("Sales");
    sales.getCell("A1").value = "Region";
    sales.getCell("A1").font = { bold: true };
    sales.getCell("B1").value = "Total";
    sales.getCell("A2").value = "North";
    sales.getCell("B2").value = 120.5;
    sales.getCell("B3").value = { formula: "B2*2", result: 241 };
    sales.mergeCells("D1:E1");
    sales.getColumn(1).width = 20;
    workbook.addWorksheet("Notes").getCell("A1").value = "second tab";
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

const uploadForm = (buffer, filename = "book.xlsx", fields = {}) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append("file", new Blob([buffer], { type: XLSX_MIME }), filename);
    return form;
};

test("every route requires authentication", async () => {
    await withHarness(async ({ harness }) => {
        for (const [method, url] of [["GET", "/"], ["POST", "/"], ["GET", "/1"], ["GET", "/1/workbook"], ["GET", "/1/export"], ["PUT", "/1/access"], ["DELETE", "/1"]]) {
            const res = await harness.request(method, url, { body: method === "GET" ? undefined : {} });
            assert.equal(res.status, 401, `${method} ${url}`);
        }
    });
});

test("only the admin tier reaches the management routes; employees get 403 and nothing is written", async () => {
    await withHarness(async ({ harness, store, files }) => {
        const id = (await harness.service.createBlankSheet(SUPER, "Sheet")).id;
        await harness.service.assign(SUPER, id, { userIds: [EMP_A], permission: "edit" });
        const before = store.sheets.size;

        const forbidden = [
            ["POST", "/", { name: "x" }],
            ["GET", "/assignable-employees"],
            ["PATCH", `/${id}`, { name: "hacked" }],
            ["DELETE", `/${id}`],
            ["GET", `/${id}/access`],
            ["PUT", `/${id}/access`, { userIds: [EMP_B] }],
            ["DELETE", `/${id}/access/${EMP_A}`],
        ];
        for (const [method, url, body] of forbidden) {
            const res = await harness.request(method, url, { user: EMP_A, body });
            assert.equal(res.status, 403, `${method} ${url}`);
        }
        const upload = await harness.request("POST", "/import", { user: EMP_A, raw: uploadForm(await sampleWorkbook()) });
        assert.equal(upload.status, 403);
        assert.deepEqual(files(), [], "an employee's upload never reaches the disk");
        assert.equal(store.sheets.size, before);
        assert.equal((await harness.service.getSheet(SUPER, id)).sheet.name, "Sheet");
    });
});

test("admin: create, list, open, rename, archive, restore, delete", async () => {
    await withHarness(async ({ harness }) => {
        const created = await harness.request("POST", "/", { user: SUPER, body: { name: "  My   sheet " } });
        assert.equal(created.status, 201);
        assert.equal(created.data.success, true);
        assert.equal(created.data.name, "My sheet");
        const id = created.data.id;

        const bad = await harness.request("POST", "/", { user: SUPER, body: { name: "" } });
        assert.equal(bad.status, 400);
        assert.equal(bad.data.code, "INVALID_NAME");

        const list = await harness.request("GET", "/", { user: SUPER });
        assert.equal(list.data.canManage, true);
        assert.deepEqual(list.data.sheets.map((s) => s.name), ["My sheet"]);

        const opened = await harness.request("GET", `/${id}/workbook`, { user: SUPER });
        assert.equal(opened.status, 200);
        assert.equal(opened.headers.get("cache-control"), "no-store");
        assert.equal(opened.data.permission, "edit");

        assert.equal((await harness.request("PATCH", `/${id}`, { user: SUPER, body: { name: "Renamed" } })).data.name, "Renamed");
        assert.equal((await harness.request("PATCH", `/${id}`, { user: SUPER, body: { status: "archived" } })).data.status, "archived");
        assert.equal((await harness.request("GET", `/${id}`, { user: SUPER })).data.sheet.status, "archived");
        assert.equal((await harness.request("PATCH", `/${id}`, { user: SUPER, body: { status: "active" } })).data.status, "active");
        assert.equal((await harness.request("PATCH", `/${id}`, { user: SUPER, body: { status: "weird" } })).status, 400);
        assert.equal((await harness.request("PATCH", `/${id}`, { user: SUPER, body: {} })).status, 400);

        assert.equal((await harness.request("DELETE", `/${id}`, { user: SUPER })).status, 200);
        assert.equal((await harness.request("GET", `/${id}`, { user: SUPER })).status, 404);
        assert.deepEqual((await harness.request("GET", "/", { user: SUPER })).data.sheets, []);
    });
});

test("employees see only assigned sheets and cannot reach others by guessing ids", async () => {
    await withHarness(async ({ harness }) => {
        const mine = (await harness.service.createBlankSheet(SUPER, "Mine")).id;
        const secret = (await harness.service.createBlankSheet(SUPER, "Secret")).id;
        await harness.service.assign(SUPER, mine, { userIds: [EMP_A], permission: "edit" });

        const list = await harness.request("GET", "/", { user: EMP_A });
        assert.deepEqual(list.data.sheets.map((s) => s.name), ["Mine"]);
        assert.equal(list.data.canManage, false);

        for (const suffix of ["", "/workbook", "/export"]) {
            const guessed = await harness.request("GET", `/${secret}${suffix}`, { user: EMP_A });
            const missing = await harness.request("GET", `/424242${suffix}`, { user: EMP_A });
            assert.equal(guessed.status, 404, `guess ${suffix}`);
            if (suffix !== "/export") assert.deepEqual(guessed.data, missing.data, "indistinguishable from a non-existent id");
        }
        assert.equal((await harness.request("GET", `/${mine}/workbook`, { user: EMP_A })).status, 200);
        assert.equal((await harness.request("GET", `/${mine}`, { user: EMP_C })).status, 404);

        for (const bad of ["abc", "0", "-5", "1.5", "1e3", "9999999999999", "%20", "1%3BDROP"]) {
            const res = await harness.request("GET", `/${bad}`, { user: EMP_A });
            assert.ok([400, 404].includes(res.status), `${bad} -> ${res.status}`);
            assert.notEqual(res.status, 500);
        }
    });
});

test("assigning and unassigning over HTTP", async () => {
    await withHarness(async ({ harness }) => {
        const id = (await harness.service.createBlankSheet(SUPER, "Team")).id;

        const search = await harness.request("GET", "/assignable-employees?q=emp", { user: SUPER });
        assert.deepEqual(search.data.employees.map((e) => e.id).sort(), [EMP_A, EMP_B, EMP_C]);

        const assigned = await harness.request("PUT", `/${id}/access`, { user: SUPER, body: { userIds: [EMP_A, EMP_B], permission: "edit" } });
        assert.equal(assigned.status, 200);
        assert.deepEqual(assigned.data.granted.sort(), [EMP_A, EMP_B]);
        assert.equal((await harness.request("GET", `/${id}/access`, { user: SUPER })).data.access.length, 2);
        assert.equal((await harness.request("GET", `/${id}/workbook`, { user: EMP_A })).status, 200);

        assert.equal((await harness.request("PUT", `/${id}/access`, { user: SUPER, body: { userIds: [] } })).status, 400);
        assert.equal((await harness.request("PUT", `/${id}/access`, { user: SUPER, body: { userIds: [EMP_C], permission: "root" } })).status, 400);
        assert.equal((await harness.request("PUT", `/${id}/access`, { user: SUPER, body: "not json", headers: { "Content-Type": "application/json" }, raw: "{bad" })).status, 400);

        const removed = await harness.request("DELETE", `/${id}/access/${EMP_A}`, { user: SUPER });
        assert.equal(removed.status, 200);
        assert.equal((await harness.request("GET", `/${id}/workbook`, { user: EMP_A })).status, 404, "revoked access is refused immediately");
        assert.equal((await harness.request("GET", `/${id}/workbook`, { user: EMP_B })).status, 200);
        assert.equal((await harness.request("DELETE", `/${id}/access/${EMP_A}`, { user: SUPER })).status, 404);
    });
});

test("the controller tells Socket.IO to evict sockets when access is removed, archived or deleted", async () => {
    await withHarness(async ({ harness }) => {
        const log = [];
        harness.app.set("io", {
            to: (room) => ({ emit: (event, payload) => log.push(["emit", room, event, payload]) }),
            in: (room) => ({ socketsLeave: (target) => log.push(["leave", room, target]), fetchSockets: async () => [] }),
        });
        const id = (await harness.service.createBlankSheet(SUPER, "Evict")).id;
        await harness.service.assign(SUPER, id, { userIds: [EMP_A, EMP_B], permission: "edit" });
        const room = `tenant:reinsteins:smartsheet:${id}`;

        await harness.request("PUT", `/${id}/access`, { user: SUPER, body: { userIds: [EMP_A], permission: "view" } });
        assert.ok(log.some(([k, r, e, p]) => k === "emit" && r === `tenant:reinsteins:user:${EMP_A}` && e === "smartsheet:access-changed" && p.permission === "view"));

        log.length = 0;
        await harness.request("DELETE", `/${id}/access/${EMP_A}`, { user: SUPER });
        assert.ok(log.some(([k, r, e, p]) => k === "emit" && r === `tenant:reinsteins:user:${EMP_A}` && e === "smartsheet:access-revoked" && p.reason === "unassigned"));
        assert.ok(log.some(([k, r, target]) => k === "leave" && r === `tenant:reinsteins:user:${EMP_A}` && target === room), "the user's sockets leave the spreadsheet room");

        log.length = 0;
        await harness.request("PATCH", `/${id}`, { user: SUPER, body: { status: "archived" } });
        assert.ok(log.some(([k, r, e, p]) => k === "emit" && r === room && e === "smartsheet:access-revoked" && p.reason === "archived"));
        assert.ok(log.some(([k, r, target]) => k === "leave" && r === room && target === room));

        log.length = 0;
        await harness.request("PATCH", `/${id}`, { user: SUPER, body: { name: "just a rename" } });
        assert.deepEqual(log, [], "a rename must not disturb collaborators");

        await harness.request("PATCH", `/${id}`, { user: SUPER, body: { status: "active" } });
        log.length = 0;
        await harness.request("DELETE", `/${id}`, { user: SUPER });
        assert.ok(log.some(([k, r, e, p]) => k === "emit" && r === room && e === "smartsheet:access-revoked" && p.reason === "deleted"));

        // a rejected request evicts nobody
        log.length = 0;
        await harness.request("DELETE", `/${id}/access/${EMP_B}`, { user: EMP_B });
        await harness.request("PATCH", `/${id}`, { user: EMP_B, body: { status: "archived" } });
        assert.deepEqual(log, []);
    });
});

test("IMPORT: a valid .xlsx becomes a spreadsheet with its worksheets, values, formulas, formatting and widths", async () => {
    await withHarness(async ({ harness, files }) => {
        const res = await harness.request("POST", "/import", { user: SUPER, raw: uploadForm(await sampleWorkbook(), "Quarterly Report.xlsx") });
        assert.equal(res.status, 201);
        assert.equal(res.data.name, "Quarterly Report", "named after the file when no name is given");
        assert.equal(res.data.worksheetCount, 2);
        assert.ok(res.data.warnings.some((w) => /merged/i.test(w)), "the merged range is reported, not silently dropped");

        const stored = files();
        assert.equal(stored.length, 1);
        assert.match(stored[0], /^\d+-[0-9a-f]{16}\.xlsx$/, "random stored name; the client's file name is never a path");

        const opened = await harness.request("GET", `/${res.data.id}/workbook`, { user: SUPER });
        const { workbook } = opened.data;
        assert.deepEqual(workbook.sheetOrder.map((k) => workbook.sheets[k].name), ["Sales", "Notes"]);
        const sales = workbook.sheets[workbook.sheetOrder[0]];
        assert.equal(sales.cellData[0][0].v, "Region");
        assert.equal(sales.cellData[0][0].s.bl, 1);
        assert.equal(sales.cellData[1][1].v, 120.5);
        assert.equal(sales.cellData[2][1].f, "=B2*2");
        assert.equal(sales.cellData[2][1].v, 241);
        assert.ok(sales.columnData[0].w >= 100, "column width kept");
        assert.equal(workbook.sheets[workbook.sheetOrder[1]].cellData[0][0].v, "second tab");

        const meta = await harness.request("GET", `/${res.data.id}`, { user: SUPER });
        assert.equal(meta.data.sheet.source_file_name, "Quarterly Report.xlsx");

        // and the admin's explicit name wins
        const named = await harness.request("POST", "/import", { user: SUPER, raw: uploadForm(await sampleWorkbook(), "x.xlsx", { name: "Chosen name" }) });
        assert.equal(named.data.name, "Chosen name");
    });
});

test("IMPORT validation: extension, real content, size and missing file are all rejected cleanly", async () => {
    await withHarness(async ({ harness, store, files }) => {
        const post = (form) => harness.request("POST", "/import", { user: SUPER, raw: form });

        const wrongExtension = await post(uploadForm(await sampleWorkbook(), "book.xls"));
        assert.equal(wrongExtension.status, 400);
        assert.equal(wrongExtension.data.code, "INVALID_FILE");
        assert.equal((await post(uploadForm(await sampleWorkbook(), "book.xlsm"))).status, 400);
        assert.equal((await post(uploadForm(Buffer.from("a,b\n1,2"), "data.csv"))).status, 400);
        assert.equal((await post(uploadForm(await sampleWorkbook(), "evil.xlsx.exe"))).status, 400);

        const noFile = await harness.request("POST", "/import", { user: SUPER, raw: new FormData() });
        assert.equal(noFile.status, 400);
        assert.equal(noFile.data.code, "FILE_REQUIRED");

        // right extension, wrong content (a renamed text file / a renamed PNG)
        const fakeText = await post(uploadForm(Buffer.from("this is not an excel file"), "fake.xlsx"));
        assert.equal(fakeText.status, 400);
        assert.equal(fakeText.data.code, "INVALID_XLSX");
        const fakePng = await post(uploadForm(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]), "fake.xlsx"));
        assert.equal(fakePng.data.code, "INVALID_XLSX");

        // a ZIP that is not a workbook, and a legacy / password-protected container
        const emptyZip = await post(uploadForm(Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]), "empty.xlsx"));
        assert.equal(emptyZip.status, 400);
        const encrypted = await post(uploadForm(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), "locked.xlsx"));
        assert.equal(encrypted.status, 400);
        assert.equal(encrypted.data.code, "UNSUPPORTED_XLSX");

        const tooBig = await post(uploadForm(Buffer.alloc(LIMITS.MAX_UPLOAD_BYTES + 1024, 0x50), "big.xlsx"));
        assert.equal(tooBig.status, 413);
        assert.equal(tooBig.data.code, "FILE_TOO_LARGE");

        assert.equal(store.sheets.size, 0, "no spreadsheet was created by any rejected upload");
        assert.deepEqual(files(), [], "no rejected file was left on disk");
    });
});

test("IMPORT: a workbook that holds a DDE-style formula is refused with a clear error", async () => {
    await withHarness(async ({ harness, store, files }) => {
        const workbook = new ExcelJS.Workbook();
        workbook.addWorksheet("S").getCell("A1").value = { formula: "cmd|'/c calc'!A0" };
        const res = await harness.request("POST", "/import", { user: SUPER, raw: uploadForm(Buffer.from(await workbook.xlsx.writeBuffer())) });
        assert.equal(res.status, 400);
        assert.equal(res.data.code, "INVALID_CELL");
        assert.equal(store.sheets.size, 0);
        assert.deepEqual(files(), []);
    });
});

test("EXPORT: the edited spreadsheet downloads as a valid .xlsx that keeps tab names and data", async () => {
    await withHarness(async ({ harness }) => {
        const imported = await harness.request("POST", "/import", { user: SUPER, raw: uploadForm(await sampleWorkbook(), "Report.xlsx") });
        const id = imported.data.id;
        await harness.service.assign(SUPER, id, { userIds: [EMP_A], permission: "edit" });
        const ws = (await harness.service.getWorkbook(SUPER, id)).workbook.sheetOrder[0];
        await harness.service.applyOperation(EMP_A, id, { type: "cells", ws, cells: [{ r: 4, c: 0, cell: { v: "added by employee", t: 1, s: { bl: 1 } } }] });
        await harness.service.applyOperation(EMP_A, id, { type: "addWorksheet", ws: "tab9", name: "Added tab" });

        for (const user of [SUPER, EMP_A]) {
            const res = await harness.request("GET", `/${id}/export`, { user });
            assert.equal(res.status, 200);
            assert.equal(res.headers.get("content-type"), XLSX_MIME);
            assert.match(res.headers.get("content-disposition"), /^attachment; filename="Report\.xlsx"; filename\*=UTF-8''Report\.xlsx$/);
            assert.equal(res.headers.get("cache-control"), "no-store");

            const book = new ExcelJS.Workbook();
            await book.xlsx.load(res.data);
            assert.deepEqual(book.worksheets.map((s) => s.name), ["Sales", "Notes", "Added tab"]);
            const sales = book.getWorksheet("Sales");
            assert.equal(sales.getCell("A1").value, "Region");
            assert.equal(sales.getCell("A1").font.bold, true);
            assert.equal(sales.getCell("B2").value, 120.5);
            assert.equal(sales.getCell("B3").formula, "B2*2");
            assert.equal(sales.getCell("A5").value, "added by employee");
        }

        assert.equal((await harness.request("GET", `/${id}/export`, { user: EMP_C })).status, 404);
    });
});

test("unexpected failures return a generic 500 and never leak internals", async () => {
    await withHarness(async ({ harness, store }) => {
        store.listSheetsForAdmin = async () => {
            throw new Error("connection to 10.0.0.5:5432 refused; password=hunter2");
        };
        const originalError = console.error;
        console.error = () => {};
        try {
            const res = await harness.request("GET", "/", { user: SUPER });
            assert.equal(res.status, 500);
            assert.equal(res.data.code, "SERVER_ERROR");
            assert.doesNotMatch(JSON.stringify(res.data), /10\.0\.0\.5|hunter2|password|connection/);
        } finally {
            console.error = originalError;
        }
    });
});
