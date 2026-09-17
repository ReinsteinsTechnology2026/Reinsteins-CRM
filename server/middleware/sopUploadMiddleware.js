const multer = require("multer");
const path = require("path");

const { tenantUploadAbsoluteDir } = require("../utils/tenantUploadPath");
const { SAFE_SOP_EXTENSIONS, isSafeUpload } = require("../utils/fileTypeValidation");

// ==========================================
// SOP UPLOAD MIDDLEWARE (Phase 17c)
//
// Destination resolved per-request from the authenticated tenant
// context (req.tenantCompany, set synchronously by tenantAuthMiddleware.js
// BEFORE multer ever runs) -- never from req.body/req.params, and
// never via the AsyncLocalStorage-backed getCurrentCompanySlug()
// inside a multer callback specifically (see tenantUploadPath.js's
// own "Phase 16B" comment for why that specific combination is
// unsafe under concurrency). This exactly matches every other
// tenant-scoped multer config in this codebase
// (uploadMiddleware.js/chatUploadMiddleware.js/etc.).
// ==========================================

const storage = multer.diskStorage({
  destination(req, file, callback) {
    callback(null, tenantUploadAbsoluteDir(req, "sops"));
  },

  filename(req, file, callback) {
    // The original filename is NEVER trusted for anything beyond
    // reading its extension (already validated below) -- the stored
    // name is entirely server-generated, so nothing about the
    // client-supplied name (path separators, "..", null bytes, a
    // double extension, etc.) can influence where or as what this
    // file is written.
    const extension = path.extname(file.originalname).toLowerCase();
    const uniqueName = `sop-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;
    callback(null, uniqueName);
  },
});

const allowedMimeTypes = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "image/webp",
];

const fileFilter = (req, file, callback) => {
  if (isSafeUpload(file, allowedMimeTypes, SAFE_SOP_EXTENSIONS)) {
    callback(null, true);
  } else {
    callback(new Error("Only PDF, DOC, DOCX, JPG, JPEG, PNG and WEBP files are allowed."));
  }
};

const uploadSop = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB -- generous for a document/scan, well below fileUpload.js's generic 50MB
  },
});

module.exports = {
  uploadSop,
};
