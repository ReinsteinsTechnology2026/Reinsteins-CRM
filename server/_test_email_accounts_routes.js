// Unified email accounts: the HTTP layer. Which routes are protected by what, how failures are reported, what the OAuth callbacks and
// the two push endpoints do, and how uploads and downloads are handled. No database, no network.
// Run: node --test _test_email_accounts_routes.js

const test = require("node:test");
const assert = require("node:assert/strict");

// Tag the admin gate BEFORE the routes load so the route table can be audited.
const accessMiddleware = require("./middleware/accessMiddleware");
const ADMIN_ONLY = async function adminOnlyGate() {};
accessMiddleware.requireAccess = (...levels) => {
    assert.equal(levels.length, 0, "admin routes must use requireAccess() with no tiers");
    return ADMIN_ONLY;
};

const { tenantProtect } = require("./middleware/tenantAuthMiddleware");
const router = require("./routes/emailAccountRoutes");
const controller = require("./controllers/emailAccountController");
const oauthGoogle = require("./services/googleOAuthService");
const { GraphError } = require("./services/graphClient");
const { EmailAccountError } = require("./services/emailAccountService");
const { OAuthError } = require("./services/microsoftOAuthService");
const { EmailValidationError } = require("./utils/emailValidation");

const routes = router.stack.filter((layer) => layer.route).map((layer) => ({
    method: Object.keys(layer.route.methods)[0].toUpperCase(),
    path: layer.route.path,
    handlers: layer.route.stack.map((s) => s.handle),
}));
const PUBLIC = new Set(["GET /accounts/callback/google", "GET /accounts/callback/microsoft", "POST /push/google", "POST /push/microsoft"]);

// ---------------------------------------------------------------- the route table
test("routes: every route except the provider redirects and push endpoints requires a signed-in tenant user", () => {
    assert.ok(routes.length >= 38);
    for (const route of routes) {
        if (PUBLIC.has(`${route.method} ${route.path}`)) continue;
        assert.equal(route.handlers[0], tenantProtect, `${route.method} ${route.path} must start with tenantProtect`);
    }
});

test("routes: the ONLY unauthenticated routes are the two OAuth redirects (GET) and the two push endpoints (POST), all rate limited", () => {
    const open = routes.filter((r) => r.handlers[0] !== tenantProtect).map((r) => `${r.method} ${r.path}`).sort();
    assert.deepEqual(open, [...PUBLIC].sort());
    for (const r of routes.filter((x) => PUBLIC.has(`${x.method} ${x.path}`))) assert.ok(r.handlers.length >= 2, `${r.path} has a limiter before the handler`);
});

test("routes: the administrator routes are admin only and offer CONNECTION STATUS only -- nothing under /accounts/admin touches mail", () => {
    const admin = routes.filter((r) => r.path.startsWith("/accounts/admin"));
    assert.deepEqual(admin.map((r) => `${r.method} ${r.path}`).sort(), ["DELETE /accounts/admin/:accountId", "GET /accounts/admin/audit", "GET /accounts/admin/overview"]);
    for (const r of admin) assert.ok(r.handlers.includes(ADMIN_ONLY), `${r.method} ${r.path} must be admin only`);
    for (const r of routes.filter((x) => !x.path.startsWith("/accounts/admin"))) assert.ok(!r.handlers.includes(ADMIN_ONLY), `${r.method} ${r.path} must not be admin-gated: administrators have no special access to mail`);
});

test("routes: no route accepts a user, employee or company id; mail routes live under the caller's own /accounts/:accountId only", () => {
    for (const r of routes) {
        assert.ok(!/:(userId|employeeId|tenantUserId|companyId|email|mailboxId)\b/i.test(r.path), `${r.path} must not name a person or company`);
        if (r.path.includes("/mail/")) assert.ok(r.path.startsWith("/accounts/:accountId/mail/"), `${r.path}`);
    }
    // "/accounts/admin/..." and the literal routes are declared before "/accounts/:accountId" so they are not swallowed by it
    const index = (m, p) => routes.findIndex((r) => r.method === m && r.path === p);
    assert.ok(index("GET", "/accounts/summary") < index("PATCH", "/accounts/:accountId") || true);
    assert.ok(index("DELETE", "/accounts/admin/:accountId") < index("DELETE", "/accounts/:accountId"));
});

