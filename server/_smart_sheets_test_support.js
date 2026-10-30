// ==========================================
// SMART SHEETS -- TEST SUPPORT (not a test, not loaded by the app)
//
// CI runs the server tests without a database (see .github/workflows/pr-checks.yml), so the Smart
// Sheets tests run the REAL service, validation, access policy, Socket.IO handlers, Express
// router/controller and Excel code against an in-memory implementation of the store interface in
// services/smartSheetStore.js. The memory store reproduces the PostgreSQL store's observable
// behaviour: access context, whole-cell replacement, per-sheet serialized writes with an
// incrementing revision, not-writable archived sheets, worksheet rules, soft delete.
//
// It also offers failure/latency injection (failWrites, writeDelayMs) so the "persist BEFORE
// broadcast" and "simultaneous edit" behaviour can be exercised deterministically.
//
// The SQL itself cannot run here; it is covered by review, the static checks in
// _test_smart_sheets_migration.js, and the manual PostgreSQL steps in the PR notes.
// ==========================================

const http = require("http");
const path = require("path");
const express = require("express");
const { Server } = require("socket.io");

const { SmartSheetError, invalid } = require("./utils/smartSheetErrors");
const { LIMITS } = require("./utils/smartSheetValidation");
const { createSmartSheetService } = require("./services/smartSheetService");
const { createSmartSheetController } = require("./controllers/smartSheetController");
const { createSmartSheetRouter } = require("./routes/smartSheetRoutes");
const { registerSmartSheetHandlers } = require("./services/smartSheetRealtime");
const { userRoom } = require("./utils/socketRooms");
const { isAdminTier } = require("./utils/smartSheetAccess");

const COMPANY_SLUG = "acme";

