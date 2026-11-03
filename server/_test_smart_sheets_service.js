// Smart Sheets -- business rules: who may create / assign / open / edit, persistence and retrieval,
// archive / delete, and the validation + access-policy units. Real service code on an in-memory
// store (no database). Run: node --test _test_smart_sheets_service.js

const test = require("node:test");
const assert = require("node:assert/strict");

const { createMemoryStore } = require("./_smart_sheets_test_support");
const { createSmartSheetService, toUniverWorkbook, safeFileName } = require("./services/smartSheetService");
const { resolveAccess, isAdminTier } = require("./utils/smartSheetAccess");
const {
    LIMITS,
    sanitizeCell,
    validateOperation,
    validateSheetName,
    validateWorksheetName,
    parseSheetId,
} = require("./utils/smartSheetValidation");
const { SmartSheetError } = require("./utils/smartSheetErrors");

const SUPER = 1; // role admin + system_access super_admin
const ADMIN_BY_ACCESS = 2; // role employee but system_access admin
const EMP_A = 3;
const EMP_B = 4;
const EMP_C = 5; // never assigned
const MANAGER = 6;
const HR = 7;
const INACTIVE_ADMIN = 8;

function build() {
    const store = createMemoryStore([
        { id: SUPER, full_name: "Super", role: "admin", system_access: "super_admin" },
        { id: ADMIN_BY_ACCESS, full_name: "Admin By Access", role: "employee", system_access: "admin" },
        { id: EMP_A, full_name: "Emp A" },
        { id: EMP_B, full_name: "Emp B" },
        { id: EMP_C, full_name: "Emp C" },
        { id: MANAGER, full_name: "Manager", system_access: "manager" },
        { id: HR, full_name: "HR", system_access: "hr" },
        { id: INACTIVE_ADMIN, full_name: "Gone", role: "admin", system_access: "super_admin", employment_status: "resigned" },
    ]);
    return { store, service: createSmartSheetService({ store }) };
}

const rejects = (promise, code, status) =>
    assert.rejects(promise, (error) => {
        assert.ok(error instanceof SmartSheetError, `expected SmartSheetError, got ${error && error.stack}`);
        assert.equal(error.code, code);
        if (status) assert.equal(error.status, status);
        return true;
    });

const wsKey = async (service, user, id) => (await service.getWorkbook(user, id)).workbook.sheetOrder[0];
const cells = (ws, ...entries) => ({ type: "cells", ws, cells: entries.map(([r, c, cell]) => ({ r, c, cell })) });

// ---------------------------------------------------------------- creation

test("Super Admin and Admin create a blank spreadsheet with one worksheet", async () => {
    const { service } = build();
    for (const admin of [SUPER, ADMIN_BY_ACCESS]) {
        const { id, name } = await service.createBlankSheet(admin, "  Q3   Budget  ");
        assert.equal(name, "Q3 Budget", "whitespace is normalised");
        const opened = await service.getWorkbook(admin, id);
        assert.equal(opened.permission, "edit");
        assert.equal(opened.canManage, true);
        const sheetNames = opened.workbook.sheetOrder.map((key) => opened.workbook.sheets[key].name);
        assert.deepEqual(sheetNames, ["Sheet1"]);
        assert.equal(opened.workbook.sheets[opened.workbook.sheetOrder[0]].rowCount, LIMITS.DEFAULT_ROWS);
        assert.equal(opened.revision, 0);
    }
});

test("employees, managers and HR cannot create spreadsheets; an inactive admin cannot either", async () => {
    const { service } = build();
    for (const user of [EMP_A, MANAGER, HR]) {
        await rejects(service.createBlankSheet(user, "Nope"), "FORBIDDEN", 403);
    }
    await rejects(service.createBlankSheet(INACTIVE_ADMIN, "Nope"), "UNAUTHENTICATED", 401);
    await rejects(service.createBlankSheet(9999, "Nope"), "UNAUTHENTICATED", 401);
});

