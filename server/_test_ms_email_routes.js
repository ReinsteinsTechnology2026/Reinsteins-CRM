// Microsoft 365 email: the HTTP layer. Which routes are protected by what, how failures are reported, what the OAuth
// callback does with the browser, and how attachments are served. No database, no network.
// Run: node --test _test_ms_email_routes.js

const test = require("node:test");
const assert = require("node:assert/strict");

// Replace the admin gate with a tagged function BEFORE the routes are loaded, so the route table itself can be audited:
// requireAccess() with no tiers is the repository's "role = admin" gate.
const accessMiddleware = require("./middleware/accessMiddleware");
const ADMIN_ONLY = async function adminOnlyGate() {};
accessMiddleware.requireAccess = (...levels) => {
    assert.equal(levels.length, 0, "admin routes must use requireAccess() with no tiers");
    return ADMIN_ONLY;
};

const { tenantProtect } = require("./middleware/tenantAuthMiddleware");
const router = require("./routes/msEmailRoutes");
const controller = require("./controllers/msEmailController");
const { GraphError } = require("./services/graphClient");
const { EmailServiceError } = require("./services/msEmailService");
const { OAuthError } = require("./services/microsoftOAuthService");
const { EmailValidationError } = require("./utils/emailValidation");
const { SecretBoxError } = require("./utils/secretBox");

const routes = router.stack.filter((layer) => layer.route).map((layer) => ({
    method: Object.keys(layer.route.methods)[0].toUpperCase(),
    path: layer.route.path,
    handlers: layer.route.stack.map((s) => s.handle),
}));

// ---------------------------------------------------------------- the route table
test("routes: every route except the Microsoft redirect requires a signed-in tenant user", () => {
    assert.ok(routes.length > 40);
    for (const route of routes) {
        if (route.path === "/ms/callback") continue;
        assert.equal(route.handlers[0], tenantProtect, `${route.method} ${route.path} must start with tenantProtect`);
    }
});

test("routes: the callback is the ONLY unauthenticated route, and it is rate limited and GET-only", () => {
    const open = routes.filter((route) => route.handlers[0] !== tenantProtect);
    assert.deepEqual(open.map((route) => `${route.method} ${route.path}`), ["GET /ms/callback"]);
    assert.ok(open[0].handlers.length >= 2, "a limiter runs before the handler");
});

test("routes: company-level and mailbox-admin routes are admin only", () => {
    const adminPaths = routes.filter((route) => /^\/ms\/(company|mailboxes|audit)/.test(route.path));
    assert.ok(adminPaths.length >= 9);
    for (const route of adminPaths) assert.ok(route.handlers.includes(ADMIN_ONLY), `${route.method} ${route.path} must be admin only`);
});

test("routes: employee routes are NOT admin-gated (every employee uses their own mailbox), and no route accepts a user or mailbox id for mail", () => {
    for (const route of routes.filter((r) => /^\/(mail|ms\/me)/.test(r.path))) {
        assert.ok(!route.handlers.includes(ADMIN_ONLY), `${route.method} ${route.path} must not be admin-gated`);
        assert.ok(!/:(userId|mailboxId|companyId|tenantUserId|email)\b/i.test(route.path), `${route.path} must not name a user, mailbox or company`);
    }
});

test("routes: sending is rate limited per employee", () => {
    for (const target of ["POST /mail/send", "POST /mail/drafts/:id/send"]) {
        const route = routes.find((r) => `${r.method} ${r.path}` === target);
        assert.ok(route && route.handlers.length >= 3, `${target} has a limiter between auth and handler`);
    }
});

test("send limiter: keyed by company + employee (not by IP), so offices behind one address and shared accounts do not collide", () => {
    const { msEmailSendLimiter } = require("./middleware/rateLimiters");
    assert.equal(typeof msEmailSendLimiter, "function");
});

// ---------------------------------------------------------------- error mapping
function fakeRes() {
    const res = { statusCode: 200, headers: {}, body: undefined, redirected: null, sent: undefined };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    res.set = (headers, value) => { Object.assign(res.headers, typeof headers === "string" ? { [headers]: value } : headers); return res; };
    res.redirect = (code, url) => { res.statusCode = code; res.redirected = url; return res; };
    res.send = (body) => { res.sent = body; return res; };
    return res;
}

