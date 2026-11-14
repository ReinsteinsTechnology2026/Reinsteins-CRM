const crypto = require("crypto");
const { LOGIN_HOST, GUID_PATTERN } = require("../config/microsoftEmailConfig");

// ==========================================
// MICROSOFT OAUTH 2.0 (authorization code + PKCE) -- pure protocol helpers, no database.
//
// Tenant-specific by design: every authorize / token call goes to https://login.microsoftonline.com/{tenant-guid}/...
// where the tenant is the company's OWN Microsoft 365 organisation (found from its verified domain), never
// "common" or "organizations". After the code exchange the id_token claims are checked: the tenant (tid) must be the
// company's tenant, the audience must be our client id, the nonce must be the one we issued. A personal Microsoft
// account, or an account from any other organisation, therefore cannot be linked to this company.
//
// The id_token is received DIRECTLY from Microsoft's token endpoint over TLS, authenticated by our client secret and
// the PKCE verifier. OpenID Connect Core 3.1.3.7 allows the TLS server check in place of a signature check in that
// case, so the claims are validated here without verifying a signature.
//
// `fetchImpl` is injectable so tests never touch the network.
// ==========================================

class OAuthError extends Error {
    constructor(code, message, status) {
        super(message);
        this.name = "OAuthError";
        this.code = code;
        this.status = status;
    }
}

const REQUEST_TIMEOUT_MS = 15000;

const b64u = (buffer) => buffer.toString("base64url");

function randomToken(bytes = 32) {
    return b64u(crypto.randomBytes(bytes));
}

function generatePkce() {
    const verifier = randomToken(48); // 64 chars, within the 43-128 range of RFC 7636
    const challenge = b64u(crypto.createHash("sha256").update(verifier).digest());
    return { verifier, challenge };
}

function assertTenantId(tenantId) {
    if (typeof tenantId !== "string" || !GUID_PATTERN.test(tenantId)) {
        throw new OAuthError("TENANT_INVALID", "The Microsoft 365 tenant id is not valid.", 400);
    }
    return tenantId.toLowerCase();
}

function buildAuthorizeUrl({ config, msTenantId, state, nonce, challenge, loginHint }) {
    const tenant = assertTenantId(msTenantId);
    const url = new URL(`${LOGIN_HOST}/${tenant}/oauth2/v2.0/authorize`);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", config.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (loginHint) url.searchParams.set("login_hint", loginHint);
    return url.toString();
}

// Tenant-wide consent link for a customer's Microsoft 365 administrator. Opening it grants nothing by itself: the
// customer's admin must sign in and accept. Only needed when that organisation blocks user consent.
function buildAdminConsentUrl({ config, msTenantId }) {
    const tenant = assertTenantId(msTenantId);
    const url = new URL(`${LOGIN_HOST}/${tenant}/v2.0/adminconsent`);
    url.searchParams.set("client_id", config.clientId);
    // ".default" = the delegated permissions configured on the app registration (exactly the scopes in MS_SCOPES).
    url.searchParams.set("scope", "https://graph.microsoft.com/.default");
    url.searchParams.set("redirect_uri", config.redirectUri);
    return url.toString();
}