test("spreadsheet names are validated", async () => {
    const { service } = build();
    for (const bad of ["", "   ", undefined, null, 7, "x".repeat(151), "bad\u0000name", "bell\u0007"]) {
        await rejects(service.createBlankSheet(SUPER, bad), "INVALID_NAME", 400);
    }
    assert.equal((await service.createBlankSheet(SUPER, "x".repeat(150))).name.length, 150);
    assert.equal((await service.createBlankSheet(SUPER, "line\n\tbreak")).name, "line break", "any whitespace run becomes one space");
});

// ---------------------------------------------------------------- assignment + listing scope

test("an Admin assigns employees; each employee sees ONLY the spreadsheets assigned to them", async () => {
    const { service } = build();
    const a = (await service.createBlankSheet(SUPER, "For A")).id;
    const b = (await service.createBlankSheet(SUPER, "For B")).id;
    const both = (await service.createBlankSheet(SUPER, "For both")).id;
    await service.createBlankSheet(SUPER, "For nobody");

    await service.assign(SUPER, a, { userIds: [EMP_A], permission: "edit" });
    await service.assign(SUPER, b, { userIds: [EMP_B], permission: "view" });
    await service.assign(SUPER, both, { userIds: [EMP_A, EMP_B], permission: "edit" });

    const names = async (user) => (await service.listSheets(user)).sheets.map((s) => s.name).sort();
    assert.deepEqual(await names(EMP_A), ["For A", "For both"]);
    assert.deepEqual(await names(EMP_B), ["For B", "For both"]);
    assert.deepEqual(await names(EMP_C), []);
    assert.deepEqual(await names(MANAGER), []);

    const admin = await service.listSheets(SUPER);
    assert.equal(admin.canManage, true);
    assert.deepEqual(admin.sheets.map((s) => s.name).sort(), ["For A", "For B", "For both", "For nobody"]);
    assert.equal(admin.sheets.find((s) => s.name === "For both").assigned_count, 2);
    assert.equal((await service.listSheets(EMP_A)).canManage, false);
    assert.equal((await service.listSheets(EMP_A)).sheets.find((s) => s.name === "For A").permission, "edit");
});

test("only the admin tier can assign, unassign, rename, archive, delete or list who has access", async () => {
    const { service } = build();
    const id = (await service.createBlankSheet(SUPER, "Mgmt")).id;
    await service.assign(SUPER, id, { userIds: [EMP_A], permission: "edit" });

    for (const user of [EMP_A, MANAGER, HR]) {
        const label = `user ${user}`;
        await rejects(service.assign(user, id, { userIds: [EMP_B] }), user === EMP_A ? "FORBIDDEN" : "NOT_FOUND", user === EMP_A ? 403 : 404);
        if (user === EMP_A) {
            await rejects(service.revoke(user, id, EMP_A), "FORBIDDEN");
            await rejects(service.updateSheet(user, id, { name: "Hacked" }), "FORBIDDEN");
            await rejects(service.updateSheet(user, id, { status: "archived" }), "FORBIDDEN");
            await rejects(service.deleteSheet(user, id), "FORBIDDEN");
            await rejects(service.listAccess(user, id), "FORBIDDEN");
        }
        await rejects(service.searchEmployees(user, "a"), "FORBIDDEN", 403);
        assert.ok(label);
    }
    assert.equal((await service.getSheet(SUPER, id)).sheet.name, "Mgmt", "nothing changed");
    assert.equal((await service.listAccess(SUPER, id)).access.length, 1);
});

