// ==========================================
// SMART SHEETS -- WORKBOOK PARSE WORKER (runs in a CHILD PROCESS; never required by the server itself)
//
// Parsing an .xlsx builds the whole workbook in memory and is CPU heavy. Doing that inside the CRM's single
// Node process would stall every tenant's sockets and requests (measured: a 5 MB workbook froze the process
// for 2.6 s; a 21 MB one for 11 s and 1.4 GB). So it runs here, in a separate process started with its own
// heap limit (--max-old-space-size) and killed after a timeout (services/smartSheetImportRunner.js).
// If this process runs out of memory it simply dies; the CRM keeps serving.
//
// This file loads NO database or environment code: only ExcelJS and the pure Smart Sheets modules.
// Protocol: the parent sends { filePath }; this answers { ok:true, result } or { ok:false, status, code, message }.
// ==========================================

const fs = require("fs");

const { parseXlsxBuffer } = require("./smartSheetXlsxService");

process.once("message", async (message) => {
    let reply;
    try {
        const buffer = await fs.promises.readFile(message.filePath);
        reply = { ok: true, result: await parseXlsxBuffer(buffer) };
    } catch (error) {
        reply = {
            ok: false,
            status: error && error.status ? error.status : 400,
            code: error && error.code ? error.code : "INVALID_XLSX",
            message: error && error.status ? error.message : "The file could not be read as an Excel (.xlsx) workbook.",
        };
    }
    process.send(reply, () => process.exit(0));
});
