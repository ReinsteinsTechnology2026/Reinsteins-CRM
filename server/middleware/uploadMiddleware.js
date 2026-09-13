const multer = require("multer");
const path = require("path");

const { tenantUploadAbsoluteDir } = require("../utils/tenantUploadPath");
const { SAFE_IMAGE_EXTENSIONS, isSafeUpload } = require("../utils/fileTypeValidation");

// ==========================================
// STORAGE CONFIGURATION
//
// Destination is resolved per-request from the authenticated
// tenant context (never from req.body/req.params) -- see
// utils/tenantUploadPath.js.
// ==========================================

const storage = multer.diskStorage({
  destination: (
    req,
    file,
    callback
  ) => {
    callback(
      null,
      tenantUploadAbsoluteDir("profiles")
    );
  },

  filename: (
    req,
    file,
    callback
  ) => {
    const extension =
      path.extname(
        file.originalname
      ).toLowerCase();

    const uniqueName =
      `employee-${req.user.id}-${Date.now()}${extension}`;

    callback(
      null,
      uniqueName
    );
  },
});

// ==========================================
// FILE FILTER
// ==========================================

const fileFilter = (
  req,
  file,
  callback
) => {
  const allowedMimeTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
  ];

  if (
    // Phase 14L -- mimetype AND extension must both be safe.
    isSafeUpload(
      file,
      allowedMimeTypes,
      SAFE_IMAGE_EXTENSIONS
    )
  ) {
    callback(
      null,
      true
    );
  } else {
    callback(
      new Error(
        "Only JPG, JPEG, PNG and WEBP images are allowed"
      ),
      false
    );
  }
};

// ==========================================
// MULTER CONFIGURATION
// Maximum profile photo size: 5 MB
// ==========================================

const uploadProfilePhoto =
  multer({
    storage,

    fileFilter,

    limits: {
      fileSize:
        5 * 1024 * 1024,
    },
  });

// ==========================================
// EXPORT
// ==========================================

module.exports = {
  uploadProfilePhoto,
};