test("assignment input is validated; inactive accounts are skipped; re-assigning changes the permission", async () => {
    const { service, store } = build();
    const id = (await service.createBlankSheet(SUPER, "Validation")).id;

    await rejects(service.assign(SUPER, id, { userIds: [] }), "INVALID_USERS");
    await rejects(service.assign(SUPER, id, { userIds: "3" }), "INVALID_USERS");
    await rejects(service.assign(SUPER, id, { userIds: [0] }), "INVALID_USERS");
    await rejects(service.assign(SUPER, id, { userIds: ["3; DROP TABLE users"] }), "INVALID_USERS");
    await rejects(service.assign(SUPER, id, { userIds: Array.from({ length: 201 }, (_, i) => i + 1) }), "INVALID_USERS");
    await rejects(service.assign(SUPER, id, { userIds: [EMP_A], permission: "owner" }), "INVALID_PERMISSION");
    assert.equal((await service.listAccess(SUPER, id)).access.length, 0, "rejected requests assigned nobody");

    const result = await service.assign(SUPER, id, { userIds: [EMP_A, EMP_A, INACTIVE_ADMIN, 424242], permission: "view" });
    assert.deepEqual(result.granted, [EMP_A]);
    assert.deepEqual(result.skipped.sort((x, y) => x - y), [INACTIVE_ADMIN, 424242].sort((x, y) => x - y));

    await service.assign(SUPER, id, { userIds: [EMP_A], permission: "edit" });
    assert.equal(store.sheets.size, 1);
    assert.deepEqual((await service.listAccess(SUPER, id)).access.map((x) => x.permission), ["edit"]);
});

// ---------------------------------------------------------------- unauthorized / revoked

test("UNAUTHORIZED employee: cannot read, open, export or edit an unassigned spreadsheet by guessing its id", async () => {
    const { service } = build();
    const id = (await service.createBlankSheet(SUPER, "Private")).id;
    const ws = await wsKey(service, SUPER, id);
    await service.assign(SUPER, id, { userIds: [EMP_A], permission: "edit" });

    const attempts = {
        getSheet: () => service.getSheet(EMP_C, id),
        getWorkbook: () => service.getWorkbook(EMP_C, id),
        exportXlsx: () => service.exportXlsx(EMP_C, id),
        authorizeJoin: () => service.authorizeJoin(EMP_C, id),
        applyOperation: () => service.applyOperation(EMP_C, id, cells(ws, [0, 0, { v: "x" }])),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
        await rejects(attempt(), "NOT_FOUND", 404);
        assert.ok(name);
    }

    // identical to asking for an id that does not exist at all
    const real = await service.getWorkbook(EMP_C, id).catch((e) => e);
    const missing = await service.getWorkbook(EMP_C, 424242).catch((e) => e);
    assert.deepEqual({ code: real.code, status: real.status, message: real.message }, { code: missing.code, status: missing.status, message: missing.message });
});

test("REVOKED access is rejected everywhere, at once", async () => {
    const { service } = build();
    const id = (await service.createBlankSheet(SUPER, "Revocable")).id;
    const ws = await wsKey(service, SUPER, id);
    await service.assign(SUPER, id, { userIds: [EMP_A, EMP_B], permission: "edit" });
    assert.equal((await service.applyOperation(EMP_A, id, cells(ws, [0, 0, { v: "mine" }]))).revision, 1);

    await service.revoke(SUPER, id, EMP_A);

    await rejects(service.getWorkbook(EMP_A, id), "NOT_FOUND");
    await rejects(service.authorizeJoin(EMP_A, id), "NOT_FOUND");
    await rejects(service.exportXlsx(EMP_A, id), "NOT_FOUND");
    await rejects(service.applyOperation(EMP_A, id, cells(ws, [1, 1, { v: "late" }])), "NOT_FOUND");
    assert.deepEqual((await service.listSheets(EMP_A)).sheets, []);
    // others unaffected, and the revoked user's earlier work is still there
    const bobView = await service.getWorkbook(EMP_B, id);
    assert.deepEqual(bobView.workbook.sheets[ws].cellData[0][0], { v: "mine" });
    assert.equal(bobView.workbook.sheets[ws].cellData[1], undefined);

    await rejects(service.revoke(SUPER, id, EMP_A), "NOT_FOUND", 404); // already removed
    await rejects(service.revoke(SUPER, id, "abc"), "INVALID_USERS", 400);

    // re-assigning restores access
    await service.assign(SUPER, id, { userIds: [EMP_A], permission: "view" });
    assert.equal((await service.getWorkbook(EMP_A, id)).permission, "view");
});

