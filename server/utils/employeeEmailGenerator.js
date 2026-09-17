const emailDomainService = require("../services/emailDomainService");

// ==========================================
// EMPLOYEE COMPANY EMAIL GENERATION (Phase 17c)
//
// Reuses the existing Phase 16A email_domains architecture
// (server/services/emailDomainService.js) as the ONLY source of truth
// for which domain an employee's auto-generated email uses -- never a
// hardcoded domain, never the company's display name. This module
// adds no new tables and talks to no mail server; it only computes a
// local-part + picks a domain, then the caller (employeeController.js)
// writes the result to the tenant users.email column exactly like any
// other field.
//
// DOMAIN SELECTION RULE (documented here because none exists in the
// schema/service layer -- see getVerifiedCompanyDomain below): the
// email_domains table has no is_default/is_primary column at all
// (confirmed by reading schemas/platformSchema.postgresql.sql and
// emailDomainService.js directly). Since a company can register
// multiple domains but nothing marks one as "the" default, this picks
// the most-recently-added VERIFIED + ACTIVE domain
// (listDomainsForCompany already orders by created_at DESC, so the
// first match after filtering is the most recent). If the project
// later adds a real default-domain concept, only this one function
// needs to change.
// ==========================================

// getVerifiedCompanyDomain: returns the domain string (e.g.
// "reinsteins.com") to use for this company's auto-generated employee
// emails, or null if the company has no verified, active domain yet.
// Never throws for "no domain" -- that is an expected, normal state
// the caller must handle explicitly (per the explicit requirement:
// "do not generate a fake domain").
async function getVerifiedCompanyDomain(companyId) {
    if (!companyId) {
        return null;
    }

    const domains = await emailDomainService.listDomainsForCompany(companyId);

    const usable = domains.find(
        (d) => d.verification_status === "verified" && d.status === "active"
    );

    return usable ? usable.domain : null;
}

// slugifyNameForEmail: "Shafiq Mohammed" -> "shafiqmohammed",
// "O'Brien-Smith" -> "obriensmith". Strips accents first (so
// "José" -> "jose", not dropped entirely), then keeps only a-z0-9 --
// this deliberately drops spaces, punctuation, and anything non-ASCII
// rather than substituting a separator, matching the exact examples
// given ("Shafiq Mohammed" -> "shafiqmohammed", no dot/underscore).
function slugifyNameForEmail(fullName) {
    return String(fullName || "")
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
}

// generateUniqueCompanyEmail: builds "<slug>@<domain>", and if that
// address is already taken (checked against the CALLER-PROVIDED
// tenant pool, i.e. this tenant's own users table), deterministically
// appends 2, 3, 4, ... until an unused address is found -- matching
// the collision example in the spec exactly
// (johnsmith@ -> johnsmith2@ -> johnsmith3@). Bounded at 1000
// attempts as a sanity ceiling (never expected to be reached in
// practice); returns null (not an error) if the base slug itself is
// empty (e.g. a name with no a-z0-9 characters at all), same
// "explicit no-email state" convention as no-verified-domain.
async function generateUniqueCompanyEmail(tenantPool, fullName, domain) {
    const base = slugifyNameForEmail(fullName);

    if (!base || !domain) {
        return null;
    }

    for (let suffix = 0; suffix < 1000; suffix += 1) {
        const candidateLocalPart = suffix === 0 ? base : `${base}${suffix + 1}`;
        const candidate = `${candidateLocalPart}@${domain}`;

        const [existing] = await tenantPool.query(
            `SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1`,
            [candidate]
        );

        if (existing.length === 0) {
            return candidate;
        }
    }

    return null;
}

module.exports = {
    getVerifiedCompanyDomain,
    slugifyNameForEmail,
    generateUniqueCompanyEmail,
};
