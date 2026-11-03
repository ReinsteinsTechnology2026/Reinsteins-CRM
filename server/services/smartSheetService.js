const { resolveAccess, isAdminTier, isActiveAccount } = require("../utils/smartSheetAccess");
const { SmartSheetError, notFound, forbidden, invalid } = require("../utils/smartSheetErrors");
const {
    LIMITS,
    parseSheetId,
    parsePositiveId,
    validateSheetName,
    validateOperation,
    cellStorageBytes,
} = require("../utils/smartSheetValidation");
const { createWindowLimiter, createConcurrencyGate } = require("../utils/smartSheetLimiter");
const xlsxService = require("./smartSheetXlsxService");

// ==========================================
// SMART SHEETS -- SERVICE
//
// All business rules live here, on top of an injected `store` (PostgreSQL in production, an
// in-memory implementation in the tests). REST controllers and Socket.IO handlers are thin
// wrappers around these functions, so both paths enforce exactly the same rules.
//
// EVERY function that takes a userId re-reads that user's role, status and assignment from the
// store first (getAccessContext) -- nothing is cached and nothing is taken from the JWT or from
// the client. That is what makes "recheck permissions on every update" and "an unassigned
// employee loses access immediately" true by construction.
//
// Authorization outcomes:
//   not signed in / inactive / no such sheet / sheet not assigned to you  -> NOT_FOUND (404)
//        (identical for "does not exist" and "not yours", so ids cannot be probed)
//   you can open it but lack the right to change it / manage it           -> FORBIDDEN (403)
// ==========================================

const PERMISSIONS = ["view", "edit"];
const STATUSES = ["active", "archived"];

function safeFileName(name) {
    const cleaned = String(name || "").replace(/[^\w\-. ()]/g, "_").replace(/\s+/g, " ").trim().slice(0, 100);
    return `${cleaned || "spreadsheet"}.xlsx`;
}

// The stored state -> the editor's workbook JSON (Univer IWorkbookData). Styles stay inline on the
// cells, so the shared `styles` table is empty.
function toUniverWorkbook(state) {
    const sheets = {};
    const sheetOrder = [];

    for (const worksheet of [...state.worksheets].sort((a, b) => a.position - b.position)) {
        const cellData = {};
        for (const { r, c, cell } of worksheet.cells) {
            if (!cellData[r]) cellData[r] = {};
            cellData[r][c] = cell;
        }

        const columnData = {};
        for (const [index, width] of Object.entries((worksheet.layout && worksheet.layout.columnWidths) || {})) {
            columnData[index] = { w: width };
        }
        const rowData = {};
        for (const [index, height] of Object.entries((worksheet.layout && worksheet.layout.rowHeights) || {})) {
            rowData[index] = { h: height };
        }

        sheetOrder.push(worksheet.key);
        sheets[worksheet.key] = {
            id: worksheet.key,
            name: worksheet.name,
            rowCount: worksheet.rowCount,
            columnCount: worksheet.columnCount,
            cellData,
            columnData,
            rowData,
        };
    }

    return {
        id: `smartsheet-${state.sheet.id}`,
        name: state.sheet.name,
        appVersion: "1",
        locale: "enUS",
        styles: {},
        sheetOrder,
        sheets,
    };
}

// Expected failures keep their status/code/message; anything else is an unexpected bug and must
// not leak internals.
function describeError(error) {
    if (error instanceof SmartSheetError) {
        const description = { status: error.status, code: error.code, message: error.message };
        if (error.retryAfterMs !== undefined) description.retryAfterMs = error.retryAfterMs;
        return description;
    }
    return { status: 500, code: "SERVER_ERROR", message: "Something went wrong. Please try again." };
}

// The ambient database scope ("legacy-db" or the tenant slug). Lazy so the service has no import-time
// dependency on the database configuration.
function defaultScopeKey() {
    return require("../utils/socketRooms").getCurrentRoomScope();
}

// A spreadsheet that is somehow over the growth limits (only possible by editing the database directly) is
// refused instead of being loaded whole into the one shared Node process.
function assertOpenable(sheet, limits) {
    if (
        (Number(sheet.cell_count) || 0) > limits.MAX_CELLS_PER_SHEET ||
        (Number(sheet.data_bytes) || 0) > limits.MAX_SHEET_DATA_BYTES
    ) {
        throw new SmartSheetError(413, "WORKBOOK_TOO_LARGE", "This spreadsheet is too large to open. Ask an administrator to split it.");
    }
}

