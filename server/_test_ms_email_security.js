// Microsoft 365 email: the security building blocks, with no database and no network.
//   - token encryption (AES-256-GCM, bound to its row), OAuth state / PKCE / id_token checks, tenant discovery
//   - the HTML sanitizer against real XSS vectors, recipient / attachment / id validation
// Run: node --test _test_ms_email_security.js

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const secretBox = require("./utils/secretBox");
const oauth = require("./services/microsoftOAuthService");
const { getConfig, MS_SCOPES } = require("./config/microsoftEmailConfig");
const { sanitizeEmailHtml, htmlToText, safeUrl } = require("./utils/emailHtmlSanitizer");
const v = require("./utils/emailValidation");

const KEY = crypto.randomBytes(32).toString("base64");
const OTHER_KEY = crypto.randomBytes(32).toString("base64");
const TENANT = "11111111-2222-3333-4444-555555555555";
const OTHER_TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CONFIG = { clientId: "client-id-1", clientSecret: "s3cret", redirectUri: "https://crm.example.com/api/email/ms/callback", scopes: MS_SCOPES };

// ---------------------------------------------------------------- secretBox
test("secretBox: round-trips, and every encryption of the same text is different", () => {
    const a = secretBox.encrypt("refresh-token-value", "ms-user:1:2", KEY);
    const b = secretBox.encrypt("refresh-token-value", "ms-user:1:2", KEY);
    assert.notEqual(a, b);
    assert.equal(secretBox.decrypt(a, "ms-user:1:2", KEY), "refresh-token-value");
    assert.ok(!a.includes("refresh-token-value"));
});

test("secretBox: a ciphertext cannot be moved to another company's or user's row (AAD binding)", () => {
    const sealed = secretBox.encrypt("tok", "ms-user:1:2", KEY);
    assert.throws(() => secretBox.decrypt(sealed, "ms-user:2:2", KEY), { code: "DECRYPT_FAILED" });
    assert.throws(() => secretBox.decrypt(sealed, "ms-user:1:3", KEY), { code: "DECRYPT_FAILED" });
});

test("secretBox: wrong key, tampering and malformed input all fail closed without detail", () => {
    const sealed = secretBox.encrypt("tok", "aad", KEY);
    assert.throws(() => secretBox.decrypt(sealed, "aad", OTHER_KEY), { code: "DECRYPT_FAILED" });
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    assert.throws(() => secretBox.decrypt(parts.join("."), "aad", KEY), { code: "DECRYPT_FAILED" });
    assert.throws(() => secretBox.decrypt("not-a-ciphertext", "aad", KEY), { code: "BAD_FORMAT" });
});

test("secretBox: a missing or short key is refused -- there is no fallback key and no plaintext fallback", () => {
    assert.throws(() => secretBox.encrypt("x", "a", ""), { code: "KEY_MISSING" });
    assert.throws(() => secretBox.encrypt("x", "a", Buffer.alloc(16).toString("base64")), { code: "KEY_INVALID" });
    assert.throws(() => secretBox.encrypt("", "a", KEY), { code: "EMPTY" });
});

test("config: not configured until every setting is present; values are never part of the public status", () => {
    const none = getConfig({});
    assert.equal(none.configured, false);
    assert.deepEqual(none.missing.sort(), ["MS_EMAIL_CLIENT_ID", "MS_EMAIL_CLIENT_SECRET", "MS_EMAIL_FRONTEND_ORIGIN", "MS_EMAIL_REDIRECT_URI", "MS_EMAIL_TOKEN_KEY"]);
    const full = getConfig({ MS_EMAIL_CLIENT_ID: "a", MS_EMAIL_CLIENT_SECRET: "b", MS_EMAIL_REDIRECT_URI: "https://x/cb", MS_EMAIL_TOKEN_KEY: KEY, MS_EMAIL_FRONTEND_ORIGIN: "https://x/" });
    assert.equal(full.configured, true);
    assert.equal(full.frontendOrigin, "https://x");
    const { publicStatus } = require("./config/microsoftEmailConfig");
    const shown = JSON.stringify(publicStatus({ MS_EMAIL_CLIENT_ID: "a", MS_EMAIL_CLIENT_SECRET: "topsecret", MS_EMAIL_REDIRECT_URI: "https://x/cb", MS_EMAIL_TOKEN_KEY: KEY, MS_EMAIL_FRONTEND_ORIGIN: "https://x" }));
    assert.ok(!shown.includes("topsecret") && !shown.includes(KEY));
});

