// Microsoft 365 email: the Graph client (auth refresh, throttling, retries, paging safety, error mapping) and every mail
// operation, against a scripted fake Graph. No network, no database.
// Run: node --test _test_ms_email_graph.js

const test = require("node:test");
const assert = require("node:assert/strict");

const { createGraphClient, GraphError, buildQuery, isAllowedAbsoluteUrl } = require("./services/graphClient");
const mail = require("./services/graphMailService");

// ---------------------------------------------------------------- a scripted fetch
const reply = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (body === undefined || body === null ? "" : JSON.stringify(body)),
    arrayBuffer: async () => {
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body || ""));
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
});

function scripted(...responses) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        const next = responses.shift();
        if (!next) throw new Error("unexpected extra request: " + url);
        if (next instanceof Error) throw next;
        return typeof next === "function" ? next(url, init) : next;
    };
    return { fetchImpl, calls };
}

const noSleep = { slept: [], fn: async function (ms) { noSleep.slept.push(ms); } };
const clientFor = (fetchImpl, over = {}) => {
    noSleep.slept.length = 0;
    return createGraphClient({ getAccessToken: async () => "TOKEN-1", refreshAccessToken: async () => "TOKEN-2", fetchImpl, sleep: noSleep.fn, random: () => 0.5, ...over });
};

// ---------------------------------------------------------------- client behaviour
test("client: sends the bearer token and returns parsed JSON; 204 is null", async () => {
    const { fetchImpl, calls } = scripted(reply(200, { value: [1] }), reply(204));
    const graph = clientFor(fetchImpl);
    assert.deepEqual(await graph.get("/me/messages"), { value: [1] });
    assert.equal(calls[0].init.headers.Authorization, "Bearer TOKEN-1");
    assert.equal(calls[0].url, "https://graph.microsoft.com/v1.0/me/messages");
    assert.equal(await graph.delete("/me/messages/abc"), null);
});

test("client: a 401 refreshes the token ONCE and retries; a second 401 is REAUTH_REQUIRED", async () => {
    let refreshes = 0;
    const ok = scripted(reply(401, {}), reply(200, { ok: true }));
    const graph = clientFor(ok.fetchImpl, { refreshAccessToken: async () => { refreshes += 1; return "FRESH"; } });
    assert.deepEqual(await graph.get("/me"), { ok: true });
    assert.equal(refreshes, 1);
    assert.equal(ok.calls[1].init.headers.Authorization, "Bearer FRESH");

    const dead = scripted(reply(401, {}), reply(401, {}));
    await assert.rejects(clientFor(dead.fetchImpl).get("/me"), { code: "REAUTH_REQUIRED" });
    assert.equal(dead.calls.length, 2, "no endless refresh loop");
});

test("client: 429 honours Retry-After, then succeeds; the wait is capped", async () => {
    const { fetchImpl, calls } = scripted(reply(429, {}, { "retry-after": "2" }), reply(503, {}, { "retry-after": "999" }), reply(200, { done: 1 }));
    const result = await clientFor(fetchImpl).get("/me/messages");
    assert.deepEqual(result, { done: 1 });
    assert.equal(calls.length, 3);
    assert.deepEqual(noSleep.slept, [2000, 30000]);
});

test("client: throttling that never clears becomes THROTTLED (with the retry hint); outages become MICROSOFT_UNAVAILABLE", async () => {
    const throttled = scripted(...Array.from({ length: 4 }, () => reply(429, {}, { "retry-after": "1" })));
    await assert.rejects(clientFor(throttled.fetchImpl).get("/me"), (e) => e.code === "THROTTLED" && e.status === 429);
    const down = scripted(...Array.from({ length: 4 }, () => new Error("ECONNRESET")));
    await assert.rejects(clientFor(down.fetchImpl).get("/me"), { code: "MICROSOFT_UNAVAILABLE" });
    const flaky = scripted(new Error("ECONNRESET"), reply(200, { ok: 1 }));
    assert.deepEqual(await clientFor(flaky.fetchImpl).get("/me"), { ok: 1 });
});

