// Provider sign-in for the unified email client: Google OAuth, Microsoft personal + work accounts (the "common" authority), provider
// configuration, and the authentication of Google Pub/Sub push. No network, no database.
// Run: node --test _test_email_providers_oauth.js

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const google = require("./services/googleOAuthService");
const ms = require("./services/microsoftOAuthService");
const secretBox = require("./utils/secretBox");
const cfg = require("./config/emailProvidersConfig");

const KEY = crypto.randomBytes(32).toString("base64");
const GOOGLE = { clientId: "g-client.apps.googleusercontent.com", clientSecret: "g-secret", redirectUri: "https://crm.example.com/api/email/accounts/callback/google", scopes: cfg.GOOGLE_SCOPES };
const MSCFG = { clientId: "ms-client-id", clientSecret: "ms-secret", redirectUri: "https://crm.example.com/api/email/accounts/callback/microsoft", scopes: cfg.MICROSOFT_ACCOUNT_SCOPES };
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body });

// ---------------------------------------------------------------- configuration
test("config: a provider is 'configured' only when every setting is present; names (never values) are reported", () => {
    const none = cfg.getGoogleConfig({});
    assert.equal(none.configured, false);
    assert.deepEqual(none.missing.sort(), ["EMAIL_FRONTEND_ORIGIN", "EMAIL_TOKEN_KEY", "GOOGLE_EMAIL_CLIENT_ID", "GOOGLE_EMAIL_CLIENT_SECRET", "GOOGLE_EMAIL_REDIRECT_URI"]);
    const env = { GOOGLE_EMAIL_CLIENT_ID: "id", GOOGLE_EMAIL_CLIENT_SECRET: "topsecret", GOOGLE_EMAIL_REDIRECT_URI: "https://x/cb", EMAIL_TOKEN_KEY: KEY, EMAIL_FRONTEND_ORIGIN: "https://x/" };
    const full = cfg.getGoogleConfig(env);
    assert.equal(full.configured, true);
    assert.equal(full.frontendOrigin, "https://x");
    assert.equal(full.pushConfigured, false, "push is optional: without it the sync polls");
    const shown = JSON.stringify(cfg.publicProviderStatus(env));
    assert.ok(!shown.includes("topsecret") && !shown.includes(KEY));
    // the original Microsoft settings names keep working as fallbacks for the shared ones
    const msEnv = cfg.getMicrosoftConfig({ MS_EMAIL_CLIENT_ID: "a", MS_EMAIL_CLIENT_SECRET: "b", MS_EMAIL_ACCOUNT_REDIRECT_URI: "https://x/cb", MS_EMAIL_TOKEN_KEY: KEY, MS_EMAIL_FRONTEND_ORIGIN: "https://x" });
    assert.equal(msEnv.configured, true);
    assert.equal(cfg.getMicrosoftConfig({ ...{ MS_EMAIL_CLIENT_ID: "a", MS_EMAIL_CLIENT_SECRET: "b", MS_EMAIL_ACCOUNT_REDIRECT_URI: "https://x/cb", EMAIL_TOKEN_KEY: KEY, EMAIL_FRONTEND_ORIGIN: "https://x" }, MS_EMAIL_NOTIFICATION_URL: "https://x/api/email/push/microsoft" }).pushConfigured, true);
    assert.equal(cfg.getMicrosoftConfig({ MS_EMAIL_NOTIFICATION_URL: "http://insecure/x" }).pushConfigured, false, "change notifications need https");
});

test("scopes: the minimum for a mail client, no contacts, calendar, drive, directory or tenant-wide permission", () => {
    for (const scope of cfg.GOOGLE_SCOPES) assert.ok(!/contacts|calendar|drive|admin\.|^https:\/\/mail\.google\.com\/$/.test(scope), `${scope} is broader than needed`);
    assert.ok(cfg.GOOGLE_SCOPES.includes("https://www.googleapis.com/auth/gmail.modify"));
    assert.ok(!cfg.GOOGLE_SCOPES.includes("https://mail.google.com/"), "the full-access scope (which also allows permanent deletion) is not requested");
    for (const scope of cfg.MICROSOFT_ACCOUNT_SCOPES) assert.ok(!/\.All$|Directory|full_access_as_app|Shared/i.test(scope), `${scope} is too broad`);
    assert.deepEqual(cfg.GOOGLE_REQUIRED_SCOPES, ["https://www.googleapis.com/auth/gmail.modify"]);
});

