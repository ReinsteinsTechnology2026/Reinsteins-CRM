const crypto = require("crypto");
const dns = require("dns").promises;

const platformPool = require("../config/platformDb");
const { getEmailLimitsForPlan } = require("./emailPlanLimitsService");

// ==========================================
// EMAIL DOMAIN SERVICE (Phase 16A)
//
// Pure DB + DNS logic for the business-email domain layer. Every
// read/write that touches a specific domain row takes companyId as a
// real WHERE-clause parameter, never as a post-fetch comparison --
// this is the actual cross-tenant isolation boundary (Phase 16A Step
// 12), not the controller layer above it and not the React UI.
//
// Domains live in the PLATFORM database (see the "PHASE 16A" banner
// in schemas/platformSchema.postgresql.sql for the full reasoning:
// domain names must be globally unique across every company, which a
// per-tenant-database table could not enforce on its own).
// ==========================================

const DOMAIN_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const VERIFICATION_RECORD_PREFIX = "_zioventure-verify";

function normalizeDomain(rawDomain) {
    return String(rawDomain || "").trim().toLowerCase();
}

function isValidDomainFormat(domain) {
    return DOMAIN_PATTERN.test(domain) && domain.length <= 255;
}

function generateVerificationToken() {
    // 32 random bytes -> 64 hex chars, matches verification_token's
    // column width. Long enough that guessing it is not a viable
    // attack -- domain ownership is only ever proven by controlling
    // the domain's own DNS, never by knowing this value alone.
    return crypto.randomBytes(32).toString("hex");
}

const DOMAIN_COLUMNS = `
    id, company_id, domain, verification_status, verification_method,
    verification_token, verified_at, status, created_at, updated_at
`;

// ------------------------------------------
// CREATE
// ------------------------------------------

const createDomain = async (companyId, rawDomain, planId) => {

    const domain = normalizeDomain(rawDomain);

    if (!isValidDomainFormat(domain)) {
        const error = new Error("Enter a valid domain name (e.g. example.com).");
        error.code = "DOMAIN_INVALID_FORMAT";
        throw error;
    }

    const { maxDomains } = await getEmailLimitsForPlan(planId);
    const [[{ existingCount }]] = await platformPool.query(
        `SELECT COUNT(*) AS "existingCount" FROM email_domains WHERE company_id = ?`,
        [companyId]
    );

    if (Number(existingCount) >= maxDomains) {
        const error = new Error(`This plan allows up to ${maxDomains} domain(s). Upgrade your plan to add more.`);
        error.code = "DOMAIN_LIMIT_REACHED";
        throw error;
    }

    const verificationToken = generateVerificationToken();

    try {

        const [result] = await platformPool.query(
            `INSERT INTO email_domains (company_id, domain, verification_status, verification_method, verification_token)
             VALUES (?, ?, 'pending', 'dns_txt', ?)
             RETURNING ${DOMAIN_COLUMNS}`,
            [companyId, domain, verificationToken]
        );

        return result[0];

    } catch (dbError) {
        // PostgreSQL 23505 = unique_violation -- the domain UNIQUE
        // constraint is what makes "a company must not be able to
        // claim another company's domain" (Step 8) an unbreakable
        // database-level guarantee, not just an application check
        // that a race condition could slip past.
        if (dbError.code === "23505") {
            const error = new Error("This domain is already registered on ZioVenture (by this company or another).");
            error.code = "DOMAIN_ALREADY_REGISTERED";
            throw error;
        }
        throw dbError;
    }

};

// ------------------------------------------
// READ -- every lookup is scoped to companyId in the query itself.
// ------------------------------------------

const listDomainsForCompany = async (companyId) => {
    const [rows] = await platformPool.query(
        `SELECT ${DOMAIN_COLUMNS} FROM email_domains WHERE company_id = ? ORDER BY created_at DESC`,
        [companyId]
    );
    return rows;
};

const getDomainForCompany = async (domainId, companyId) => {
    const [rows] = await platformPool.query(
        `SELECT ${DOMAIN_COLUMNS} FROM email_domains WHERE id = ? AND company_id = ? LIMIT 1`,
        [domainId, companyId]
    );
    return rows[0] || null;
};

// Internal only -- NOT company-scoped, used exclusively by
// mailboxService.js to confirm a domain_id supplied alongside a
// companyId-scoped request actually belongs to that same company
// (defense in depth: even if a caller obtained a domain id some other
// way, this is the second independent check before any mailbox is
// created against it).
const getDomainByIdUnscoped = async (domainId) => {
    const [rows] = await platformPool.query(
        `SELECT ${DOMAIN_COLUMNS} FROM email_domains WHERE id = ? LIMIT 1`,
        [domainId]
    );
    return rows[0] || null;
};