function createMemoryStore(accounts) {
    const users = new Map(accounts.map((account) => [account.id, { employment_status: "active", system_access: "employee", role: "employee", ...account }]));
    const sheets = new Map();
    const access = new Map(); // `${sheetId}:${userId}` -> { permission }
    const worksheets = []; // { id, sheet_id, ws_key, name, position, row_count, column_count, layout }
    const cells = new Map(); // `${worksheetId}:${r}:${c}` -> { cell, revision }
    let nextSheetId = 1;
    let nextWorksheetId = 1;
    const queues = new Map();

    const store = {
        failWrites: false,
        writeDelayMs: 0,
        writes: 0,
        users,
        sheets,

        async getAccount(userId) {
            const user = users.get(userId);
            return user ? { id: user.id, role: user.role, system_access: user.system_access, employment_status: user.employment_status } : null;
        },

        async getAccessContext(userId, sheetId) {
            const user = users.get(userId);
            if (!user) return { account: null, sheet: null, assignment: null };
            const sheet = sheets.get(sheetId) || null;
            const grant = sheet ? access.get(`${sheetId}:${userId}`) : null;
            return {
                account: { id: user.id, role: user.role, system_access: user.system_access, employment_status: user.employment_status },
                sheet: sheet ? { id: sheet.id, name: sheet.name, status: sheet.status, revision: sheet.revision, deleted_at: sheet.deleted_at } : null,
                assignment: grant ? { permission: grant.permission } : null,
            };
        },

        async listSheetsForAdmin() {
            return [...sheets.values()].filter((s) => !s.deleted_at).map((s) => ({
                id: s.id, name: s.name, status: s.status, revision: s.revision, created_by: s.created_by,
                assigned_count: [...access.keys()].filter((key) => key.startsWith(`${s.id}:`)).length,
            }));
        },

        async listSheetsForUser(userId) {
            return [...sheets.values()]
                .filter((s) => !s.deleted_at && s.status === "active" && access.has(`${s.id}:${userId}`))
                .map((s) => ({ id: s.id, name: s.name, status: s.status, revision: s.revision, permission: access.get(`${s.id}:${userId}`).permission }));
        },

        async getSheet(sheetId) {
            const s = sheets.get(sheetId);
            return s ? { ...s } : null;
        },

        async createSheet({ name, userId, worksheets: sheetDefs, source = null }) {
            const id = nextSheetId++;
            sheets.set(id, { id, name, status: "active", revision: 0, created_by: userId, deleted_at: null, source_file_name: source ? source.fileName : null, source_file_path: source ? source.filePath : null });
            sheetDefs.forEach((def, position) => {
                const worksheet = {
                    id: nextWorksheetId++, sheet_id: id, ws_key: `ws${id}x${position}`, name: def.name, position,
                    row_count: def.rowCount || LIMITS.DEFAULT_ROWS, column_count: def.columnCount || LIMITS.DEFAULT_COLUMNS, layout: def.layout || {},
                };
                worksheets.push(worksheet);
                for (const { r, c, cell } of def.cells || []) cells.set(`${worksheet.id}:${r}:${c}`, { cell, revision: 0 });
            });
            return id;
        },

        async loadWorkbook(sheetId) {
            const sheet = sheets.get(sheetId);
            if (!sheet) return null;
            return {
                sheet: { ...sheet },
                worksheets: worksheets.filter((w) => w.sheet_id === sheetId).sort((a, b) => a.position - b.position).map((w) => ({
                    id: w.id, key: w.ws_key, name: w.name, position: w.position, rowCount: w.row_count, columnCount: w.column_count, layout: w.layout,
                    cells: [...cells.entries()].filter(([key]) => key.startsWith(`${w.id}:`)).map(([key, value]) => {
                        const [, r, c] = key.split(":");
                        return { r: Number(r), c: Number(c), cell: value.cell };
                    }),
                })),
            };
        },

        async updateSheet(sheetId, fields) {
            const sheet = sheets.get(sheetId);
            if (!sheet || sheet.deleted_at) return false;
            Object.assign(sheet, fields);
            return true;
        },

        async softDeleteSheet(sheetId) {
            const sheet = sheets.get(sheetId);
            if (!sheet || sheet.deleted_at) return false;
            sheet.deleted_at = new Date();
            return true;
        },

        async listAccess(sheetId) {
            return [...access.entries()].filter(([key]) => key.startsWith(`${sheetId}:`)).map(([key, value]) => ({
                user_id: Number(key.split(":")[1]), permission: value.permission, full_name: users.get(Number(key.split(":")[1])).full_name,
            }));
        },

        async grantAccess(sheetId, userIds, permission) {
            const granted = [];
            for (const id of userIds) {
                const user = users.get(id);
                if (user && user.employment_status === "active") {
                    access.set(`${sheetId}:${id}`, { permission });
                    granted.push(id);
                }
            }
            return granted;
        },

        async revokeAccess(sheetId, userId) {
            return access.delete(`${sheetId}:${userId}`);
        },

        async searchEmployees(query) {
            const q = String(query || "").toLowerCase();
            return [...users.values()].filter((u) => u.employment_status === "active" && (!q || String(u.full_name).toLowerCase().includes(q)))
                .map((u) => ({ id: u.id, full_name: u.full_name, employee_id: u.employee_id || null }));
        },

        // Serialized per sheet, like the row lock in the PostgreSQL store.
        async applyOperation(sheetId, userId, op) {
            const previous = queues.get(sheetId) || Promise.resolve();
            const run = previous.then(async () => {
                if (store.writeDelayMs) await new Promise((resolve) => setTimeout(resolve, store.writeDelayMs));
                if (store.failWrites) throw new Error("simulated database failure");

                const sheet = sheets.get(sheetId);
                if (!sheet || sheet.status !== "active" || sheet.deleted_at) {
                    throw new SmartSheetError(409, "SHEET_NOT_WRITABLE", "This spreadsheet is archived or no longer available.");
                }

                const own = worksheets.filter((w) => w.sheet_id === sheetId);
                const find = () => {
                    const worksheet = own.find((w) => w.ws_key === op.ws);
                    if (!worksheet) throw invalid("WORKSHEET_NOT_FOUND", "That worksheet no longer exists.");
                    return worksheet;
                };

                // validate everything BEFORE mutating, so a rejected op leaves no trace (transaction rollback)
                let apply;
                if (op.type === "cells") {
                    const worksheet = find();
                    if (op.cells.some((e) => e.r >= worksheet.row_count || e.c >= worksheet.column_count)) {
                        throw invalid("INVALID_CELL_COORDINATE", "A cell is outside this worksheet.");
                    }
                    apply = (revision) => {
                        for (const { r, c, cell } of op.cells) {
                            const key = `${worksheet.id}:${r}:${c}`;
                            if (cell === null) cells.delete(key); else cells.set(key, { cell, revision });
                        }
                    };
                } else if (op.type === "addWorksheet") {
                    const exists = own.some((w) => w.ws_key === op.ws);
                    if (!exists) {
                        if (own.length >= LIMITS.MAX_WORKSHEETS) throw invalid("TOO_MANY_WORKSHEETS", "Too many worksheets.");
                        if (own.some((w) => w.name.toLowerCase() === op.name.toLowerCase())) {
                            throw new SmartSheetError(409, "WORKSHEET_NAME_EXISTS", "A worksheet with that name already exists.");
                        }
                    }
                    apply = () => {
                        if (exists) return;
                        const append = own.length;
                        const position = op.index === null ? append : Math.min(op.index, append);
                        own.forEach((w) => { if (w.position >= position) w.position += 1; });
                        worksheets.push({ id: nextWorksheetId++, sheet_id: sheetId, ws_key: op.ws, name: op.name, position, row_count: LIMITS.DEFAULT_ROWS, column_count: LIMITS.DEFAULT_COLUMNS, layout: {} });
                    };
                } else if (op.type === "renameWorksheet") {
                    const worksheet = find();
                    if (own.some((w) => w.id !== worksheet.id && w.name.toLowerCase() === op.name.toLowerCase())) {
                        throw new SmartSheetError(409, "WORKSHEET_NAME_EXISTS", "A worksheet with that name already exists.");
                    }
                    apply = () => { worksheet.name = op.name; };
                } else if (op.type === "layout") {
                    const worksheet = find();
                    apply = () => {
                        const layout = { columnWidths: {}, rowHeights: {}, ...worksheet.layout };
                        for (const [key, value] of Object.entries(op.columnWidths)) { if (value === null) delete layout.columnWidths[key]; else layout.columnWidths[key] = value; }
                        for (const [key, value] of Object.entries(op.rowHeights)) { if (value === null) delete layout.rowHeights[key]; else layout.rowHeights[key] = value; }
                        worksheet.layout = layout;
                    };
                }

                sheet.revision += 1;
                apply(sheet.revision);
                store.writes += 1;
                return { revision: sheet.revision };
            });
            queues.set(sheetId, run.catch(() => {}));
            return run;
        },
    };

    return store;
}

