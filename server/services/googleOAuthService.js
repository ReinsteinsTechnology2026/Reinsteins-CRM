const crypto = require("crypto");
const { OAuthError } = require("./microsoftOAuthService");

// ==========================================
// GOOGLE OAUTH 2.0 (authorization code + PKCE) -- pure protocol helpers, no database. `fetchImpl` is injectable.
//
// Offline access (a refresh token) is requested with prompt=consent so Google always returns one. After the code exchange the
// id_token claims are checked: issuer (Google), audience (our client id), nonce (ours), expiry, a stable subject, and a VERIFIED
// email address. The id_token is received directly from Google's token endpoint over TLS together with our client secret and PKCE
// verifier, which OpenID Connect Core 3.1.3.7 accepts in place of a signature check. The scopes Google reports as granted are
// checked too: Google lets a user untick scopes on its consent screen.
// ==========================================

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const REQUEST_TIMEOUT_MS = 15000;

const b64u = (buffer) => buffer.toString("base64url");

function buildAuthorizeUrl({ config, state, nonce, challenge, loginHint }) {
    const url = new URL(AUTH_URL);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", config.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent select_account");
    url.searchParams.set("include_granted_scopes", "false");
    if (loginHint) url.searchParams.set("login_hint", loginHint);
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
        throw new OAuthError("GOOGLE_UNREACHABLE", "Could not reach Google sign-in. Try again shortly.", 502);
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
    // invalid_grant = refresh token expired / revoked / the user removed access, or a code that was already used.
    if (error === "invalid_grant") return new OAuthError("REAUTH_REQUIRED", "Google needs you to sign in again.", 401);
    if (error === "invalid_client" || error === "unauthorized_client") {
        return new OAuthError("APP_MISCONFIGURED", "The ZioVenture Google app registration was rejected. Contact your platform administrator.", 502);
    }
    return new OAuthError("TOKEN_REQUEST_FAILED", "Google sign-in failed.", 502);
}

function normalizeTokens(body) {
    if (!body || typeof body.access_token !== "string") {
        throw new OAuthError("TOKEN_REQUEST_FAILED", "Google sign-in returned no access token.", 502);
    }
    return {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
        expiresIn: Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600,
        scope: typeof body.scope === "string" ? body.scope : "",
        idToken: typeof body.id_token === "string" ? body.id_token : null,
    };
}

async function exchangeCode({ config, code, verifier, fetchImpl = fetch }) {
    const result = await postForm(TOKEN_URL, {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        code_verifier: verifier,
    }, fetchImpl);
    if (!result.ok) throw mapTokenError(result);
    return normalizeTokens(result.body);
}

async function refreshTokens({ config, refreshToken, fetchImpl = fetch }) {
    const result = await postForm(TOKEN_URL, {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
    }, fetchImpl);
    if (!result.ok) throw mapTokenError(result);
    return normalizeTokens(result.body);
}

// Best effort: tells Google to void the token (and the grant it belongs to). A failure never blocks a local disconnect.
async function revokeToken({ token, fetchImpl = fetch }) {
    try {
        const result = await postForm(REVOKE_URL, { token }, fetchImpl);
        return { revoked: result.ok };
    } catch (_error) {
        return { revoked: false };
    }
}