// The exact DNS records a company admin needs to add. Deliberately
// returns PLACEHOLDER structure only -- record TYPE and the HOST/NAME
// pattern are real and stable, but MX/DKIM VALUES depend on the real
// mail server once one is connected (Phase 16A Step 7: "Do NOT invent
// actual values"). mailServerConfigured lets the UI show an honest
// "pending infrastructure setup" state instead of a fake-looking value.
function buildDnsInstructions(domain) {

    const mailServerHost = process.env.MAIL_SERVER_HOSTNAME || null;

    return {
        domain: domain.domain,
        mailServerConfigured: Boolean(mailServerHost),
        records: [
            {
                purpose: "Domain ownership verification",
                type: "TXT",
                host: `${VERIFICATION_RECORD_PREFIX}.${domain.domain}`,
                value: domain.verification_token,
                required: true,
                note: "Add this record first -- required before any mailbox can be created on this domain.",
            },
            {
                purpose: "Mail routing (inbound email delivery)",
                type: "MX",
                host: "@",
                value: mailServerHost || "(mail server not yet configured -- see Phase 16A report)",
                required: true,
            },
            {
                purpose: "Sender authorization (outbound spoofing protection)",
                type: "TXT",
                host: "@",
                value: mailServerHost ? `v=spf1 mx ~all` : "(mail server not yet configured -- see Phase 16A report)",
                required: true,
            },
            {
                purpose: "Message signing (DKIM)",
                type: "TXT",
                host: mailServerHost ? "default._domainkey" : "(generated by mail server once configured)",
                value: mailServerHost ? "(generated per-domain by the mail server -- see Phase 16A report)" : "(mail server not yet configured -- see Phase 16A report)",
                required: true,
            },
            {
                purpose: "Delivery/authentication policy (DMARC)",
                type: "TXT",
                host: "_dmarc",
                value: `v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@${domain.domain}`,
                required: false,
            },
        ],
    };
}

// ------------------------------------------
// VERIFY -- a REAL DNS TXT lookup (Node's built-in dns.promises,
// no mocking) against the domain's public DNS. Never trusts a
// client-supplied "verified" flag; the only thing that flips
// verification_status to 'verified' is this function actually
// finding the exact token this service generated at creation time.
// ------------------------------------------

const verifyDomain = async (domainId, companyId) => {

    const domain = await getDomainForCompany(domainId, companyId);

    if (!domain) {
        const error = new Error("Domain not found.");
        error.code = "DOMAIN_NOT_FOUND";
        throw error;
    }

    if (domain.verification_status === "verified") {
        return domain;
    }

    const recordHost = `${VERIFICATION_RECORD_PREFIX}.${domain.domain}`;
    let found = false;
    let lookupError = null;

    try {
        const txtRecords = await dns.resolveTxt(recordHost);
        // resolveTxt returns string[][] -- each inner array is one
        // TXT record's chunks, concatenated back into one string.
        found = txtRecords.some((chunks) => chunks.join("").trim() === domain.verification_token);
    } catch (err) {
        // ENOTFOUND/ENODATA -- the record genuinely doesn't exist yet,
        // not a system error. Any other error is still treated as
        // "not verified yet" (fail closed) but recorded for the
        // caller to see why.
        lookupError = err.code || err.message;
    }

    const [rows] = await platformPool.query(
        `UPDATE email_domains
         SET verification_status = ?, verified_at = ?
         WHERE id = ? AND company_id = ?
         RETURNING ${DOMAIN_COLUMNS}`,
        [found ? "verified" : "failed", found ? new Date() : null, domainId, companyId]
    );

    return { ...rows[0], lookupError: found ? null : lookupError };

};

// ------------------------------------------
// DELETE -- blocked while any mailbox still references this domain
// (Step 10/18: never silently destroy email data as a side effect of
// an unrelated action). The DB-level ON DELETE CASCADE on
// mailboxes.domain_id exists as a structural safety net, not as the
// primary path -- this application-level check is what a real caller
// actually hits first, matching the established payments/plan
// RESTRICT-with-a-clear-message pattern elsewhere in this codebase.
// ------------------------------------------

const deleteDomain = async (domainId, companyId) => {

    const domain = await getDomainForCompany(domainId, companyId);
    if (!domain) return null;

    const [[{ mailboxCount }]] = await platformPool.query(
        `SELECT COUNT(*) AS "mailboxCount" FROM mailboxes WHERE domain_id = ?`,
        [domainId]
    );

    if (Number(mailboxCount) > 0) {
        const error = new Error("This domain still has mailboxes on it. Remove or reassign every mailbox before deleting the domain.");
        error.code = "DOMAIN_HAS_MAILBOXES";
        throw error;
    }

    await platformPool.query(
        `DELETE FROM email_domains WHERE id = ? AND company_id = ?`,
        [domainId, companyId]
    );

    return true;

};

// ------------------------------------------
// PLATFORM OWNER VISIBILITY (Phase 16A Step 14) -- COUNTS ONLY. No
// domain name, no mailbox address, no message content -- the
// deliberate line between "administration" (this) and "mail content
// access" (explicitly out of scope for this phase, and for the
// Platform Owner role generally).
// ------------------------------------------

const getEmailSummaryForCompany = async (companyId) => {
    const [[{ domainCount }]] = await platformPool.query(
        `SELECT COUNT(*) AS "domainCount" FROM email_domains WHERE company_id = ?`,
        [companyId]
    );
    const [[{ verifiedDomainCount }]] = await platformPool.query(
        `SELECT COUNT(*) AS "verifiedDomainCount" FROM email_domains WHERE company_id = ? AND verification_status = 'verified'`,
        [companyId]
    );
    const [[{ mailboxCount }]] = await platformPool.query(
        `SELECT COUNT(*) AS "mailboxCount" FROM mailboxes WHERE company_id = ?`,
        [companyId]
    );

    return {
        emailEnabled: Number(domainCount) > 0,
        domainCount: Number(domainCount),
        verifiedDomainCount: Number(verifiedDomainCount),
        mailboxCount: Number(mailboxCount),
    };
};

module.exports = {
    normalizeDomain,
    isValidDomainFormat,
    createDomain,
    listDomainsForCompany,
    getDomainForCompany,
    getDomainByIdUnscoped,
    buildDnsInstructions,
    verifyDomain,
    deleteDomain,
    getEmailSummaryForCompany,
};