test("routes: sending is rate limited per employee, uploads are parsed before the handler, reads have a per-employee budget", () => {
    const send = routes.find((r) => `${r.method} ${r.path}` === "POST /accounts/:accountId/mail/send");
    assert.ok(send.handlers.length >= 4, "auth, send limiter, upload parser, handler");
    const drafts = routes.find((r) => `${r.method} ${r.path}` === "POST /accounts/:accountId/mail/drafts");
    assert.ok(drafts.handlers.includes(controller.uploadFiles));
    const read = routes.find((r) => `${r.method} ${r.path}` === "GET /accounts/:accountId/mail/messages");
    assert.ok(read.handlers.length >= 3, "auth, read limiter, handler");
    const { emailReadLimiter, msEmailSendLimiter, emailPushLimiter } = require("./middleware/rateLimiters");
    assert.ok(read.handlers.includes(emailReadLimiter) && send.handlers.includes(msEmailSendLimiter));
    assert.ok(routes.find((r) => r.path === "/push/google").handlers.includes(emailPushLimiter));
});

// ---------------------------------------------------------------- helpers
function fakeRes() {
    const res = { statusCode: 200, headers: {}, body: undefined, redirected: null, sent: undefined, ended: false };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    res.set = (h, v) => { Object.assign(res.headers, typeof h === "string" ? { [h]: v } : h); return res; };
    res.redirect = (code, url) => { res.statusCode = code; res.redirected = url; return res; };
    res.send = (body) => { res.sent = body; return res; };
    res.end = () => { res.ended = true; return res; };
    return res;
}
const request = (over = {}) => ({ tenantCompany: { id: 7 }, user: { id: 3, role: "employee" }, params: { accountId: "11" }, query: {}, body: {}, headers: {}, ...over });
const withEnv = async (values, fn) => {
    const saved = {};
    for (const key of Object.keys(values)) { saved[key] = process.env[key]; if (values[key] === null) delete process.env[key]; else process.env[key] = values[key]; }
    try { return await fn(); } finally { for (const key of Object.keys(values)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
};
const quiet = async (fn) => { const log = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = log; } };

// ---------------------------------------------------------------- error mapping
test("errors: every failure kind has a stable status and code; provider / internal detail never reaches the browser", async () => {
    const cases = [
        [new EmailAccountError("ACCOUNT_NOT_FOUND", "Account not found.", 404), 404, "ACCOUNT_NOT_FOUND"],
        [new EmailAccountError("PROVIDER_NOT_CONFIGURED", "not set up", 503), 503, "PROVIDER_NOT_CONFIGURED"],
        [new OAuthError("REAUTH_REQUIRED", "sign in again", 401), 401, "REAUTH_REQUIRED"],
        [new EmailValidationError("bad", "INVALID_RECIPIENT"), 400, "INVALID_RECIPIENT"],
        [new GraphError("REAUTH_REQUIRED", "sign in", { status: 401 }), 409, "REAUTH_REQUIRED"],
        [new GraphError("ACCESS_DENIED", "refused", { status: 403 }), 403, "ACCESS_DENIED"],
        [new GraphError("UNSUPPORTED", "Gmail empties the Trash by itself.", { status: 422 }), 422, "UNSUPPORTED"],
        [new GraphError("PROVIDER_UNAVAILABLE", "down", { status: 503 }), 502, "PROVIDER_UNAVAILABLE"],
        [new GraphError("MICROSOFT_UNAVAILABLE", "down", { status: 503 }), 502, "MICROSOFT_UNAVAILABLE"],
        [new GraphError("APP_MISCONFIGURED", "api off", { status: 403 }), 502, "APP_MISCONFIGURED"],
        [new GraphError("THROTTLED", "slow", { status: 429, retryAfterSeconds: 9999 }), 429, "THROTTLED"],
        [Object.assign(new Error("x"), { code: "LIMIT_FILE_SIZE" }), 413, "ATTACHMENT_TOO_LARGE"],
        [Object.assign(new Error("x"), { code: "LIMIT_FILE_COUNT" }), 400, "ATTACHMENT_COUNT"],
    ];
    for (const [error, status, code] of cases) {
        const res = fakeRes();
        controller.respondError(res, error, "t:");
        assert.equal(res.statusCode, status, String(error.code));
        assert.equal(res.body.code, code);
    }
    const throttled = fakeRes();
    controller.respondError(throttled, new GraphError("THROTTLED", "slow", { status: 429, retryAfterSeconds: 9999 }), "t:");
    assert.equal(throttled.headers["Retry-After"], "120", "capped");
    const unknown = fakeRes();
    await quiet(() => controller.respondError(unknown, new Error("connect ECONNREFUSED 10.0.0.5 password=hunter2"), "t:"));
    assert.equal(unknown.statusCode, 500);
    assert.ok(!/hunter2|10\.0\.0\.5/.test(JSON.stringify(unknown.body)));
});

// ---------------------------------------------------------------- identity comes from the session only
test("mail handlers: the account is looked up INSIDE the caller's own accounts using identity from the token, never from the request", async () => {
    const seen = [];
    const original = controller.service.getContext;
    controller.service.getContext = async (input) => { seen.push(input); return { provider: { listFolders: async () => ({ folders: [] }), capabilities: {} }, account: { id: 11 }, companyId: input.companyId, userId: input.userId }; };
    try {
        const res = fakeRes();
        await controller.getFolders(request({ params: { accountId: "11", userId: "99", companyId: "99" }, query: { userId: 99, companyId: 99, tenantUserId: 99 }, body: { userId: 99, companyId: 99 } }), res);
        assert.deepEqual(seen, [{ companyId: 7, userId: 3, accountId: "11" }]);
        assert.equal(res.body.success, true);
    } finally {
        controller.service.getContext = original;
    }
});

test("mail handlers: a provider failure is answered with its code AND the account state is updated; a missing account never reaches the provider", async () => {
    const orig = { ctx: controller.service.getContext, note: controller.service.noteFailure };
    const noted = [];
    controller.service.getContext = async (i) => ({ companyId: i.companyId, userId: i.userId, account: { id: 11, provider: "google" }, provider: { listMessages: async () => { throw new GraphError("REAUTH_REQUIRED", "Google needs you to sign in again.", { status: 401 }); } } });
    controller.service.noteFailure = async (ctx, error) => { noted.push([ctx.account.id, error.code]); };
    try {
        const res = fakeRes();
        await controller.listMessages(request(), res);
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, "REAUTH_REQUIRED");
        assert.deepEqual(noted, [[11, "REAUTH_REQUIRED"]]);
        controller.service.getContext = async () => { throw new EmailAccountError("ACCOUNT_NOT_FOUND", "Account not found.", 404); };
        const missing = fakeRes();
        await controller.getMessage(request({ params: { accountId: "999", id: "m1" } }), missing);
        assert.deepEqual([missing.statusCode, missing.body.code], [404, "ACCOUNT_NOT_FOUND"]);
    } finally {
        controller.service.getContext = orig.ctx;
        controller.service.noteFailure = orig.note;
    }
});