test("view-only assignments cannot change the spreadsheet", async () => {
    const { service } = build();
    const id = (await service.createBlankSheet(SUPER, "Read only")).id;
    const ws = await wsKey(service, SUPER, id);
    await service.assign(SUPER, id, { userIds: [EMP_A], permission: "view" });
    await rejects(service.applyOperation(EMP_A, id, cells(ws, [0, 0, { v: "x" }])), "READ_ONLY", 403);
    assert.equal((await service.getWorkbook(EMP_A, id)).permission, "view");
});

// ---------------------------------------------------------------- persistence + retrieval

test("cell updates are persisted and come back after a refresh, with the revision", async () => {
    const { service } = build();
    const id = (await service.createBlankSheet(SUPER, "Persist")).id;
    const ws = await wsKey(service, SUPER, id);
    await service.assign(SUPER, id, { userIds: [EMP_A], permission: "edit" });

    const first = await service.applyOperation(EMP_A, id, cells(ws, [0, 0, { v: "Name", t: 1, s: { bl: 1 } }], [1, 0, { v: 41, t: 2 }], [2, 0, { f: "=A2+1", v: 42, t: 2 }]));
    assert.equal(first.revision, 1);
    const second = await service.applyOperation(SUPER, id, cells(ws, [1, 0, { v: 99, t: 2 }]));
    assert.equal(second.revision, 2);

    for (const user of [SUPER, EMP_A]) {
        const reopened = await service.getWorkbook(user, id);
        const data = reopened.workbook.sheets[ws].cellData;
        assert.deepEqual(data[0][0], { v: "Name", t: 1, s: { bl: 1 } });
        assert.deepEqual(data[1][0], { v: 99, t: 2 });
        assert.deepEqual(data[2][0], { f: "=A2+1", v: 42, t: 2 });
        assert.equal(reopened.revision, 2);
    }
});

test("an update REPLACES the whole cell (formatting included) and a null cell clears it", async () => {
    const { service } = build();
    const id = (await service.createBlankSheet(SUPER, "Replace")).id;
    const ws = await wsKey(service, SUPER, id);

    await service.applyOperation(SUPER, id, cells(ws, [0, 0, { v: "styled", t: 1, s: { bl: 1, bg: { rgb: "#FFFF00" } } }]));
    await service.applyOperation(SUPER, id, cells(ws, [0, 0, { v: "plain", t: 1 }]));
    assert.deepEqual((await service.getWorkbook(SUPER, id)).workbook.sheets[ws].cellData[0][0], { v: "plain", t: 1 });

    await service.applyOperation(SUPER, id, cells(ws, [0, 0, null]));
    assert.equal((await service.getWorkbook(SUPER, id)).workbook.sheets[ws].cellData[0], undefined);

    // an empty-looking cell is the same as a cleared one
    await service.applyOperation(SUPER, id, cells(ws, [1, 1, { v: "x" }]));
    await service.applyOperation(SUPER, id, cells(ws, [1, 1, {}]));
    assert.equal((await service.getWorkbook(SUPER, id)).workbook.sheets[ws].cellData[1], undefined);
});

test("two edits of the same cell: the later one is stored (last write wins)", async () => {
    const { service } = build();
    const id = (await service.createBlankSheet(SUPER, "LWW")).id;
    const ws = await wsKey(service, SUPER, id);
    await service.assign(SUPER, id, { userIds: [EMP_A, EMP_B], permission: "edit" });

    const [a, b] = await Promise.all([
        service.applyOperation(EMP_A, id, cells(ws, [3, 3, { v: "A" }])),
        service.applyOperation(EMP_B, id, cells(ws, [3, 3, { v: "B" }])),
    ]);
    const later = a.revision > b.revision ? "A" : "B";
    assert.equal((await service.getWorkbook(SUPER, id)).workbook.sheets[ws].cellData[3][3].v, later);
});

