const multer = require("multer");
const crypto = require("crypto");
const path = require("path");

const { tenantUploadAbsoluteDirForSlug } = require("../utils/tenantUploadPath");
const { SAFE_IMAGE_EXTENSIONS, isSafeUpload } = require("../utils/fileTypeValidation");

// ==========================================
// COMPANY LOGO UPLOAD MIDDLEWARE
//
// Platform-Owner-driven, not tenant-session-driven -- destination is
// resolved from req.targetCompany.companySlug, which
// platformCompanyController.js's resolveCompanyForLogoUpload
// middleware attaches SYNCHRONOUSLY (from a server-side DB lookup by
// company ID, never from client input) before this ever runs -- same
// "resolved before multer, never from req.body/req.params/req.query"
// invariant every other upload middleware in this codebase already
// follows (see utils/tenantUploadPath.js's own header comment).
//
// No SVG -- SAFE_IMAGE_EXTENSIONS (jpg/jpeg/png/webp) is the same
// allow-list uploadMiddleware.js already uses for profile photos,
// deliberately reused rather than inventing a separate one. Both
// mimetype AND extension must agree (isSafeUpload), same defense as
// every other upload in this codebase (see fileTypeValidation.js's
// own header comment on why mimetype alone is spoofable).
// ==========================================

const storage = multer.diskStorage({
    destination: (req, file, callback) => {
        callback(null, tenantUploadAbsoluteDirForSlug(req.targetCompany.companySlug, "branding"));
    },

    // Deterministic, server-generated filename only -- file.originalname
    // is NEVER used beyond validating its extension in fileFilter below,
    // and even that validated extension (not the raw originalname) is
    // what gets appended here.
    filename: (req, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        const uniqueName = `logo-${crypto.randomUUID()}${extension}`;
        callback(null, uniqueName);
    },
});

const fileFilter = (req, file, callback) => {
    const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp"];

    if (isSafeUpload(file, allowedMimeTypes, SAFE_IMAGE_EXTENSIONS)) {
        callback(null, true);
    } else {
        callback(new Error("Only JPG, JPEG, PNG and WEBP images are allowed"), false);
    }
};

// 2 MB -- a company logo is a small, simple asset; deliberately
// tighter than the 5 MB profile-photo limit.
const uploadCompanyLogo = multer({
    storage,
    fileFilter,
    limits: { fileSize: 2 * 1024 * 1024 },
});

module.exports = {
    uploadCompanyLogo,
};
