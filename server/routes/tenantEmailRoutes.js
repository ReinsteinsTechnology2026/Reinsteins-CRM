const express = require("express");

const {
  listDomains,
  registerDomain,
} = require(
  "../controllers/tenantEmailController"
);

const {
  protect,
} = require(
  "../middleware/authMiddleware"
);

const {
  requireAccess,
} = require(
  "../middleware/accessMiddleware"
);

// Business email domain management is company-wide configuration --
// restricted to admin/super_admin, narrower than employee management
// (which also allows hr). role='admin' still always passes per
// accessMiddleware.js's requireAccess().

const manageEmailDomains = requireAccess("super_admin", "admin");

const router = express.Router();

// ==========================================
// ADMIN -- LIST COMPANY EMAIL DOMAINS
// ==========================================

router.get(
  "/domains",
  protect,
  manageEmailDomains,
  listDomains
);

// ==========================================
// ADMIN -- REGISTER A NEW COMPANY EMAIL DOMAIN
// ==========================================

router.post(
  "/domains",
  protect,
  manageEmailDomains,
  registerDomain
);

module.exports = router;
