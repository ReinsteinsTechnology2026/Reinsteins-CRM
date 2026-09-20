const path = require("path");
const fs = require("fs");

const {
    __getCurrentCompanySlug: getCurrentCompanySlug,
    __LEGACY_COMPANY_SLUG: LEGACY_COMPANY_SLUG,
} = require("../config/db");

// ==========================================
// TENANT UPLOAD PATH (Multi-Tenant File Storage Phase; destination
// resolution reworked in Phase 16B -- see the "Phase 16B" comment
// below on tenantUploadAbsoluteDir for why)
//
// The ONLY place that decides where a newly-uploaded file physically
// lands on disk. A malicious client cannot choose a destination
// folder: nothing here ever reads anything from the request except
// (indirectly, via multer) the file's own bytes, and (as of Phase
// 16B) the ALREADY-AUTHENTICATED req.tenantCompany/req.user object
// tenantProtect/protect attached to THIS SAME request synchronously,
// before multer ever ran -- never req.body/req.params/req.query.
//
// LEGACY COMPATIBILITY: this governs NEW uploads only. The one
// pre-existing Reinsteins file (uploads/profiles/employee-4-*.jpeg)
// stays exactly where it is -- not moved, not touched. Every new
// upload, including new Reinsteins uploads via the legacy login path,
// lands under uploads/tenant_<slug>/... from this phase onward, so
// there is exactly one going-forward convention and only one narrow,
// explicit grandfathered exception -- not two competing conventions.
// ==========================================

const UPLOADS_ROOT = path.join(__dirname, "..", "uploads");

// category: a relative subpath under the tenant's folder, e.g.
// "profiles", "chat/images", "chat/files", "tasks",
// "meetings/images", "meetings/files", "files".
function tenantUploadSubdir(category) {
    return path.posix.join(`tenant_${getCurrentCompanySlug()}`, category);
}

// ==========================================
// PHASE 16B -- tenant slug resolution for a multer DESTINATION
// callback specifically. Multer's destination/filename callbacks are
// `(req, file, cb) => {}` -- req is already passed in directly, every
// time, for every file. This reads the tenant slug from THAT req
// object (req.tenantCompany.company_slug, set synchronously by
// tenantAuthMiddleware.js's tenantProtect before multer ever runs;
// falls back to the legacy slug for a request authenticated via the
// plain Reinsteins /api/auth path, which never sets req.tenantCompany
// at all) instead of the ambient, AsyncLocalStorage-backed
// getCurrentCompanySlug() the rest of this file still correctly uses
// for ordinary controller-code/Socket.IO call sites.
//
// ROOT CAUSE this replaces: multer's destination callback fires from
// INSIDE busboy's multipart stream parsing, driven by the underlying
// HTTP request socket's own 'data' events -- an async continuation
// whose AsyncLocalStorage context is tied to when that socket/stream
// was constructed (deep in Node's HTTP server internals, BEFORE
// Express routing, BEFORE tenantProtect's AsyncLocalStorage.run()
// call ever happens), not to when tenantProtect's context was
// established. Under load, this occasionally resolved to whatever
// context happened to be ambient at that moment -- observed directly
// in Phase 16A testing as one tenant's uploaded file landing in
// uploads/tenant_reinsteins/ (the fallback default) instead of its
// own tenant folder. Every OTHER getCurrentCompanySlug() call site in
// this codebase (ordinary async/await controller code, and Socket.IO
// handlers, which explicitly re-run their own
// runWithTenantContext(socket.tenantContext, ...) per event) does not
// share this specific failure mode and is intentionally left
// unchanged.
//
// req is a plain per-request object with no cross-request sharing --
// reading a property already synchronously attached to it, before
// multer starts, before any stream/socket callback timing is
// involved, cannot race regardless of how busboy schedules its
// internal callbacks.
// ==========================================
function resolveCompanySlugFromRequest(req) {
    return (req && req.tenantCompany && req.tenantCompany.company_slug) || LEGACY_COMPANY_SLUG;
}

// Absolute filesystem directory for the file currently being
// uploaded on THIS request's tenant + category, created if missing
// (same fail-safe pattern the existing multer configs already used
// for their fixed directories). req is REQUIRED (see the Phase 16B
// comment above) -- every multer destination callback in this
// codebase already receives it as its first argument.
function tenantUploadAbsoluteDir(req, category) {
    const companySlug = resolveCompanySlugFromRequest(req);
    const dir = path.join(UPLOADS_ROOT, `tenant_${companySlug}`, ...category.split("/"));
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// The public URL path (what gets stored in the DB / returned in API
// responses, before signing) for a file already written into that
// directory by multer. Called from ordinary controller code AFTER
// multer has already finished (back in Express's normal middleware
// chain, not multer's own internal callback) -- proven reliable
// across extensive Phase 16A testing (the stored URL consistently
// named the CORRECT tenant even on the one run where the physical
// file itself was misfiled by the destination-callback bug above),
// so left on the existing AsyncLocalStorage-based resolution rather
// than changed alongside it.
function tenantUploadUrlPath(category, filename) {
    return `/uploads/${tenantUploadSubdir(category)}/${filename}`;
}

module.exports = {
    UPLOADS_ROOT,
    tenantUploadAbsoluteDir,
    tenantUploadUrlPath,
};
