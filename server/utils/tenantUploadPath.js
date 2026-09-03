const path = require("path");
const fs = require("fs");

const { __getCurrentCompanySlug: getCurrentCompanySlug } = require("../config/db");

// ==========================================
// TENANT UPLOAD PATH (Multi-Tenant File Storage Phase)
//
// The ONLY place that decides where a newly-uploaded file physically
// lands on disk. Tenant identity comes exclusively from
// getCurrentCompanySlug() -- the same AsyncLocalStorage-backed lookup
// already used for tenant DB selection and Socket.IO room naming, set
// once per request by protect/tenantProtect and never influenced by
// req.body/req.params/req.query. A malicious client cannot choose a
// destination folder: nothing here ever reads anything from the
// request except (indirectly, via multer) the file's own bytes.
//
// LEGACY COMPATIBILITY: this governs NEW uploads only. The one
// pre-existing Reinsteins file (uploads/profiles/employee-4-*.jpeg)
// stays exactly where it is -- not moved, not touched. Every new
// upload, including new Reinsteins uploads via the legacy login path
// (getCurrentCompanySlug() correctly resolves to "reinsteins" there
// too), lands under uploads/tenant_<slug>/... from this phase
// onward, so there is exactly one going-forward convention and only
// one narrow, explicit grandfathered exception -- not two competing
// active conventions.
// ==========================================

const UPLOADS_ROOT = path.join(__dirname, "..", "uploads");

// category: a relative subpath under the tenant's folder, e.g.
// "profiles", "chat/images", "chat/files", "tasks",
// "meetings/images", "meetings/files", "files".
function tenantUploadSubdir(category) {
    return path.posix.join(`tenant_${getCurrentCompanySlug()}`, category);
}

// Absolute filesystem directory for the CURRENT request's tenant +
// category, created if missing (same fail-safe pattern the existing
// multer configs already used for their fixed directories).
function tenantUploadAbsoluteDir(category) {
    const dir = path.join(UPLOADS_ROOT, ...tenantUploadSubdir(category).split("/"));
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// The public URL path (what gets stored in the DB / returned in API
// responses, before signing) for a file already written into that
// directory by multer.
function tenantUploadUrlPath(category, filename) {
    return `/uploads/${tenantUploadSubdir(category)}/${filename}`;
}

module.exports = {
    UPLOADS_ROOT,
    tenantUploadAbsoluteDir,
    tenantUploadUrlPath,
};