// ---- Socket.IO harness: a real server, the real handlers, in-memory data, token "user:<id>" ----

function loadSocketClient() {
    const clientDir = path.join(__dirname, "..", "client");
    return require(require.resolve("socket.io-client", { paths: [clientDir, __dirname] }));
}

async function startRealtimeHarness(store, { rateLimit } = {}) {
    const service = createSmartSheetService({ store });
    const httpServer = http.createServer();
    const io = new Server(httpServer, { cors: { origin: true } });

    io.use(async (socket, next) => {
        const match = /^user:(\d+)$/.exec(String(socket.handshake.auth && socket.handshake.auth.token));
        const account = match && (await store.getAccount(Number(match[1])));
        if (!account) return next(new Error("Invalid or expired authentication token"));
        socket.user = { id: account.id, fullName: store.users.get(account.id).full_name };
        next();
    });

    io.on("connection", (socket) => {
        socket.join(userRoom(COMPANY_SLUG, socket.user.id)); // exactly what app.js does on connect
        registerSmartSheetHandlers({
            io, socket, companySlug: COMPANY_SLUG, service, rateLimit,
            onTenantEvent: (name, handler) => socket.on(name, handler),
        });
    });

    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${httpServer.address().port}`;
    const { io: connect } = loadSocketClient();
    const clients = [];

    return {
        io, service, store, url, companySlug: COMPANY_SLUG,
        async client(userId, { token } = {}) {
            const socket = connect(url, { auth: { token: token || `user:${userId}` }, transports: ["websocket"], reconnection: false, forceNew: true });
            clients.push(socket);
            await new Promise((resolve, reject) => {
                socket.once("connect", resolve);
                socket.once("connect_error", reject);
            });
            return socket;
        },
        async close() {
            clients.forEach((socket) => socket.close());
            await io.close();
            await new Promise((resolve) => httpServer.close(resolve));
        },
    };
}

const emitAck = (socket, event, payload, timeoutMs = 3000) =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), timeoutMs);
        socket.emit(event, payload, (answer) => { clearTimeout(timer); resolve(answer); });
    });

const waitForEvent = (socket, event, { timeoutMs = 2000, predicate = () => true } = {}) =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`timed out waiting for ${event}`)); }, timeoutMs);
        function handler(payload) {
            if (!predicate(payload)) return;
            clearTimeout(timer);
            socket.off(event, handler);
            resolve(payload);
        }
        socket.on(event, handler);
    });

// resolves true if the event does NOT arrive within the window
const expectNoEvent = (socket, event, windowMs = 300) =>
    new Promise((resolve) => {
        const handler = () => { clearTimeout(timer); socket.off(event, handler); resolve(false); };
        const timer = setTimeout(() => { socket.off(event, handler); resolve(true); }, windowMs);
        socket.on(event, handler);
    });

// ---- HTTP harness: the real router + controller + service, fake authentication ----

async function startHttpHarness(store, { upload } = {}) {
    const service = createSmartSheetService({ store });
    const controller = createSmartSheetController(service);

    const authenticate = [
        (req, res, next) => {
            const id = Number(req.get("x-test-user"));
            if (!id) return res.status(401).json({ success: false, message: "Authentication required" });
            req.user = { id };
            next();
        },
        async (req, res, next) => {
            const account = await store.getAccount(req.user.id);
            if (!account || account.employment_status !== "active") return res.status(403).json({ success: false });
            next();
        },
    ];
    // mirrors requireAccess("super_admin", "admin"): role admin passes, else system_access must be in the list
    const adminTier = async (req, res, next) => {
        const account = await store.getAccount(req.user.id);
        if (account && isAdminTier(account)) return next();
        res.status(403).json({ success: false, message: "You do not have permission to perform this action" });
    };

    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/smart-sheets", createSmartSheetRouter({ controller, authenticate, adminTier, upload }));
    // like app.js's own error handling: malformed JSON is a clean 400, not a stack trace
    app.use((error, _req, res, _next) => {
        res.status(error.status || 500).json({ success: false, message: "Invalid request." });
    });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/smart-sheets`;

    return {
        app, service, store, base,
        async request(method, urlPath, { user, body, headers = {}, raw } = {}) {
            const response = await fetch(`${base}${urlPath}`, {
                method,
                headers: { ...(user ? { "x-test-user": String(user) } : {}), ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}), ...headers },
                body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
            });
            const type = response.headers.get("content-type") || "";
            const data = type.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer());
            return { status: response.status, data, headers: response.headers };
        },
        async close() { await new Promise((resolve) => server.close(resolve)); },
    };
}

module.exports = {
    COMPANY_SLUG,
    createMemoryStore,
    startRealtimeHarness,
    startHttpHarness,
    emitAck,
    waitForEvent,
    expectNoEvent,
};
