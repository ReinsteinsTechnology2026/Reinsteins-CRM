const multer = require("multer");
const crypto = require("crypto");
const path = require("path");

// Accessed via the module object (not destructured), same style as the other upload middlewares.
const tenantUploadPath = require("../utils/tenantUploadPath");
const { LIMITS } = require("../utils/smartSheetValidation");

// ==========================================
// SMART SHEETS -- .xlsx UPLOAD
//
// Runs AFTER authentication and the admin-tier check (see smartSheetRoutes.js), so nobody else can
// make the server write a file. Files are stored with the existing tenant upload convention:
//   uploads/tenant_<company>/smart-sheets/<random>.xlsx
// The client's file name is never used as a path: the stored name is random and the extension is
// forced to .xlsx. Only the extension is checked here (the browser's MIME type is spoofable); the
// real content check -- ZIP signature, then a full ExcelJS parse -- happens in
// services/smartSheetXlsxService.js, and the controller deletes the stored file if it fails.
//
// One file, size-limited (LIMITS.MAX_UPLOAD_BYTES), one text field `name`.
// ==========================================

const storage = multer.diskStorage({
    destination(req, _file, cb) {
        try {
            cb(null, tenantUploadPath.tenantUploadAbsoluteDir(req, "smart-sheets"));
        } catch (error) {
            cb(error);
        }
    },
    filename(_req, _file, cb) {
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}.xlsx`);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: LIMITS.MAX_UPLOAD_BYTES, files: 1, fields: 5, fieldSize: 1024 },
    fileFilter(_req, file, cb) {
        if (path.extname(String(file.originalname || "")).toLowerCase() === ".xlsx") {
            cb(null, true);
        } else {
            const error = new Error("Only .xlsx files can be uploaded.");
            error.code = "SMART_SHEET_BAD_EXTENSION";
            cb(error);
        }
    },
});

function uploadSmartSheetFile(req, res, next) {
    upload.single("file")(req, res, (error) => {
        if (!error) {
            if (!req.file) {
                return res.status(400).json({ success: false, code: "FILE_REQUIRED", message: "Choose an .xlsx file to upload." });
            }
            return next();
        }

        if (error.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({
                success: false,
                code: "FILE_TOO_LARGE",
                message: `The file is larger than the ${Math.round(LIMITS.MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit.`,
            });
        }
        if (error.code === "SMART_SHEET_BAD_EXTENSION" || error.name === "MulterError") {
            return res.status(400).json({
                success: false,
                code: "INVALID_FILE",
                message: error.code === "SMART_SHEET_BAD_EXTENSION" ? error.message : "The upload was not valid.",
            });
        }

        console.error("Smart Sheets upload error:", error.message);
        return res.status(500).json({ success: false, code: "UPLOAD_FAILED", message: "The file could not be uploaded." });
    });
}

module.exports = { uploadSmartSheetFile };