test("client: failures map to stable codes and Microsoft's text is never copied into the message", async () => {
    const cases = [
        [403, { error: { code: "ErrorAccessDenied", message: "SECRET-DETAIL tenant xyz" } }, "ACCESS_DENIED"],
        [403, { error: { code: "MailboxNotEnabledForRESTAPI", message: "x" } }, "MAILBOX_NOT_AVAILABLE"],
        [404, { error: { code: "ErrorItemNotFound", message: "SECRET-DETAIL" } }, "NOT_FOUND"],
        [404, { error: { code: "MailboxNotFound" } }, "MAILBOX_NOT_AVAILABLE"],
        [400, { error: { code: "ErrorInvalidIdMalformed" } }, "BAD_REQUEST"],
        [412, {}, "CONFLICT"],
        [413, {}, "TOO_LARGE"],
        [500, {}, "MICROSOFT_UNAVAILABLE"],
    ];
    for (const [status, body, code] of cases) {
        const { fetchImpl } = scripted(reply(status, body));
        await assert.rejects(clientFor(fetchImpl).get("/me/messages/x"), (error) => {
            assert.equal(error.code, code, `${status}`);
            assert.ok(!/SECRET-DETAIL/.test(error.message));
            return true;
        });
    }
});

test("client: only relative /me paths and https://graph.microsoft.com/v1.0/me/ links are fetched (SSRF guard)", async () => {
    const { fetchImpl, calls } = scripted(reply(200, { value: [] }));
    const graph = clientFor(fetchImpl);
    await graph.get("https://graph.microsoft.com/v1.0/me/messages?$skiptoken=abc");
    assert.equal(calls.length, 1);
    for (const evil of [
        "https://evil.example/v1.0/me/messages",
        "http://graph.microsoft.com/v1.0/me/messages",
        "https://graph.microsoft.com.evil.example/v1.0/me/messages",
        "https://graph.microsoft.com/v1.0/users/other@acme.com/messages",
        "https://graph.microsoft.com:8443/v1.0/me/messages",
        "//evil.example/x",
        "file:///etc/passwd",
        "me/messages",
    ]) {
        await assert.rejects(graph.get(evil), { code: "BAD_REQUEST" }, evil);
    }
    assert.equal(calls.length, 1, "nothing was fetched for the rejected targets");
    assert.equal(isAllowedAbsoluteUrl("https://graph.microsoft.com/v1.0/me/mailFolders"), true);
});

test("buildQuery: OData keys keep their $, spaces are %20 (never +), empty values are skipped", () => {
    assert.equal(buildQuery({ $top: 25, $filter: "isRead eq false and x ne 'a b'", skip: "", none: undefined }), "?$top=25&$filter=isRead%20eq%20false%20and%20x%20ne%20'a%20b'");
    assert.equal(buildQuery({}), "");
});

test("client: raw downloads return a buffer; an upload URL can be called without the bearer token", async () => {
    const { fetchImpl, calls } = scripted(reply(200, Buffer.from("PDFDATA"), { "content-type": "application/pdf" }), reply(200, {}));
    const graph = clientFor(fetchImpl);
    const raw = await graph.get("/me/messages/a/attachments/b/$value", { raw: true });
    assert.equal(raw.buffer.toString(), "PDFDATA");
    assert.equal(raw.contentType, "application/pdf");
    await graph.get("/me/anything", { authless: true });
    assert.equal(calls[1].init.headers.Authorization, undefined);
});

