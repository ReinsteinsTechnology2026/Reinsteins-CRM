const jwt = require("jsonwebtoken");

// ==========================================
// FILE ACCESS TOKEN (Multi-Tenant File Storage Phase)
//
// Every /uploads URL the backend ever returns to a client is signed
// with a short-lived, tenant-scoped token appended as a `fat` query
// parameter -- this is what makes "a file URL alone" NOT sufficient
// authorization (Part 4's requirement) while still working with a
// plain <img src="..."> (Part 5's constraint -- the frontend was
// confirmed, across 4 independent components, to always build file
// URLs as BACKEND_URL + <raw path from an API response>, never via
// fetch()+Authorization header).
//
// The token is the credential itself (like a presigned URL) -- it is
// NOT a substitute for authentication. It can only ever be minted by
// signFileUrlsMiddleware.js / the two explicit socket-emit call
// sites, all of which run only for an already-authenticated request
// (via protect/tenantProtect) and embed that request's OWN verified
// tenant -- never a client-supplied company slug.
// ==========================================

const FILE_ACCESS_TOKEN_EXPIRES_IN = "2h";

// path: the exact pathname (e.g. "/uploads/tenant_reinsteins/profiles/x.jpg"),
// never including a query string -- verifyFileAccessToken requires an
// exact match against the requested pathname, so a token minted for
// one file can never be replayed against a different one.
function signFileUrl(rawPath, companySlug) {
    const token = jwt.sign(
        { path: rawPath, companySlug },
        process.env.FILE_ACCESS_SECRET,
        { expiresIn: FILE_ACCESS_TOKEN_EXPIRES_IN }
    );
    const separator = rawPath.includes("?") ? "&" : "?";
    return `${rawPath}${separator}fat=${token}`;
}

function verifyFileAccessToken(token) {
    const decoded = jwt.verify(token, process.env.FILE_ACCESS_SECRET);
    if (typeof decoded.path !== "string" || typeof decoded.companySlug !== "string") {
        throw new Error("Malformed file access token");
    }
    return decoded;
}

module.exports = {
    signFileUrl,
    verifyFileAccessToken,
};