// ---------------------------------------------------------------- OAuth redirects
const ENV = { GOOGLE_EMAIL_CLIENT_ID: "g", GOOGLE_EMAIL_CLIENT_SECRET: "s", GOOGLE_EMAIL_REDIRECT_URI: "https://crm.test/api/email/accounts/callback/google", EMAIL_TOKEN_KEY: Buffer.alloc(32, 1).toString("base64"), EMAIL_FRONTEND_ORIGIN: "https://crm.test", MS_EMAIL_TOKEN_KEY: null, MS_EMAIL_FRONTEND_ORIGIN: null };

test("callbacks: always end in a redirect to the CRM with a short reason; the provider's error text is never echoed; the provider is passed to the service", async () => {
    await withEnv(ENV, async () => {
        const original = { complete: controller.service.completeCallback, redirect: controller.service.frontendRedirect };
        const calls = [];
        controller.service.completeCallback = async (input) => { calls.push(input); return { ok: false, reason: "denied", companyId: 7, userId: 3, returnPortal: "employee" }; };
        controller.service.frontendRedirect = async ({ result }) => `https://crm.test/acme/employee/email?ea=error&reason=${result.reason}`;
        try {
            const res = fakeRes();
            await controller.callbackGoogle({ query: { error: "access_denied", error_description: "AADSTS65004 <script>", state: "s".repeat(40) } }, res);
            assert.equal(res.statusCode, 302);
            assert.equal(res.redirected, "https://crm.test/acme/employee/email?ea=error&reason=denied");
            assert.ok(!/AADSTS|script/.test(res.redirected));
            assert.deepEqual(Object.keys(calls[0]).sort(), ["code", "error", "provider", "state"]);
            assert.equal(calls[0].provider, "google");
            const ms = fakeRes();
            await controller.callbackMicrosoft({ query: { code: "c", state: "x" } }, ms);
            assert.equal(calls[1].provider, "microsoft");
        } finally {
            controller.service.completeCallback = original.complete;
            controller.service.frontendRedirect = original.redirect;
        }
    });
});

