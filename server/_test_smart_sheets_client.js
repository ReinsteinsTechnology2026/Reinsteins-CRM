// Smart Sheets -- how the feature is wired into the CRM, and the "free and open source only" guard.
// Static checks of the source files (no browser, no database). The editor's behaviour in a real browser is
// covered by the manual verification described in the PR notes; the logic it relies on is in
// _test_smart_sheets_client_sync.js. Run: node --test _test_smart_sheets_client.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const exists = (...parts) => fs.existsSync(path.join(root, ...parts));

const app = read("client", "src", "App.jsx");
const adminSidebar = read("client", "src", "components", "Layout", "AdminSidebar.jsx");
const employeeSidebar = read("client", "src", "components", "Layout", "EmployeeSidebar.jsx");
const editor = read("client", "src", "components", "SmartSheets", "SmartSheetEditor.jsx");
const list = read("client", "src", "pages", "SmartSheets", "SmartSheetsList.jsx");
const share = read("client", "src", "components", "SmartSheets", "ShareSheetModal.jsx");
const lazyRoute = read("client", "src", "routes", "SmartSheetEditorRoute.jsx");
const editorPage = read("client", "src", "pages", "SmartSheets", "SmartSheetEditorPage.jsx");
const service = read("client", "src", "services", "smartSheetService.js");
const syncUtil = read("client", "src", "utils", "smartSheetSync.js");
const clientPackage = JSON.parse(read("client", "package.json"));
const clientLock = JSON.parse(read("client", "package-lock.json"));
const rootPackage = JSON.parse(read("package.json"));
const realtime = read("server", "services", "smartSheetRealtime.js");
const appJs = read("server", "app.js");

