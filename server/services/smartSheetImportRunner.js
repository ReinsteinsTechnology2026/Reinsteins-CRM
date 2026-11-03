const path = require("path");
const { fork } = require("child_process");

const { LIMITS } = require("../utils/smartSheetValidation");
const { SmartSheetError, invalid } = require("../utils/smartSheetErrors");
const { inspectZipFile } = require("../utils/zipInspect");
const { createConcurrencyGate } = require("../utils/smartSheetLimiter");

// ==========================================
// SMART SHEETS -- ISOLATED WORKBOOK IMPORT
//
// parseXlsxFileIsolated(filePath):
//   1. reads the archive's DIRECTORY ONLY and refuses anything that declares more than
//      LIMITS.MAX_UNCOMPRESSED_IMPORT_BYTES (a decompression bomb never reaches a parser);
//   2. takes one of LIMITS.MAX_CONCURRENT_IMPORTS slots (more simultaneous imports are told to retry);
//   3. parses in a CHILD PROCESS with its own heap limit and a timeout, so a hostile or merely huge workbook
//      can at worst kill/timeout that child -- the CRM process, and every other tenant, keeps running.
// ==========================================

const WORKER_PATH = path.join(__dirname, "smartSheetImportWorker.js");
const gate = createConcurrencyGate({ max: LIMITS.MAX_CONCURRENT_IMPORTS });

function runWorker(filePath, { memoryMb, timeoutMs, workerPath }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        // A MINIMAL environment: the worker needs no credentials, so none are passed to it.
        const child = fork(workerPath, [], {
            execArgv: [`--max-old-space-size=${memoryMb}`],
            serialization: "advanced",
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            env: { NODE_ENV: process.env.NODE_ENV || "production" },
        });

        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                child.kill("SIGKILL");
            } catch (_alreadyGone) {
                // the child already exited
            }
            fn(value);
        };

        const timer = setTimeout(
            () => finish(reject, invalid("IMPORT_TIMEOUT", "This workbook took too long to process. Try a smaller workbook.")),
            timeoutMs
        );

        child.once("message", (reply) => {
            if (reply && reply.ok) return finish(resolve, reply.result);
            finish(reject, new SmartSheetError((reply && reply.status) || 400, (reply && reply.code) || "INVALID_XLSX", (reply && reply.message) || "The file could not be read."));
        });
        // Exit without an answer = out of memory (or crashed): the limit did its job. A short grace period,
        // because Node can report the exit a moment before it delivers the child's last message.
        child.once("exit", () =>
            setTimeout(
                () => finish(reject, invalid("IMPORT_TOO_LARGE", "This workbook is too large to process safely. Remove unused data or split it into smaller workbooks.")),
                150
            )
        );
        child.once("error", () => finish(reject, new SmartSheetError(500, "SERVER_ERROR", "The workbook could not be processed.")));

        child.send({ filePath });
    });
}

async function parseXlsxFileIsolated(filePath, options = {}) {
    const { memoryMb = LIMITS.IMPORT_MEMORY_LIMIT_MB, timeoutMs = LIMITS.IMPORT_TIMEOUT_MS, workerPath = WORKER_PATH } = options;

    await inspectZipFile(filePath); // throws before anything is parsed

    const release = gate.acquire("global");
    if (!release) {
        throw new SmartSheetError(429, "IMPORT_BUSY", "Other workbooks are being imported right now. Please try again in a minute.", { retryAfterMs: 15000 });
    }
    try {
        return await runWorker(filePath, { memoryMb, timeoutMs, workerPath });
    } finally {
        release();
    }
}

module.exports = { parseXlsxFileIsolated, importGate: gate };
