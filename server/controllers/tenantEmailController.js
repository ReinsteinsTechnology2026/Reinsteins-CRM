const emailDomainService = require("../services/emailDomainService");

// ==========================================
// TENANT BUSINESS EMAIL -- DOMAIN MANAGEMENT (Phase 16A)
//
// req.tenantCompany is set by tenantProtect (via authMiddleware.js's
// `protect` fallthrough) -- same mechanism employeeController.js's
// getCompanyEmailDomain already relies on. A request that somehow
// reaches here without a resolved tenant company (e.g. a legacy
// Reinsteins admin token, which never sets req.tenantCompany) is
// refused outright rather than falling through to
// company_id = NULL, which would violate email_domains' NOT NULL
// constraint and surface as a raw 500 instead of a clean 403.
// ==========================================

const requireTenantCompany = (req, res) => {
  if (!req.tenantCompany?.id) {
    res.status(403).json({
      success: false,
      message: "This action requires a tenant account",
    });
    return null;
  }

  return req.tenantCompany.id;
};

// ==========================================
// ADMIN -- LIST THIS COMPANY'S EMAIL DOMAINS
// ==========================================

const listDomains = async (req, res) => {
  try {
    const companyId = requireTenantCompany(req, res);
    if (!companyId) return;

    const domains = await emailDomainService.listDomainsForCompany(companyId);

    return res.status(200).json({
      success: true,
      domains,
    });
  } catch (error) {
    console.error("List Email Domains Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to list email domains",
    });
  }
};

// ==========================================
// ADMIN -- REGISTER A NEW EMAIL DOMAIN
// Starts unverified (verification_status='pending'); verifying
// ownership is a separate, out-of-band step -- see
// emailDomainService.js's header.
// ==========================================

const registerDomain = async (req, res) => {
  try {
    const companyId = requireTenantCompany(req, res);
    if (!companyId) return;

    const { domain } = req.body;

    if (!domain || typeof domain !== "string" || !domain.trim()) {
      return res.status(400).json({
        success: false,
        message: "A domain is required",
      });
    }

    const created = await emailDomainService.registerDomain(companyId, domain);

    return res.status(201).json({
      success: true,
      domain: created,
    });
  } catch (error) {
    if (error.code === "DOMAIN_ALREADY_REGISTERED") {
      return res.status(409).json({
        success: false,
        message: error.message,
      });
    }

    if (error.code === "INVALID_DOMAIN_INPUT") {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    console.error("Register Email Domain Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to register this email domain",
    });
  }
};

module.exports = {
  listDomains,
  registerDomain,
};