const routeTable = (name) => {
    const match = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`).exec(app);
    assert.ok(match, `${name} not found in App.jsx`);
    return match[1];
};

test("both portals route to the list and to the lazily loaded editor", () => {
    for (const table of ["ADMIN_ROUTES", "EMPLOYEE_ROUTES"]) {
        const body = routeTable(table);
        assert.match(body, /\{ path: "smart-sheets", Component: SmartSheetsList \}/, `${table}: list`);
        assert.match(body, /\{ path: "smart-sheets\/:sheetId", Component: SmartSheetEditorRoute \}/, `${table}: editor`);
    }
    assert.match(app, /import SmartSheetsList from "\.\/pages\/SmartSheets\/SmartSheetsList";/);
    assert.match(app, /import SmartSheetEditorRoute from "\.\/routes\/SmartSheetEditorRoute";/);
    // the routes sit inside the existing role-protected layouts (AdminLayout / EmployeeLayout), via the shared builder
    assert.match(app, /buildRoleRoutes\(\s*"\/admin"/);
    assert.match(app, /buildRoleRoutes\(\s*"\/employee"/);
});

test("the spreadsheet engine is loaded lazily and only from the editor component", () => {
    assert.match(lazyRoute, /const SmartSheetEditorPage = lazy\(\(\) => import\("\.\.\/pages\/SmartSheets\/SmartSheetEditorPage"\)\);/);
    assert.match(lazyRoute, /<Suspense/);
    assert.match(editorPage, /import SmartSheetEditor from "\.\.\/\.\.\/components\/SmartSheets\/SmartSheetEditor";/);

    // nothing that is part of the initial bundle may pull Univer in
    const eager = { "App.jsx": app, "SmartSheetsList.jsx": list, "ShareSheetModal.jsx": share, "smartSheetService.js": service, "smartSheetSync.js": syncUtil, "AdminSidebar.jsx": adminSidebar, "EmployeeSidebar.jsx": employeeSidebar };
    for (const [name, source] of Object.entries(eager)) {
        assert.doesNotMatch(source, /@univerjs/, `${name} must not import Univer (it would join the initial bundle)`);
        assert.doesNotMatch(source, /components\/SmartSheets\/SmartSheetEditor["']/, `${name} must not import the editor directly`);
    }
    assert.match(editor, /from "@univerjs\/presets"/);
    assert.match(editor, /from "@univerjs\/preset-sheets-core"/);

    // and only the editor imports Univer anywhere in the client
    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(jsx?|css)$/.test(entry.name) && /@univerjs/.test(fs.readFileSync(full, "utf8")) && entry.name !== "SmartSheetEditor.jsx") offenders.push(path.relative(root, full));
        }
    };
    walk(path.join(root, "client", "src"));
    assert.deepEqual(offenders, []);
});

test("both sidebars link to Smart Sheets under the portal's own base path", () => {
    assert.match(adminSidebar, /`\$\{basePath\}\/smart-sheets`/);
    assert.match(adminSidebar, /Smart Sheets/);
    assert.match(adminSidebar, /FaTable/);
    const employeeLinks = employeeSidebar.match(/name: "Smart Sheets", icon: <FaTable \/>, path: `\$\{basePath\}\/smart-sheets`/g) || [];
    assert.equal(employeeLinks.length, 2, "in both the executive and the standard employee menu");
});

test("the list page trusts the server for who may manage (never the browser's idea of the role)", () => {
    assert.match(list, /setCanManage\(Boolean\(data\.canManage\)\)/);
    assert.doesNotMatch(list, /sessionStorage/, "no role is read from storage");
    assert.doesNotMatch(list, /systemAccess|system_access|role ===/, "no client-side role logic");
    for (const action of ["createSmartSheet", "importSmartSheet", "updateSmartSheet", "deleteSmartSheet"]) assert.match(list, new RegExp(action));
    // destructive actions always confirm first
    assert.match(list, /kind: "delete"/);
    assert.match(list, /confirmText\[confirm\.kind\]/);
    // the browser also pre-checks what the server enforces
    assert.match(list, /\.xlsx/);
    assert.match(list, /MAX_UPLOAD_MB = 10/);
    assert.match(list, /accept="\.xlsx,application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet"/);
});

test("the editor uses only Univer's public API and the documented veto mechanism", () => {
    assert.match(editor, /api\.addEvent\(api\.Event\.CommandExecuted/);
    assert.match(editor, /api\.addEvent\(api\.Event\.BeforeCommandExecute/);
    assert.match(editor, /event\.cancel = true/);
    assert.match(editor, /syncExecuteCommand\(mutation\.id, mutation\.params, \{ onlyLocal: true, fromCollab: true \}\)/);
    assert.match(editor, /api\.createWorkbook\(/);
    assert.match(editor, /api\.disposeUnit\(/);
    // the RAW cell, not the interceptor-processed one (that one turns 0.256 into the text "25.6%")
    assert.match(editor, /getCellRaw\(row, column\)/);
    assert.doesNotMatch(editor.replace(/\/\/.*$/gm, ""), /\.getCellData\(\)/, "code (comments aside) must not use getCellData");
    // read-only users are really read-only, and unsupported structural edits are vetoed
    assert.match(editor, /SHARED_DATA_MUTATIONS\.has\(event\.id\)/);
    assert.match(editor, /isBlockedCommand\(event\.id\)/);
    // nothing reaches into private fields
    assert.doesNotMatch(editor, /\._[a-zA-Z]+\b(?!\()/);
    assert.doesNotMatch(editor, /dangerouslySetInnerHTML|innerHTML|eval\(|new Function/);
    // the engine is disposed outside React's commit phase, and each run gets its own container
    assert.match(editor, /setTimeout\(\(\) => \{\s*try \{\s*disposing\.dispose\(\)/);
    assert.match(editor, /key=\{`\$\{sheetId\}-\$\{reloadToken\}`\}/);
});

test("the editor shows the required indicators: title, save status, collaborators, export, read-only", () => {
    assert.match(editor, /data-testid="smart-sheet-save-status"/);
    assert.match(editor, /SAVE_STATUS_LABELS\[status\]/);
    assert.match(editor, /data-testid="smart-sheet-collaborators"/);
    assert.match(editor, /Export \.xlsx/);
    assert.match(editor, /aria-label="Spreadsheet name"/);
    assert.match(editor, /View only/);
    assert.match(editor, /beforeunload/, "warns before closing a tab that still has unsaved changes");
    assert.match(editor, /role="status"/);
});

test("the editor and the server speak the same socket protocol", () => {
    for (const event of ["smartsheet:join", "smartsheet:leave", "smartsheet:op", "smartsheet:presence", "smartsheet:access-revoked", "smartsheet:access-changed"]) {
        assert.ok(editor.includes(`"${event}"`), `editor uses ${event}`);
        assert.ok(realtime.includes(`"${event}"`), `server handles/emits ${event}`);
    }
    // the editor joins before it loads the saved state, so nothing is missed in between
    assert.ok(editor.indexOf("await join();") < editor.indexOf("await getSmartSheetWorkbook(sheetId)"));
    // and after a reconnect it flushes its own unsaved edits BEFORE replacing the sheet with the saved state
    const reconnect = editor.slice(editor.indexOf('on("connect"'));
    assert.ok(reconnect.indexOf("queue.whenDrained()") > 0 && reconnect.indexOf("queue.whenDrained()") < reconnect.indexOf("getSmartSheetWorkbook"));
    assert.match(appJs, /registerSmartSheetHandlers\(\{\s*io,\s*socket,\s*onTenantEvent,\s*companySlug,\s*service: smartSheetService,\s*\}\)/, "registered per connection, inside the tenant context wrapper");
    assert.match(appJs, /"\/api\/smart-sheets",\s*smartSheetRoutes/);
});

test("REST service points at the server's routes", () => {
    for (const route of ['"/smart-sheets"', "`/smart-sheets/${id}`", "`/smart-sheets/${id}/workbook`", "`/smart-sheets/${id}/access`", "`/smart-sheets/${id}/access/${userId}`", "`/smart-sheets/${id}/export`", '"/smart-sheets/import"', '"/smart-sheets/assignable-employees"']) {
        assert.ok(service.includes(route), route);
    }
    assert.match(service, /responseType: "blob"/);
});

test("no debugging leftovers or test hooks in the shipped code", () => {
    const shipped = { editor, list, share, lazyRoute, editorPage, service, syncUtil };
    for (const [name, source] of Object.entries(shipped)) {
        assert.doesNotMatch(source, /__ssDebug|TEMP-DEBUG|window\.__|debugger;/, name);
        assert.doesNotMatch(source, /console\.log\(/, name);
    }
    for (const leftover of ["smart-sheet-harness.html", "smart-sheet-list-harness.html"]) assert.equal(exists("client", leftover), false, leftover);
    for (const leftover of ["_smart_sheet_harness.jsx", "_smart_sheet_list_harness.jsx"]) assert.equal(exists("client", "src", leftover), false, leftover);
});

// ---------------------------------------------------------------- free / open source only

const ALLOWED_UNIVER_PACKAGES = [
    "core", "design", "docs", "docs-ui", "drawing", "engine-formula", "engine-render", "icons", "network", "preset-sheets-core",
    "presets", "protocol", "rpc", "sheets", "sheets-formula", "sheets-formula-ui", "sheets-numfmt", "sheets-numfmt-ui", "sheets-ui",
    "telemetry", "themes", "ui",
].map((name) => `@univerjs/${name}`).sort();

test("FREE ONLY: the only new client dependencies are the two Univer Community presets", () => {
    const direct = Object.keys(clientPackage.dependencies).filter((name) => name.startsWith("@univerjs/")).sort();
    assert.deepEqual(direct, ["@univerjs/preset-sheets-core", "@univerjs/presets"]);
    assert.match(clientPackage.dependencies["@univerjs/presets"], /^\^1\./);
    assert.match(clientPackage.dependencies["@univerjs/preset-sheets-core"], /^\^1\./);

    // nothing paid / commercial-only anywhere, direct or transitive
    const everything = new Set([...Object.keys(clientPackage.dependencies), ...Object.keys(clientPackage.devDependencies || {}), ...Object.keys(clientLock.packages).map((key) => key.replace(/^node_modules\//, "").replace(/.*node_modules\//, ""))]);
    const forbidden = [/univerjs-pro/i, /@univerjs\/(.*-)?(pro|collaboration|collab|server|cloud)(-.*)?$/i, /handsontable/i, /hyperformula/i, /ag-grid-enterprise/i, /syncfusion/i, /@mescius/i, /wijmo/i, /dhtmlx/i, /jspreadsheet-pro/i, /luckysheet/i, /y-websocket|liveblocks|pusher|ably/i];
    for (const name of everything) {
        for (const pattern of forbidden) assert.doesNotMatch(name, pattern, `a paid or unapproved package appeared: ${name}`);
    }

    // the server gained no new dependency (Excel work uses the existing ExcelJS, collaboration the existing Socket.IO)
    const serverDeps = Object.keys(rootPackage.dependencies);
    assert.ok(serverDeps.includes("exceljs") && serverDeps.includes("socket.io"));
    assert.equal(serverDeps.some((name) => /univer|handsontable|hyperformula|yjs|automerge|sheetjs|xlsx$/i.test(name)), false);
});

test("FREE ONLY: the locked Univer packages are exactly the approved set", () => {
    const locked = Object.keys(clientLock.packages).filter((key) => /node_modules\/@univerjs\//.test(key)).map((key) => key.replace(/^node_modules\//, "")).sort();
    assert.deepEqual(locked, ALLOWED_UNIVER_PACKAGES, "adding or swapping a Univer package must be a conscious decision (update this list and re-check its licence)");
});

test("FREE ONLY: every installed Univer package carries a permissive open-source licence", () => {
    // Apache-2.0 for the engine; @univerjs/icons is MIT. Both allow free commercial use.
    const MIT_PACKAGES = new Set(["@univerjs/icons"]);
    for (const name of ALLOWED_UNIVER_PACKAGES) {
        const manifest = path.join(root, "client", "node_modules", name, "package.json");
        assert.ok(fs.existsSync(manifest), `${name} is not installed -- run \`npm ci\` in client/`);
        const license = JSON.parse(fs.readFileSync(manifest, "utf8")).license;
        assert.equal(license, MIT_PACKAGES.has(name) ? "MIT" : "Apache-2.0", `${name} is licensed ${license}`);
    }
});
