// ==========================================
// EMAIL HTML SANITIZER -- allow-list, tokenizer based (no regular-expression rewriting of markup).
//
// Used for (a) incoming message bodies before they reach the browser and (b) the composer's HTML before it is
// sent. It is the FIRST of two layers: the client additionally renders every message in a sandboxed iframe with a
// strict Content-Security-Policy, so a mistake here still cannot run script in the CRM page.
//
// What it does:
//   * walks the input once, character by character, building tags / text / comments;
//   * keeps ONLY the tags and attributes in the allow-lists below; everything else is dropped (the text inside an
//     unknown tag is kept, but script / style / iframe / object / embed / svg / math / form ... lose their content too);
//   * links keep http, https, mailto and tel only, and are rewritten to open in a new tab with rel="noopener noreferrer";
//   * images keep data:image (png, jpeg, gif, webp) and cid: references; remote http(s) images are BLOCKED by default
//     (they are tracking pixels) and are only kept as https when options.allowRemoteImages is true;
//   * inline styles are rebuilt from a short allow-list of properties with value checks (no url(), no expression());
//   * attribute values are entity-decoded before the URL check, so "jav&#x61;script:" cannot slip through;
//   * every output attribute value is re-escaped, stray "<" in text is escaped, and open tags are closed.
// ==========================================

const ALLOWED_TAGS = new Set([
    "a", "abbr", "b", "blockquote", "br", "caption", "center", "code", "col", "colgroup", "dd", "div", "dl", "dt",
    "em", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "s", "small",
    "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);

// Elements whose CONTENT must be removed as well (not just the tag).
const DROP_WITH_CONTENT = new Set([
    "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "template", "svg",
    "math", "head", "title", "form", "textarea", "select", "option", "button", "audio", "video", "canvas", "map",
    "meta", "link", "base", "xml", "o:p", "xmp", "plaintext", "noembed", "noframes",
]);

const VOID_TAGS = new Set(["br", "hr", "img", "col"]);

const GLOBAL_ATTRS = new Set(["dir", "lang", "title"]);
const TAG_ATTRS = {
    a: new Set(["href", "name"]),
    img: new Set(["src", "alt", "width", "height"]),
    td: new Set(["colspan", "rowspan", "align", "valign", "width", "height", "bgcolor"]),
    th: new Set(["colspan", "rowspan", "align", "valign", "width", "height", "bgcolor"]),
    table: new Set(["width", "border", "cellpadding", "cellspacing", "align", "bgcolor"]),
    tr: new Set(["align", "valign", "bgcolor"]),
    font: new Set(["color", "size", "face"]),
    col: new Set(["span", "width"]),
    colgroup: new Set(["span"]),
    ol: new Set(["start", "type"]),
    ul: new Set(["type"]),
    p: new Set(["align"]),
    div: new Set(["align"]),
};

const SAFE_STYLE_PROPS = new Set([
    "color", "background-color", "font-weight", "font-style", "text-decoration", "text-align", "font-size",
    "font-family", "line-height", "margin", "margin-top", "margin-bottom", "margin-left", "padding", "padding-left",
    "border", "border-top", "border-bottom", "border-left", "border-collapse", "width", "max-width", "height",
    "vertical-align", "white-space", "text-indent", "list-style-type", "direction",
]);

const MAX_INPUT_CHARS = 2_000_000;

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", tab: "\t", newline: "\n", colon: ":" };

function decodeEntities(value) {
    return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (match, body) => {
        let codePoint = null;
        if (body[0] === "#") {
            codePoint = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        } else if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body.toLowerCase())) {
            return NAMED_ENTITIES[body.toLowerCase()];
        } else {
            return match;
        }
        if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return "";
        try {
            return String.fromCodePoint(codePoint);
        } catch (_error) {
            return "";
        }
    });
}

const escapeAttr = (value) =>
    String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Text between tags: keep valid entities, escape every bare "<" and ">" and any "&" that does not start an entity.
