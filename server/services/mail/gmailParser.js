const { decodeEntities } = require("../../utils/emailHtmlSanitizer");

// ==========================================
// GMAIL PARSER -- turns the Gmail API's message resource into the unified message shape. Pure functions, no I/O.
//
// Gmail returns RAW header values (RFC 2047 encoded-words undecoded) and a MIME tree (payload.parts) whose text is base64url.
// Everything that reaches the browser still goes through the HTML sanitizer afterwards; nothing here trusts message content.
// ==========================================

const decoderFor = (charset) => {
    try {
        return new TextDecoder(String(charset || "utf-8").toLowerCase());
    } catch (_error) {
        return new TextDecoder("utf-8");
    }
};

// RFC 2047:  =?charset?B?base64?=  and  =?charset?Q?quoted_printable?=
function decodeHeader(value) {
    return String(value == null ? "" : value)
        .replace(/\?=\s+=\?/g, "?==?") // adjacent encoded-words: the whitespace between them is not part of the text
        .replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (match, charset, encoding, text) => {
            try {
                let bytes;
                if (encoding.toUpperCase() === "B") {
                    bytes = Buffer.from(text, "base64");
                } else {
                    const raw = text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
                    bytes = Buffer.from(raw, "latin1");
                }
                return decoderFor(charset).decode(bytes);
            } catch (_error) {
                return match;
            }
        })
        .replace(/[\r\n]+/g, " ")
        .trim();
}

// Splits "Jane Doe <jane@acme.com>, \"Smith, Bob\" <bob@x.com>, plain@x.com" into people, honouring quotes and angle brackets.
function parseAddressHeader(value) {
    const text = decodeHeader(value);
    const people = [];
    let current = "";
    let inQuote = false;
    let depth = 0;
    const flush = () => {
        const part = current.trim();
        current = "";
        if (!part) return;
        const angle = /^(.*?)<([^<>]+)>\s*$/.exec(part);
        let name = "";
        let address = part;
        if (angle) {
            name = angle[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\(["\\])/g, "$1").trim();
            address = angle[2].trim();
        }
        address = address.replace(/^mailto:/i, "").trim();
        if (address.includes("@")) people.push({ name, address: address.toLowerCase() === address ? address : address });
    };
    for (const char of text) {
        if (char === '"' ) inQuote = !inQuote;
        if (!inQuote && char === "<") depth += 1;
        if (!inQuote && char === ">") depth = Math.max(0, depth - 1);
        if (char === "," && !inQuote && depth === 0) flush();
        else current += char;
    }
    flush();
    return people;
}

function headerMap(payload) {
    const map = {};
    for (const header of (payload && payload.headers) || []) {
        const key = String(header.name || "").toLowerCase();
        if (!(key in map)) map[key] = header.value;
    }
    return map;
}

function charsetOf(contentType) {
    const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(String(contentType || ""));
    return match ? match[1] : "utf-8";
}

function decodeBody(part) {
    const data = part && part.body && part.body.data;
    if (!data) return "";
    const headers = headerMap(part);
    return decoderFor(charsetOf(headers["content-type"])).decode(Buffer.from(data, "base64url"));
}

// Depth-first list of every part in the tree (the root counts as the part with partId "").
function flattenParts(payload, out = [], depth = 0) {
    if (!payload || depth > 20) return out;
    out.push(payload);
    for (const child of payload.parts || []) flattenParts(child, out, depth + 1);
    return out;
}

function partToAttachment(part) {
    const headers = headerMap(part);
    const disposition = String(headers["content-disposition"] || "").toLowerCase();
    const contentId = String(headers["content-id"] || "").replace(/[<>\s]/g, "");
    const name = part.filename || decodeHeader((/name\s*=\s*"?([^";]+)"?/i.exec(headers["content-type"] || "") || [])[1] || "");
    return {
        id: `p${String(part.partId).replace(/\./g, "_")}`,
        partId: part.partId,
        name: name || "attachment",
        contentType: String(part.mimeType || "application/octet-stream").toLowerCase(),
        size: (part.body && part.body.size) || 0,
        isInline: disposition.startsWith("inline") || Boolean(contentId && !disposition.startsWith("attachment")),
        contentId,
        gmailAttachmentId: part.body && part.body.attachmentId,
        inlineData: part.body && part.body.data,
        downloadable: Boolean(part.body && (part.body.attachmentId || part.body.data)),
    };
}

// Real attachments are parts that carry a file: a file name, or a body fetched separately (attachmentId) and not a text body.
function attachmentsOf(payload) {
    const out = [];
    for (const part of flattenParts(payload)) {
        if (part === payload && !part.filename) continue;
        if (!part.body || !(part.body.attachmentId || part.filename)) continue;
        if (/^multipart\//i.test(part.mimeType || "")) continue;
        out.push(partToAttachment(part));
    }
    return out;
}

function bodiesOf(payload) {
    const parts = flattenParts(payload).filter((p) => !p.filename && p.body && p.body.data && /^text\/(html|plain)/i.test(p.mimeType || ""));
    const html = parts.filter((p) => /^text\/html/i.test(p.mimeType));
    const plain = parts.filter((p) => /^text\/plain/i.test(p.mimeType));
    return {
        html: html.map(decodeBody).join("<br>"),
        text: plain.map(decodeBody).join("\n"),
    };
}

// Gmail's snippet is HTML-escaped text.
const decodeSnippet = (snippet) => decodeEntities(String(snippet || "")).replace(/\s+/g, " ").trim();

function listFields(message, labelNames = new Map()) {
    const headers = headerMap(message.payload);
    const labelIds = message.labelIds || [];
    const from = parseAddressHeader(headers["from"])[0] || null;
    const contentType = String(headers["content-type"] || "").toLowerCase();
    const internal = Number(message.internalDate);
    return {
        id: message.id,
        conversationId: message.threadId || null,
        subject: decodeHeader(headers["subject"]),
        preview: decodeSnippet(message.snippet),
        from,
        to: parseAddressHeader(headers["to"]),
        receivedAt: Number.isFinite(internal) && internal > 0 ? new Date(internal).toISOString() : null,
        sentAt: null,
        isRead: !labelIds.includes("UNREAD"),
        isDraft: labelIds.includes("DRAFT"),
        // The list is fetched as "metadata" (no MIME tree). multipart/mixed is what mail clients use when a file is attached.
        hasAttachments: contentType.startsWith("multipart/mixed"),
        importance: /^(1|high)/i.test(String(headers["x-priority"] || headers["importance"] || "")) ? "high" : "normal",
        flag: labelIds.includes("STARRED") ? "flagged" : "notFlagged",
        categories: labelIds.map((id) => labelNames.get(id)).filter(Boolean),
        folderId: labelIds.includes("INBOX") ? "INBOX" : labelIds[0] || null,
    };
}

module.exports = { decodeHeader, parseAddressHeader, headerMap, decodeBody, flattenParts, attachmentsOf, bodiesOf, decodeSnippet, listFields, charsetOf };