function decodeJwtPayload(jwt) {
    const parts = String(jwt || "").split(".");
    if (parts.length !== 3) throw new OAuthError("ID_TOKEN_INVALID", "The Google identity token is malformed.", 400);
    try {
        return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch (_error) {
        throw new OAuthError("ID_TOKEN_INVALID", "The Google identity token is malformed.", 400);
    }
}

function validateIdTokenClaims(claims, { config, expectedNonceHash, now = Date.now(), sha256Hex }) {
    if (claims.aud !== config.clientId) throw new OAuthError("ID_TOKEN_AUDIENCE", "The sign-in was issued for a different application.", 400);
    if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new OAuthError("ID_TOKEN_ISSUER", "The sign-in came from an unexpected issuer.", 400);
    if (typeof claims.exp !== "number" || claims.exp * 1000 < now - 60000) throw new OAuthError("ID_TOKEN_EXPIRED", "The sign-in has expired. Try again.", 400);
    if (!claims.nonce || sha256Hex(claims.nonce) !== expectedNonceHash) throw new OAuthError("NONCE_MISMATCH", "The sign-in could not be verified. Try again.", 400);
    if (typeof claims.sub !== "string" || claims.sub === "") throw new OAuthError("ID_TOKEN_INVALID", "The sign-in did not identify an account.", 400);
    if (typeof claims.email !== "string" || !claims.email.includes("@") || claims.email_verified !== true) {
        throw new OAuthError("EMAIL_NOT_VERIFIED", "Google did not return a verified email address.", 400);
    }
    const email = claims.email.trim().toLowerCase();
    // "hd" (hosted domain) is present for Google Workspace accounts and absent for consumer Gmail accounts.
    const kind = claims.hd ? "google_workspace" : "gmail";
    return { subject: claims.sub, email, name: typeof claims.name === "string" ? claims.name.slice(0, 255) : null, hostedDomain: claims.hd || null, kind };
}

// The scopes Google says were granted must include the ones the client cannot work without.
function grantedScopesOk(granted, required) {
    const have = new Set(String(granted || "").split(/\s+/).filter(Boolean));
    return required.every((scope) => have.has(scope));
}

// ---------------------------------------------------------------- Pub/Sub push authentication
// Google's Pub/Sub push sends "Authorization: Bearer <OIDC JWT>" signed by Google. The signature is verified against Google's
// published keys (JWKS), the audience must be OUR push endpoint and the identity must be the configured push service account.
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
let jwksCache = { at: 0, keys: [] };

async function getGoogleKeys(fetchImpl = fetch, now = Date.now()) {
    if (jwksCache.keys.length && now - jwksCache.at < 3600000) return jwksCache.keys;
    const response = await fetchImpl(JWKS_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new OAuthError("JWKS_UNAVAILABLE", "Could not load Google's signing keys.", 502);
    jwksCache = { at: now, keys: (await response.json()).keys || [] };
    return jwksCache.keys;
}

function resetKeyCache() {
    jwksCache = { at: 0, keys: [] };
}

async function verifyPushJwt(authorizationHeader, { audience, serviceAccount, fetchImpl = fetch, now = Date.now(), keys = null }) {
    const bad = (why) => new OAuthError("PUSH_AUTH_FAILED", `Push notification rejected (${why}).`, 401);
    if (!audience || !serviceAccount) throw bad("not configured");
    const match = /^Bearer\s+(\S+)$/.exec(String(authorizationHeader || ""));
    if (!match) throw bad("no bearer token");
    const parts = match[1].split(".");
    if (parts.length !== 3) throw bad("malformed");
    let header;
    let claims;
    try {
        header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
        claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch (_error) {
        throw bad("malformed");
    }
    if (header.alg !== "RS256") throw bad("algorithm");
    const available = keys || (await getGoogleKeys(fetchImpl, now));
    const jwk = available.find((key) => key.kid === header.kid);
    if (!jwk) throw bad("unknown key");
    const ok = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"));
    if (!ok) throw bad("signature");
    if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw bad("issuer");
    if (claims.aud !== audience) throw bad("audience");
    if (typeof claims.exp !== "number" || claims.exp * 1000 < now - 60000) throw bad("expired");
    if (String(claims.email || "").toLowerCase() !== serviceAccount.toLowerCase() || claims.email_verified !== true) throw bad("identity");
    return claims;
}

module.exports = {
    buildAuthorizeUrl,
    exchangeCode,
    refreshTokens,
    revokeToken,
    decodeJwtPayload,
    validateIdTokenClaims,
    grantedScopesOk,
    verifyPushJwt,
    resetKeyCache,
    b64u,
};
