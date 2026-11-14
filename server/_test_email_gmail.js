// Gmail support: the MIME builder, the message parser, the Gmail HTTP client, and every mail operation of the Google provider,
// against a scripted Gmail API. No network, no database.
// Run: node --test _test_email_gmail.js

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildMime, toRaw, encodeWords, formatAddress } = require("./services/mail/mimeBuilder");
const parser = require("./services/mail/gmailParser");
const { createGmailClient, isGmailTarget } = require("./services/mail/gmailClient");
const gp = require("./services/mail/googleProvider");

const U = "/gmail/v1/users/me";
const b64 = (text) => Buffer.from(text, "utf8").toString("base64url");
const decodeRaw = (raw) => Buffer.from(raw, "base64url").toString("utf8");

// ---------------------------------------------------------------- MIME builder
test("mime: header values can never carry a line break (no header injection) and addresses are validated", () => {
    const mime = buildMime({
        to: [{ name: "Eve\r\nBcc: spy@evil.test", address: "eve@acme.com" }],
        subject: "Hello\r\nBcc: spy@evil.test",
        html: "<p>x</p>",
        text: "x",
    });
    const headerBlock = mime.split("\r\n\r\n")[0];
    assert.ok(!/^Bcc:/im.test(headerBlock), headerBlock);
    assert.ok(headerBlock.split("\r\n").every((line) => /^[A-Za-z-]+:/.test(line) || /^\s/.test(line)), "every line is a header");
    assert.throws(() => buildMime({ to: [{ address: "a@b.com\r\nBcc: x@y.com" }], html: "", text: "" }), /invalid address/);
    assert.throws(() => buildMime({ to: [{ address: "not an address" }], html: "", text: "" }), /invalid address/);
});

test("mime: non-ASCII subjects and names use RFC 2047; file names use RFC 2231; ids in threading headers are filtered", () => {
    assert.match(encodeWords("Grüße 你好"), /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
    assert.equal(Buffer.from(encodeWords("Grüße").match(/\?B\?([^?]+)\?=/)[1], "base64").toString("utf8"), "Grüße");
    assert.equal(formatAddress({ name: 'Jane "J" Doe', address: "jane@acme.com" }), '"Jane \\"J\\" Doe" <jane@acme.com>');
    const mime = buildMime({
        to: [{ address: "a@acme.com" }],
        subject: "Café",
        html: "<p>x</p>",
        text: "x",
        attachments: [{ name: "résumé.pdf", contentType: "application/pdf", buffer: Buffer.from("PDF") }],
        inReplyTo: "<abc@mail.example>\r\nBcc: spy@evil.test",
        references: "<one@x> junk <two@x>",
    });
    assert.match(mime, /Subject: =\?UTF-8\?B\?/);
    assert.match(mime, /filename\*=UTF-8''r%C3%A9sum%C3%A9\.pdf/);
    assert.match(mime, /^In-Reply-To: <abc@mail\.example>$/m);
    assert.match(mime, /^References: <one@x> <two@x>$/m);
    assert.ok(!/spy@evil/.test(mime));
});

test("mime: multipart structure, both text and html parts, attachment bytes survive a base64 round trip", () => {
    const payload = Buffer.from("0123456789".repeat(500));
    const mime = buildMime({ to: [{ address: "a@acme.com" }], cc: [{ address: "c@acme.com" }], bcc: [{ address: "b@acme.com" }], subject: "S", html: "<p>Hi <b>there</b></p>", text: "Hi there", attachments: [{ name: "n.bin", contentType: "application/octet-stream", buffer: payload }] });
    assert.match(mime, /^Content-Type: multipart\/mixed; boundary="=_zv_mix_[0-9a-f]{24}"$/m);
    assert.match(mime, /Content-Type: multipart\/alternative/);
    assert.match(mime, /Content-Type: text\/plain; charset="UTF-8"/);
    assert.match(mime, /Content-Type: text\/html; charset="UTF-8"/);
    assert.match(mime, /^Cc: c@acme\.com$/m);
    assert.match(mime, /^Bcc: b@acme\.com$/m);
    assert.ok(mime.split("\r\n").every((line) => line.length <= 998), "no over-long line");
    const part = mime.split(/\r\n--=_zv_mix_[0-9a-f]+\r\n/)[2].split("\r\n\r\n")[1].replace(/\r\n--=_zv_mix.*$/s, "");
    assert.ok(Buffer.from(part.replace(/\r\n/g, ""), "base64").equals(payload));
    assert.equal(buildMime({ to: [], html: "", text: "" }).includes("multipart/mixed"), false, "no attachments, no mixed part");
});

// ---------------------------------------------------------------- parser
test("parser: RFC 2047 words (B and Q, several charsets) and address lists with quoted commas decode correctly", () => {
    assert.equal(parser.decodeHeader("=?UTF-8?B?R3LDvMOfZQ==?="), "Grüße");
    assert.equal(parser.decodeHeader("=?iso-8859-1?Q?Caf=E9_cr=E8me?="), "Café crème");
    assert.equal(parser.decodeHeader("=?UTF-8?B?SGVsbG8g?= =?UTF-8?B?V29ybGQ=?="), "Hello World");
    assert.equal(parser.decodeHeader("plain\r\nsecond"), "plain second");
    assert.deepEqual(parser.parseAddressHeader('"Smith, Bob" <bob@x.com>, Jane Doe <jane@acme.com>, plain@x.com, =?UTF-8?B?w4lsw6g=?= <ele@x.com>'), [
        { name: "Smith, Bob", address: "bob@x.com" },
        { name: "Jane Doe", address: "jane@acme.com" },
        { name: "", address: "plain@x.com" },
        { name: "Él\u00e8", address: "ele@x.com" },
    ].map((p) => (p.address === "ele@x.com" ? { name: parser.decodeHeader("=?UTF-8?B?w4lsw6g=?="), address: p.address } : p)));
});

const tree = () => ({
    partId: "",
    mimeType: "multipart/mixed",
    headers: [{ name: "Subject", value: "=?UTF-8?B?SGVsbG8=?=" }, { name: "From", value: "Jane <jane@acme.com>" }, { name: "Content-Type", value: "multipart/mixed; boundary=zz" }],
    parts: [
        { partId: "0", mimeType: "multipart/alternative", parts: [
            { partId: "0.0", mimeType: "text/plain", body: { size: 5, data: b64("plain") } },
            { partId: "0.1", mimeType: "text/html", headers: [{ name: "Content-Type", value: 'text/html; charset="UTF-8"' }], body: { size: 40, data: b64('<p>Logo <img src="cid:logo@x"> hi</p>') } },
        ] },
        { partId: "1", mimeType: "application/pdf", filename: "report.pdf", headers: [{ name: "Content-Disposition", value: 'attachment; filename="report.pdf"' }], body: { size: 2048, attachmentId: "ATT-1" } },
        { partId: "2", mimeType: "image/png", filename: "logo.png", headers: [{ name: "Content-ID", value: "<logo@x>" }, { name: "Content-Disposition", value: "inline" }], body: { size: 100, attachmentId: "ATT-2" } },
    ],
});

test("parser: bodies, real attachments (stable ids from part ids) and inline pictures are told apart", () => {
    const payload = tree();
    const bodies = parser.bodiesOf(payload);
    assert.equal(bodies.text, "plain");
    assert.match(bodies.html, /Logo/);
    const files = parser.attachmentsOf(payload);
    assert.deepEqual(files.map((a) => [a.id, a.name, a.isInline]), [["p1", "report.pdf", false], ["p2", "logo.png", true]]);
    assert.equal(files[1].contentId, "logo@x");
    const message = parser.listFields({ id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD", "STARRED", "Label_5"], snippet: "Tom &amp; Jerry &#39;s", internalDate: "1767225600000", payload }, new Map([["Label_5", "Clients"]]));
    assert.deepEqual({ subject: message.subject, isRead: message.isRead, flag: message.flag, categories: message.categories, preview: message.preview, hasAttachments: message.hasAttachments, conversationId: message.conversationId }, { subject: "Hello", isRead: false, flag: "flagged", categories: ["Clients"], preview: "Tom & Jerry 's", hasAttachments: true, conversationId: "t1" });
    assert.equal(message.receivedAt, "2026-01-01T00:00:00.000Z");
});

test("parser: a legacy charset body is decoded with its own charset", () => {
    const bytes = Buffer.from([0x43, 0x61, 0x66, 0xe9]); // "Cafe" with an ISO-8859-1 e-acute
    const part = { mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=ISO-8859-1" }], body: { data: bytes.toString("base64url") } };
    assert.equal(parser.decodeBody(part), "Café");
});

// ---------------------------------------------------------------- the HTTP client
const reply = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (body === undefined || body === null ? "" : JSON.stringify(body)),
    arrayBuffer: async () => Buffer.from(JSON.stringify(body || "")).buffer,
});
function scripted(...responses) {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); const next = responses.shift(); if (!next) throw new Error("unexpected request " + url); return next; };
    return { fetchImpl, calls };
}
const noSleep = async () => {};
const clientFor = (fetchImpl, over = {}) => createGmailClient({ getAccessToken: async () => "T1", refreshAccessToken: async () => "T2", fetchImpl, sleep: noSleep, random: () => 0.5, ...over });