test("scopes: delegated, minimum for a mail client, and no application-wide or directory permission", () => {
    for (const scope of ["Mail.ReadWrite", "Mail.Send", "offline_access", "User.Read"]) assert.ok(MS_SCOPES.includes(scope), scope);
    for (const scope of MS_SCOPES) assert.ok(!/\.All$/.test(scope) && !/Directory|full_access_as_app|Mail\.ReadWrite\.Shared/i.test(scope), `${scope} is too broad`);
});

// ---------------------------------------------------------------- OAuth
test("PKCE: the challenge is the S256 of the verifier and the verifier is long enough", () => {
    const { verifier, challenge } = oauth.generatePkce();
    assert.ok(verifier.length >= 43 && verifier.length <= 128);
    assert.equal(challenge, crypto.createHash("sha256").update(verifier).digest("base64url"));
    assert.notEqual(oauth.generatePkce().verifier, verifier);
});

test("authorize URL: tenant-specific, PKCE, state and nonce, exact redirect, never 'common'", () => {
    const url = new URL(oauth.buildAuthorizeUrl({ config: CONFIG, msTenantId: TENANT, state: "st", nonce: "no", challenge: "ch", loginHint: "jane@acme.com" }));
    assert.equal(url.origin + url.pathname, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
    assert.equal(url.searchParams.get("redirect_uri"), CONFIG.redirectUri);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("state"), "st");
    assert.equal(url.searchParams.get("nonce"), "no");
    assert.equal(url.searchParams.get("login_hint"), "jane@acme.com");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.ok(!url.toString().includes("client_secret"));
    for (const bad of ["common", "organizations", "consumers", "../x", "", "acme.com"]) assert.throws(() => oauth.buildAuthorizeUrl({ config: CONFIG, msTenantId: bad, state: "s", nonce: "n", challenge: "c" }), { code: "TENANT_INVALID" });
});

test("admin consent URL is tenant-specific and only asks for the app's configured delegated permissions", () => {
    const url = new URL(oauth.buildAdminConsentUrl({ config: CONFIG, msTenantId: TENANT }));
    assert.equal(url.pathname, `/${TENANT}/v2.0/adminconsent`);
    assert.equal(url.searchParams.get("scope"), "https://graph.microsoft.com/.default");
});

const idToken = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const goodClaims = (extra = {}) => ({ aud: CONFIG.clientId, tid: TENANT, iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, exp: Math.floor(Date.now() / 1000) + 3600, nonce: "the-nonce", oid: "oid-1", preferred_username: "Jane@Acme.com", ...extra });
const validate = (claims, over = {}) => oauth.validateIdTokenClaims(claims, { config: CONFIG, expectedTenantId: TENANT, expectedNonceHash: secretBox.sha256Hex("the-nonce"), sha256Hex: secretBox.sha256Hex, ...over });

test("id_token: a correct token is accepted and the account is normalised to lower case", () => {
    const result = validate(oauth.decodeJwtPayload(idToken(goodClaims())));
    assert.equal(result.oid, "oid-1");
    assert.deepEqual(result.accounts, ["jane@acme.com"]);
});