// ---------------------------------------------------------------- mail operations (scripted Graph)
// A fake `graph` that records calls and answers from a route table.
function fakeGraph(routes = {}) {
    const calls = [];
    const answer = (method) => async (target, options = {}) => {
        calls.push({ method, target, ...options });
        const key = `${method} ${String(target).split("?")[0]}`;
        const handler = key in routes ? routes[key] : routes[`${method} *`];
        if (!(key in routes) && !(`${method} *` in routes)) throw new Error("no route for " + key);
        return typeof handler === "function" ? handler(target, options) : handler;
    };
    return { calls, get: answer("GET"), post: answer("POST"), patch: answer("PATCH"), put: answer("PUT"), delete: answer("DELETE") };
}

const wellKnownBatch = (target, { body }) => ({
    responses: body.requests.map((request) => {
        const name = request.url.split("/mailFolders/")[1].split("?")[0];
        if (name === "archive") return { id: request.id, status: 404, body: {} };
        return { id: request.id, status: 200, body: { id: `ID-${name}`, displayName: name, unreadItemCount: 2, totalItemCount: 9, childFolderCount: 0 } };
    }),
});

test("folders: well-known folders come first with Outlook names; custom folders follow; system folders are hidden", async () => {
    const graph = fakeGraph({
        "POST /$batch": wellKnownBatch,
        "GET /me/mailFolders": { value: [
            { id: "ID-inbox", displayName: "Inbox" },
            { id: "C1", displayName: "Projects", unreadItemCount: 1, totalItemCount: 4, childFolderCount: 2 },
            { id: "OUT", displayName: "Outbox" },
            { id: "CH", displayName: "Conversation History" },
            { id: "C0", displayName: "Accounts" },
        ] },
    });
    const { folders } = await mail.listFolders(graph);
    assert.deepEqual(folders.map((f) => f.name), ["Inbox", "Sent Items", "Drafts", "Deleted Items", "Junk Email", "Accounts", "Projects"]);
    assert.equal(folders[0].wellKnown, "inbox");
    assert.equal(folders[0].unread, 2);
    assert.equal(folders[6].wellKnown, null);
    assert.equal(folders[6].childCount, 2);
});

test("folders: built-in folders cannot be renamed or deleted; custom ones can; names are validated", async () => {
    const graph = fakeGraph({ "POST /$batch": wellKnownBatch, "PATCH *": { id: "C1", displayName: "New" }, "DELETE *": null, "POST /me/mailFolders": { id: "N1", displayName: "Fresh" } });
    await assert.rejects(mail.renameFolder(graph, "ID-inbox", "Mine"), { code: "FOLDER_PROTECTED" });
    await assert.rejects(mail.deleteFolder(graph, "ID-sentitems"), { code: "FOLDER_PROTECTED" });
    assert.equal((await mail.renameFolder(graph, "C1", "New")).name, "New");
    assert.deepEqual(await mail.deleteFolder(graph, "C1"), { deleted: true });
    assert.equal((await mail.createFolder(graph, { name: "Fresh" })).id, "N1");
    await assert.rejects(mail.createFolder(graph, { name: "  " }), { code: "INVALID_FOLDER_NAME" });
    await assert.rejects(mail.createFolder(graph, { name: "x".repeat(101) }), { code: "INVALID_FOLDER_NAME" });
});

const graphMessage = (over = {}) => ({ id: "M1", conversationId: "CV1", subject: "Hello", bodyPreview: "preview", from: { emailAddress: { name: "Jane", address: "jane@acme.com" } }, toRecipients: [{ emailAddress: { address: "me@acme.com" } }], receivedDateTime: "2026-01-02T10:00:00Z", isRead: false, hasAttachments: true, importance: "normal", flag: { flagStatus: "flagged" }, categories: ["Red"], parentFolderId: "ID-inbox", ...over });