test("gmail client: only the account's own /gmail/v1/users/me (and /upload/) is reachable; nothing else, no absolute URL", async () => {
    for (const ok of [`${U}/labels`, `${U}/messages?format=full`, "/upload/gmail/v1/users/me/drafts?uploadType=media", `${U}`]) assert.equal(isGmailTarget(ok), true, ok);
    const { fetchImpl, calls } = scripted(reply(200, {}));
    const api = clientFor(fetchImpl);
    for (const bad of ["/gmail/v1/users/someone@x.com/messages", "/gmail/v1/users/me/../../other", "https://evil.example/gmail/v1/users/me/labels", "//evil.example/x", "/oauth2/v2/userinfo", "/drive/v3/files"]) {
        await assert.rejects(api.get(bad), { code: "BAD_REQUEST" }, bad);
    }
    assert.equal(calls.length, 0);
    await api.get(`${U}/labels`);
    assert.equal(calls[0].url, "https://gmail.googleapis.com/gmail/v1/users/me/labels");
    assert.equal(calls[0].init.headers.Authorization, "Bearer T1");
});

test("gmail client: a quota 403 is retried (rateLimitExceeded), a permission 403 is not; 401 refreshes once then asks to reconnect", async () => {
    const quota = { error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } };
    const a = scripted(reply(403, quota, { "retry-after": "1" }), reply(200, { ok: 1 }));
    assert.deepEqual(await clientFor(a.fetchImpl).get(`${U}/labels`), { ok: 1 });
    assert.equal(a.calls.length, 2);

    const denied = scripted(reply(403, { error: { errors: [{ reason: "insufficientPermissions" }] } }));
    await assert.rejects(clientFor(denied.fetchImpl).get(`${U}/labels`), { code: "ACCESS_DENIED" });
    assert.equal(denied.calls.length, 1, "no retry for a real permission problem");

    let refreshes = 0;
    const r = scripted(reply(401, {}), reply(200, { fine: true }));
    assert.deepEqual(await clientFor(r.fetchImpl, { refreshAccessToken: async () => { refreshes += 1; return "FRESH"; } }).get(`${U}/profile`), { fine: true });
    assert.equal(refreshes, 1);
    assert.equal(r.calls[1].init.headers.Authorization, "Bearer FRESH");
    const dead = scripted(reply(401, {}), reply(401, {}));
    await assert.rejects(clientFor(dead.fetchImpl).get(`${U}/profile`), { code: "REAUTH_REQUIRED" });
});