// ---------------------------------------------------------------- Google OAuth
test("google: the authorize URL asks for offline access with PKCE, state, nonce and the exact redirect, and never carries the secret", () => {
    const url = new URL(google.buildAuthorizeUrl({ config: GOOGLE, state: "st", nonce: "no", challenge: "ch", loginHint: "jane@gmail.com" }));
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    assert.equal(p.get("access_type"), "offline");
    assert.match(p.get("prompt"), /consent/);
    assert.equal(p.get("code_challenge_method"), "S256");
    assert.equal(p.get("redirect_uri"), GOOGLE.redirectUri);
    assert.equal(p.get("login_hint"), "jane@gmail.com");
    assert.equal(p.get("include_granted_scopes"), "false");
    assert.ok(p.get("scope").includes("gmail.modify"));
    assert.ok(!url.toString().includes("g-secret"));
});

test("google: code exchange and refresh send the right grant; invalid_grant means 'reconnect', a bad client is a configuration problem", async () => {
    let seen;
    const ok = async (url, init) => { seen = { url, body: new URLSearchParams(init.body) }; return response(200, { access_token: "AT", refresh_token: "RT", expires_in: 3599, scope: cfg.GOOGLE_SCOPES.join(" "), id_token: "a.b.c" }); };
    const tokens = await google.exchangeCode({ config: GOOGLE, code: "CODE", verifier: "VER", fetchImpl: ok });
    assert.equal(seen.url, "https://oauth2.googleapis.com/token");
    assert.deepEqual([seen.body.get("grant_type"), seen.body.get("code_verifier"), seen.body.get("redirect_uri")], ["authorization_code", "VER", GOOGLE.redirectUri]);
    assert.equal(tokens.refreshToken, "RT");
    await google.refreshTokens({ config: GOOGLE, refreshToken: "RT", fetchImpl: ok });
    assert.equal(seen.body.get("grant_type"), "refresh_token");
    const reject = (error) => async () => response(400, { error, error_description: "SECRET detail" });
    await assert.rejects(google.refreshTokens({ config: GOOGLE, refreshToken: "r", fetchImpl: reject("invalid_grant") }), { code: "REAUTH_REQUIRED" });
    await assert.rejects(google.refreshTokens({ config: GOOGLE, refreshToken: "r", fetchImpl: reject("invalid_client") }), (e) => e.code === "APP_MISCONFIGURED" && !/SECRET/.test(e.message));
    await assert.rejects(google.refreshTokens({ config: GOOGLE, refreshToken: "r", fetchImpl: async () => { throw new Error("ECONNRESET"); } }), { code: "GOOGLE_UNREACHABLE" });
    await assert.rejects(google.exchangeCode({ config: GOOGLE, code: "c", verifier: "v", fetchImpl: async () => response(200, {}) }), { code: "TOKEN_REQUEST_FAILED" });
});

test("google: revoking a token is best effort and never throws", async () => {
    let body;
    assert.deepEqual(await google.revokeToken({ token: "RT", fetchImpl: async (u, i) => { body = new URLSearchParams(i.body); return response(200, {}); } }), { revoked: true });
    assert.equal(body.get("token"), "RT");
    assert.deepEqual(await google.revokeToken({ token: "RT", fetchImpl: async () => { throw new Error("down"); } }), { revoked: false });
    assert.deepEqual(await google.revokeToken({ token: "RT", fetchImpl: async () => response(400, { error: "invalid_token" }) }), { revoked: false });
});

const gClaims = (extra = {}) => ({ iss: "https://accounts.google.com", aud: GOOGLE.clientId, sub: "1234567890", email: "Jane@Gmail.com", email_verified: true, name: "Jane Doe", exp: Math.floor(Date.now() / 1000) + 3600, nonce: "the-nonce", ...extra });
const gValidate = (claims, over = {}) => google.validateIdTokenClaims(claims, { config: GOOGLE, expectedNonceHash: secretBox.sha256Hex("the-nonce"), sha256Hex: secretBox.sha256Hex, ...over });

test("google id_token: a Gmail account and a Workspace account are told apart; the address is normalised and must be verified", () => {
    assert.deepEqual(gValidate(gClaims()), { subject: "1234567890", email: "jane@gmail.com", name: "Jane Doe", hostedDomain: null, kind: "gmail" });
    assert.deepEqual({ kind: gValidate(gClaims({ hd: "acme.com", email: "jane@acme.com" })).kind, hd: gValidate(gClaims({ hd: "acme.com", email: "jane@acme.com" })).hostedDomain }, { kind: "google_workspace", hd: "acme.com" });
    assert.equal(gValidate(gClaims({ iss: "accounts.google.com" })).subject, "1234567890");
});