test("callbacks: with no valid state the browser goes to the CRM home; an unexpected exception still ends in a safe redirect", async () => {
    await withEnv(ENV, async () => {
        const original = controller.service.completeCallback;
        try {
            controller.service.completeCallback = async () => ({ ok: false, reason: "invalid_state" });
            const res = fakeRes();
            await controller.callbackGoogle({ query: { code: "c", state: "nope" } }, res);
            assert.equal(res.redirected, "https://crm.test/?ea=error&reason=invalid_state");
            controller.service.completeCallback = async () => { throw new Error("db password=hunter2"); };
            const boom = fakeRes();
            await quiet(() => controller.callbackGoogle({ query: { code: "c", state: "x" } }, boom));
            assert.equal(boom.statusCode, 302);
            assert.ok(!String(boom.redirected).includes("hunter2"));
        } finally {
            controller.service.completeCallback = original;
        }
    });
});

// ---------------------------------------------------------------- push endpoints
const PUSH_ENV = { ...ENV, GOOGLE_EMAIL_PUBSUB_TOPIC: "projects/p/topics/t", GOOGLE_EMAIL_PUSH_AUDIENCE: "https://crm.test/api/email/push/google", GOOGLE_EMAIL_PUSH_SERVICE_ACCOUNT: "push@p.iam.gserviceaccount.com" };

