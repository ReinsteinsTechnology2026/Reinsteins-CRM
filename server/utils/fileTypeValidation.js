// ==========================================
// FILE TYPE VALIDATION (Phase 14L)
//
// REAL FINDING, not theoretical: every existing upload fileFilter
// (chatUploadMiddleware.js, taskUploadMiddleware.js,
// meetingUploadMiddleware.js, fileUpload.js, uploadMiddleware.js)
// checked ONLY the client-supplied `file.mimetype` -- a value the
// browser sets from the multipart Content-Type header, which a
// scripted client can set to anything regardless of the file's real
// content. The SAVED file's extension, meanwhile, came from
// `path.extname(file.originalname)` -- also fully client-controlled,
// and NEVER cross-checked against the (also-spoofable) mimetype.
//
// Concretely: a client could claim mimetype "application/pdf" (passes
// every existing allow-list) while naming the file "x.html". multer
// would save it as `...-<timestamp>-<random>.html`. The authenticated
// file-serving route in app.js then calls res.sendFile() on it, which
// sets Content-Type from the FILE EXTENSION (via the `mime` package),
// not the original claimed mimetype -- so this would be served as
// `text/html` and execute as a live HTML/JS document in the victim's
// browser: a stored XSS delivered entirely through the "attach a PDF"
// feature, reachable by any authenticated tenant user against any
// other user in the same tenant (chat/task/meeting attachments are
// visible to other participants).
//
// FIX: an explicit extension allow-list, enforced INDEPENDENTLY of
// the existing mimetype check -- both must pass. Every dangerous,
// script-capable extension (.html, .htm, .svg, .js, .mjs, .php, .jsp,
// .asp, .aspx, .exe, .sh, .bat, .cmd, .ps1, .py, .rb, .jar, .apk,
// .dll, .com, .scr, .msi, .vbs, .wsf, .hta) is rejected outright,
// regardless of what mimetype was claimed for it.
// ==========================================

const path = require("path");

// Every extension any existing upload feature legitimately needs,
// derived directly from each middleware's existing mimetype allow-
// list -- this does not add or remove what users can upload, it only
// closes the gap where the extension and mimetype could disagree.
const SAFE_DOCUMENT_EXTENSIONS = new Set([
    ".jpg", ".jpeg", ".png", ".webp", ".gif",
    ".pdf",
    ".doc", ".docx",
    ".xls", ".xlsx",
    ".ppt", ".pptx",
    ".txt",
    ".zip", ".rar",
]);

const SAFE_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

// Phase 17c -- SOP library allow-list: PDF/DOC/DOCX plus the same
// image types as SAFE_IMAGE_EXTENSIONS (a scanned/photographed SOP is
// a legitimate upload), explicitly narrower than
// SAFE_DOCUMENT_EXTENSIONS (no xls/xlsx/ppt/pptx/txt/zip/rar/gif) per
// the feature's own explicit allow-list.
const SAFE_SOP_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".jpg", ".jpeg", ".png", ".webp"]);

function isSafeExtension(originalName, allowedExtensions) {
    const extension = path.extname(originalName || "").toLowerCase();
    return allowedExtensions.has(extension);
}

// Combined check -- BOTH the claimed mimetype (existing per-middleware
// allow-list, passed in) AND the extension (this file's allow-list)
// must be safe. Neither check alone is trusted.
function isSafeUpload(file, mimetypeAllowList, extensionAllowList) {
    return mimetypeAllowList.includes(file.mimetype) && isSafeExtension(file.originalname, extensionAllowList);
}

module.exports = {
    SAFE_DOCUMENT_EXTENSIONS,
    SAFE_IMAGE_EXTENSIONS,
    SAFE_SOP_EXTENSIONS,
    isSafeExtension,
    isSafeUpload,
};