test("google id_token: wrong app, issuer, nonce, expiry, missing subject or an unverified email are each refused", () => {
    assert.throws(() => gValidate(gClaims({ aud: "another-app" })), { code: "ID_TOKEN_AUDIENCE" });
    assert.throws(() => gValidate(gClaims({ iss: "https://evil.example" })), { code: "ID_TOKEN_ISSUER" });
    assert.throws(() => gValidate(gClaims({ nonce: "replayed" })), { code: "NONCE_MISMATCH" });
    assert.throws(() => gValidate(gClaims({ nonce: undefined })), { code: "NONCE_MISMATCH" });
    assert.throws(() => gValidate(gClaims({ exp: Math.floor(Date.now() / 1000) - 7200 })), { code: "ID_TOKEN_EXPIRED" });
    assert.throws(() => gValidate(gClaims({ sub: undefined })), { code: "ID_TOKEN_INVALID" });
    assert.throws(() => gValidate(gClaims({ email_verified: false })), { code: "EMAIL_NOT_VERIFIED" });
    assert.throws(() => gValidate(gClaims({ email: undefined })), { code: "EMAIL_NOT_VERIFIED" });
    assert.throws(() => google.decodeJwtPayload("garbage"), { code: "ID_TOKEN_INVALID" });
});

test("google: a user who unticks the Gmail permission on Google's consent screen is detected from the granted scopes", () => {
    const all = cfg.GOOGLE_SCOPES.join(" ");
    assert.equal(google.grantedScopesOk(all, cfg.GOOGLE_REQUIRED_SCOPES), true);
    assert.equal(google.grantedScopesOk("openid email profile", cfg.GOOGLE_REQUIRED_SCOPES), false);
    assert.equal(google.grantedScopesOk("", cfg.GOOGLE_REQUIRED_SCOPES), false);
    assert.equal(google.grantedScopesOk(undefined, cfg.GOOGLE_REQUIRED_SCOPES), false);
});

// ---------------------------------------------------------------- Microsoft personal + work accounts
test("microsoft account sign-in: the 'common' authority (any account), PKCE, state, nonce, exact redirect", () => {
    const url = new URL(ms.buildAccountAuthorizeUrl({ config: MSCFG, state: "st", nonce: "no", challenge: "ch", loginHint: "jane@outlook.com" }));
    assert.equal(url.origin + url.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    assert.equal(url.searchParams.get("redirect_uri"), MSCFG.redirectUri);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("login_hint"), "jane@outlook.com");
    assert.ok(!url.toString().includes("ms-secret"));
});

const WORK_TID = "11111111-2222-3333-4444-555555555555";
const mClaims = (extra = {}) => ({ aud: MSCFG.clientId, tid: WORK_TID, iss: `https://login.microsoftonline.com/${WORK_TID}/v2.0`, exp: Math.floor(Date.now() / 1000) + 3600, nonce: "the-nonce", oid: "oid-1", preferred_username: "Jane@Acme.com", name: "Jane", ...extra });
const mValidate = (claims) => ms.validateAccountIdToken(claims, { config: MSCFG, expectedNonceHash: secretBox.sha256Hex("the-nonce"), sha256Hex: secretBox.sha256Hex });

test("microsoft id_token: a work account and a personal Outlook.com / Hotmail account are told apart by tenant; the tenant is recorded, not assumed", () => {
    assert.deepEqual(mValidate(mClaims()), { subject: "oid-1", tid: WORK_TID, email: "jane@acme.com", name: "Jane", kind: "microsoft_365" });
    const personalTid = "9188040d-6c67-4c5b-b112-36a304b66dad";
    const personal = mValidate(mClaims({ tid: personalTid, iss: `https://login.microsoftonline.com/${personalTid}/v2.0`, preferred_username: "jane@hotmail.com", email: undefined }));
    assert.equal(personal.kind, "outlook_personal");
    assert.equal(personal.tid, personalTid);
    assert.equal(ms.CONSUMER_TENANT, personalTid);
    assert.equal(mValidate(mClaims({ oid: undefined, sub: "sub-7" })).subject, "sub-7", "falls back to sub when there is no oid");
});

test("microsoft id_token: wrong app, issuer, nonce, expiry, tenant or a missing address are each refused", () => {
    assert.throws(() => mValidate(mClaims({ aud: "someone-else" })), { code: "ID_TOKEN_AUDIENCE" });
    assert.throws(() => mValidate(mClaims({ iss: "https://evil.example/v2.0" })), { code: "ID_TOKEN_ISSUER" });
    assert.throws(() => mValidate(mClaims({ iss: "https://login.microsoftonline.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/v2.0" })), { code: "ID_TOKEN_ISSUER" }, "the issuer must match the token's own tenant");
    assert.throws(() => mValidate(mClaims({ nonce: "replayed" })), { code: "NONCE_MISMATCH" });
    assert.throws(() => mValidate(mClaims({ exp: Math.floor(Date.now() / 1000) - 7200 })), { code: "ID_TOKEN_EXPIRED" });
    assert.throws(() => mValidate(mClaims({ tid: "not-a-guid" })), { code: "ID_TOKEN_INVALID" });
    assert.throws(() => mValidate(mClaims({ oid: undefined, sub: undefined })), { code: "ID_TOKEN_INVALID" });
    assert.throws(() => mValidate(mClaims({ preferred_username: "no-address", email: undefined })), { code: "EMAIL_NOT_AVAILABLE" });
});