test("list: no search uses $filter + $orderby with the receivedDateTime guard; unread / flagged / attachments / dates are server side", async () => {
    const graph = fakeGraph({ "GET /me/mailFolders/inbox/messages": { value: [graphMessage()], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=T" } });
    const page = await mail.listMessages(graph, { unread: "1", flagged: "true", hasAttachments: "1", after: "2026-01-01", before: "2026-02-01", top: "10", sort: "oldest" });
    const { query } = graph.calls[0];
    assert.match(query.$filter, /^receivedDateTime ge 2026-01-01T00:00:00Z and receivedDateTime le 2026-02-01T23:59:59Z and isRead eq false and flag\/flagStatus eq 'flagged' and hasAttachments eq true$/);
    assert.equal(query.$orderby, "receivedDateTime asc");
    assert.equal(query.$top, 10);
    assert.equal(page.filteredLocally, false);
    assert.equal(page.messages[0].flag, "flagged");
    assert.deepEqual(page.messages[0].from, { name: "Jane", address: "jane@acme.com" });
    assert.ok(page.nextCursor && !page.nextCursor.includes("graph.microsoft.com"), "the cursor is opaque");
});

test("list: the default is the Inbox, newest first, with the 1900 guard that keeps Exchange from rejecting the query", async () => {
    const graph = fakeGraph({ "GET /me/mailFolders/inbox/messages": { value: [] } });
    await mail.listMessages(graph, {});
    assert.equal(graph.calls[0].query.$filter, "receivedDateTime ge 1900-01-01T00:00:00Z");
    assert.equal(graph.calls[0].query.$orderby, "receivedDateTime desc");
    assert.equal(graph.calls[0].query.$top, 25);
});

test("list: a text search uses $search ALONE (Graph cannot combine it with $filter/$orderby) and applies the other filters afterwards, including on page 2", async () => {
    const pages = [
        { value: [graphMessage({ id: "A", isRead: true }), graphMessage({ id: "B", isRead: false })], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=P2" },
        { value: [graphMessage({ id: "C", isRead: false }), graphMessage({ id: "D", isRead: true })] },
    ];
    const graph = fakeGraph({ "GET /me/mailFolders/sentitems/messages": () => pages[0], "GET *": () => pages[1] });
    const first = await mail.listMessages(graph, { folderId: "sentitems", q: "invoice", from: "jane@acme.com", subject: "Q3", unread: "1" });
    assert.equal(graph.calls[0].query.$filter, undefined);
    assert.equal(graph.calls[0].query.$orderby, undefined);
    assert.match(graph.calls[0].query.$search, /from:jane@acme\.com/);
    assert.match(graph.calls[0].query.$search, /subject:Q3/);
    assert.match(graph.calls[0].query.$search, /invoice/);
    assert.equal(first.filteredLocally, true);
    assert.deepEqual(first.messages.map((m) => m.id), ["B"]);
    const second = await mail.listMessages(graph, { cursor: first.nextCursor });
    assert.deepEqual(second.messages.map((m) => m.id), ["C"], "the unread filter still applies on the next page");
});

test("list: search text cannot break out of the KQL phrase; dates and cursors are validated", async () => {
    const graph = fakeGraph({ "GET /me/mailFolders/inbox/messages": { value: [] } });
    await mail.listMessages(graph, { q: 'x" OR from:"boss@acme.com' });
    assert.ok(!graph.calls[0].query.$search.slice(1, -1).includes(String.fromCharCode(34)), "no quote can end the search phrase early: " + graph.calls[0].query.$search);
    await assert.rejects(mail.listMessages(graph, { after: "yesterday" }), { code: "INVALID_DATE" });
    await assert.rejects(mail.listMessages(graph, { cursor: "%%%not-base64-json" }), { code: "INVALID_CURSOR" });
    await assert.rejects(mail.listMessages(graph, { folderId: "../../users" }), { code: "INVALID_ID" });
    const evil = Buffer.from(JSON.stringify({ l: "https://evil.example/steal", f: null })).toString("base64url");
    const realClient = clientFor(scripted().fetchImpl);
    await assert.rejects(mail.listMessages(realClient, { cursor: evil }), { code: "BAD_REQUEST" }, "a forged cursor cannot make the server fetch another host");
});

test("read: the body is sanitized (script and tracking pixel removed), a text fallback is produced, attachments are listed", async () => {
    const graph = fakeGraph({
        "GET /me/messages/M1": graphMessage({ body: { contentType: "html", content: '<p>Hi <b>there</b></p><script>steal()</script><img src="https://t.example/p.gif"><a href="javascript:x()">click</a>' }, ccRecipients: [], bccRecipients: [], replyTo: [] }),
        "GET /me/messages/M1/attachments": { value: [{ id: "AT1", name: "report.pdf", contentType: "application/pdf", size: 1234, isInline: false, "@odata.type": "#microsoft.graph.fileAttachment" }, { id: "AT2", name: "Fwd", "@odata.type": "#microsoft.graph.itemAttachment", size: 10 }] },
    });
    const message = await mail.getMessage(graph, "M1");
    assert.ok(!/script|steal|t\.example|javascript:/.test(message.body.html), message.body.html);
    assert.match(message.body.html, /<b>there<\/b>/);
    assert.equal(message.body.blockedRemoteImages, 1);
    assert.equal(message.body.text, "Hi there\nclick");
    assert.deepEqual(message.attachments.map((a) => [a.id, a.downloadable]), [["AT1", true], ["AT2", false]]);
    assert.match(graph.calls[0].headers.Prefer, /html/);
});

test("read: a plain-text message is escaped, not interpreted", async () => {
    const graph = fakeGraph({ "GET /me/messages/M2": graphMessage({ id: "M2", hasAttachments: false, body: { contentType: "text", content: "1 < 2 <script>x()</script>\nline2" } }) });
    const { body } = await mail.getMessage(graph, "M2");
    assert.ok(!/<script/.test(body.html));
    assert.match(body.html, /&lt;script&gt;/);
});

test("thread: a conversation is fetched by conversationId and ordered oldest first locally", async () => {
    const graph = fakeGraph({ "GET /me/messages": { value: [graphMessage({ id: "late", receivedDateTime: "2026-03-01T00:00:00Z" }), graphMessage({ id: "early", receivedDateTime: "2026-01-01T00:00:00Z" })] } });
    const { messages } = await mail.getConversation(graph, "CV1");
    assert.deepEqual(messages.map((m) => m.id), ["early", "late"]);
    assert.equal(graph.calls[0].query.$orderby, undefined);
    assert.match(graph.calls[0].query.$filter, /conversationId eq 'CV1'/);
    await assert.rejects(mail.getConversation(graph, "x' or 1 eq 1 or 'y"), { code: "INVALID_ID" });
});

test("send: validated, body sanitized, saved to Sent Items; no recipient or bad address is refused before Graph is called", async () => {
    const graph = fakeGraph({ "POST /me/sendMail": null });
    await mail.sendNew(graph, { to: ["a@acme.com"], cc: "b@acme.com", bcc: [], subject: "Hi", body: '<p>Hello</p><script>x()</script><img src=x onerror=alert(1)>' });
    const sent = graph.calls[0].body;
    assert.equal(sent.saveToSentItems, true);
    assert.equal(sent.message.subject, "Hi");
    assert.equal(sent.message.body.contentType, "HTML");
    assert.ok(!/script|onerror/.test(sent.message.body.content));
    assert.deepEqual(sent.message.toRecipients, [{ emailAddress: { address: "a@acme.com" } }]);
    assert.deepEqual(sent.message.ccRecipients, [{ emailAddress: { address: "b@acme.com" } }]);
    graph.calls.length = 0;
    await assert.rejects(mail.sendNew(graph, { to: [], subject: "x", body: "y" }), { code: "NO_RECIPIENT" });
    await assert.rejects(mail.sendNew(graph, { to: ["nope"], subject: "x", body: "y" }), { code: "INVALID_RECIPIENT" });
    assert.equal(graph.calls.length, 0);
});

test("signature: appended only when asked, and it is sanitized too", async () => {
    const graph = fakeGraph({ "POST /me/sendMail": null, "POST /me/messages": { id: "D1", conversationId: "CV" } });
    await mail.sendNew(graph, { to: ["a@acme.com"], subject: "s", body: "<p>body</p>", appendSignature: true }, { signatureHtml: '<b>Jane</b><script>x()</script>' });
    assert.match(graph.calls[0].body.message.body.content, /<p>body<\/p><br><div class="zv-signature"><b>Jane<\/b><\/div>/);
    await mail.createDraft(graph, { subject: "s", body: "<p>b</p>" }, { signatureHtml: "<i>sig</i>" });
    assert.ok(!/sig/.test(graph.calls[1].body.body.content), "no signature unless appendSignature is set");
});

test("drafts: create, edit, discard and send; reply / reply-all / forward open an editable draft", async () => {
    const graph = fakeGraph({
        "POST /me/messages": { id: "D1", conversationId: "CV" },
        "PATCH /me/messages/D1": null,
        "POST /me/messages/D1/send": null,
        "DELETE /me/messages/D1": null,
        "POST /me/messages/M1/createReplyAll": { id: "R1" },
        "GET /me/messages/R1": { id: "R1", subject: "RE: Hello", body: { contentType: "html", content: "<p>quoted</p><script>x()</script>" }, toRecipients: [{ emailAddress: { address: "jane@acme.com" } }], ccRecipients: [], bccRecipients: [], importance: "normal", hasAttachments: false },
    });
    assert.equal((await mail.createDraft(graph, { to: ["a@acme.com"], subject: "s", body: "b" })).id, "D1");
    await mail.updateDraft(graph, "D1", { to: ["a@acme.com"], subject: "s2", body: "b2" });
    assert.equal(graph.calls[1].body.subject, "s2");
    assert.deepEqual(await mail.sendDraft(graph, "D1"), { sent: true });
    assert.deepEqual(await mail.discardDraft(graph, "D1"), { deleted: true });
    const draft = await mail.createReplyDraft(graph, "M1", "replyAll");
    assert.equal(draft.id, "R1");
    assert.ok(!/script/.test(draft.bodyHtml));
    assert.deepEqual(draft.to, [{ name: "", address: "jane@acme.com" }]);
    await assert.rejects(mail.createReplyDraft(graph, "M1", "bcc-everyone"), { code: "INVALID_MODE" });
});

test("state: read / flag / categories are validated; move, delete (recoverable), restore, archive target the right folders", async () => {
    const graph = fakeGraph({ "PATCH *": null, "POST /me/messages/M1/move": { id: "M1-new" }, "DELETE *": null });
    await mail.updateMessage(graph, "M1", { isRead: true, flag: "flagged", categories: ["Red", " Blue "] });
    assert.deepEqual(graph.calls[0].body, { isRead: true, flag: { flagStatus: "flagged" }, categories: ["Red", "Blue"] });
    await assert.rejects(mail.updateMessage(graph, "M1", { flag: "urgent" }), { code: "INVALID_FLAG" });
    await assert.rejects(mail.updateMessage(graph, "M1", {}), { code: "NOTHING_TO_CHANGE" });
    assert.equal((await mail.moveMessage(graph, "M1", "ID-folder")).id, "M1-new");
    const del = await mail.deleteMessage(graph, "M1");
    assert.equal(del.permanent, false);
    assert.equal(graph.calls.at(-1).body.destinationId, "deleteditems");
    await mail.restoreMessage(graph, "M1");
    assert.equal(graph.calls.at(-1).body.destinationId, "inbox");
    await mail.archiveMessage(graph, "M1");
    assert.equal(graph.calls.at(-1).body.destinationId, "archive");
    assert.equal((await mail.deleteMessage(graph, "M1", { permanent: true })).permanent, true);
    assert.equal(graph.calls.at(-1).method, "DELETE");
});

test("bulk: chunked into Graph batches of 20, per-message results, failures are reported not hidden", async () => {
    const ids = Array.from({ length: 45 }, (_, i) => `M${i}`);
    const batches = [];
    const graph = fakeGraph({
        "POST /$batch": (target, { body }) => {
            batches.push(body.requests.length);
            return { responses: body.requests.map((r) => ({ id: r.id, status: r.url.includes("M7/") || r.url.endsWith("M7") ? 404 : 200 })) };
        },
    });
    const result = await mail.bulkAction(graph, ids, "read");
    assert.deepEqual(batches, [20, 20, 5]);
    assert.equal(result.succeeded, 44);
    assert.equal(result.failed, 1);
    assert.equal(result.results.find((r) => !r.ok).id, "M7");
    const moved = fakeGraph({ "POST /$batch": (t, { body }) => ({ responses: body.requests.map((r) => ({ id: r.id, status: 200 })) }) });
    await mail.bulkAction(moved, ["A", "B"], "move", { destination: "ID-x" });
    assert.equal(moved.calls[0].body.requests[0].body.destinationId, "ID-x");
    await assert.rejects(mail.bulkAction(moved, [], "read"), { code: "INVALID_SELECTION" });
    await assert.rejects(mail.bulkAction(moved, Array.from({ length: 101 }, (_, i) => `M${i}`), "read"), { code: "INVALID_SELECTION" });
    await assert.rejects(mail.bulkAction(moved, ["A"], "wipe-everything"), { code: "INVALID_ACTION" });
    await assert.rejects(mail.bulkAction(moved, ["../x"], "read"), { code: "INVALID_ID" });
});

test("attachments: small files go in one request, large files use an upload session (without our bearer token) in chunks", async () => {
    const graph = fakeGraph({
        "POST /me/messages/D1/attachments": { id: "AT1", name: "a.txt", size: 5, contentType: "text/plain" },
        "POST /me/messages/D1/attachments/createUploadSession": { uploadUrl: "https://outlook.office.com/api/gv1/upload/abc" },
    });
    const small = await mail.addAttachment(graph, "D1", { name: "a.txt", size: 5, contentType: "text/plain", buffer: Buffer.from("hello") });
    assert.equal(small.id, "AT1");
    assert.equal(graph.calls[0].body.contentBytes, Buffer.from("hello").toString("base64"));
    assert.equal(graph.calls[0].body["@odata.type"], "#microsoft.graph.fileAttachment");

    const big = Buffer.alloc(9 * 1024 * 1024, 1);
    const puts = [];
    const fetchImpl = async (url, init) => { puts.push({ url, headers: init.headers }); return reply(201, {}); };
    await mail.addAttachment(graph, "D1", { name: "big.zip", size: big.length, contentType: "application/zip", buffer: big }, { fetchImpl });
    assert.equal(puts.length, 3, "9 MB in 4 MB chunks");
    assert.equal(puts[0].headers["Content-Range"], `bytes 0-${4 * 1024 * 1024 - 1}/${big.length}`);
    assert.ok(puts.every((p) => p.headers.Authorization === undefined), "the pre-authenticated upload URL never receives the token");

    const hostile = fakeGraph({ "POST /me/messages/D1/attachments/createUploadSession": { uploadUrl: "https://evil.example/collect" } });
    await assert.rejects(mail.addAttachment(hostile, "D1", { name: "big.zip", size: big.length, contentType: "application/zip", buffer: big }, { fetchImpl }), { code: "MICROSOFT_UNAVAILABLE" });
    const http = fakeGraph({ "POST /me/messages/D1/attachments/createUploadSession": { uploadUrl: "http://outlook.office.com/x" } });
    await assert.rejects(mail.addAttachment(http, "D1", { name: "big.zip", size: big.length, contentType: "application/zip", buffer: big }, { fetchImpl }), { code: "MICROSOFT_UNAVAILABLE" });
});

test("attachments: download returns the bytes with Graph's metadata; a non-file attachment is refused", async () => {
    const graph = fakeGraph({
        "GET /me/messages/M1/attachments/AT1": { id: "AT1", name: "r.pdf", contentType: "application/pdf", "@odata.type": "#microsoft.graph.fileAttachment" },
        "GET /me/messages/M1/attachments/AT1/$value": { buffer: Buffer.from("%PDF"), contentType: "application/pdf" },
        "GET /me/messages/M1/attachments/AT2": { id: "AT2", name: "Fwd", "@odata.type": "#microsoft.graph.itemAttachment" },
    });
    const file = await mail.downloadAttachment(graph, "M1", "AT1");
    assert.equal(file.buffer.toString(), "%PDF");
    assert.equal(file.name, "r.pdf");
    await assert.rejects(mail.downloadAttachment(graph, "M1", "AT2"), { code: "NOT_DOWNLOADABLE" });
    await assert.rejects(mail.downloadAttachment(graph, "M1", "../x"), { code: "INVALID_ID" });
});

test("contacts: needs 2+ characters, returns name and address only", async () => {
    const graph = fakeGraph({ "GET /me/people": { value: [{ displayName: "Jane Doe", scoredEmailAddresses: [{ address: "jane@acme.com" }] }, { displayName: "No Email", scoredEmailAddresses: [] }] } });
    assert.deepEqual(await mail.suggestContacts(graph, "j"), { contacts: [] });
    assert.equal(graph.calls.length, 0);
    assert.deepEqual((await mail.suggestContacts(graph, "jane")).contacts, [{ name: "Jane Doe", address: "jane@acme.com" }]);
});

test("automatic replies: validated and sanitized; a schedule needs both times", async () => {
    const graph = fakeGraph({ "PATCH /me/mailboxSettings": null, "GET /me/mailboxSettings": { timeZone: "UTC", automaticRepliesSetting: { status: "alwaysEnabled", externalAudience: "all", internalReplyMessage: "<p>away</p>", externalReplyMessage: "" } } });
    const result = await mail.updateAutomaticReplies(graph, { status: "alwaysEnabled", externalAudience: "all", internalReplyMessage: "<p>away</p><script>x()</script>", externalReplyMessage: "back soon" });
    assert.ok(!/script/.test(graph.calls[0].body.automaticRepliesSetting.internalReplyMessage));
    assert.equal(result.automaticReplies.status, "alwaysEnabled");
    await assert.rejects(mail.updateAutomaticReplies(graph, { status: "sometimes" }), { code: "INVALID_SETTING" });
    await assert.rejects(mail.updateAutomaticReplies(graph, { status: "scheduled", scheduledStartDateTime: "2026-05-01T09:00" }), { code: "INVALID_SETTING" });
    await mail.updateAutomaticReplies(graph, { status: "scheduled", timeZone: "Europe/London", scheduledStartDateTime: "2026-05-01T09:00:00", scheduledEndDateTime: "2026-05-08T09:00:00" });
    assert.deepEqual(graph.calls.at(-2).body.automaticRepliesSetting.scheduledStartDateTime, { dateTime: "2026-05-01T09:00:00", timeZone: "Europe/London" });
});

test("a Graph failure propagates as a GraphError with a stable code (so the API can answer without leaking details)", async () => {
    const { fetchImpl } = scripted(reply(403, { error: { code: "ErrorAccessDenied", message: "tenant policy ABC" } }));
    const graph = clientFor(fetchImpl);
    await assert.rejects(mail.listFolders(graph), (error) => error instanceof GraphError && error.code === "ACCESS_DENIED" && !/ABC/.test(error.message));
});
