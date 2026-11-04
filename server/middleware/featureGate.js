const jwt = require("jsonwebtoken");

const platformCompanyService = require("../services/platformCompanyService");
const companyFeatureService = require("../services/companyFeatureService");
const { featuresForApiPath, FEATURE_BY_ID } = require("../config/tenantFeatures");

// ==========================================
// FEATURE GATE (one gate for every /api route)
//
// Mounted ONCE in app.js, before any route: app.use("/api", featureGate). The path -> feature table lives in
// config/tenantFeatures.js, so adding a route cannot "forget" the check (a test fails if a mounted /api prefix is neither
// gated nor declared core).
//
// Who is the caller? Only the SIGNED token says so -- never a header, query string or body field:
//   * a legacy Reinsteins token (JWT_SECRET)      -> the legacy database has every module; nothing to check.
//   * a tenant token (TENANT_JWT_SECRET)          -> companyId + companySlug from the token, re-resolved against the
//                                                    platform database (a token whose slug does not match its company is ignored).
//   * anything else (no token, bad token, an Owner token) -> passed through untouched: the route's own authentication
//                                                    answers 401. The gate never reveals which features exist to someone
//                                                    who is not signed in.
//
// A disabled feature answers 403 { code: "FEATURE_NOT_ENABLED" } and the request never reaches the route.
// ==========================================

const FEATURE_NOT_ENABLED = "FEATURE_NOT_ENABLED";
const DISABLED_MESSAGE = "This feature is not enabled for your organization.";

const disabledBody = (featureIds) => ({
    success: false,
    code: FEATURE_NOT_ENABLED,
    message: DISABLED_MESSAGE,
    features: featureIds,
});

// -> { kind: "legacy" } | { kind: "tenant", companyId } | { kind: "none" }
function identifyCaller(authorizationHeader) {
    if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) return { kind: "none" };
    const token = authorizationHeader.split(" ")[1];

    try {
        jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
        return { kind: "legacy" };
    } catch (_notLegacy) {
        // try the tenant secret
    }

    try {
        const { TENANT_JWT_ISSUER, TENANT_JWT_AUDIENCE } = require("../controllers/tenantAuthController");
        const decoded = jwt.verify(token, process.env.TENANT_JWT_SECRET, {
            issuer: TENANT_JWT_ISSUER,
            audience: TENANT_JWT_AUDIENCE,
            algorithms: ["HS256"],
        });
        if (decoded.type === "tenant_user" && decoded.companyId && decoded.companySlug) {
            return { kind: "tenant", companyId: decoded.companyId, companySlug: decoded.companySlug };
        }
    } catch (_notTenant) {
        // not a token we know
    }
    return { kind: "none" };
}

// `getCompanyById(id)` and `getEnabledFeatureIds(companyId)` are injectable so the gate can be tested against any store.
function createFeatureGate({ getCompanyById, getEnabledFeatureIds }) {
    // Which of `required` are NOT enabled for this company? ([] = allowed; null = the token does not match a company).
    async function disabledFeaturesFor(companyId, companySlug, required) {
        const company = await getCompanyById(companyId);
        if (!company || company.company_slug !== companySlug) return null; // forged / stale token: let authentication reject it
        const enabled = await getEnabledFeatureIds(company.id);
        return required.filter((id) => !enabled.includes(id));
    }

    return async function featureGate(req, res, next) {
        const rule = featuresForApiPath(`${req.baseUrl || ""}${req.path}`);
        if (!rule.gated || rule.features.length === 0) return next();

        const caller = identifyCaller(req.headers.authorization);
        if (caller.kind !== "tenant") return next();

        try {
            const disabled = await disabledFeaturesFor(caller.companyId, caller.companySlug, rule.features);
            if (disabled === null || disabled.length === 0) return next();
            return res.status(403).json(disabledBody(disabled.filter((id) => FEATURE_BY_ID[id])));
        } catch (error) {
            // Fail CLOSED: if the configuration cannot be read, a gated module is not served.
            console.error("[feature-gate] could not read company features:", error.message);
            return res.status(503).json({ success: false, message: "Unable to verify access to this feature. Please try again." });
        }
    };
}

// The application's gate, wired to the platform database.
const featureGate = createFeatureGate({
    getCompanyById: (id) => platformCompanyService.getCompanyById(id),
    getEnabledFeatureIds: (id) => companyFeatureService.getEnabledFeatureIds(id),
});

module.exports = { featureGate, createFeatureGate, identifyCaller, disabledBody, FEATURE_NOT_ENABLED, DISABLED_MESSAGE };