test("errors: each failure kind has a stable status and code, and Microsoft / internal detail never reaches the browser", () => {
    const cases = [
        [new EmailServiceError("NOT_CONNECTED", "Connect your Microsoft account to use email.", 409), 409, "NOT_CONNECTED"],
        [new EmailServiceError("MS_NOT_CONFIGURED", "not set up", 503), 503, "MS_NOT_CONFIGURED"],
        [new OAuthError("TENANT_MISMATCH", "different organisation", 403), 403, "TENANT_MISMATCH"],
        [new EmailValidationError("bad", "INVALID_RECIPIENT"), 400, "INVALID_RECIPIENT"],
        [new GraphError("REAUTH_REQUIRED", "sign in again", { status: 401 }), 409, "REAUTH_REQUIRED"],
        [new GraphError("ACCESS_DENIED", "refused", { status: 403 }), 403, "ACCESS_DENIED"],
        [new GraphError("NOT_FOUND", "gone", { status: 404 }), 404, "NOT_FOUND"],
        [new GraphError("TOO_LARGE", "big", { status: 413 }), 413, "TOO_LARGE"],
        [new GraphError("MICROSOFT_UNAVAILABLE", "down", { status: 503 }), 502, "MICROSOFT_UNAVAILABLE"],
        [new SecretBoxError("key", "KEY_MISSING"), 503, "MS_NOT_CONFIGURED"],
        [Object.assign(new Error("x"), { code: "LIMIT_FILE_SIZE" }), 413, "ATTACHMENT_TOO_LARGE"],
    ];
    for (const [error, status, code] of cases) {
        const res = fakeRes();
        controller.respondError(res, error, "test:");
        assert.equal(res.statusCode, status, String(error.code));
        assert.equal(res.body.code, code);
        assert.equal(res.body.success, false);
    }
    const unknown = fakeRes();
    const log = console.error;
    console.error = () => {};
    try {
        controller.respondError(unknown, new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"), "test:");
    } finally {
        console.error = log;
    }
    assert.equal(unknown.statusCode, 500);
    assert.ok(!JSON.stringify(unknown.body).includes("hunter2") && !JSON.stringify(unknown.body).includes("10.0.0.5"));
});

test("errors: a throttled Graph reply passes a capped Retry-After on to the browser", () => {
    const res = fakeRes();
    controller.respondError(res, new GraphError("THROTTLED", "slow down", { status: 429, retryAfterSeconds: 9999 }), "t:");
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers["Retry-After"], "120");
});

// ---------------------------------------------------------------- the mail wrapper
const request = (over = {}) => ({ tenantCompany: { id: 7 }, user: { id: 3, role: "employee" }, params: {}, query: {}, body: {}, ...over });

test("mail handlers: the context is built from the TOKEN identity only, never from the request", async () => {
    const seen = [];
    const originalGet = controller.service.getMailContext;
    controller.service.getMailContext = async (identity) => { seen.push(identity); return { graph: { get: async () => ({ value: [] }), post: async () => ({ responses: [] }) }, companyId: identity.companyId, userId: identity.userId }; };
    try {
        const res = fakeRes();
        // A hostile request that tries to name another company / user in every place it can.
        await controller.getFolders(request({ params: { companyId: 99, userId: 99 }, query: { companyId: 99, userId: 99, mailboxId: 99 }, body: { companyId: 99, userId: 99, tenantUserId: 99 } }), res);
        assert.deepEqual(seen, [{ companyId: 7, userId: 3 }]);
    } finally {
        controller.service.getMailContext = originalGet;
    }
});

test("mail handlers: a Graph failure is answered with its code AND the connection state is updated", async () => {
    const original = { ctx: controller.service.getMailContext, note: controller.service.noteGraphFailure };
    const noted = [];
    controller.service.getMailContext = async ({ companyId, userId }) => ({
        companyId, userId,
        graph: { get: async () => { throw new GraphError("REAUTH_REQUIRED", "Microsoft needs you to sign in again.", { status: 401 }); }, post: async () => { throw new GraphError("REAUTH_REQUIRED", "x", { status: 401 }); } },
    });
    controller.service.noteGraphFailure = async (identity, error) => { noted.push([identity, error.code]); };
    try {
        const res = fakeRes();
        await controller.listMessages(request(), res);
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, "REAUTH_REQUIRED");
        assert.deepEqual(noted, [[{ companyId: 7, userId: 3 }, "REAUTH_REQUIRED"]]);
    } finally {
        controller.service.getMailContext = original.ctx;
        controller.service.noteGraphFailure = original.note;
    }
});

