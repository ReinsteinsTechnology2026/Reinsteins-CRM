const fs = require("fs");
const path = require("path");

const { describeError } = require("../services/smartSheetService");
const realtime = require("../services/smartSheetRealtime");
const { getCurrentCompanySlug } = require("../utils/socketRooms");
const { UPLOADS_ROOT } = require("../utils/tenantUploadPath");

// ==========================================
// SMART SHEETS -- REST CONTROLLER
//
// Thin: every rule (who may do what, validation, persistence) lives in services/smartSheetService.js,
// which re-reads the caller's role and assignment from the database on every call. This file only
// translates HTTP <-> service calls and, after a database change that must cut live access
// (unassign, archive, delete), tells the Socket.IO layer to evict the affected sockets.
//
// Response shape follows the rest of the API: { success, ...data } / { success:false, code, message }.
// ==========================================

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function handle(work) {
    return async (req, res) => {
        try {
            await work(req, res);
        } catch (error) {
            const { status, code, message } = describeError(error);
            if (status >= 500) {
                console.error("Smart Sheets error:", error);
            }
            if (!res.headersSent) {
                res.status(status).json({ success: false, code, message });
            }
        }
    };
}

const ok = (res, data = {}, status = 200) => res.status(status).json({ success: true, ...data });

function io(req) {
    return req.app.get("io");
}

// The service is injected: production passes the PostgreSQL-backed one (see the bottom of this file),
// tests pass one built on an in-memory store.
function createSmartSheetController(service) {
    const listSheets = handle(async (req, res) => {
        ok(res, await service.listSheets(req.user.id));
    });

    const searchEmployees = handle(async (req, res) => {
        ok(res, await service.searchEmployees(req.user.id, req.query.q));
    });

    const createSheet = handle(async (req, res) => {
        ok(res, await service.createBlankSheet(req.user.id, req.body && req.body.name), 201);
    });

    const importSheet = handle(async (req, res) => {
        const storedPath = path.relative(UPLOADS_ROOT, req.file.path).split(path.sep).join("/");
        try {
            const buffer = await fs.promises.readFile(req.file.path);
            const result = await service.importSheet(req.user.id, req.body && req.body.name, {
                buffer,
                originalName: req.file.originalname,
                storedPath,
            });
            ok(res, result, 201);
        } catch (error) {
            // A rejected workbook must not stay on disk.
            await fs.promises.unlink(req.file.path).catch(() => {});
            throw error;
        }
    });

    const getSheet = handle(async (req, res) => {
        ok(res, await service.getSheet(req.user.id, req.params.id));
    });

    const getWorkbook = handle(async (req, res) => {
        res.set("Cache-Control", "no-store");
        ok(res, await service.getWorkbook(req.user.id, req.params.id));
    });

    const updateSheet = handle(async (req, res) => {
        const body = req.body || {};
        const result = await service.updateSheet(req.user.id, req.params.id, { name: body.name, status: body.status });
        if (result.status === "archived" && io(req)) {
            await realtime.evictAll(io(req), getCurrentCompanySlug(), result.id, "archived");
        }
        ok(res, result);
    });

    const deleteSheet = handle(async (req, res) => {
        const result = await service.deleteSheet(req.user.id, req.params.id);
        if (io(req)) {
            await realtime.evictAll(io(req), getCurrentCompanySlug(), result.id, "deleted");
        }
        ok(res, result);
    });

    const listAccess = handle(async (req, res) => {
        ok(res, await service.listAccess(req.user.id, req.params.id));
    });

    const assign = handle(async (req, res) => {
        const body = req.body || {};
        const result = await service.assign(req.user.id, req.params.id, { userIds: body.userIds, permission: body.permission });
        if (io(req)) {
            for (const userId of result.granted) {
                realtime.notifyAccessChanged(io(req), getCurrentCompanySlug(), req.params.id, userId, result.permission);
            }
        }
        ok(res, result);
    });

    const revoke = handle(async (req, res) => {
        const result = await service.revoke(req.user.id, req.params.id, req.params.userId);
        if (io(req)) {
            // Immediately: the employee's open tabs leave the room and are told why.
            await realtime.evictUser(io(req), getCurrentCompanySlug(), result.sheetId, result.userId, "unassigned");
        }
        ok(res, result);
    });

    const exportSheet = handle(async (req, res) => {
        const { buffer, fileName } = await service.exportXlsx(req.user.id, req.params.id);
        const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
        res.set({
            "Content-Type": XLSX_MIME,
            "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
            "Content-Length": buffer.length,
            "Cache-Control": "no-store",
        });
        res.end(buffer);
    });


    return { listSheets, searchEmployees, createSheet, importSheet, getSheet, getWorkbook, updateSheet, deleteSheet, listAccess, assign, revoke, exportSheet };
}

// Production instance. Required lazily so merely loading this module (e.g. in tests that inject their own
// service) does not touch the database configuration.
let defaultController = null;
function getDefaultController() {
    if (!defaultController) {
        const pool = require("../config/db");
        const { createPgStore } = require("../services/smartSheetStore");
        const { createSmartSheetService } = require("../services/smartSheetService");
        defaultController = createSmartSheetController(createSmartSheetService({ store: createPgStore({ pool }) }));
    }
    return defaultController;
}

module.exports = { createSmartSheetController, getDefaultController };
