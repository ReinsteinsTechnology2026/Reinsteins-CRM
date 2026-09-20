const multer = require("multer");
const path = require("path");

const { tenantUploadAbsoluteDir } = require("../utils/tenantUploadPath");
const { SAFE_DOCUMENT_EXTENSIONS, isSafeUpload } = require("../utils/fileTypeValidation");

// ==========================================
// STORAGE
//
// Destination is resolved per-request from the authenticated tenant
// context (never from req.body/req.params) -- see
// utils/tenantUploadPath.js.
// ==========================================

const storage = multer.diskStorage({
  destination(req, file, callback) {
    if (file.mimetype.startsWith("image/")) {
      callback(null, tenantUploadAbsoluteDir(req, "chat/images"));
    } else {
      callback(null, tenantUploadAbsoluteDir(req, "chat/files"));
    }
  },

  filename(req, file, callback) {
    const extension = path.extname(file.originalname);

    callback(
      null,
      `chat-${Date.now()}-${Math.round(
        Math.random() * 1000000
      )}${extension}`
    );
  },
});

// ==========================================
// ALLOWED FILE TYPES
// ==========================================

const allowedTypes = [
  // Images
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",

  // PDF
  "application/pdf",

  // Word
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",

  // Excel
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",

  // PowerPoint
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",

  // Text
  "text/plain",

  // Zip
  "application/zip",
  "application/x-zip-compressed",
  "application/x-rar-compressed",
];

// Phase 14L -- mimetype AND extension must both be safe (see
// utils/fileTypeValidation.js for why the mimetype check alone was
// exploitable).
const fileFilter = (req, file, callback) => {
  if (isSafeUpload(file, allowedTypes, SAFE_DOCUMENT_EXTENSIONS)) {
    callback(null, true);
  } else {
    callback(
      new Error("Unsupported file type."),
      false
    );
  }
};

// ==========================================
// EXPORT
// ==========================================

module.exports = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
});