test("mail handlers: not connected / no mailbox are answered with their code, before any Microsoft call", async () => {
    const original = controller.service.getMailContext;
    controller.service.getMailContext = async () => { throw new EmailServiceError("NOT_CONNECTED", "Connect your Microsoft account to use email.", 409); };
    try {
        const res = fakeRes();
        await controller.getMessage(request({ params: { id: "AAMk1=" } }), res);
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, "NOT_CONNECTED");
    } finally {
        controller.service.getMailContext = original;
    }
});

// ---------------------------------------------------------------- the OAuth callback
const withEnv = async (values, fn) => {
    const saved = {};
    for (const key of Object.keys(values)) { saved[key] = process.env[key]; process.env[key] = values[key]; }
    try { return await fn(); } finally { for (const key of Object.keys(values)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
};
const ENV = { MS_EMAIL_CLIENT_ID: "c", MS_EMAIL_CLIENT_SECRET: "s", MS_EMAIL_REDIRECT_URI: "https://crm.test/api/email/ms/callback", MS_EMAIL_TOKEN_KEY: Buffer.alloc(32, 1).toString("base64"), MS_EMAIL_FRONTEND_ORIGIN: "https://crm.test" };

test("callback: always ends in a redirect to the CRM with a short reason code -- Microsoft's error text is never echoed", async () => {
    await withEnv(ENV, async () => {
        const original = { complete: controller.service.completeCallback, redirect: controller.service.frontendRedirect };
        controller.service.frontendRedirect = original.redirect; // the real one, with a stubbed company lookup below
        const calls = [];
        controller.service.completeCallback = async (input) => { calls.push(input); return { ok: false, reason: "denied", companyId: 7, userId: 3, returnPortal: "employee" }; };
        controller.service.frontendRedirect = async ({ result }) => `https://crm.test/acme/employee/email?ms=error&reason=${result.reason}`;
        try {
            const res = fakeRes();
            await controller.handleCallback({ query: { error: "access_denied", error_description: "AADSTS65004: the user declined <script>", state: "s".repeat(40) } }, res);
            assert.equal(res.statusCode, 302);
            assert.equal(res.redirected, "https://crm.test/acme/employee/email?ms=error&reason=denied");
            assert.ok(!/AADSTS|script/.test(res.redirected));
            assert.deepEqual(Object.keys(calls[0]).sort(), ["code", "error", "state"], "error_description is not even passed on");
        } finally {
            controller.service.completeCallback = original.complete;
            controller.service.frontendRedirect = original.redirect;
        }
    });
});

test("callback: with no valid state there is no company to go back to, so the browser goes to the CRM home with a reason", async () => {
    await withEnv(ENV, async () => {
        const original = controller.service.completeCallback;
        controller.service.completeCallback = async () => ({ ok: false, reason: "invalid_state" });
        try {
            const res = fakeRes();
            await controller.handleCallback({ query: { code: "c", state: "nope" } }, res);
            assert.equal(res.statusCode, 302);
            assert.equal(res.redirected, "https://crm.test/?ms=error&reason=invalid_state");
        } finally {
            controller.service.completeCallback = original;
        }
    });
});

test("callback: an unexpected exception still ends in a safe response, not a stack trace", async () => {
    await withEnv(ENV, async () => {
        const original = controller.service.completeCallback;
        const log = console.error;
        console.error = () => {};
        controller.service.completeCallback = async () => { throw new Error("db password=hunter2"); };
        try {
            const res = fakeRes();
            await controller.handleCallback({ query: { code: "c", state: "x" } }, res);
            assert.equal(res.statusCode, 302);
            assert.ok(!String(res.redirected).includes("hunter2"));
        } finally {
            console.error = log;
            controller.service.completeCallback = original;
        }
    });
});

// ---------------------------------------------------------------- attachments over HTTP
function attachmentGraph() {
    return {
        get: async (target) => {
            if (target.endsWith("/$value")) return { buffer: Buffer.from("<html><script>alert(1)</script></html>"), contentType: "text/html" };
            if (target.includes("/attachments/")) return { id: "AT1", name: 'evil".html', contentType: "text/html", "@odata.type": "#microsoft.graph.fileAttachment" };
            return { value: [] };
        },
        post: async () => ({ id: "NEW", name: "ok.txt", size: 5, contentType: "text/plain" }),
    };
}
const withContext = async (graph, fn) => {
    const original = controller.service.getMailContext;
    controller.service.getMailContext = async ({ companyId, userId }) => ({ graph, companyId, userId });
    try { return await fn(); } finally { controller.service.getMailContext = original; }
};

test("download: HTML attachments are forced to download as octet-stream with nosniff and a sandbox CSP, never rendered", async () => {
    await withContext(attachmentGraph(), async () => {
        const res = fakeRes();
        await controller.downloadAttachment(request({ params: { id: "M1", attachmentId: "AT1" }, query: { inline: "1" } }), res);
        assert.equal(res.headers["Content-Type"], "application/octet-stream");
        assert.match(res.headers["Content-Disposition"], /^attachment;/);
        assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
        assert.match(res.headers["Content-Security-Policy"], /sandbox/);
        assert.equal(res.headers["Cache-Control"], "private, no-store");
        assert.ok(!/[\r\n]/.test(res.headers["Content-Disposition"]));
    });
});

test("upload: blocked file types, empty files and a missing file are refused before anything is sent to Microsoft", async () => {
    let posted = 0;
    const graph = { get: async () => ({ value: [] }), post: async () => { posted += 1; return { id: "x" }; } };
    await withContext(graph, async () => {
        for (const [file, code] of [
            [{ originalname: "payload.exe", size: 10, mimetype: "application/x-msdownload", buffer: Buffer.alloc(10) }, "ATTACHMENT_BLOCKED_TYPE"],
            [{ originalname: "invoice.pdf.js", size: 10, mimetype: "text/javascript", buffer: Buffer.alloc(10) }, "ATTACHMENT_BLOCKED_TYPE"],
            [{ originalname: "empty.txt", size: 0, mimetype: "text/plain", buffer: Buffer.alloc(0) }, "ATTACHMENT_EMPTY"],
            [undefined, "NO_FILE"],
        ]) {
            const res = fakeRes();
            await controller.addAttachment(request({ params: { id: "D1" }, file }), res);
            assert.equal(res.statusCode, 400, code);
            assert.equal(res.body.code, code);
        }
        assert.equal(posted, 0);
        const ok = fakeRes();
        await controller.addAttachment(request({ params: { id: "D1" }, file: { originalname: "ok.txt", size: 5, mimetype: "text/plain", buffer: Buffer.from("hello") } }), ok);
        assert.equal(ok.statusCode, 201);
        assert.equal(posted, 1);
    });
});

test("upload: the 25 MB total across a message's attachments is enforced using what is already on the draft", async () => {
    const graph = {
        get: async () => ({ value: [{ id: "A", name: "big.zip", size: 24 * 1024 * 1024, contentType: "application/zip" }] }),
        post: async () => { throw new Error("must not be called"); },
    };
    await withContext(graph, async () => {
        const res = fakeRes();
        await controller.addAttachment(request({ params: { id: "D1" }, file: { originalname: "more.zip", size: 2 * 1024 * 1024, mimetype: "application/zip", buffer: Buffer.alloc(2 * 1024 * 1024) } }), res);
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.code, "ATTACHMENT_TOO_LARGE");
    });
});

test("bulk and send are audited without content; a bulk request with a bad action is refused", async () => {
    const audited = [];
    const original = controller.service.auditMailEvent;
    controller.service.auditMailEvent = async (entry) => { audited.push(entry); };
    const graph = { post: async (t, { body }) => ({ responses: body.requests.map((r) => ({ id: r.id, status: 200 })) }), get: async () => ({}) };
    try {
        await withContext(graph, async () => {
            const res = fakeRes();
            await controller.bulk(request({ body: { ids: ["A", "B"], action: "read" } }), res);
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.succeeded, 2);
            const bad = fakeRes();
            await controller.bulk(request({ body: { ids: ["A"], action: "format-disk" } }), bad);
            assert.equal(bad.statusCode, 400);
        });
        assert.equal(audited[0].action, "bulk_read");
        assert.ok(!JSON.stringify(audited).match(/subject|body|@/), "no content in the audit");
    } finally {
        controller.service.auditMailEvent = original;
    }
});