test("id_token: another organisation, personal account, wrong app, wrong nonce, expired -- each rejected with its own code", () => {
    assert.throws(() => validate(goodClaims({ tid: OTHER_TENANT, iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` })), { code: "TENANT_MISMATCH" });
    assert.throws(() => validate(goodClaims({ tid: "9188040d-6c67-4c5b-b112-36a304b66dad" })), { code: "TENANT_MISMATCH" }); // the consumer (personal account) tenant
    assert.throws(() => validate(goodClaims({ aud: "someone-elses-app" })), { code: "ID_TOKEN_AUDIENCE" });
    assert.throws(() => validate(goodClaims({ nonce: "replayed" })), { code: "NONCE_MISMATCH" });
    assert.throws(() => validate(goodClaims({ nonce: undefined })), { code: "NONCE_MISMATCH" });
    assert.throws(() => validate(goodClaims({ exp: Math.floor(Date.now() / 1000) - 3600 })), { code: "ID_TOKEN_EXPIRED" });
    assert.throws(() => validate(goodClaims({ iss: "https://evil.example/v2.0" })), { code: "ID_TOKEN_ISSUER" });
    assert.throws(() => validate(goodClaims({ oid: undefined })), { code: "ID_TOKEN_INVALID" });
    assert.throws(() => oauth.decodeJwtPayload("garbage"), { code: "ID_TOKEN_INVALID" });
});

const jsonResponse = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] || null }, json: async () => body, text: async () => JSON.stringify(body) });

test("token exchange: sends the code, verifier and secret to the company's own tenant endpoint", async () => {
    let seen;
    const fetchImpl = async (url, init) => { seen = { url, body: new URLSearchParams(init.body) }; return jsonResponse(200, { access_token: "AT", refresh_token: "RT", expires_in: 3599, scope: "Mail.ReadWrite", id_token: "x.y.z" }); };
    const tokens = await oauth.exchangeCode({ config: CONFIG, msTenantId: TENANT, code: "CODE", verifier: "VER", fetchImpl });
    assert.equal(seen.url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    assert.equal(seen.body.get("grant_type"), "authorization_code");
    assert.equal(seen.body.get("code_verifier"), "VER");
    assert.equal(tokens.accessToken, "AT");
    assert.equal(tokens.refreshToken, "RT");
    assert.equal(tokens.expiresIn, 3599);
});

test("token errors: a revoked or expired grant means 'sign in again'; a bad client is a configuration problem; outages are reported as such", async () => {
    const reject = (error) => async () => jsonResponse(400, { error });
    await assert.rejects(oauth.refreshTokens({ config: CONFIG, msTenantId: TENANT, refreshToken: "r", fetchImpl: reject("invalid_grant") }), { code: "REAUTH_REQUIRED" });
    await assert.rejects(oauth.refreshTokens({ config: CONFIG, msTenantId: TENANT, refreshToken: "r", fetchImpl: reject("interaction_required") }), { code: "REAUTH_REQUIRED" });
    await assert.rejects(oauth.refreshTokens({ config: CONFIG, msTenantId: TENANT, refreshToken: "r", fetchImpl: reject("invalid_client") }), { code: "APP_MISCONFIGURED" });
    await assert.rejects(oauth.refreshTokens({ config: CONFIG, msTenantId: TENANT, refreshToken: "r", fetchImpl: async () => { throw new Error("ECONNRESET"); } }), { code: "MICROSOFT_UNREACHABLE" });
    await assert.rejects(oauth.refreshTokens({ config: CONFIG, msTenantId: TENANT, refreshToken: "r", fetchImpl: async () => jsonResponse(200, {}) }), { code: "TOKEN_REQUEST_FAILED" });
});

test("tenant discovery: reads the organisation from Microsoft's public OpenID configuration, and refuses anything unexpected", async () => {
    const ok = async (url) => { assert.ok(url.startsWith("https://login.microsoftonline.com/acme.com/v2.0/.well-known/openid-configuration")); return jsonResponse(200, { issuer: `https://login.microsoftonline.com/${TENANT}/v2.0` }); };
    assert.equal(await oauth.discoverTenantId("ACME.com", ok), TENANT);
    await assert.rejects(oauth.discoverTenantId("acme.com", async () => jsonResponse(400, {})), { code: "DOMAIN_NOT_IN_MICROSOFT" });
    await assert.rejects(oauth.discoverTenantId("acme.com", async () => jsonResponse(200, { issuer: "https://evil.example/x/v2.0" })), { code: "DOMAIN_NOT_IN_MICROSOFT" });
    await assert.rejects(oauth.discoverTenantId("a b.com", ok), { code: "DOMAIN_INVALID" });
    await assert.rejects(oauth.discoverTenantId("acme.com", async () => { throw new Error("down"); }), { code: "MICROSOFT_UNREACHABLE" });
});

// ---------------------------------------------------------------- sanitizer
const clean = (html, options) => sanitizeEmailHtml(html, options).html;
const NO_SCRIPTY = /<script|<iframe|<object|<embed|<svg|<style|<form|javascript:|vbscript:|\son[a-z]+\s*=|expression\(|<meta|<link|<base/i;

test("sanitizer: keeps ordinary formatting", () => {
    const out = clean('<p style="color:#333;font-weight:bold">Hello <b>Jane</b>, <a href="https://acme.com/x?a=1&b=2">link</a></p><ul><li>one</li></ul><table><tr><td colspan="2">cell</td></tr></table>');
    assert.match(out, /<p style="color:#333;font-weight:bold">/);
    assert.match(out, /<b>Jane<\/b>/);
    assert.match(out, /<a href="https:\/\/acme\.com\/x\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">link<\/a>/);
    assert.match(out, /<td colspan="2">cell<\/td>/);
});

test("sanitizer: script, event handlers, javascript: URLs and friends are removed (OWASP-style vectors)", () => {
    const vectors = [
        '<script>alert(1)</script>',
        '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
        '<img src=x onerror=alert(1)>',
        '<img src="javascript:alert(1)">',
        '<a href="javascript:alert(1)">x</a>',
        '<a href="JaVaScRiPt:alert(1)">x</a>',
        '<a href="jav&#x61;script:alert(1)">x</a>',
        '<a href="jav&#09;ascript:alert(1)">x</a>',
        '<a href="&#106;avascript:alert(1)">x</a>',
        '<a href=" javascript:alert(1)">x</a>',
        '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
        '<a href="vbscript:msgbox(1)">x</a>',
        '<iframe src="https://evil.example"></iframe>',
        '<svg onload=alert(1)><circle/></svg>',
        '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
        '<body onload=alert(1)>',
        '<div style="background:url(javascript:alert(1))">x</div>',
        '<div style="width:expression(alert(1))">x</div>',
        '<style>@import "http://evil.example/x.css"; body{display:none}</style>',
        '<link rel="stylesheet" href="http://evil.example/x.css">',
        '<meta http-equiv="refresh" content="0;url=http://evil.example">',
        '<base href="http://evil.example/">',
        '<form action="http://evil.example"><input name=x></form>',
        '<object data="x.swf"></object><embed src="x.swf">',
        '<scr<script>ipt>alert(1)</scr</script>ipt>',
        '<<script>alert(1)//<</script>',
        '<img src="x" onerror="alert(1)" onerror="alert(2)">',
        '<a href="x" onclick=alert(1)>x</a>',
        '<!--[if gte mso 9]><script>alert(1)</script><![endif]-->',
        '<![CDATA[<script>alert(1)</script>]]>',
        '<p onmouseover="alert(1)">x</p>',
        '<IMG """><SCRIPT>alert("XSS")</SCRIPT>">',
        "<a href='javascript:alert(1)'>x</a>",
        '<a href=javascript:alert(1)>x</a>',
        '<details open ontoggle=alert(1)>x</details>',
        '<video><source onerror=alert(1)></video>',
        '<template><script>alert(1)</script></template>',
        '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
    ];
    for (const vector of vectors) {
        const out = clean(vector);
        assert.ok(!NO_SCRIPTY.test(out), `survived: ${vector}\n   -> ${out}`);
        assert.ok(!/alert\(/.test(out.replace(/&[a-z#0-9]+;/gi, "")) || !/<[^>]*alert\(/.test(out), `alert inside a tag: ${vector} -> ${out}`);
    }
});

test("sanitizer: remote images are blocked by default (tracking pixels) and reported; data and cid images are kept", () => {
    const result = sanitizeEmailHtml('<img src="https://tracker.example/p.gif" width="1"><img src="http://x.example/a.png"><img src="data:image/png;base64,iVBORw0KGgo="><img src="cid:logo@x">');
    assert.equal(result.blockedRemoteImages, 2);
    assert.ok(!/tracker\.example|x\.example/.test(result.html));
    assert.match(result.html, /src="data:image\/png;base64,iVBORw0KGgo="/);
    assert.match(result.html, /src="cid:logo@x"/);
    assert.match(clean('<img src="https://ok.example/a.png">', { allowRemoteImages: true }), /src="https:\/\/ok\.example\/a\.png"/);
    assert.ok(!/src=/.test(clean('<img src="http://ok.example/a.png">', { allowRemoteImages: true })), "plain http is never loaded");
    assert.ok(!/src=/.test(clean('<img src="data:image/svg+xml;base64,PHN2Zz4=">')), "svg data URLs can carry script");
});

test("sanitizer: unbalanced markup is closed, bare angle brackets are escaped, depth is bounded", () => {
    assert.equal(clean("<b>bold <i>both"), "<b>bold <i>both</i></b>");
    assert.equal(clean("a < b and c > d"), "a &lt; b and c &gt; d");
    assert.equal(clean("</div></p>text"), "text");
    const deep = clean("<div>".repeat(5000));
    assert.ok(deep.length < 5000 * 12);
    assert.equal(clean(undefined), "");
});

test("sanitizer: style attributes are rebuilt from an allow-list only", () => {
    const out = clean('<div style="color:red;position:fixed;top:0;background:url(http://x/y);font-size:14px;behavior:url(x.htc)">x</div>');
    assert.match(out, /style="color:red;font-size:14px"/);
    assert.ok(!/position|url\(|behavior/.test(out));
});

test("safeUrl: only http(s), mailto, tel (by caller) and #anchors survive; whitespace and control tricks do not hide a scheme", () => {
    assert.equal(safeUrl("https://a.example", ["http", "https"]), "https://a.example");
    assert.equal(safeUrl("#top", ["https"]), "#top");
    assert.equal(safeUrl("/relative", ["https"]), null);
    assert.equal(safeUrl("java\nscript:alert(1)", ["http", "https"]), null);
    assert.equal(safeUrl("\u0001javascript:alert(1)", ["http", "https"]), null);
});

test("htmlToText: a plain-text fallback with no markup", () => {
    assert.equal(htmlToText("<p>Hello&nbsp;<b>you</b></p><p>Bye</p><script>x()</script>"), "Hello you\nBye");
});

// ---------------------------------------------------------------- validation
test("recipients: valid forms are accepted, duplicates are removed, header injection and junk are rejected", () => {
    assert.deepEqual(v.parseRecipientList("a@acme.com; B@Acme.com, a@acme.com", "To").map((r) => r.address), ["a@acme.com", "B@Acme.com"]);
    assert.deepEqual(v.parseAddress("Jane Doe <jane@acme.com>"), { address: "jane@acme.com", name: "Jane Doe" });
    for (const bad of ["no-at-sign", "a@b", "a b@acme.com", "a@acme.com\r\nBcc: evil@x.com", "<script>@x.com", "", "a@@acme.com"]) assert.throws(() => v.parseAddress(bad), { code: "INVALID_RECIPIENT" }, bad);
    assert.throws(() => v.parseRecipientList(Array.from({ length: 101 }, (_, i) => `u${i}@acme.com`), "To"), { code: "TOO_MANY_RECIPIENTS" });
});

test("compose: sending needs a recipient, drafts do not; subject line breaks (header injection) are refused", () => {
    assert.throws(() => v.validateCompose({ to: [], subject: "s", body: "b" }, { requireRecipient: true }), { code: "NO_RECIPIENT" });
    assert.doesNotThrow(() => v.validateCompose({ to: [], subject: "", body: "" }, { requireRecipient: false }));
    assert.throws(() => v.validateCompose({ to: ["a@acme.com"], subject: "hi\r\nBcc: x@y.com", body: "" }, { requireRecipient: true }), { code: "INVALID_SUBJECT" });
    const ok = v.validateCompose({ to: ["a@acme.com"], cc: "b@acme.com", subject: "S", body: "<p>x</p>", importance: "high" }, { requireRecipient: true });
    assert.equal(ok.importance, "high");
    assert.equal(v.validateCompose({ to: ["a@acme.com"], importance: "urgent!" }, { requireRecipient: true }).importance, "normal");
});

test("graph ids: only base64url-like ids reach a Graph URL; path tricks are refused", () => {
    assert.equal(v.assertGraphId("AAMkAGI2TG93AAA="), "AAMkAGI2TG93AAA=");
    for (const bad of ["../me", "a/b", "a?b=1", "a b", "", "x".repeat(600), null, 5, "a%2fb"]) assert.throws(() => v.assertGraphId(bad), { code: "INVALID_ID" }, String(bad));
    assert.equal(v.assertFolderRef("Inbox"), "inbox");
    assert.equal(v.assertFolderRef("junkemail"), "junkemail");
    assert.throws(() => v.assertFolderRef("somewhere/else"), { code: "INVALID_ID" });
});

test("attachments: executables and double extensions are blocked, size and count limits hold, names are cleaned", () => {
    for (const name of ["setup.exe", "run.BAT", "x.pdf.exe", "invoice.pdf.js", "a.ps1", "m.docm.vbs", "evil.lnk", "x.msi", "x.hta"]) assert.throws(() => v.validateAttachment({ name, size: 10 }), { code: "ATTACHMENT_BLOCKED_TYPE" }, name);
    for (const name of ["report.pdf", "photo.JPG", "notes.txt", "sheet.xlsx", "archive.zip", "doc.docx"]) assert.doesNotThrow(() => v.validateAttachment({ name, size: 10 }), name);
    assert.throws(() => v.validateAttachment({ name: "a.txt", size: 0 }), { code: "ATTACHMENT_EMPTY" });
    assert.throws(() => v.validateAttachment({ name: "a.txt", size: v.MAX_ATTACHMENT_BYTES + 1 }), { code: "ATTACHMENT_TOO_LARGE" });
    assert.throws(() => v.validateAttachment({ name: "a.txt", size: 10 }, { totalSoFar: v.MAX_TOTAL_ATTACHMENT_BYTES }), { code: "ATTACHMENT_TOO_LARGE" });
    assert.throws(() => v.validateAttachment({ name: "a.txt", size: 10 }, { countSoFar: v.MAX_ATTACHMENTS }), { code: "ATTACHMENT_COUNT" });
    assert.equal(v.sanitizeFileName("..\\..\\etc/passwd"), "_.._etc_passwd");
    assert.equal(v.sanitizeFileName("\u0000\r\n"), "attachment");
    assert.equal(v.sanitizeFileName("report" + String.fromCharCode(0x202e) + "txt.exe"), "reporttxt.exe");
    assert.equal(v.validateAttachment({ name: "x.txt", size: 5, contentType: "text/plain; charset=utf-8" }).contentType, "text/plain");
    assert.equal(v.validateAttachment({ name: "x.txt", size: 5, contentType: "not a type" }).contentType, "application/octet-stream");
});

test("download headers: forced download by default; only known-safe types may be shown inline; never svg or html", () => {
    const download = v.attachmentDisposition("a.html", "text/html", true);
    assert.equal(download.inline, false);
    assert.equal(download.contentType, "application/octet-stream");
    assert.match(download.disposition, /^attachment;/);
    assert.equal(v.attachmentDisposition("a.svg", "image/svg+xml", true).inline, false);
    const image = v.attachmentDisposition("a.png", "image/png", true);
    assert.equal(image.inline, true);
    assert.match(image.disposition, /^inline;/);
    assert.equal(v.attachmentDisposition("a.png", "image/png", false).inline, false);
    assert.ok(!/[\r\n"]{2}/.test(v.attachmentDisposition('x"\r\nSet-Cookie: a=b.png', "image/png", true).disposition.replace(/filename="[^"]*"/, "")));
});