function cleanText(text) {
    return text
        .replace(/&(?!(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);)/gi, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// Characters browsers ignore inside a URL scheme (controls, spaces, zero-width and line-separator characters, BOM).
const INVISIBLE_CHARS = new RegExp("[\x00-\x20\x7f-\x9f" + String.fromCharCode(0x200b) + "-" + String.fromCharCode(0x200f, 0x2028, 0x2029, 0xfeff) + "]+", "g");

// A URL is judged AFTER decoding entities and removing characters browsers ignore inside a scheme.
function safeUrl(raw, allowedSchemes) {
    const decoded = decodeEntities(raw).replace(INVISIBLE_CHARS, "");
    if (decoded === "") return null;
    const schemeMatch = decoded.match(/^([a-z][a-z0-9+.-]*):/i);
    if (!schemeMatch) {
        // No scheme: a relative URL or a fragment. Relative URLs are meaningless in a mail body; only "#anchor" is kept.
        return decoded.startsWith("#") ? decoded : null;
    }
    return allowedSchemes.includes(schemeMatch[1].toLowerCase()) ? decoded : null;
}

function cleanDataImage(raw) {
    const decoded = decodeEntities(raw).replace(/[\u0000- ]+/g, "");
    return /^data:image\/(png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=]+$/i.test(decoded) ? decoded : null;
}

function cleanStyle(raw) {
    const decoded = decodeEntities(raw);
    const out = [];
    for (const declaration of decoded.split(";")) {
        const index = declaration.indexOf(":");
        if (index === -1) continue;
        const property = declaration.slice(0, index).trim().toLowerCase();
        const value = declaration.slice(index + 1).trim();
        if (!SAFE_STYLE_PROPS.has(property) || value === "" || value.length > 120) continue;
        if (/[\\<>{}"'@]|url\s*\(|expression|javascript|behavior|-moz-binding|import/i.test(value)) continue;
        if (!/^[#a-z0-9 .,%()+\-/!]+$/i.test(value)) continue;
        out.push(`${property}:${value}`);
    }
    return out.join(";");
}

// Parses the inside of a start tag (everything after the tag name, up to ">") into [name, value] pairs.
function parseAttributes(source) {
    const attributes = [];
    let i = 0;
    const length = source.length;
    while (i < length) {
        while (i < length && /[\s/]/.test(source[i])) i += 1;
        if (i >= length) break;
        let name = "";
        while (i < length && !/[\s=/>]/.test(source[i])) {
            name += source[i];
            i += 1;
        }
        // A stray ">" or similar that is not a name: step over it (otherwise the loop would never advance).
        if (name === "" && source[i] !== "=") {
            i += 1;
            continue;
        }
        while (i < length && /\s/.test(source[i])) i += 1;
        let value = "";
        if (source[i] === "=") {
            i += 1;
            while (i < length && /\s/.test(source[i])) i += 1;
            const quote = source[i];
            if (quote === '"' || quote === "'") {
                i += 1;
                const end = source.indexOf(quote, i);
                const stop = end === -1 ? length : end;
                value = source.slice(i, stop);
                i = stop + 1;
            } else {
                while (i < length && !/\s/.test(source[i])) {
                    value += source[i];
                    i += 1;
                }
            }
        }
        if (name) attributes.push([name.toLowerCase(), value]);
    }
    return attributes;
}

// Finds the ">" that ends a tag, ignoring any ">" inside a quoted attribute value.
function findTagEnd(html, from) {
    let quote = null;
    for (let i = from; i < html.length; i += 1) {
        const ch = html[i];
        if (quote) {
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === ">") {
            return i;
        }
    }
    return -1;
}

function buildAllowedAttributes(tag, attributes, options) {
    const allowed = TAG_ATTRS[tag] || new Set();
    const seen = new Set();
    let out = "";
    let blockedRemoteImage = false;

    for (const [name, value] of attributes) {
        if (seen.has(name)) continue;

        if (name === "style") {
            const style = cleanStyle(value);
            if (style) {
                out += ` style="${escapeAttr(style)}"`;
                seen.add(name);
            }
            continue;
        }
        if (!GLOBAL_ATTRS.has(name) && !allowed.has(name)) continue;

        if (tag === "a" && name === "href") {
            const url = safeUrl(value, ["http", "https", "mailto", "tel"]);
            if (url) {
                out += ` href="${escapeAttr(url)}"`;
                seen.add(name);
            }
            continue;
        }
        if (tag === "img" && name === "src") {
            const data = cleanDataImage(value);
            const cid = safeUrl(value, ["cid"]);
            const remote = options.allowRemoteImages ? safeUrl(value, ["https"]) : null;
            const chosen = data || cid || remote;
            if (chosen) {
                out += ` src="${escapeAttr(chosen)}"`;
                seen.add(name);
            } else if (safeUrl(value, ["http", "https"])) {
                blockedRemoteImage = true;
            }
            continue;
        }
        if (name === "name" && tag === "a") {
            if (/^[\w.:-]{1,64}$/.test(value)) {
                out += ` name="${escapeAttr(value)}"`;
                seen.add(name);
            }
            continue;
        }
        // Remaining allowed attributes carry plain values only: letters, digits and a few punctuation marks.
        const plain = decodeEntities(value);
        if (plain.length <= 100 && /^[#\w .,%/-]*$/.test(plain)) {
            out += ` ${name}="${escapeAttr(plain)}"`;
            seen.add(name);
        }
    }

    if (tag === "a") out += ' target="_blank" rel="noopener noreferrer nofollow"';
    if (tag === "img" && blockedRemoteImage) out += ' data-remote-blocked="1"';
    return { attributes: out, blockedRemoteImage };
}

/**
 * @returns {{ html: string, blockedRemoteImages: number, truncated: boolean }}
 */
function sanitizeEmailHtml(input, options = {}) {
    let html = typeof input === "string" ? input : "";
    let truncated = false;
    if (html.length > MAX_INPUT_CHARS) {
        html = html.slice(0, MAX_INPUT_CHARS);
        truncated = true;
    }

    let output = "";
    let blockedRemoteImages = 0;
    const stack = [];
    let skipUntil = null; // name of a DROP_WITH_CONTENT element whose content is being skipped
    let i = 0;

    while (i < html.length) {
        const lt = html.indexOf("<", i);
        if (lt === -1) {
            if (!skipUntil) output += cleanText(html.slice(i));
            break;
        }
        if (lt > i && !skipUntil) output += cleanText(html.slice(i, lt));

        // Comments, CDATA, doctype, processing instructions: dropped whole (this also removes conditional comments).
        if (html.startsWith("<!--", lt)) {
            const end = html.indexOf("-->", lt + 4);
            i = end === -1 ? html.length : end + 3;
            continue;
        }
        if (html[lt + 1] === "!" || html[lt + 1] === "?") {
            const end = html.indexOf(">", lt + 2);
            i = end === -1 ? html.length : end + 1;
            continue;
        }

        const isEnd = html[lt + 1] === "/";
        const nameStart = lt + (isEnd ? 2 : 1);
        const nameMatch = /^[a-zA-Z][a-zA-Z0-9:_-]*/.exec(html.slice(nameStart, nameStart + 40));
        if (!nameMatch) {
            // A lone "<" that does not begin a tag: literal text.
            if (!skipUntil) output += "&lt;";
            i = lt + 1;
            continue;
        }

        const tag = nameMatch[0].toLowerCase();
        const tagEnd = findTagEnd(html, nameStart + nameMatch[0].length);
        if (tagEnd === -1) {
            // Unterminated tag: drop the rest rather than guess.
            break;
        }
        const inner = html.slice(nameStart + nameMatch[0].length, tagEnd);
        i = tagEnd + 1;

        if (skipUntil) {
            if (isEnd && tag === skipUntil) skipUntil = null;
            continue;
        }

        if (isEnd) {
            const index = stack.lastIndexOf(tag);
            if (index !== -1) {
                while (stack.length > index) output += `</${stack.pop()}>`;
            }
            continue;
        }

        if (DROP_WITH_CONTENT.has(tag)) {
            if (!/\/\s*$/.test(inner)) skipUntil = tag;
            continue;
        }
        if (!ALLOWED_TAGS.has(tag)) continue; // unknown tag: tag dropped, its text kept

        const built = buildAllowedAttributes(tag, parseAttributes(inner), options);
        if (built.blockedRemoteImage) blockedRemoteImages += 1;
        if (tag === "img" && !/ src="/.test(built.attributes)) continue; // an image with no allowed source is dropped

        output += `<${tag}${built.attributes}>`;
        if (!VOID_TAGS.has(tag)) stack.push(tag);
        if (stack.length > 200) {
            // Pathological nesting: stop here instead of building an enormous tree.
            truncated = true;
            break;
        }
    }

    while (stack.length) output += `</${stack.pop()}>`;
    return { html: output, blockedRemoteImages, truncated };
}

// Plain text from sanitized or raw HTML, for previews and the text/plain fallback.
function htmlToText(html) {
    return decodeEntities(
        String(html || "")
            .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
            .replace(/<[^>]*>/g, "")
    )
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// A plain-text body shown as HTML: escaped, with line breaks preserved. Links are not auto-created.
function textToHtml(text) {
    const escaped = String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<div style="white-space:pre-wrap">${escaped}</div>`;
}

module.exports = { sanitizeEmailHtml, htmlToText, textToHtml, decodeEntities, safeUrl };
