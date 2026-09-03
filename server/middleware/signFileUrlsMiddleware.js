const { signFileUrl } = require("../utils/fileAccessToken");
const { __getCurrentCompanySlug: getCurrentCompanySlug } = require("../config/db");

// ==========================================
// SIGN FILE URLS (Multi-Tenant File Storage Phase)
//
// A single, centralized point that signs every /uploads/... path
// anywhere in an outgoing JSON response, rather than editing every
// individual controller/service that happens to return one.
//
// WHY CENTRALIZED (not per-call-site edits): investigation found raw
// /uploads paths returned from at least 5 different files
// (employeeController.js profile_photo x5, reportController.js
// profile_photo x4, chatController.js, meetingService.js,
// taskActivityService.js) under several different response key names
// (profile_photo, image, file_path). A centralized transform depends
// only on the VALUE shape (a string starting with "/uploads/"), never
// on knowing every field name or every file that returns one -- so it
// cannot silently miss a call site the way 15+ scattered edits could.
// A missed/unsigned path is a fail-SAFE bug (the file-serving
// endpoint below rejects the missing token, so the image breaks
// visibly) rather than a fail-OPEN security leak, so centralizing
// this made the design LESS risky, not more "clever" in a bad way.
//
// Uses the exact same getCurrentCompanySlug() AsyncLocalStorage
// lookup already used for tenant DB selection (config/db.js) and
// Socket.IO room naming (utils/socketRooms.js) -- there is only ever
// one source of truth for "which tenant is this request" anywhere in
// the app.
//
// Idempotent: a path that has already been signed (contains "fat=")
// is left untouched, so this is safe to apply even to a value that
// was already explicitly signed elsewhere (see the two Socket.IO
// emit call sites in chatController.js/meetingController.js, which
// must sign manually since a socket emit never passes through
// res.json).
// ==========================================

const UPLOAD_PATH_PATTERN = /^\/uploads\//;

function isUnsignedUploadPath(value) {
    return (
        typeof value === "string" &&
        UPLOAD_PATH_PATTERN.test(value) &&
        !value.includes("fat=")
    );
}

function signFileUrlsDeep(value, companySlug, depth = 0) {
    if (depth > 8) return value; // defensive recursion cap -- response shapes here never nest this deep
    if (isUnsignedUploadPath(value)) {
        return signFileUrl(value, companySlug);
    }
    if (Array.isArray(value)) {
        return value.map((item) => signFileUrlsDeep(item, companySlug, depth + 1));
    }
    if (value && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) {
        const out = {};
        for (const key of Object.keys(value)) {
            out[key] = signFileUrlsDeep(value[key], companySlug, depth + 1);
        }
        return out;
    }
    return value;
}

function signFileUrlsMiddleware(req, res, next) {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
        const companySlug = getCurrentCompanySlug();
        return originalJson(signFileUrlsDeep(body, companySlug));
    };
    next();
}

module.exports = {
    signFileUrlsDeep,
    signFileUrlsMiddleware,
};