function createSmartSheetService({
    store,
    xlsx = xlsxService,
    scopeKey = defaultScopeKey,
    importLimiter = createWindowLimiter({ limit: LIMITS.IMPORTS_PER_USER, windowMs: LIMITS.IMPORT_WINDOW_MS }),
    importGate = createConcurrencyGate({ max: Infinity }),
    limits = LIMITS, // injectable so tests can use small caps; must be the same object the store was given
}) {
    async function requireActiveAccount(userId) {
        const account = await store.getAccount(userId);
        if (!isActiveAccount(account)) {
            throw new SmartSheetError(401, "UNAUTHENTICATED", "Authentication required.");
        }
        return account;
    }

    async function requireAdminAccount(userId) {
        const account = await requireActiveAccount(userId);
        if (!isAdminTier(account)) {
            throw forbidden("Only an Admin or Super Admin can do that.");
        }
        return account;
    }

    // need: 'view' | 'edit' | 'manage'
    async function authorize(userId, rawSheetId, need = "view") {
        const sheetId = parseSheetId(rawSheetId);
        const context = await store.getAccessContext(userId, sheetId);
        const access = resolveAccess(context);

        if (!access.allowed) {
            throw notFound();
        }
        if (need === "manage" && !access.canManage) {
            throw forbidden("Only an Admin or Super Admin can do that.");
        }
        if (need === "edit" && access.permission !== "edit") {
            throw new SmartSheetError(
                403,
                "READ_ONLY",
                context.sheet.status !== "active"
                    ? "This spreadsheet is archived and read-only."
                    : "You have view-only access to this spreadsheet."
            );
        }

        return { sheetId, sheet: context.sheet, account: context.account, ...access };
    }

    return {
        authorize,

        async listSheets(userId) {
            const account = await requireActiveAccount(userId);
            if (isAdminTier(account)) {
                return { canManage: true, sheets: await store.listSheetsForAdmin() };
            }
            return { canManage: false, sheets: await store.listSheetsForUser(userId) };
        },

        async createBlankSheet(userId, rawName) {
            await requireAdminAccount(userId);
            const name = validateSheetName(rawName);
            const sheetId = await store.createSheet({
                name,
                userId,
                worksheets: [{ name: "Sheet1", rowCount: LIMITS.DEFAULT_ROWS, columnCount: LIMITS.DEFAULT_COLUMNS, cells: [], layout: {} }],
            });
            return { id: sheetId, name };
        },

        // `file`: { path | buffer, originalName, storedPath } -- already size-limited by the upload middleware.
        // Production passes `path`: the workbook is then parsed in an isolated child process (directory check,
        // memory limit, timeout), never inside the CRM process. `buffer` is the in-process path used by tests.
        async importSheet(userId, rawName, file) {
            await requireAdminAccount(userId);

            const fallbackName = String(file.originalName || "").replace(/\.xlsx$/i, "");
            const name = validateSheetName(rawName && String(rawName).trim() ? rawName : fallbackName);

            // Per-USER limits (keyed by database scope + user id, since ids restart at 1 in every database).
            const key = `${scopeKey()}:${userId}`;
            const allowance = importLimiter.hit(key);
            if (!allowance.allowed) {
                throw new SmartSheetError(
                    429,
                    "IMPORT_RATE_LIMITED",
                    `You have imported several workbooks recently. Please wait ${Math.ceil(allowance.retryAfterMs / 60000)} minute(s) and try again.`,
                    { retryAfterMs: allowance.retryAfterMs }
                );
            }
            const release = importGate.acquire(key, 1);
            if (!release) {
                throw new SmartSheetError(429, "IMPORT_BUSY", "One of your workbooks is still being imported. Please wait for it to finish.", { retryAfterMs: 15000 });
            }

            try {
                const parsed = file.path ? await xlsx.parseXlsxFile(file.path) : await xlsx.parseXlsxBuffer(file.buffer);

                // The same growth limits as live editing, applied before anything is stored.
                let totalCells = 0;
                let totalBytes = 0;
                for (const worksheet of parsed.worksheets) {
                    for (const entry of worksheet.cells) {
                        entry.bytes = cellStorageBytes(entry.cell);
                        totalCells += 1;
                        totalBytes += entry.bytes;
                    }
                }
                if (totalCells > limits.MAX_CELLS_PER_SHEET || totalBytes > limits.MAX_SHEET_DATA_BYTES) {
                    throw invalid("IMPORT_TOO_LARGE", "This workbook holds more data than one spreadsheet can store. Split it into smaller workbooks.");
                }

                const sheetId = await store.createSheet({
                    name,
                    userId,
                    worksheets: parsed.worksheets,
                    source: { fileName: String(file.originalName || "").slice(0, 255), filePath: file.storedPath ? String(file.storedPath).slice(0, 500) : null },
                });

                return { id: sheetId, name, warnings: parsed.warnings, worksheetCount: parsed.worksheets.length };
            } finally {
                release();
            }
        },

        async getSheet(userId, rawSheetId) {
            const access = await authorize(userId, rawSheetId, "view");
            const sheet = await store.getSheet(access.sheetId);
            return { sheet, permission: access.permission, canManage: access.canManage };
        },

        // The current saved state, ready for the editor. Used on first open, after a refresh and
        // after a reconnect -- always the database's latest committed state.
        async getWorkbook(userId, rawSheetId) {
            const access = await authorize(userId, rawSheetId, "view");
            assertOpenable(await store.getSheet(access.sheetId), limits); // cheap metadata check BEFORE any cell is loaded
            const state = await store.loadWorkbook(access.sheetId);
            if (!state || state.sheet.deleted_at) throw notFound();
            return {
                workbook: toUniverWorkbook(state),
                revision: state.sheet.revision,
                permission: access.permission,
                canManage: access.canManage,
                sheet: { id: state.sheet.id, name: state.sheet.name, status: state.sheet.status },
            };
        },

        async updateSheet(userId, rawSheetId, changes) {
            const access = await authorize(userId, rawSheetId, "manage");
            const fields = {};
            if (changes.name !== undefined) fields.name = validateSheetName(changes.name);
            if (changes.status !== undefined) {
                if (!STATUSES.includes(changes.status)) throw invalid("INVALID_STATUS", "Invalid status.");
                fields.status = changes.status;
            }
            if (Object.keys(fields).length === 0) throw invalid("NOTHING_TO_UPDATE", "Nothing to update.");
            if (!(await store.updateSheet(access.sheetId, fields, userId))) throw notFound();
            return { id: access.sheetId, ...fields };
        },

        // Soft delete: the rows stay in the database (recoverable by an administrator with database
        // access) but the sheet disappears for everyone.
        async deleteSheet(userId, rawSheetId) {
            const access = await authorize(userId, rawSheetId, "manage");
            if (!(await store.softDeleteSheet(access.sheetId, userId))) throw notFound();
            return { id: access.sheetId };
        },

        async listAccess(userId, rawSheetId) {
            const access = await authorize(userId, rawSheetId, "manage");
            return { access: await store.listAccess(access.sheetId) };
        },

        async assign(userId, rawSheetId, { userIds, permission = "edit" }) {
            const access = await authorize(userId, rawSheetId, "manage");

            if (!PERMISSIONS.includes(permission)) throw invalid("INVALID_PERMISSION", "Permission must be view or edit.");
            if (!Array.isArray(userIds) || userIds.length === 0) throw invalid("INVALID_USERS", "Select at least one employee.");
            if (userIds.length > LIMITS.MAX_ASSIGNEES_PER_REQUEST) {
                throw invalid("INVALID_USERS", `Select at most ${LIMITS.MAX_ASSIGNEES_PER_REQUEST} employees at a time.`);
            }
            const ids = [...new Set(userIds.map((id) => parsePositiveId(id, "INVALID_USERS", "employee id")))];

            const granted = await store.grantAccess(access.sheetId, ids, permission, userId);
            return { granted, skipped: ids.filter((id) => !granted.includes(id)), permission };
        },

        async revoke(userId, rawSheetId, rawTargetUserId) {
            const access = await authorize(userId, rawSheetId, "manage");
            const targetUserId = parsePositiveId(rawTargetUserId, "INVALID_USERS", "employee id");
            const removed = await store.revokeAccess(access.sheetId, targetUserId);
            if (!removed) throw notFound();
            return { sheetId: access.sheetId, userId: targetUserId };
        },

        async searchEmployees(userId, query) {
            await requireAdminAccount(userId);
            return { employees: await store.searchEmployees(query, 50) };
        },

        // The join check: the same rules as any read, plus the latest revision so the client knows
        // which state it is looking at.
        async authorizeJoin(userId, rawSheetId) {
            const access = await authorize(userId, rawSheetId, "view");
            return {
                sheetId: access.sheetId,
                permission: access.permission,
                canManage: access.canManage,
                revision: access.sheet.revision,
                name: access.sheet.name,
            };
        },

        // One live edit. Order is the contract: authorize (fresh) -> validate -> PERSIST -> return.
        // The caller broadcasts only after this resolves, i.e. only after the database committed.
        async applyOperation(userId, rawSheetId, rawOperation) {
            const access = await authorize(userId, rawSheetId, "edit");
            const operation = validateOperation(rawOperation);
            const { revision } = await store.applyOperation(access.sheetId, userId, operation);
            return { sheetId: access.sheetId, revision, operation };
        },

        async exportXlsx(userId, rawSheetId) {
            const access = await authorize(userId, rawSheetId, "view");
            assertOpenable(await store.getSheet(access.sheetId), limits);
            const state = await store.loadWorkbook(access.sheetId);
            if (!state || state.sheet.deleted_at) throw notFound();
            return { buffer: await xlsx.buildXlsxBuffer(state), fileName: safeFileName(state.sheet.name) };
        },
    };
}

module.exports = { createSmartSheetService, toUniverWorkbook, describeError, safeFileName };