test("gmail client: errors map to stable codes and Google's text is never copied into the message", async () => {
    const cases = [
        [404, { error: { message: "SECRET-DETAIL" } }, "NOT_FOUND"],
        [400, { error: { errors: [{ reason: "failedPrecondition" }] } }, "MAILBOX_NOT_AVAILABLE"],
        [400, { error: { errors: [{ reason: "invalid" }] } }, "BAD_REQUEST"],
        [403, { error: { errors: [{ reason: "accessNotConfigured" }] } }, "APP_MISCONFIGURED"],
        [413, {}, "TOO_LARGE"],
        [500, {}, "PROVIDER_UNAVAILABLE"],
    ];
    for (const [status, body, code] of cases) {
        const { fetchImpl } = scripted(reply(status, body), reply(status, body), reply(status, body), reply(status, body));
        await assert.rejects(clientFor(fetchImpl).get(`${U}/labels`), (e) => { assert.equal(e.code, code, String(status)); assert.ok(!/SECRET-DETAIL/.test(e.message)); return true; });
    }
});

// ---------------------------------------------------------------- the provider against a scripted Gmail
function fakeApi(routes = {}) {
    const calls = [];
    const answer = (method) => async (target, options = {}) => {
        calls.push({ method, target, ...options });
        const key = `${method} ${String(target).split("?")[0]}`;
        const wildcard = `${method} *`;
        if (!(key in routes) && !(wildcard in routes)) throw new Error("no route for " + key);
        const handler = key in routes ? routes[key] : routes[wildcard];
        return typeof handler === "function" ? handler(target, options) : handler;
    };
    const api = { calls, get: answer("GET"), post: answer("POST"), put: answer("PUT"), patch: answer("PATCH"), delete: answer("DELETE"), request: (m, t, o) => answer(m.toUpperCase())(t, o) };
    return api;
}
let accountSeq = 100;
const ctxOf = (api) => ({ api, account: { id: ++accountSeq, email_address: "me@gmail.com", display_name: "Me Myself" } });