async function postForm(url, params, fetchImpl) {
    let response;
    try {
        response = await fetchImpl(url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
            body: new URLSearchParams(params).toString(),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (_error) {
        throw new OAuthError("MICROSOFT_UNREACHABLE", "Could not reach Microsoft sign-in. Try again shortly.", 502);
    }
    let body = null;
    try {
        body = await response.json();
    } catch (_error) {
        body = null;
    }
    return { ok: response.ok, status: response.status, body };
}

function mapTokenError(result) {
    const error = result.body && result.body.error;
    // invalid_grant = the refresh token or code is expired, revoked, or the password/consent changed: sign in again.
    if (error === "invalid_grant" || error === "interaction_required" || error === "consent_required") {
        return new OAuthError("REAUTH_REQUIRED", "Microsoft needs you to sign in again.", 401);
    }
    if (error === "invalid_client" || error === "unauthorized_client") {
        return new OAuthError("APP_MISCONFIGURED", "The ZioVenture Microsoft app registration was rejected. Contact your platform administrator.", 502);
    }
    return new OAuthError("TOKEN_REQUEST_FAILED", "Microsoft sign-in failed.", 502);
}

function normalizeTokens(body) {
    if (!body || typeof body.access_token !== "string") {
        throw new OAuthError("TOKEN_REQUEST_FAILED", "Microsoft sign-in returned no access token.", 502);
    }
    return {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
        expiresIn: Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600,
        scope: typeof body.scope === "string" ? body.scope : "",
        idToken: typeof body.id_token === "string" ? body.id_token : null,
    };
}

async function exchangeCode({ config, msTenantId, code, verifier, fetchImpl = fetch }) {
    const tenant = assertTenantId(msTenantId);
    const result = await postForm(
        `${LOGIN_HOST}/${tenant}/oauth2/v2.0/token`,
        {
            client_id: config.clientId,
            client_secret: config.clientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: config.redirectUri,
            code_verifier: verifier,
            scope: config.scopes.join(" "),
        },
        fetchImpl
    );
    if (!result.ok) throw mapTokenError(result);
    return normalizeTokens(result.body);
}

async function refreshTokens({ config, msTenantId, refreshToken, fetchImpl = fetch }) {
    const tenant = assertTenantId(msTenantId);
    const result = await postForm(
        `${LOGIN_HOST}/${tenant}/oauth2/v2.0/token`,
        {
            client_id: config.clientId,
            client_secret: config.clientSecret,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            scope: config.scopes.join(" "),
        },
        fetchImpl
    );
    if (!result.ok) throw mapTokenError(result);
    return normalizeTokens(result.body);
}

function decodeJwtPayload(jwt) {
    const parts = String(jwt || "").split(".");
    if (parts.length !== 3) throw new OAuthError("ID_TOKEN_INVALID", "The Microsoft identity token is malformed.", 400);
    try {
        return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch (_error) {
        throw new OAuthError("ID_TOKEN_INVALID", "The Microsoft identity token is malformed.", 400);
    }
}

// Throws unless the token proves: our app, the expected organisation, the nonce we issued, still valid.
function validateIdTokenClaims(claims, { config, expectedTenantId, expectedNonceHash, now = Date.now(), sha256Hex }) {
    const tenant = assertTenantId(expectedTenantId);
    if (claims.aud !== config.clientId) throw new OAuthError("ID_TOKEN_AUDIENCE", "The sign-in was issued for a different application.", 400);
    if (String(claims.tid || "").toLowerCase() !== tenant) {
        throw new OAuthError("TENANT_MISMATCH", "This Microsoft account belongs to a different organisation than your company's Microsoft 365.", 403);
    }
    if (claims.iss !== `${LOGIN_HOST}/${tenant}/v2.0`) throw new OAuthError("ID_TOKEN_ISSUER", "The sign-in came from an unexpected issuer.", 400);
    if (typeof claims.exp !== "number" || claims.exp * 1000 < now - 60_000) throw new OAuthError("ID_TOKEN_EXPIRED", "The sign-in has expired. Try again.", 400);
    if (typeof claims.nbf === "number" && claims.nbf * 1000 > now + 5 * 60_000) throw new OAuthError("ID_TOKEN_INVALID", "The sign-in is not valid yet.", 400);
    if (!claims.nonce || sha256Hex(claims.nonce) !== expectedNonceHash) throw new OAuthError("NONCE_MISMATCH", "The sign-in could not be verified. Try again.", 400);
    if (typeof claims.oid !== "string" || claims.oid === "") throw new OAuthError("ID_TOKEN_INVALID", "The sign-in did not identify an account.", 400);
    return {
        oid: claims.oid,
        tid: tenant,
        // Accounts are matched on the sign-in name / email as an address, case-insensitively.
        accounts: [claims.preferred_username, claims.email, claims.upn]
            .filter((value) => typeof value === "string" && value.includes("@"))
            .map((value) => value.trim().toLowerCase()),
    };
}

// The organisation that owns a domain is public information: Microsoft publishes it in the domain's OpenID
// configuration. No credential is involved. Returns the tenant GUID, or throws DOMAIN_NOT_IN_MICROSOFT.
async function discoverTenantId(domain, fetchImpl = fetch) {
    if (!/^[a-z0-9.-]{3,253}$/i.test(String(domain || ""))) {
        throw new OAuthError("DOMAIN_INVALID", "The domain is not valid.", 400);
    }
    let response;
    try {
        response = await fetchImpl(`${LOGIN_HOST}/${encodeURIComponent(domain.toLowerCase())}/v2.0/.well-known/openid-configuration`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (_error) {
        throw new OAuthError("MICROSOFT_UNREACHABLE", "Could not reach Microsoft to look up this domain. Try again shortly.", 502);
    }
    if (!response.ok) {
        throw new OAuthError("DOMAIN_NOT_IN_MICROSOFT", "Microsoft has no Microsoft 365 organisation for this domain. Add and verify the domain in your Microsoft 365 admin center first.", 404);
    }
    let issuer = "";
    try {
        issuer = (await response.json()).issuer || "";
    } catch (_error) {
        issuer = "";
    }
    const match = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0\/?$/i.exec(issuer);
    if (!match || !GUID_PATTERN.test(match[1])) {
        throw new OAuthError("DOMAIN_NOT_IN_MICROSOFT", "Microsoft returned no organisation for this domain.", 404);
    }
    return match[1].toLowerCase();
}

// ---------------------------------------------------------------- personal + work accounts (the "common" authority)
// The unified client lets an employee connect ANY Microsoft account: Outlook.com / Hotmail (personal) or Microsoft 365 (work or
// school). The sign-in goes to the "common" authority, so no company-managed tenant is needed beforehand. What the id_token then
// proves is the account's own identity (tenant id, object id, address); the tenant is recorded, never assumed.
const CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

function buildAccountAuthorizeUrl({ config, state, nonce, challenge, loginHint }) {
    const url = new URL(`${LOGIN_HOST}/common/oauth2/v2.0/authorize`);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", config.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("prompt", "select_account");
    if (loginHint) url.searchParams.set("login_hint", loginHint);
    return url.toString();
}

async function exchangeAccountCode({ config, code, verifier, fetchImpl = fetch }) {
    const result = await postForm(
        `${LOGIN_HOST}/common/oauth2/v2.0/token`,
        {
            client_id: config.clientId,
            client_secret: config.clientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: config.redirectUri,
            code_verifier: verifier,
            scope: config.scopes.join(" "),
        },
        fetchImpl
    );
    if (!result.ok) throw mapTokenError(result);
    return normalizeTokens(result.body);
}

// A refresh token belongs to the account's own tenant (for a personal account, the consumers tenant), which was recorded at connect.
async function refreshAccountTokens({ config, tenantId, refreshToken, fetchImpl = fetch }) {
    const tenant = assertTenantId(tenantId);
    const result = await postForm(
        `${LOGIN_HOST}/${tenant}/oauth2/v2.0/token`,
        { client_id: config.clientId, client_secret: config.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken, scope: config.scopes.join(" ") },
        fetchImpl
    );
    if (!result.ok) throw mapTokenError(result);
    return normalizeTokens(result.body);
}

function validateAccountIdToken(claims, { config, expectedNonceHash, now = Date.now(), sha256Hex }) {
    if (claims.aud !== config.clientId) throw new OAuthError("ID_TOKEN_AUDIENCE", "The sign-in was issued for a different application.", 400);
    const tid = String(claims.tid || "").toLowerCase();
    if (!GUID_PATTERN.test(tid)) throw new OAuthError("ID_TOKEN_INVALID", "The sign-in did not identify an organisation.", 400);
    if (claims.iss !== `${LOGIN_HOST}/${tid}/v2.0`) throw new OAuthError("ID_TOKEN_ISSUER", "The sign-in came from an unexpected issuer.", 400);
    if (typeof claims.exp !== "number" || claims.exp * 1000 < now - 60000) throw new OAuthError("ID_TOKEN_EXPIRED", "The sign-in has expired. Try again.", 400);
    if (!claims.nonce || sha256Hex(claims.nonce) !== expectedNonceHash) throw new OAuthError("NONCE_MISMATCH", "The sign-in could not be verified. Try again.", 400);
    const subject = typeof claims.oid === "string" && claims.oid ? claims.oid : typeof claims.sub === "string" ? claims.sub : "";
    if (!subject) throw new OAuthError("ID_TOKEN_INVALID", "The sign-in did not identify an account.", 400);
    const address = [claims.email, claims.preferred_username, claims.upn].find((value) => typeof value === "string" && value.includes("@"));
    if (!address) throw new OAuthError("EMAIL_NOT_AVAILABLE", "Microsoft did not return an email address for this account.", 400);
    return {
        subject,
        tid,
        email: address.trim().toLowerCase(),
        name: typeof claims.name === "string" ? claims.name.slice(0, 255) : null,
        kind: tid === CONSUMER_TENANT ? "outlook_personal" : "microsoft_365",
    };
}

module.exports = {
    OAuthError,
    randomToken,
    generatePkce,
    assertTenantId,
    buildAuthorizeUrl,
    buildAdminConsentUrl,
    exchangeCode,
    refreshTokens,
    decodeJwtPayload,
    validateIdTokenClaims,
    discoverTenantId,
    buildAccountAuthorizeUrl,
    exchangeAccountCode,
    refreshAccountTokens,
    validateAccountIdToken,
    CONSUMER_TENANT,
};
