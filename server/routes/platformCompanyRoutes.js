const express = require("express");

const router = express.Router();

const {
    createCompany,
    createFirstAdmin,
    listCompanies,
    getStats,
    getCompanyDetails,
    updateStatus,
    updateAccessType,
    resolveCompanyForLogoUpload,
    setCompanyLogo,
    handleLogoUploadError,
    removeCompanyLogo,
    updateSubscription,
    updateBillingContact,
    removeBillingContact,
    deleteCompany,
} = require("../controllers/platformCompanyController");
const { platformProtect } = require("../middleware/platformAuthMiddleware");
const { billingContactLimiter } = require("../middleware/rateLimiters");
const { uploadCompanyLogo } = require("../middleware/companyLogoUploadMiddleware");

// ==========================================
// PLATFORM COMPANY ROUTES (Phase 2D / 2E / 4)
// Mounted at /api/platform/companies in app.js. Every route here
// requires an authenticated, active Platform Owner -- a tenant JWT
// (or no token at all) is rejected by platformProtect before any
// handler runs.
//
// Route order matters: /stats must be registered before /:id, or
// Express would match a request for "/stats" as :id="stats".
// ==========================================

router.get("/", platformProtect, listCompanies);
router.get("/stats", platformProtect, getStats);

router.post("/", platformProtect, createCompany);

// Phase 2E -- create a company's first tenant Administrator. Writes
// only to that company's own tenant database (resolved server-side
// from :companyId); never touches groworgs_platform_db.platform_users.
router.post("/:companyId/admin", platformProtect, createFirstAdmin);

// Phase 4 -- company management (Platform Owner Dashboard).
router.get("/:id", platformProtect, getCompanyDetails);
router.patch("/:id/status", platformProtect, updateStatus);
router.patch("/:id/access-type", platformProtect, updateAccessType);

// Company branding (logo) -- Platform Owner only, for this phase.
// resolveCompanyForLogoUpload runs before multer so the upload
// destination is already resolved from a server-verified company
// slug (never a client-supplied path) by the time any file bytes are
// accepted -- see companyLogoUploadMiddleware.js's own header comment.
// handleLogoUploadError is a 4-arg (err, req, res, next) error handler
// -- Express only invokes it if uploadCompanyLogo called next(err)
// (a fileFilter/file-size rejection, or now a destination-directory
// failure -- see companyLogoUploadMiddleware.js); it never runs on
// the ordinary success path, since setCompanyLogo always sends its
// own response and never calls next().
router.post(
    "/:id/logo",
    platformProtect,
    resolveCompanyForLogoUpload,
    uploadCompanyLogo.single("logo"),
    setCompanyLogo,
    handleLogoUploadError
);
router.delete("/:id/logo", platformProtect, removeCompanyLogo);

// Phase 8 -- company subscription/plan management. Metadata-only;
// never touches tenant_db_name or any tenant database.
router.patch("/:id/subscription", platformProtect, updateSubscription);

// Phase 13A/13B -- billing contact (platform-level SaaS metadata
// only, never a tenant employee record).
router.patch("/:id/billing-contact", platformProtect, billingContactLimiter, updateBillingContact);
router.delete("/:id/billing-contact", platformProtect, billingContactLimiter, removeBillingContact);

// Delete a company (with server-side confirmation) -- drops its
// tenant database and removes its companies row. See
// platformCompanyController.js's deleteCompany for the safety
// guarantees (Reinsteins is unconditionally excluded).
router.delete("/:id", platformProtect, deleteCompany);

module.exports = router;