const LABELS = [
    { id: "INBOX", name: "INBOX", type: "system" }, { id: "SENT", name: "SENT", type: "system" }, { id: "DRAFT", name: "DRAFT", type: "system" },
    { id: "TRASH", name: "TRASH", type: "system" }, { id: "SPAM", name: "SPAM", type: "system" }, { id: "STARRED", name: "STARRED", type: "system" },
    { id: "UNREAD", name: "UNREAD", type: "system" }, { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS", type: "system" },
    { id: "Label_2", name: "Clients", type: "user" }, { id: "Label_1", name: "Accounts", type: "user" },
];
const labelDetail = (target) => { const id = decodeURIComponent(target.split("/labels/")[1].split("?")[0]); const l = LABELS.find((x) => x.id === id); return l ? { ...l, messagesTotal: 10, messagesUnread: id === "INBOX" ? 4 : 1 } : Promise.reject(Object.assign(new Error("x"), { code: "NOT_FOUND" })); };

test("folders: well-known Gmail labels with unified names and counts, a virtual Archive, then the user's own labels", async () => {
    const api = fakeApi({ [`GET ${U}/labels`]: { labels: LABELS }, [`GET ${U}/labels/*`]: labelDetail });
    // the route table matches exact paths: register each label detail
    for (const l of LABELS) api.get = ((orig) => async (t, o) => (t.startsWith(`${U}/labels/`) ? labelDetail(t) : orig(t, o)))(api.get);
    const { folders } = await gp.listFolders(ctxOf(api));
    assert.deepEqual(folders.map((f) => f.name), ["Inbox", "Starred", "Drafts", "Sent", "Archive", "Spam", "Trash", "Accounts", "Clients"]);
    assert.deepEqual(folders.slice(0, 7).map((f) => f.wellKnown), ["inbox", "starred", "drafts", "sent", "archive", "junk", "trash"]);
    assert.equal(folders[0].unread, 4);
    assert.equal(folders[4].id, "ARCHIVE");
    assert.equal(folders[7].wellKnown, null);
});

test("folders: labels can be created and renamed; built-in labels are protected; deleting a label never deletes mail", async () => {
    const api = fakeApi({
        [`POST ${U}/labels`]: { id: "Label_9", name: "New" },
        [`GET ${U}/labels/INBOX`]: { id: "INBOX", type: "system" },
        [`GET ${U}/labels/Label_2`]: { id: "Label_2", type: "user" },
        [`PATCH ${U}/labels/Label_2`]: { id: "Label_2", name: "Renamed" },
        [`DELETE ${U}/labels/Label_2`]: null,
    });
    const c = ctxOf(api);
    assert.equal((await gp.createFolder(c, { name: "New" })).id, "Label_9");
    assert.equal((await gp.renameFolder(c, "Label_2", "Renamed")).name, "Renamed");
    await assert.rejects(gp.renameFolder(c, "INBOX", "x"), { code: "FOLDER_PROTECTED" });
    await assert.rejects(gp.deleteFolder(c, "INBOX"), { code: "FOLDER_PROTECTED" });
    assert.deepEqual(await gp.deleteFolder(c, "Label_2"), { deleted: true });
    await assert.rejects(gp.createFolder(c, { name: " " }), { code: "INVALID_FOLDER_NAME" });
    assert.equal(gp.capabilities.folderDeleteRemovesMessages, false);
});

const meta = (id, over = {}) => ({ id, threadId: "T-" + id, labelIds: ["INBOX", "UNREAD"], snippet: "snippet " + id, internalDate: String(Date.UTC(2026, 0, 2, 10, 0, 0)), payload: { headers: [{ name: "From", value: "Sam Lee <sam@acme.com>" }, { name: "To", value: "me@gmail.com" }, { name: "Subject", value: "Report " + id }, { name: "Content-Type", value: id === "m1" ? "multipart/mixed; boundary=x" : "multipart/alternative; boundary=y" }] }, ...over });
function listApi(extra = {}) {
    return fakeApi({
        [`GET ${U}/labels`]: { labels: LABELS },
        [`GET ${U}/messages`]: { messages: [{ id: "m1" }, { id: "m2" }, { id: "gone" }], nextPageToken: "NEXT_PAGE_TOKEN_1" },
        [`GET ${U}/messages/m1`]: meta("m1", { labelIds: ["INBOX", "Label_2"] }),
        [`GET ${U}/messages/m2`]: meta("m2", { labelIds: ["INBOX"] }),
        [`GET ${U}/messages/gone`]: () => Promise.reject(Object.assign(new Error("gone"), { code: "NOT_FOUND" })),
        ...extra,
    });
}

test("list: the folder maps to a label, filters become Gmail search syntax, deleted-in-flight messages are skipped, cursors are opaque", async () => {
    const api = listApi();
    const page = await gp.listMessages(ctxOf(api), { folderId: "inbox", top: "10", unread: "1", flagged: "true", hasAttachments: "1", after: "2026-01-01", before: "2026-02-01", from: "jane doe", subject: "Q3", q: "invoice" });
    const request = api.calls.find((c) => c.target === `${U}/messages`);
    assert.equal(request.query.labelIds, "INBOX");
    assert.equal(request.query.maxResults, 10);
    assert.equal(request.query.q, "invoice from:(jane doe) subject:Q3 after:2026/01/01 before:2026/02/01 is:unread is:starred has:attachment");
    assert.deepEqual(page.messages.map((m) => m.id), ["m1", "m2"]);
    assert.equal(page.messages[0].hasAttachments, true, "multipart/mixed implies a file");
    assert.equal(page.messages[0].categories[0], "Clients");
    assert.ok(page.nextCursor && !page.nextCursor.includes("NEXT_PAGE_TOKEN_1"));
    await gp.listMessages(ctxOf(api), { folderId: "inbox", cursor: page.nextCursor });
    assert.equal(api.calls.filter((c) => c.target === `${U}/messages`).pop().query.pageToken, "NEXT_PAGE_TOKEN_1");
});

test("list: Trash and Spam include their messages; Archive is a query, not a label; sort 'oldest' is reported as unsupported", async () => {
    const api = listApi();
    await gp.listMessages(ctxOf(api), { folderId: "trash" });
    const trash = api.calls.find((c) => c.target === `${U}/messages`);
    assert.equal(trash.query.labelIds, "TRASH");
    assert.equal(trash.query.includeSpamTrash, "true");
    const api2 = listApi();
    const archived = await gp.listMessages(ctxOf(api2), { folderId: "archive", sort: "oldest" });
    const q = api2.calls.find((c) => c.target === `${U}/messages`);
    assert.equal(q.query.labelIds, undefined);
    assert.match(q.query.q, /-in:inbox -in:trash -in:spam -in:sent -in:drafts/);
    assert.equal(archived.sortIgnored, true);
});

test("list: search text cannot break out of its group, a bad date or cursor or folder is refused before Gmail is called", async () => {
    const api = listApi();
    await gp.listMessages(ctxOf(api), { folderId: "inbox", q: 'x") OR (from:boss@acme.com', from: 'a" OR label:private' });
    const q = api.calls.find((c) => c.target === `${U}/messages`).query.q;
    assert.ok(!/["\\]/.test(q) && !/\(from:boss/.test(q), q);
    const before = api.calls.length;
    await assert.rejects(gp.listMessages(ctxOf(api), { after: "yesterday" }), { code: "INVALID_DATE" });
    await assert.rejects(gp.listMessages(ctxOf(api), { cursor: "%%%" }), { code: "INVALID_CURSOR" });
    await assert.rejects(gp.listMessages(ctxOf(api), { folderId: "../users" }), { code: "INVALID_ID" });
    assert.equal(api.calls.length, before);
    await gp.listMessages(ctxOf(api), { folderId: "inbox", beforeTime: "1767225600" });
    assert.match(api.calls.filter((c) => c.target === `${U}/messages`).pop().query.q, /before:1767225600/);
});

const FULL = (over = {}) => ({ id: "m1", threadId: "T1", labelIds: ["INBOX"], snippet: "s", internalDate: String(Date.UTC(2026, 0, 2)), payload: { ...tree(), headers: [...tree().headers, { name: "To", value: "me@gmail.com" }, { name: "Cc", value: "c@x.com" }, { name: "Message-ID", value: "<orig@mail.example>" }, { name: "Reply-To", value: "Replies <replies@acme.com>" }] }, ...over });

test("read: sanitized body, inline picture turned into a data URL, real attachments only listed, headers parsed", async () => {
    const payload = FULL();
    payload.payload.parts[0].parts[1].body.data = b64('<p>Logo <img src="cid:logo@x"> hi</p><script>alert(1)</script><img src="https://tracker.example/p.gif">');
    const api = fakeApi({
        [`GET ${U}/messages/m1`]: payload,
        [`GET ${U}/labels`]: { labels: LABELS },
        [`GET ${U}/messages/m1/attachments/ATT-2`]: { data: Buffer.from("PNGDATA").toString("base64url"), size: 7 },
    });
    const message = await gp.getMessage(ctxOf(api), "m1");
    assert.match(message.body.html, /<img src="data:image\/png;base64,/);
    assert.ok(!/script|tracker\.example/.test(message.body.html));
    assert.equal(message.body.blockedRemoteImages, 1);
    assert.deepEqual(message.attachments.filter((a) => !a.isInline).map((a) => a.name), ["report.pdf"]);
    assert.equal(message.hasAttachments, true);
    assert.deepEqual(message.cc, [{ name: "", address: "c@x.com" }]);
    assert.deepEqual(message.replyTo, [{ name: "Replies", address: "replies@acme.com" }]);
    assert.equal(message.internetMessageId, "<orig@mail.example>");
    assert.equal(message.subject, "Hello");
});

test("read: a plain-text-only message is escaped, not interpreted; an id with path tricks never reaches Gmail", async () => {
    const api = fakeApi({ [`GET ${U}/messages/m9`]: { id: "m9", threadId: "T9", labelIds: [], payload: { mimeType: "text/plain", headers: [], body: { data: b64("1 < 2 <script>x()</script>") } } }, [`GET ${U}/labels`]: { labels: LABELS } });
    const { body } = await gp.getMessage(ctxOf(api), "m9");
    assert.ok(!/<script/.test(body.html));
    assert.match(body.html, /&lt;script&gt;/);
    await assert.rejects(gp.getMessage(ctxOf(api), "../me"), { code: "INVALID_ID" });
});

test("attachments: downloaded by stable part id through Gmail's attachment endpoint; unknown ids are not found", async () => {
    const api = fakeApi({ [`GET ${U}/messages/m1`]: FULL(), [`GET ${U}/messages/m1/attachments/ATT-1`]: { data: Buffer.from("%PDF-1.7").toString("base64url") } });
    const file = await gp.downloadAttachment(ctxOf(api), "m1", "p1");
    assert.equal(file.buffer.toString(), "%PDF-1.7");
    assert.equal(file.name, "report.pdf");
    await assert.rejects(gp.downloadAttachment(ctxOf(api), "m1", "p9"), { code: "NOT_FOUND" });
});

test("state: read / star / labels become label changes; move, trash, archive, restore and spam use the right labels", async () => {
    const api = fakeApi({
        [`POST ${U}/messages/m1/modify`]: {},
        [`POST ${U}/messages/m1/trash`]: {},
        [`GET ${U}/labels`]: { labels: LABELS },
        [`GET ${U}/messages/m1`]: meta("m1", { labelIds: ["INBOX", "Label_1"] }),
    });
    const c = ctxOf(api);
    await gp.updateMessage(c, "m1", { isRead: true, flag: "flagged" });
    assert.deepEqual(api.calls.at(-1).body, { addLabelIds: ["STARRED"], removeLabelIds: ["UNREAD"] });
    await gp.updateMessage(c, "m1", { isRead: false, flag: "notFlagged" });
    assert.deepEqual(api.calls.at(-1).body, { addLabelIds: ["UNREAD"], removeLabelIds: ["STARRED"] });
    await gp.updateMessage(c, "m1", { categories: ["clients"] });
    assert.deepEqual(api.calls.at(-1).body, { addLabelIds: ["Label_2"], removeLabelIds: ["Label_1"] });
    await assert.rejects(gp.updateMessage(c, "m1", { flag: "urgent" }), { code: "INVALID_FLAG" });
    await assert.rejects(gp.updateMessage(c, "m1", {}), { code: "NOTHING_TO_CHANGE" });
    await gp.archiveMessage(c, "m1");
    assert.deepEqual(api.calls.at(-1).body, { addLabelIds: [], removeLabelIds: ["INBOX"] });
    await gp.restoreMessage(c, "m1");
    assert.deepEqual(api.calls.at(-1).body, { addLabelIds: ["INBOX"], removeLabelIds: ["TRASH", "SPAM"] });
    await gp.moveMessage(c, "m1", "junk");
    assert.deepEqual(api.calls.at(-1).body, { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] });
    await gp.moveMessage(c, "m1", "Label_2");
    assert.deepEqual(api.calls.at(-1).body, { addLabelIds: ["Label_2"], removeLabelIds: ["INBOX"] });
    await gp.moveMessage(c, "m1", "trash");
    assert.equal(api.calls.at(-1).target, `${U}/messages/m1/trash`);
    await assert.rejects(gp.moveMessage(c, "m1", "sent"), { code: "UNSUPPORTED" });
    assert.deepEqual(await gp.deleteMessage(c, "m1"), { id: "m1", deleted: true, permanent: false });
    assert.equal(api.calls.at(-1).target, `${U}/messages/m1/trash`);
});

test("delete forever is NOT possible with the minimum scope and says so (Gmail empties Trash after 30 days)", async () => {
    const api = fakeApi({});
    await assert.rejects(gp.deleteMessage(ctxOf(api), "m1", { permanent: true }), (e) => e.code === "UNSUPPORTED" && /30 days/.test(e.message));
    assert.equal(api.calls.length, 0);
    assert.equal(gp.capabilities.permanentDelete, false);
});

test("bulk: one batchModify call for label changes, per-message trash calls for delete, selection limits and ids validated", async () => {
    const ids = ["a1", "a2", "a3"];
    const api = fakeApi({ [`POST ${U}/messages/batchModify`]: null, [`POST ${U}/messages/a1/trash`]: {}, [`POST ${U}/messages/a2/trash`]: () => Promise.reject(Object.assign(new Error("x"), { status: 404 })), [`POST ${U}/messages/a3/trash`]: {} });
    const c = ctxOf(api);
    const read = await gp.bulkAction(c, ids, "read");
    assert.deepEqual(api.calls.at(-1).body, { ids, addLabelIds: [], removeLabelIds: ["UNREAD"] });
    assert.equal(read.succeeded, 3);
    await gp.bulkAction(c, ids, "move", { destination: "Label_2" });
    assert.deepEqual(api.calls.at(-1).body, { ids, addLabelIds: ["Label_2"], removeLabelIds: ["INBOX"] });
    const del = await gp.bulkAction(c, ids, "delete");
    assert.deepEqual([del.succeeded, del.failed], [2, 1]);
    assert.equal(del.results.find((r) => !r.ok).id, "a2");
    await assert.rejects(gp.bulkAction(c, [], "read"), { code: "INVALID_SELECTION" });
    await assert.rejects(gp.bulkAction(c, Array.from({ length: 101 }, (_, i) => `x${i}`), "read"), { code: "INVALID_SELECTION" });
    await assert.rejects(gp.bulkAction(c, ids, "wipe"), { code: "INVALID_ACTION" });
    await assert.rejects(gp.bulkAction(c, ["../x"], "read"), { code: "INVALID_ID" });
    await assert.rejects(gp.bulkAction(c, ids, "move", { destination: "sent" }), { code: "UNSUPPORTED" });
});

// ---------- drafts and sending
function draftResource(id, mime, threadId = "T-d") {
    // What Gmail returns for drafts.get(format=full): the message as a MIME tree. Built from the real builder output.
    const header = (name) => (new RegExp(`^${name}: (.*)$`, "mi").exec(mime) || [])[1];
    const parts = [{ partId: "0", mimeType: "multipart/alternative", parts: [{ partId: "0.0", mimeType: "text/plain", body: { data: b64("x") } }, { partId: "0.1", mimeType: "text/html", body: { data: b64("<p>body</p>") } }] }];
    let n = 1;
    for (const m of mime.matchAll(/Content-Disposition: attachment; filename="([^"]+)"/g)) parts.push({ partId: String(n), mimeType: "application/octet-stream", filename: m[1], body: { size: 5, attachmentId: `ATT-${n++}` } });
    return { id, message: { id: "msg-" + id, threadId, payload: { mimeType: "multipart/mixed", headers: ["Subject", "To", "Cc", "Bcc", "In-Reply-To", "References"].filter(header).map((h) => ({ name: h, value: header(h) })), parts } } };
}

test("compose: saving builds a safe MIME draft (sanitized body, text part, validated recipients) and returns the draft id with its attachments", async () => {
    let created;
    const api = fakeApi({
        [`POST ${U}/drafts`]: (t, o) => { created = decodeRaw(o.body.message.raw); return { id: "r-1", message: { id: "msg-1" } }; },
        [`GET ${U}/drafts/r-1`]: () => draftResource("r-1", created),
    });
    const draft = await gp.saveDraft(ctxOf(api), { to: [{ address: "a@acme.com", name: "Alex" }], cc: ["c@acme.com"], subject: "Hello", body: "<p>Hi</p><script>alert(1)</script><img src=x onerror=alert(1)>" }, [{ name: "notes.txt", contentType: "text/plain", buffer: Buffer.from("hello") }]);
    assert.equal(draft.id, "r-1");
    assert.ok(!/script|onerror/.test(created));
    // a subject with a line break is refused outright (header injection) before anything is built
    await assert.rejects(gp.saveDraft(ctxOf(api), { to: ["a@acme.com"], subject: "Hello\r\nBcc: spy@evil.test", body: "x" }), { code: "INVALID_SUBJECT" });
    assert.match(created, /^From: "Me Myself" <me@gmail\.com>$/m);
    assert.match(created, /^To: "Alex" <a@acme\.com>$/m);
    assert.match(created, /^Cc: c@acme\.com$/m);
    assert.match(created, /Content-Type: text\/plain/);
    assert.deepEqual(draft.attachments.map((a) => a.name), ["notes.txt"]);
    await assert.rejects(gp.saveDraft(ctxOf(api), { to: ["not-an-address"], subject: "x", body: "y" }), { code: "INVALID_RECIPIENT" });
});

test("compose: updating keeps only the attachments the client still lists (their bytes are re-read from Gmail) and the thread headers", async () => {
    let updated;
    const existing = { id: "r-2", message: { id: "msg-old", threadId: "T-9", payload: { mimeType: "multipart/mixed", headers: [{ name: "In-Reply-To", value: "<orig@x>" }, { name: "References", value: "<orig@x>" }], parts: [
        { partId: "0", mimeType: "multipart/alternative", parts: [] },
        { partId: "1", mimeType: "application/pdf", filename: "keep.pdf", body: { size: 3, attachmentId: "K1" } },
        { partId: "2", mimeType: "application/pdf", filename: "drop.pdf", body: { size: 3, attachmentId: "D1" } },
    ] } } };
    const api = fakeApi({
        [`GET ${U}/drafts/r-2`]: (t) => (updated ? draftResource("r-2", updated, "T-9") : existing),
        [`GET ${U}/messages/msg-old/attachments/K1`]: { data: Buffer.from("KEEP").toString("base64url") },
        [`PUT ${U}/drafts/r-2`]: (t, o) => { updated = decodeRaw(o.body.message.raw); assert.equal(o.body.message.threadId, "T-9"); return { id: "r-2" }; },
    });
    const saved = await gp.saveDraft(ctxOf(api), { draftId: "r-2", to: ["a@acme.com"], subject: "S", body: "<p>b</p>", keepAttachmentIds: ["p1"] }, []);
    assert.match(updated, /filename="keep\.pdf"/);
    assert.ok(!/drop\.pdf/.test(updated));
    assert.match(updated, /^In-Reply-To: <orig@x>$/m);
    assert.ok(Buffer.from(updated.match(/filename="keep\.pdf"[\s\S]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+)/)[1].replace(/\r\n/g, ""), "base64").toString() === "KEEP");
    assert.deepEqual(saved.attachments.map((a) => a.name), ["keep.pdf"]);
});

test("compose: a message over ~4 MB is uploaded as message/rfc822 instead of JSON; total attachment limits hold", async () => {
    let uploaded;
    const api = fakeApi({
        [`POST /upload/gmail/v1/users/me/drafts`]: (t, o) => { uploaded = { target: t, headers: o.headers, size: Buffer.byteLength(o.rawBody) }; return { id: "r-big" }; },
        [`GET ${U}/drafts/r-big`]: () => draftResource("r-big", "Subject: x\r\n"),
    });
    const big = Buffer.alloc(4 * 1024 * 1024 + 500000, 7);
    await gp.saveDraft(ctxOf(api), { to: ["a@acme.com"], subject: "S", body: "<p>b</p>" }, [{ name: "big.bin", contentType: "application/octet-stream", buffer: big }]);
    assert.match(uploaded.target, /^\/upload\/gmail\/v1\/users\/me\/drafts\?uploadType=media$/);
    assert.equal(uploaded.headers["Content-Type"], "message/rfc822");
    assert.ok(uploaded.size > big.length);
    await assert.rejects(gp.saveDraft(ctxOf(fakeApi({})), { to: ["a@acme.com"], subject: "S", body: "b" }, [{ name: "a.bin", contentType: "x/y", buffer: Buffer.alloc(14 * 1024 * 1024) }, { name: "b.bin", contentType: "x/y", buffer: Buffer.alloc(14 * 1024 * 1024) }]), { code: "ATTACHMENT_TOO_LARGE" });
});

test("send: needs a recipient, saves the draft then sends it by draft id; the message list's id resolves to its draft id for discard", async () => {
    let created;
    const api = fakeApi({
        [`POST ${U}/drafts`]: (t, o) => { created = decodeRaw(o.body.message.raw); return { id: "r-3" }; },
        [`GET ${U}/drafts/r-3`]: () => draftResource("r-3", created),
        [`POST ${U}/drafts/send`]: {},
    });
    const c = ctxOf(api);
    await assert.rejects(gp.sendDraft(c, { to: [], subject: "x", body: "y" }), { code: "NO_RECIPIENT" });
    assert.deepEqual(await gp.sendDraft(c, { to: ["a@acme.com"], subject: "Hi", body: "<p>x</p>" }), { sent: true });
    assert.deepEqual(api.calls.at(-1).body, { id: "r-3" });

    const api2 = fakeApi({
        [`GET ${U}/drafts/MSGID1`]: () => Promise.reject(Object.assign(new Error("nf"), { code: "NOT_FOUND" })),
        [`GET ${U}/drafts`]: { drafts: [{ id: "r-77", message: { id: "OTHER" } }, { id: "r-88", message: { id: "MSGID1" } }] },
        [`DELETE ${U}/drafts/r-88`]: null,
    });
    assert.deepEqual(await gp.discardDraft(ctxOf(api2), "MSGID1"), { deleted: true });
    assert.equal(api2.calls.at(-1).target, `${U}/drafts/r-88`);
});

const ORIGINAL = () => ({ id: "m1", threadId: "T1", labelIds: ["INBOX"], internalDate: String(Date.UTC(2026, 0, 2, 9, 30)), payload: { mimeType: "multipart/mixed", headers: [
    { name: "From", value: "Sam Lee <sam@acme.com>" }, { name: "To", value: "Me <me@gmail.com>, Pat <pat@acme.com>" }, { name: "Cc", value: "kim@acme.com, me@gmail.com" },
    { name: "Subject", value: "Quarterly report" }, { name: "Message-ID", value: "<orig@mail.example>" }, { name: "References", value: "<root@mail.example>" },
], parts: [
    { partId: "0", mimeType: "text/html", body: { data: b64("<p>Original <b>text</b></p><script>x()</script>") } },
    { partId: "1", mimeType: "application/pdf", filename: "q.pdf", body: { size: 4, attachmentId: "A1" } },
] } });

function replyApi() {
    let created;
    return fakeApi({
        [`GET ${U}/messages/m1`]: ORIGINAL(),
        [`GET ${U}/messages/m1/attachments/A1`]: { data: Buffer.from("PDF!").toString("base64url") },
        [`POST ${U}/drafts`]: (t, o) => { created = { raw: decodeRaw(o.body.message.raw), threadId: o.body.message.threadId }; return { id: "r-9" }; },
        [`GET ${U}/drafts/r-9`]: () => draftResource("r-9", created.raw, "T1"),
        get created() { return created; },
    });
}

test("reply: goes to Reply-To / From, threads under the original (In-Reply-To, References, threadId), quotes the sanitized original", async () => {
    const api = replyApi();
    await gp.createReplyDraft(ctxOf(api), "m1", "reply");
    const created = api.calls.find((c) => c.method === "POST" && c.target === `${U}/drafts`);
    const raw = decodeRaw(created.body.message.raw);
    assert.equal(created.body.message.threadId, "T1");
    assert.match(raw, /^To: "Sam Lee" <sam@acme\.com>$/m);
    assert.ok(!/^Cc:/m.test(raw));
    assert.match(raw, /^Subject: Re: Quarterly report$/m);
    assert.match(raw, /^In-Reply-To: <orig@mail\.example>$/m);
    assert.match(raw, /^References: <root@mail\.example> <orig@mail\.example>$/m);
    const html = Buffer.from(raw.match(/text\/html[^\r]*\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/)[1].replace(/\r\n/g, ""), "base64").toString();
    assert.match(html, /wrote:/);
    assert.match(html, /<blockquote>/);
    assert.ok(!/script/.test(html));
});

test("reply all: everyone except me, no duplicates; forward: empty To, Fwd: subject, original attachments included", async () => {
    const all = replyApi();
    await gp.createReplyDraft(ctxOf(all), "m1", "replyAll");
    const rawAll = decodeRaw(all.calls.find((c) => c.method === "POST" && c.target === `${U}/drafts`).body.message.raw);
    assert.match(rawAll, /^To: "Sam Lee" <sam@acme\.com>$/m);
    assert.match(rawAll, /^Cc: "Pat" <pat@acme\.com>, kim@acme\.com$/m);
    assert.ok(!/Cc:.*me@gmail\.com/.test(rawAll), "I am not copied on my own reply");

    const fwd = replyApi();
    await gp.createReplyDraft(ctxOf(fwd), "m1", "forward");
    const created = fwd.calls.find((c) => c.method === "POST" && c.target === `${U}/drafts`);
    const rawFwd = decodeRaw(created.body.message.raw);
    assert.ok(!/^To:/m.test(rawFwd));
    assert.match(rawFwd, /^Subject: Fwd: Quarterly report$/m);
    assert.match(rawFwd, /filename="q\.pdf"/);
    assert.equal(created.body.message.threadId, undefined, "a forward starts a new thread");
    await assert.rejects(gp.createReplyDraft(ctxOf(fwd), "m1", "bcc-all"), { code: "INVALID_MODE" });
});

// ---------- settings, sync, push
test("auto reply: Gmail's vacation responder maps to the unified settings in both directions (including the schedule)", async () => {
    let put;
    const api = fakeApi({
        [`GET ${U}/settings/vacation`]: () => (put ? { ...put, startTime: put.startTime, endTime: put.endTime } : { enableAutoReply: true, responseBodyHtml: "<p>Away</p>", restrictToContacts: true, startTime: String(Date.UTC(2026, 4, 1, 9)), endTime: String(Date.UTC(2026, 4, 8, 9)), responseSubject: "OOO" }),
        [`PUT ${U}/settings/vacation`]: (t, o) => { put = o.body; return o.body; },
    });
    const c = ctxOf(api);
    const read = await gp.getSettings(c);
    assert.deepEqual({ s: read.automaticReplies.status, a: read.automaticReplies.externalAudience, start: read.automaticReplies.scheduledStartDateTime }, { s: "scheduled", a: "contactsOnly", start: "2026-05-01T09:00:00" });
    const after = await gp.updateAutoReply(c, { status: "scheduled", externalAudience: "none", externalReplyMessage: "I am away<script>x()</script>", utcOffsetMinutes: -60, scheduledStartDateTime: "2026-06-01T10:00:00", scheduledEndDateTime: "2026-06-02T10:00:00" });
    assert.equal(put.enableAutoReply, true);
    assert.equal(put.restrictToDomain, true);
    assert.ok(!/script/.test(put.responseBodyHtml));
    assert.equal(put.startTime, String(Date.UTC(2026, 5, 1, 10) - 60 * 60000), "the offset turns local time into UTC");
    assert.equal(after.automaticReplies.status, "scheduled");
    await assert.rejects(gp.updateAutoReply(c, { status: "sometimes" }), { code: "INVALID_SETTING" });
    await assert.rejects(gp.updateAutoReply(c, { status: "scheduled", scheduledStartDateTime: "2026-06-01T10:00" }), { code: "INVALID_SETTING" });
    await gp.updateAutoReply(c, { status: "disabled" });
    assert.equal(put.enableAutoReply, false);
});

test("sync: the first poll only records 'now' (old mail never notifies); later polls return NEW unread inbox mail from history; a rejected old cursor starts over", async () => {
    const api = fakeApi({
        [`GET ${U}/profile`]: { emailAddress: "me@gmail.com", historyId: "5000" },
        [`GET ${U}/labels/INBOX`]: { messagesUnread: 7 },
        [`GET ${U}/history`]: { historyId: "5100", history: [{ messagesAdded: [{ message: { id: "n1", labelIds: ["INBOX", "UNREAD"] } }, { message: { id: "n2", labelIds: ["SENT"] } }, { message: { id: "n3", labelIds: ["INBOX"] } }, { message: { id: "n1", labelIds: ["INBOX", "UNREAD"] } }] }] },
        [`GET ${U}/messages/n1`]: meta("n1"),
    });
    const c = ctxOf(api);
    const first = await gp.pollNewMail(c, null);
    assert.deepEqual({ events: first.events.length, cursor: first.cursor, unread: first.unread, reset: first.reset }, { events: 0, cursor: "5000", unread: 7, reset: true });
    const next = await gp.pollNewMail(c, "5000");
    assert.deepEqual(next.events.map((e) => [e.id, e.subject, e.from.address]), [["n1", "Report n1", "sam@acme.com"]]);
    assert.equal(next.cursor, "5100");
    const hist = api.calls.find((x) => x.target === `${U}/history`);
    assert.deepEqual({ s: hist.query.startHistoryId, t: hist.query.historyTypes, l: hist.query.labelId }, { s: "5000", t: "messageAdded", l: "INBOX" });

    const stale = fakeApi({ [`GET ${U}/history`]: () => Promise.reject(Object.assign(new Error("nf"), { code: "NOT_FOUND" })), [`GET ${U}/profile`]: { historyId: "9000" }, [`GET ${U}/labels/INBOX`]: { messagesUnread: 2 } });
    const reset = await gp.pollNewMail(ctxOf(stale), "1");
    assert.deepEqual({ cursor: reset.cursor, reset: reset.reset, events: reset.events.length }, { cursor: "9000", reset: true, events: 0 });
});

test("push: Gmail watch is registered for the INBOX only on the configured topic; contacts are not requested (minimum permissions)", async () => {
    const api = fakeApi({ [`POST ${U}/watch`]: { historyId: "42", expiration: String(Date.now() + 7 * 86400000) }, [`POST ${U}/stop`]: {} });
    const result = await gp.ensurePush(ctxOf(api), { topic: "projects/p/topics/gmail" });
    assert.deepEqual(api.calls[0].body, { topicName: "projects/p/topics/gmail", labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" });
    assert.ok(result.expiresAt > new Date());
    assert.deepEqual(await gp.suggestContacts(ctxOf(api), "jane"), { contacts: [] });
    assert.equal(api.calls.length, 1);
    const { GOOGLE_SCOPES } = require("./config/emailProvidersConfig");
    assert.ok(GOOGLE_SCOPES.includes("https://www.googleapis.com/auth/gmail.modify"));
    for (const scope of GOOGLE_SCOPES) assert.ok(!/contacts|drive|calendar|^https:\/\/mail\.google\.com\/$/.test(scope), `${scope} is broader than needed`);
});