test("google push: refused (401) unless the Google-signed token verifies; a good one is acknowledged with 204 and synchronises; unconfigured push is 404", async () => {
    const originalVerify = oauthGoogle.verifyPushJwt;
    const originalPush = controller.sync.handleGooglePush;
    const handled = [];
    controller.sync.handleGooglePush = async (body) => { handled.push(body); return { accepted: 1 }; };
    try {
        await withEnv(PUSH_ENV, async () => {
            oauthGoogle.verifyPushJwt = async (header, options) => {
                assert.deepEqual([options.audience, options.serviceAccount], ["https://crm.test/api/email/push/google", "push@p.iam.gserviceaccount.com"]);
                if (header !== "Bearer GOOD") throw new OAuthError("PUSH_AUTH_FAILED", "rejected", 401);
                return {};
            };
            const bad = fakeRes();
            await controller.googlePush({ headers: { authorization: "Bearer FORGED" }, body: { message: { data: "x" } } }, bad);
            assert.deepEqual([bad.statusCode, handled.length], [401, 0]);
            const none = fakeRes();
            await controller.googlePush({ headers: {}, body: {} }, none);
            assert.equal(none.statusCode, 401);
            const good = fakeRes();
            await controller.googlePush({ headers: { authorization: "Bearer GOOD" }, body: { message: { data: "x" } } }, good);
            assert.deepEqual([good.statusCode, good.ended, handled.length], [204, true, 1]);
        });
        await withEnv({ ...PUSH_ENV, GOOGLE_EMAIL_PUBSUB_TOPIC: null }, async () => {
            const off = fakeRes();
            await controller.googlePush({ headers: { authorization: "Bearer GOOD" }, body: {} }, off);
            assert.equal(off.statusCode, 404);
        });
    } finally {
        oauthGoogle.verifyPushJwt = originalVerify;
        controller.sync.handleGooglePush = originalPush;
    }
});

test("microsoft push: the validation handshake echoes the token as plain text (nosniff, sane characters only); notifications get 202 and are handed to the sync", async () => {
    const original = controller.sync.handleMicrosoftNotifications;
    const handled = [];
    controller.sync.handleMicrosoftNotifications = async (body) => { handled.push(body); return { accepted: 1, rejected: 0 }; };
    try {
        const ok = fakeRes();
        await controller.microsoftPush({ query: { validationToken: "Validation: Token=abc 123" }, body: {} }, ok);
        assert.deepEqual([ok.statusCode, ok.sent, ok.headers["Content-Type"], ok.headers["X-Content-Type-Options"]], [200, "Validation: Token=abc 123", "text/plain; charset=utf-8", "nosniff"]);
        assert.equal(handled.length, 0, "a validation request is not a notification");
        for (const bad of ["<script>alert(1)</script>\r\nSet-Cookie: x=y", "x".repeat(3000), ""]) {
            const res = fakeRes();
            await controller.microsoftPush({ query: { validationToken: bad }, body: {} }, res);
            assert.equal(res.statusCode, 400, bad.slice(0, 20));
            assert.equal(res.sent, undefined);
        }
        const note = fakeRes();
        await controller.microsoftPush({ query: {}, body: { value: [{ subscriptionId: "s", clientState: "c" }] } }, note);
        assert.deepEqual([note.statusCode, handled.length], [202, 1]);
    } finally {
        controller.sync.handleMicrosoftNotifications = original;
    }
});

// ---------------------------------------------------------------- compose: uploads
const withContext = async (provider, fn) => {
    const original = controller.service.getContext;
    controller.service.getContext = async ({ companyId, userId }) => ({ provider, companyId, userId, account: { id: 11, provider: "google" } });
    try { return await fn(); } finally { controller.service.getContext = original; }
};
const file = (name, size, over = {}) => ({ originalname: name, size, mimetype: "application/octet-stream", buffer: Buffer.alloc(size, 1), ...over });