test("a repeated position inside one change keeps its last value; a rejected change leaves no trace", async () => {
    const { service } = build();
    const id = (await service.createBlankSheet(SUPER, "Atomic")).id;
    const ws = await wsKey(service, SUPER, id);

    await service.applyOperation(SUPER, id, cells(ws, [0, 0, { v: "first" }], [0, 0, { v: "last" }]));
    assert.equal((await service.getWorkbook(SUPER, id)).workbook.sheets[ws].cellData[0][0].v, "last");

    // the 2nd cell is outside the grid -> the whole change (including the valid first cell) is refused
    await rejects(service.applyOperation(SUPER, id, cells(ws, [1, 1, { v: "valid" }], [5000, 0, { v: "outside" }])), "INVALID_CELL_COORDINATE");
    const after = await service.getWorkbook(SUPER, id);
    assert.equal(after.workbook.sheets[ws].cellData[1], undefined);
    assert.equal(after.revision, 1, "the failed change did not consume a revision");
});

test("worksheet tabs: add, rename, ordering, duplicates, limits", async () => {
    const { service } = build();
    const id = (await service.createBlankSheet(SUPER, "Tabs")).id;
    const names = async () => {
        const { workbook } = await service.getWorkbook(SUPER, id);
        return workbook.sheetOrder.map((k) => workbook.sheets[k].name);
    };

    await service.applyOperation(SUPER, id, { type: "addWorksheet", ws: "t2", name: "Second" });
    await service.applyOperation(SUPER, id, { type: "addWorksheet", ws: "t3", name: "Inserted", index: 1 });
    assert.deepEqual(await names(), ["Sheet1", "Inserted", "Second"]);

    await service.applyOperation(SUPER, id, { type: "renameWorksheet", ws: "t2", name: "Renamed" });
    assert.deepEqual(await names(), ["Sheet1", "Inserted", "Renamed"]);

    await rejects(service.applyOperation(SUPER, id, { type: "renameWorksheet", ws: "t3", name: "renamed" }), "WORKSHEET_NAME_EXISTS", 409);
    await rejects(service.applyOperation(SUPER, id, { type: "addWorksheet", ws: "t9", name: "SHEET1" }), "WORKSHEET_NAME_EXISTS", 409);
    await rejects(service.applyOperation(SUPER, id, { type: "renameWorksheet", ws: "ghost", name: "X" }), "WORKSHEET_NOT_FOUND");

    for (let i = 0; i < LIMITS.MAX_WORKSHEETS - 3; i += 1) {
        await service.applyOperation(SUPER, id, { type: "addWorksheet", ws: `bulk${i}`, name: `Bulk ${i}` });
    }
    await rejects(service.applyOperation(SUPER, id, { type: "addWorksheet", ws: "overflow", name: "One too many" }), "TOO_MANY_WORKSHEETS");
});

// ---------------------------------------------------------------- archive / delete