test("microsoft account tokens: the code goes to 'common'; a refresh goes to the account's OWN recorded tenant", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, body: new URLSearchParams(init.body) }); return response(200, { access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "Mail.ReadWrite Mail.Send" }); };
    await ms.exchangeAccountCode({ config: MSCFG, code: "C", verifier: "V", fetchImpl });
    assert.equal(calls[0].url, "https://login.microsoftonline.com/common/oauth2/v2.0/token");
    await ms.refreshAccountTokens({ config: MSCFG, tenantId: WORK_TID, refreshToken: "RT", fetchImpl });
    assert.equal(calls[1].url, `https://login.microsoftonline.com/${WORK_TID}/oauth2/v2.0/token`);
    await assert.rejects(ms.refreshAccountTokens({ config: MSCFG, tenantId: "common", refreshToken: "RT", fetchImpl }), { code: "TENANT_INVALID" });
    await assert.rejects(ms.refreshAccountTokens({ config: MSCFG, tenantId: WORK_TID, refreshToken: "RT", fetchImpl: async () => response(400, { error: "invalid_grant" }) }), { code: "REAUTH_REQUIRED" });
});

// ---------------------------------------------------------------- Google Pub/Sub push authentication
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256", use: "sig" };
const AUDIENCE = "https://crm.example.com/api/email/push/google";
const SERVICE_ACCOUNT = "pubsub-push@project.iam.gserviceaccount.com";

function signedPush(claims, { kid = "key-1", alg = "RS256", key = privateKey } = {}) {
    const header = Buffer.from(JSON.stringify({ alg, kid, typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key).toString("base64url");
    return `Bearer ${header}.${payload}.${signature}`;
}
const pushClaims = (extra = {}) => ({ iss: "https://accounts.google.com", aud: AUDIENCE, email: SERVICE_ACCOUNT, email_verified: true, exp: Math.floor(Date.now() / 1000) + 600, ...extra });
const verifyPush = (header, over = {}) => google.verifyPushJwt(header, { audience: AUDIENCE, serviceAccount: SERVICE_ACCOUNT, keys: [jwk], ...over });

test("push auth: a Google-signed token for OUR endpoint from the configured service account is accepted", async () => {
    const claims = await verifyPush(signedPush(pushClaims()));
    assert.equal(claims.email, SERVICE_ACCOUNT);
});

test("push auth: a forged signature, unknown key, wrong audience, wrong sender, expired token, odd algorithm or no token is refused", async () => {
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const cases = [
        ["forged signature", signedPush(pushClaims(), { key: other })],
        ["unknown key id", signedPush(pushClaims(), { kid: "other" })],
        ["wrong audience", signedPush(pushClaims({ aud: "https://evil.example/hook" }))],
        ["wrong service account", signedPush(pushClaims({ email: "attacker@evil.iam.gserviceaccount.com" }))],
        ["unverified email", signedPush(pushClaims({ email_verified: false }))],
        ["wrong issuer", signedPush(pushClaims({ iss: "https://evil.example" }))],
        ["expired", signedPush(pushClaims({ exp: Math.floor(Date.now() / 1000) - 3600 }))],
        ["alg none", `Bearer ${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(pushClaims())).toString("base64url")}.`],
        ["HS256 confusion", signedPush(pushClaims(), { alg: "HS256" })],
        ["no header", undefined],
        ["not a bearer", "Basic abc"],
        ["malformed", "Bearer abc.def"],
    ];
    for (const [name, header] of cases) await assert.rejects(verifyPush(header), { code: "PUSH_AUTH_FAILED" }, name);
    await assert.rejects(google.verifyPushJwt(signedPush(pushClaims()), { audience: "", serviceAccount: SERVICE_ACCOUNT, keys: [jwk] }), { code: "PUSH_AUTH_FAILED" }, "unconfigured push accepts nothing");
});

test("push auth: Google's signing keys are fetched once and cached", async () => {
    google.resetKeyCache();
    let fetched = 0;
    const fetchImpl = async () => { fetched += 1; return response(200, { keys: [jwk] }); };
    for (let i = 0; i < 3; i += 1) await google.verifyPushJwt(signedPush(pushClaims()), { audience: AUDIENCE, serviceAccount: SERVICE_ACCOUNT, fetchImpl });
    assert.equal(fetched, 1);
    google.resetKeyCache();
});
