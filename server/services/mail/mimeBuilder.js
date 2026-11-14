const crypto = require("crypto");

// ==========================================
// MIME BUILDER -- turns a compose payload into an RFC 5322 / MIME message (what the Gmail API sends and stores as a draft).
//
// Safety rules (each one has a test in _test_email_gmail.js):
//   * every header VALUE is stripped of CR / LF, so no field (subject, name, address, file name) can inject another header;
//   * non-ASCII text in headers uses RFC 2047 encoded-words, file names use RFC 2231 (filename*=UTF-8''...);
//   * the body is sent as BOTH text/plain and text/html (base64, 76-column lines), attachments as base64 parts;
//   * the boundary is random per message and can never appear in the content (base64 has no "-").
// Callers pass HTML that the server has ALREADY sanitized (utils/emailHtmlSanitizer.js).
// ==========================================

const CRLF = "\r\n";

const oneLine = (value) => String(value == null ? "" : value).replace(/[\r\n]+/g, " ").trim();
const isAscii = (value) => /^[\x20-\x7e]*$/.test(value);

// RFC 2047: =?UTF-8?B?...?= words of at most ~45 UTF-8 bytes so each stays under the 75-character limit.
function encodeWords(text) {
    const value = oneLine(text);
    if (isAscii(value)) return value;
    const words = [];
    let chunk = "";
    for (const char of value) {
        if (Buffer.byteLength(chunk + char, "utf8") > 45) {
            words.push(chunk);
            chunk = char;
        } else {
            chunk += char;
        }
    }
    if (chunk) words.push(chunk);
    return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(" ");
}

function formatAddress(person) {
    const address = oneLine(person.address);
    if (!/^[^\s<>()[\],;:"\\]+@[^\s<>()[\],;:"\\]+$/.test(address)) throw new Error("invalid address in MIME build");
    const name = oneLine(person.name);
    if (!name) return address;
    if (isAscii(name)) return `"${name.replace(/(["\\])/g, "\\$1")}" <${address}>`;
    return `${encodeWords(name)} <${address}>`;
}

const formatList = (list) => (list || []).map(formatAddress).join(", ");

function foldBase64(buffer) {
    const text = Buffer.from(buffer).toString("base64");
    return text.replace(/(.{76})/g, "$1" + CRLF).replace(new RegExp(CRLF + "$"), "");
}

// RFC 2231 file name: an ASCII fallback plus the UTF-8 form for clients that understand it.
function dispositionName(name) {
    const clean = oneLine(name).replace(/[\\/:*?"<>|]/g, "_") || "attachment";
    const fallback = clean.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_");
    const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    return { fallback, encoded, clean };
}

function boundary(tag) {
    return `=_zv_${tag}_${crypto.randomBytes(12).toString("hex")}`;
}

function textPart(contentType, content) {
    return [`Content-Type: ${contentType}; charset="UTF-8"`, "Content-Transfer-Encoding: base64", "", foldBase64(Buffer.from(String(content), "utf8"))].join(CRLF);
}

/**
 * @param {{from?:{name?:string,address:string}, to?:Array, cc?:Array, bcc?:Array, subject?:string, html:string, text:string,
 *          attachments?:Array<{name:string, contentType:string, buffer:Buffer}>, inReplyTo?:string, references?:string,
 *          importance?:string, date?:Date}} message
 * @returns {string} the complete RFC 5322 message (CRLF line endings)
 */
function buildMime(message) {
    const headers = [];
    headers.push("MIME-Version: 1.0");
    headers.push(`Date: ${(message.date || new Date()).toUTCString().replace("GMT", "+0000")}`);
    if (message.from) headers.push(`From: ${formatAddress(message.from)}`);
    if (message.to && message.to.length) headers.push(`To: ${formatList(message.to)}`);
    if (message.cc && message.cc.length) headers.push(`Cc: ${formatList(message.cc)}`);
    if (message.bcc && message.bcc.length) headers.push(`Bcc: ${formatList(message.bcc)}`);
    headers.push(`Subject: ${encodeWords(message.subject || "")}`);
    // Message-ID style values for threading: allow only "<id>" tokens, never anything that could carry a line break.
    const ids = (value) => String(value || "").match(/<[^<>\s]{1,200}>/g) || [];
    if (ids(message.inReplyTo)[0]) headers.push(`In-Reply-To: ${ids(message.inReplyTo)[0]}`);
    if (ids(message.references).length) headers.push(`References: ${ids(message.references).slice(-20).join(" ")}`);
    if (message.importance === "high") headers.push("Importance: high", "X-Priority: 1");
    if (message.importance === "low") headers.push("Importance: low", "X-Priority: 5");

    const alt = boundary("alt");
    const alternative = [
        `Content-Type: multipart/alternative; boundary="${alt}"`,
        "",
        `--${alt}`,
        textPart("text/plain", message.text || ""),
        `--${alt}`,
        textPart("text/html", message.html || ""),
        `--${alt}--`,
    ].join(CRLF);

    const attachments = message.attachments || [];
    if (attachments.length === 0) return headers.join(CRLF) + CRLF + alternative + CRLF;

    const mixed = boundary("mix");
    const parts = [`--${mixed}`, alternative];
    for (const file of attachments) {
        const name = dispositionName(file.name);
        const type = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(file.contentType || "") ? file.contentType : "application/octet-stream";
        parts.push(`--${mixed}`);
        parts.push(
            [
                `Content-Type: ${type}; name="${name.fallback}"`,
                "Content-Transfer-Encoding: base64",
                `Content-Disposition: attachment; filename="${name.fallback}"; filename*=UTF-8''${name.encoded}`,
                "",
                foldBase64(file.buffer),
            ].join(CRLF)
        );
    }
    parts.push(`--${mixed}--`);
    return headers.join(CRLF) + CRLF + `Content-Type: multipart/mixed; boundary="${mixed}"` + CRLF + CRLF + parts.join(CRLF) + CRLF;
}

const toRaw = (mime) => Buffer.from(mime, "utf8").toString("base64url");

module.exports = { buildMime, toRaw, encodeWords, formatAddress, oneLine };
