const multer = require("multer");
const crypto = require("crypto");
const path = require("path");

// Accessed via the module object (tenantUploadPath.tenantUploadAbsoluteDirForSlug),
// not destructured -- lets _test_company_logo_upload_error_handling.js
// substitute a throwing implementation for one call without needing a
// real directory-permission failure to exercise the try/catch below.
// Same function, same behavior, purely a reference-access style choice.
const tenantUploadPath = require("../utils/tenantUploadPath");
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

// Explicit try/catch, not left to throw synchronously -- unlike
// uploadMiddleware.js's equivalent (profiles/, an already-existing
// directory since Phase 1), this is the first-ever write into
// tenant_<slug>/branding/, so its mkdirSync(..., {recursive: true})
// genuinely can fail (permissions, a non-directory already at that
// path, etc.) in a way that's never been exercised in production
// before. A thrown error here would otherwise escape multer's own
// handling inconsistently; calling back with the error instead routes
// it through the SAME next(err) path multer already uses for
// fileFilter/size rejections, so the route-level error handler in
// platformCompanyController.js sees it uniformly. Path resolution/
// isolation itself (tenantUploadAbsoluteDirForSlug) is completely
// unchanged. Exported (not an inline closure) so this exact logic is
// independently testable without needing a real multipart request.
function resolveLogoDestination(req, file, callback) {
    try {
        const dir = tenantUploadPath.tenantUploadAbsoluteDirForSlug(req.targetCompany.companySlug, "branding");
        callback(null, dir);
    } catch (destinationError) {
        callback(destinationError);
    }
}

const storage = multer.diskStorage({
    destination: resolveLogoDestination,

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
    resolveLogoDestination,
};