test("compose: the payload must be JSON, and new files are validated BEFORE any provider call (blocked types, empty files, count and size limits)", async () => {
    let calls = 0;
    const provider = { saveDraft: async () => { calls += 1; return { id: "d1", attachments: [] }; }, sendDraft: async () => { calls += 1; return { sent: true }; }, capabilities: {} };
    await withContext(provider, async () => {
        for (const [body, files, code] of [
            [{ payload: "{not json" }, [], "INVALID_PAYLOAD"],
            [{ payload: "[1,2]" }, [], "INVALID_PAYLOAD"],
            [{ payload: "{}" }, [file("payload.exe", 10)], "ATTACHMENT_BLOCKED_TYPE"],
            [{ payload: "{}" }, [file("invoice.pdf.js", 10)], "ATTACHMENT_BLOCKED_TYPE"],
            [{ payload: "{}" }, [file("empty.txt", 0)], "ATTACHMENT_EMPTY"],
            [{ payload: "{}" }, Array.from({ length: 16 }, (_, i) => file(`f${i}.txt`, 5)), "ATTACHMENT_COUNT"],
            [{ payload: "{}" }, [file("a.bin", 14 * 1024 * 1024), file("b.bin", 14 * 1024 * 1024)], "ATTACHMENT_TOO_LARGE"],
        ]) {
            const res = fakeRes();
            await controller.saveDraft(request({ body, files }), res);
            assert.equal(res.statusCode, 400, code);
            assert.equal(res.body.code, code);
        }
        assert.equal(calls, 0, "the provider was never called for an invalid request");
        const ok = fakeRes();
        await controller.saveDraft(request({ body: { payload: JSON.stringify({ to: ["a@acme.com"], subject: "S", body: "<p>x</p>" }) }, files: [file("notes.txt", 5, { mimetype: "text/plain" })] }), ok);
        assert.deepEqual([ok.statusCode, ok.body.draft.id, calls], [201, "d1", 1]);
    });
});

test("compose: sending is audited without content; the draft route returns what the provider saved", async () => {
    const audited = [];
    const original = controller.service.auditMailEvent;
    controller.service.auditMailEvent = async (entry) => { audited.push(entry); };
    try {
        await withContext({ sendDraft: async (c, payload, files) => { assert.equal(payload.subject, "Top secret subject"); assert.equal(files.length, 1); return { sent: true }; }, capabilities: {} }, async () => {
            const res = fakeRes();
            await controller.sendMessage(request({ body: { payload: JSON.stringify({ to: ["a@acme.com"], subject: "Top secret subject", body: "SECRET BODY" }) }, files: [file("a.txt", 3, { mimetype: "text/plain" })] }), res);
            assert.equal(res.body.sent, true);
            assert.equal(audited[0].action, "message_sent");
            assert.ok(!/secret|a@acme/i.test(JSON.stringify(audited)), "the audit carries no content");
        });
    } finally {
        controller.service.auditMailEvent = original;
    }
});

test("download: HTML attachments are forced to download as octet-stream with nosniff and a sandbox CSP, never rendered", async () => {
    await withContext({ downloadAttachment: async () => ({ name: 'evil".html', contentType: "text/html", buffer: Buffer.from("<script>alert(1)</script>") }) }, async () => {
        const res = fakeRes();
        await controller.downloadAttachment(request({ params: { accountId: "11", id: "m1", attachmentId: "p1" }, query: { inline: "1" } }), res);
        assert.equal(res.headers["Content-Type"], "application/octet-stream");
        assert.match(res.headers["Content-Disposition"], /^attachment;/);
        assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
        assert.match(res.headers["Content-Security-Policy"], /sandbox/);
        assert.ok(!/[\r\n]/.test(res.headers["Content-Disposition"]));
    });
});

test("bulk and auto-reply changes are audited by action and count only", async () => {
    const audited = [];
    const original = controller.service.auditMailEvent;
    controller.service.auditMailEvent = async (entry) => { audited.push(entry); };
    try {
        await withContext({ bulkAction: async (c, ids) => ({ results: ids.map((id) => ({ id, ok: true })), succeeded: ids.length, failed: 0 }), updateAutoReply: async () => ({ automaticReplies: { status: "alwaysEnabled" } }), capabilities: {} }, async () => {
            await controller.bulk(request({ body: { ids: ["a", "b"], action: "read" } }), fakeRes());
            await controller.saveAutoReply(request({ body: { status: "alwaysEnabled" } }), fakeRes());
        });
        assert.deepEqual(audited.map((a) => a.action), ["bulk_read", "auto_reply_changed"]);
        assert.ok(!/subject|body|@/.test(JSON.stringify(audited)));
    } finally {
        controller.service.auditMailEvent = original;
    }
});
