const platformPool = require("../config/platformDb");

// ==========================================
// EMAIL DOMAIN SERVICE (Phase 16A)
//
// Pure DB logic against groworgs_platform_db.email_domains /
// .mailboxes ONLY -- these are platform-level tables (a domain is
// owned by exactly one company and reused by every tenant-side
// feature that needs it, e.g. utils/employeeEmailGenerator.js), not
// per-tenant data. See schemas/platformSchema.postgresql.sql's
// "Phase 16A" section for the table definitions this service
// depends on.
//
// Verifying a domain (proving DNS/MX ownership) is an out-of-band,
// platform-admin-side operation with no automated implementation
// anywhere in this codebase (no Stalwart/DNS integration exists
// here yet) -- this service only records and reads the
// verification_status a human/future process sets; it never flips
// a domain to 'verified' itself.
// ==========================================

const DOMAIN_COLUMNS = `
    id, company_id, domain, verification_status, status, verified_at,
    created_at, updated_at
`;

// listDomainsForCompany: every domain row registered by this
// company, most-recently-added first. Callers that need "the"
// domain (e.g. employeeEmailGenerator.js's getVerifiedCompanyDomain)
// take the first VERIFIED + ACTIVE match from this list, since there
// is no is_default/is_primary column -- see that file's own header
// for why.
const listDomainsForCompany = async (companyId) => {
  if (!companyId) {
    return [];
  }

  const [rows] = await platformPool.query(
    `SELECT ${DOMAIN_COLUMNS} FROM email_domains WHERE company_id = ? ORDER BY created_at DESC`,
    [companyId]
  );

  return rows;
};

// registerDomain: records a new domain for this company, always
// starting at verification_status='pending' -- a caller can never
// create an already-verified domain through this API. Domain
// ownership is global (one real DNS domain can only ever belong to
// one company), enforced by the UNIQUE constraint on
// email_domains.domain; a duplicate registration -- by this company
// or any other -- is rejected rather than silently reassigning
// ownership. Mirrors platformCompanyService.js's
// createPendingCompany() pre-check + UNIQUE-constraint-as-real-guard
// pattern.
const registerDomain = async (companyId, domain) => {
  const normalizedDomain = String(domain || "").trim().toLowerCase();

  if (!companyId || !normalizedDomain) {
    const error = new Error("A company and domain are required.");
    error.code = "INVALID_DOMAIN_INPUT";
    throw error;
  }

  const [existing] = await platformPool.query(
    `SELECT id FROM email_domains WHERE domain = ? LIMIT 1`,
    [normalizedDomain]
  );

  if (existing.length > 0) {
    const error = new Error("This domain is already registered.");
    error.code = "DOMAIN_ALREADY_REGISTERED";
    throw error;
  }

  try {
    const [result] = await platformPool.query(
      `INSERT INTO email_domains (company_id, domain, verification_status, status)
       VALUES (?, ?, 'pending', 'active')
       RETURNING id`,
      [companyId, normalizedDomain]
    );

    const [rows] = await platformPool.query(
      `SELECT ${DOMAIN_COLUMNS} FROM email_domains WHERE id = ? LIMIT 1`,
      [result[0].id]
    );

    return rows[0];
  } catch (dbError) {
    if (dbError.code === "23505") {
      const error = new Error("This domain is already registered.");
      error.code = "DOMAIN_ALREADY_REGISTERED";
      throw error;
    }

    throw dbError;
  }
};

module.exports = {
  listDomainsForCompany,
  registerDomain,
};