test("archiving hides the sheet from employees and makes it read-only for admins; restoring reverses it", async () => {
    const { service } = build();
    const id = (await service.createBlankSheet(SUPER, "Archivable")).id;
    const ws = await wsKey(service, SUPER, id);
    await service.assign(SUPER, id, { userIds: [EMP_A], permission: "edit" });

    await service.updateSheet(SUPER, id, { status: "archived" });
    await rejects(service.getWorkbook(EMP_A, id), "NOT_FOUND");
    assert.deepEqual((await service.listSheets(EMP_A)).sheets, []);
    const adminView = await service.getWorkbook(SUPER, id);
    assert.equal(adminView.permission, "view");
    assert.equal(adminView.sheet.status, "archived");
    await rejects(service.applyOperation(SUPER, id, cells(ws, [0, 0, { v: "x" }])), "READ_ONLY", 403);
    assert.equal((await service.listSheets(SUPER)).sheets.find((s) => s.id === id).status, "archived");

    await service.updateSheet(SUPER, id, { status: "active" });
    assert.equal((await service.getWorkbook(EMP_A, id)).permission, "edit");
    assert.equal((await service.applyOperation(EMP_A, id, cells(ws, [0, 0, { v: "back" }]))).revision, 1);

    await rejects(service.updateSheet(SUPER, id, { status: "deleted" }), "INVALID_STATUS");
    await rejects(service.updateSheet(SUPER, id, {}), "NOTHING_TO_UPDATE");
    assert.equal((await service.updateSheet(SUPER, id, { name: " Renamed  sheet " })).name, "Renamed sheet");
});

test("deleting is a soft delete: it disappears for everyone, but the data is kept", async () => {
    const { service, store } = build();
    const id = (await service.createBlankSheet(SUPER, "Doomed")).id;
    const ws = await wsKey(service, SUPER, id);
    await service.applyOperation(SUPER, id, cells(ws, [0, 0, { v: "keep me" }]));
    await service.assign(SUPER, id, { userIds: [EMP_A], permission: "edit" });

    await service.deleteSheet(SUPER, id);

    for (const user of [SUPER, ADMIN_BY_ACCESS, EMP_A]) {
        await rejects(service.getWorkbook(user, id), "NOT_FOUND");
        await rejects(service.authorizeJoin(user, id), "NOT_FOUND");
    }
    assert.deepEqual((await service.listSheets(SUPER)).sheets, []);
    assert.deepEqual((await service.listSheets(EMP_A)).sheets, []);
    await rejects(service.deleteSheet(SUPER, id), "NOT_FOUND");
    await rejects(service.applyOperation(SUPER, id, cells(ws, [1, 1, { v: "x" }])), "NOT_FOUND");
    assert.ok(store.sheets.get(id).deleted_at, "the row is still there, marked deleted");
    assert.equal((await store.loadWorkbook(id)).worksheets[0].cells.length, 1);
});

// ---------------------------------------------------------------- pure units

test("access policy: who can do what", () => {
    const active = { employment_status: "active" };
    const sheet = { status: "active", deleted_at: null };
    const grant = (permission) => ({ permission });
    const decide = (account, s = sheet, assignment = null) => resolveAccess({ account: { ...active, ...account }, sheet: s, assignment });

    assert.deepEqual(
        { ...decide({ role: "admin", system_access: "employee" }) },
        { allowed: true, reason: "admin", canManage: true, permission: "edit" }
    );
    assert.equal(decide({ role: "employee", system_access: "super_admin" }).canManage, true);
    assert.equal(decide({ role: "employee", system_access: "admin" }).canManage, true);
    for (const level of ["executive", "hr", "department_head", "manager", "team_lead", "employee"]) {
        assert.equal(decide({ role: "employee", system_access: level }).allowed, false, `${level} without a grant`);
        assert.equal(decide({ role: "employee", system_access: level }, sheet, grant("edit")).canManage, false, `${level} never manages`);
    }
    assert.equal(decide({ role: "employee", system_access: "employee" }, sheet, grant("edit")).permission, "edit");
    assert.equal(decide({ role: "employee", system_access: "employee" }, sheet, grant("view")).permission, "view");
    assert.equal(decide({ role: "employee", system_access: "employee" }, sheet, grant("weird")).permission, "view", "unknown grants never mean edit");

    const archived = { status: "archived", deleted_at: null };
    assert.equal(decide({ role: "admin" }, archived).permission, "view");
    assert.equal(decide({ role: "employee" }, archived, grant("edit")).allowed, false);
    const deleted = { status: "active", deleted_at: new Date() };
    assert.equal(decide({ role: "admin" }, deleted).allowed, false);
    assert.equal(decide({ role: "admin" }, null).allowed, false);

    for (const status of ["inactive", "resigned", "terminated", "retired", undefined]) {
        assert.equal(resolveAccess({ account: { role: "admin", system_access: "super_admin", employment_status: status }, sheet, assignment: null }).allowed, false, `${status} account`);
    }
    assert.equal(resolveAccess(null).allowed, false);
    assert.equal(resolveAccess({ account: null, sheet }).allowed, false);
    assert.equal(isAdminTier({ role: "employee", system_access: "hr" }), false);
});

