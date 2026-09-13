const multer = require("multer");
const path = require("path");

const { tenantUploadAbsoluteDir } = require("../utils/tenantUploadPath");
const { SAFE_DOCUMENT_EXTENSIONS, isSafeUpload } = require("../utils/fileTypeValidation");

// ==========================================
// MEETING CHAT UPLOAD MIDDLEWARE
//
// Deliberately its own multer config (not a
// shared import from chatUploadMiddleware.js)
// so the normal WorkHub Chat upload path is
// never touched by this feature — but the
// RULES below (allowed MIME types, size limit)
// are copied verbatim from chatUploadMiddleware.js
// so Meeting Chat supports exactly the same safe
// file types as normal Chat, no more, no less.
// Meeting attachments are stored under their own
// meetings/* subdirectories, kept separate from
// chat/* — meeting attachments must never be
// mistaken for normal chat attachments. Both live
// under the same per-tenant root (see
// utils/tenantUploadPath.js), resolved per-request
// from the authenticated tenant context, never from
// req.body/req.params.
// ==========================================

const storage = multer.diskStorage({
  destination(req, file, callback) {
    if (file.mimetype.startsWith("image/")) {
      callback(null, tenantUploadAbsoluteDir("meetings/images"));
    } else {
      callback(null, tenantUploadAbsoluteDir("meetings/files"));
    }
  },

  filename(req, file, callback) {
    const extension = path.extname(file.originalname);

    callback(
      null,
      `meeting-${Date.now()}-${Math.round(Math.random() * 1000000)}${extension}`
    );
  },
});

// ==========================================
// ALLOWED FILE TYPES
// Identical whitelist to chatUploadMiddleware.js
// — same safe file types, no video, nothing new.
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

// Phase 14L -- mimetype AND extension must both be safe.
const fileFilter = (req, file, callback) => {
  if (isSafeUpload(file, allowedTypes, SAFE_DOCUMENT_EXTENSIONS)) {
    callback(null, true);
  } else {
    callback(new Error("Unsupported file type."), false);
  }
};

// ==========================================
// EXPORT
// Same 50MB limit as normal chat.
// ==========================================

module.exports = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
});