test("input validation helpers", () => {
    for (const ok of [1, "1", 42, "2147483647"]) assert.equal(parseSheetId(ok), Number(ok));
    for (const bad of [0, -1, 1.5, "01", "1e3", "0x10", " 1", "1 ", "2147483648", "", null, undefined, {}, [], true, "٣"]) {
        assert.throws(() => parseSheetId(bad), (e) => e.code === "INVALID_SHEET_ID", JSON.stringify(bad));
    }

    assert.equal(validateWorksheetName("  Q1 Sales  "), "Q1 Sales");
    for (const bad of ["", " ", "a/b", "a\\b", "a?b", "a*b", "a[b", "a]b", "a:b", "'quoted", "quoted'", "x".repeat(32), 5, null, "tab\there"]) {
        assert.throws(() => validateWorksheetName(bad), (e) => e.code === "INVALID_WORKSHEET_NAME", JSON.stringify(bad));
    }
    assert.throws(() => validateSheetName(undefined));
    assert.equal(validateWorksheetName("x".repeat(31)).length, 31);
});

test("cell sanitising: allowed fields only, bounded, no poison, no DDE", () => {
    assert.deepEqual(sanitizeCell({ v: "a", t: 1, evil: 1 }), { v: "a", t: 1 });
    assert.equal(sanitizeCell(null), null);
    assert.equal(sanitizeCell({}), null);
    assert.equal(sanitizeCell({ v: null, s: {} }), null);
    assert.deepEqual(sanitizeCell({ v: true }), { v: true });
    assert.deepEqual(sanitizeCell({ v: 0 }), { v: 0 });
    assert.deepEqual(sanitizeCell({ v: "", t: 1 }), { v: "", t: 1 });
    assert.deepEqual(sanitizeCell({ v: 0.25, nf: "0.00%" }), { v: 0.25, nf: "0.00%" });
    assert.equal(sanitizeCell({ nf: "General" }), null, "the default format is not stored");
    assert.equal(sanitizeCell({ nf: "general" }), null);
    assert.equal(sanitizeCell({ nf: "" }), null);
    for (const badFormat of [5, {}, [], "x".repeat(257), "bad format"]) {
        assert.throws(() => sanitizeCell({ v: 1, nf: badFormat }), SmartSheetError, JSON.stringify(badFormat).slice(0, 30));
    }

    for (const bad of [
        { v: Infinity }, { v: NaN }, { v: [] }, { v: {} }, { t: 5 }, { t: 0 }, { t: "1" }, { f: "SUM(A1)" }, { f: 7 }, { s: "bold" }, { s: [] },
        { si: "a b" }, { p: "text" }, [], "string", 5, { v: "x".repeat(32768) }, { f: `=${"A".repeat(8192)}` },
    ]) {
        assert.throws(() => sanitizeCell(bad), SmartSheetError, JSON.stringify(bad).slice(0, 40));
    }
    for (const dde of ["=cmd|'/c calc'!A0", "=1+1|2", "=SUM(A1)|x", '="a"&cmd|b']) {
        assert.throws(() => sanitizeCell({ f: dde }), SmartSheetError, dde);
    }
    assert.deepEqual(sanitizeCell({ f: '=IF(A1="a|b";1;2)' }), { f: '=IF(A1="a|b";1;2)' });
    assert.deepEqual(sanitizeCell({ f: '=IF(A1="""|""",1,2)' }), { f: '=IF(A1="""|""",1,2)' }, "escaped quotes inside a literal");

    assert.throws(() => sanitizeCell({ v: 1, s: JSON.parse('{"constructor":{"prototype":{"x":1}}}') }), SmartSheetError);
    let deep = { a: 1 };
    for (let i = 0; i < 12; i += 1) deep = { n: deep };
    assert.throws(() => sanitizeCell({ v: 1, s: deep }), SmartSheetError, "deeply nested style");
    assert.throws(() => sanitizeCell({ v: 1, s: { big: "x".repeat(LIMITS.MAX_STYLE_BYTES + 1) } }), SmartSheetError);
});

test("operation validation normalises and bounds every kind of change", () => {
    assert.deepEqual(validateOperation({ type: "cells", ws: "abc_1-2", cells: [{ r: 0, c: 0, cell: { v: 1 } }, { r: 0, c: 0, cell: { v: 2 } }] }).cells, [{ r: 0, c: 0, cell: { v: 2 } }]);
    assert.deepEqual(validateOperation({ type: "addWorksheet", ws: "n1", name: " Tab " }), { type: "addWorksheet", ws: "n1", name: "Tab", index: null });
    assert.deepEqual(
        validateOperation({ type: "layout", ws: "w", columnWidths: { 2: 150.4, 3: null }, rowHeights: {} }),
        { type: "layout", ws: "w", columnWidths: { 2: 150, 3: null }, rowHeights: {} }
    );
    for (const bad of [
        null, [], "x", 5, { type: "cells" }, { type: "nope", ws: "a" }, { type: "cells", ws: "a", cells: "x" }, { type: "cells", ws: "", cells: [{ r: 0, c: 0, cell: {} }] },
        { type: "cells", ws: "a", cells: [null] }, { type: "cells", ws: "a", cells: [{ r: "0", c: 0, cell: {} }] }, { type: "addWorksheet", ws: "a", name: "ok", index: -1 },
        { type: "addWorksheet", ws: "a", name: "ok", index: 51 }, { type: "layout", ws: "a" }, { type: "layout", ws: "a", columnWidths: { x: 10 } },
        { type: "layout", ws: "a", rowHeights: { 0: 1 } }, { type: "layout", ws: "a", columnWidths: { 1000: 100 } },
    ]) {
        assert.throws(() => validateOperation(bad), SmartSheetError, JSON.stringify(bad));
    }
});

test("workbook conversion to the editor format keeps cells, widths and tab order", () => {
    const state = {
        sheet: { id: 9, name: "Conv" },
        worksheets: [
            { key: "b", name: "Second", position: 1, rowCount: 10, columnCount: 5, layout: {}, cells: [] },
            { key: "a", name: "First", position: 0, rowCount: 20, columnCount: 6, layout: { columnWidths: { 1: 90 }, rowHeights: { 0: 30 } }, cells: [{ r: 2, c: 1, cell: { v: 1 } }, { r: 2, c: 3, cell: { v: 2 } }] },
        ],
    };
    const wb = toUniverWorkbook(state);
    assert.deepEqual(wb.sheetOrder, ["a", "b"]);
    assert.deepEqual(wb.sheets.a.cellData, { 2: { 1: { v: 1 }, 3: { v: 2 } } });
    assert.deepEqual(wb.sheets.a.columnData, { 1: { w: 90 } });
    assert.deepEqual(wb.sheets.a.rowData, { 0: { h: 30 } });
    assert.equal(wb.sheets.a.rowCount, 20);
    assert.equal(wb.id, "smartsheet-9");

    assert.equal(safeFileName("Q3 / Budget: \"final\"?"), "Q3 _ Budget_ _final__.xlsx");
    assert.equal(safeFileName(""), "spreadsheet.xlsx");
    assert.ok(safeFileName("x".repeat(500)).length <= 105);
});
