// ==========================================
// EMAIL INPUT VALIDATION -- recipients, ids, folder names, attachments. Pure functions, no I/O.
// ==========================================

class EmailValidationError extends Error {
    constructor(message, code = "EMAIL_VALIDATION") {
        super(message);
        this.name = "EmailValidationError";
        this.code = code;
    }
}

const MAX_RECIPIENTS = 100; // per message, across To + Cc + Bcc
const MAX_SUBJECT_LENGTH = 255;
const MAX_BODY_CHARS = 1_000_000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // per file
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024; // per message (Exchange Online's default message limit is ~35 MB after encoding)
const MAX_ATTACHMENTS = 15;
const SIMPLE_ATTACHMENT_LIMIT = 3 * 1024 * 1024; // Graph: above ~3 MB an upload session is required

// Graph ids (messages, folders, attachments, conversations) are base64url-like. Anything else is rejected before it
// is placed into a Graph URL path.
const GRAPH_ID = /^[A-Za-z0-9_\-=+]{1,512}$/;
const WELL_KNOWN_FOLDERS = ["inbox", "sentitems", "drafts", "deleteditems", "junkemail", "archive"];

// Practical address check (not full RFC 5322): one "@", a dotted domain, no whitespace or control characters.
const ADDRESS = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// Extensions Outlook itself blocks. Sending or receiving them through the CRM would defeat that protection.
const BLOCKED_EXTENSIONS = new Set([
    "ade", "adp", "app", "asp", "bas", "bat", "cer", "chm", "cmd", "cnt", "com", "cpl", "crt", "csh", "der", "diagcab",
    "exe", "fxp", "gadget", "grp", "hlp", "hpj", "hta", "inf", "ins", "isp", "its", "jar", "jnlp", "js", "jse", "ksh",
    "lnk", "mad", "maf", "mag", "mam", "maq", "mar", "mas", "mat", "mau", "mav", "maw", "mcf", "mda", "mdb", "mde",
    "mdt", "mdw", "mdz", "msc", "msh", "msh1", "msh2", "mshxml", "msh1xml", "msh2xml", "msi", "msp", "mst", "msix",
    "ops", "osd", "pcd", "pif", "pl", "plg", "prf", "prg", "printerexport", "ps1", "ps1xml", "ps2", "ps2xml", "psc1",
    "psc2", "psd1", "psdm1", "pst", "py", "pyc", "pyo", "pyw", "pyz", "pyzw", "reg", "scf", "scr", "sct", "shb", "shs",
    "theme", "tmp", "url", "vb", "vbe", "vbp", "vbs", "vhd", "vhdx", "vsmacros", "vsw", "webpnp", "website", "ws",
    "wsc", "wsf", "wsh", "xbap", "xll", "xnk", "dll", "sys", "vxd", "wsh", "appx", "appxbundle",
]);

// Types a browser may show inline from a download endpoint. Never svg / html / xml: they can carry script.
const INLINE_SAFE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);

function assertGraphId(value, label = "id") {
    if (typeof value !== "string" || !GRAPH_ID.test(value)) {
        throw new EmailValidationError(`Invalid ${label}.`, "INVALID_ID");
    }
    return value;
}

// A folder reference is either a Graph id or one of the well-known names Graph understands.
function assertFolderRef(value) {
    if (typeof value === "string" && WELL_KNOWN_FOLDERS.includes(value.toLowerCase())) return value.toLowerCase();
    return assertGraphId(value, "folder");
}

function parseAddress(raw) {
    let address = "";
    let name = "";
    if (typeof raw === "string") {
        address = raw.trim();
    } else if (raw && typeof raw === "object") {
        address = String(raw.address || raw.email || "").trim();
        name = String(raw.name || "").trim();
    }
    // "Jane Doe <jane@acme.com>" is accepted too.
    const angle = /^(.*)<([^<>]+)>\s*$/.exec(address);
    if (angle) {
        name = name || angle[1].replace(/^["'\s]+|["'\s]+$/g, "");
        address = angle[2].trim();
    }
    if (!ADDRESS.test(address) || address.length > 254) {
        throw new EmailValidationError(`"${address.slice(0, 80)}" is not a valid email address.`, "INVALID_RECIPIENT");
    }
    if (/[\r\n]/.test(name)) throw new EmailValidationError("Invalid recipient name.", "INVALID_RECIPIENT");
    return { address, name: name.slice(0, 120) };
}

function parseRecipientList(value, label) {
    if (value == null || value === "") return [];
    const list = Array.isArray(value) ? value : String(value).split(/[;,]\s*/).filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const item of list) {
        const parsed = parseAddress(item);
        const key = parsed.address.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(parsed);
    }
    if (out.length > MAX_RECIPIENTS) throw new EmailValidationError(`Too many recipients in ${label}.`, "TOO_MANY_RECIPIENTS");
    return out;
}

const toGraphRecipient = ({ address, name }) => ({ emailAddress: name ? { address, name } : { address } });

// Validates a compose payload and returns the pieces a Graph draft needs. `requireRecipient` is true when sending.
function validateCompose(input, { requireRecipient }) {
    const to = parseRecipientList(input.to, "To");
    const cc = parseRecipientList(input.cc, "Cc");
    const bcc = parseRecipientList(input.bcc, "Bcc");
    if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
        throw new EmailValidationError("Too many recipients.", "TOO_MANY_RECIPIENTS");
    }
    if (requireRecipient && to.length + cc.length + bcc.length === 0) {
        throw new EmailValidationError("Add at least one recipient.", "NO_RECIPIENT");
    }
    const subject = String(input.subject == null ? "" : input.subject);
    if (/[\r\n]/.test(subject)) throw new EmailValidationError("The subject cannot contain line breaks.", "INVALID_SUBJECT");
    if (subject.length > MAX_SUBJECT_LENGTH) throw new EmailValidationError("The subject is too long.", "INVALID_SUBJECT");
    const body = String(input.body == null ? "" : input.body);
    if (body.length > MAX_BODY_CHARS) throw new EmailValidationError("The message is too large.", "BODY_TOO_LARGE");
    const importance = ["low", "normal", "high"].includes(input.importance) ? input.importance : "normal";
    return { to, cc, bcc, subject, body, importance };
}

// Bidirectional-override characters, used to make a file name's real extension look harmless.
const BIDI_CONTROLS = new RegExp("[" + String.fromCharCode(0x202a) + "-" + String.fromCharCode(0x202e, 0x2066) + "-" + String.fromCharCode(0x2069) + "]", "g");

function sanitizeFileName(raw) {
    let name = String(raw == null ? "" : raw)
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/[\\/:*?"<>|]/g, "_")
        .replace(BIDI_CONTROLS, "")
        .trim()
        .replace(/^\.+/, "");
    if (name.length > 180) {
        const dot = name.lastIndexOf(".");
        const extension = dot > 0 ? name.slice(dot, dot + 12) : "";
        name = name.slice(0, 180 - extension.length) + extension;
    }
    return name || "attachment";
}

function extensionsOf(name) {
    // Every dot-separated tail counts: "invoice.pdf.exe" is an .exe, and "a.exe.txt" is flagged too (conservative).
    return String(name).toLowerCase().split(".").slice(1);
}

function validateAttachment({ name, size, contentType }, { totalSoFar = 0, countSoFar = 0 } = {}) {
    const fileName = sanitizeFileName(name);
    if (!Number.isFinite(size) || size <= 0) throw new EmailValidationError(`"${fileName}" is empty.`, "ATTACHMENT_EMPTY");
    if (countSoFar >= MAX_ATTACHMENTS) throw new EmailValidationError("Too many attachments.", "ATTACHMENT_COUNT");
    if (size > MAX_ATTACHMENT_BYTES) {
        throw new EmailValidationError(`"${fileName}" is larger than ${Math.floor(MAX_ATTACHMENT_BYTES / 1048576)} MB.`, "ATTACHMENT_TOO_LARGE");
    }
    if (totalSoFar + size > MAX_TOTAL_ATTACHMENT_BYTES) {
        throw new EmailValidationError(`Attachments together are larger than ${Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / 1048576)} MB.`, "ATTACHMENT_TOO_LARGE");
    }
    const blocked = extensionsOf(fileName).find((extension) => BLOCKED_EXTENSIONS.has(extension));
    if (blocked) {
        throw new EmailValidationError(`".${blocked}" files cannot be attached (blocked for safety, the same as Outlook).`, "ATTACHMENT_BLOCKED_TYPE");
    }
    const type = String(contentType || "application/octet-stream").toLowerCase().split(";")[0].trim();
    return { name: fileName, size, contentType: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : "application/octet-stream" };
}

// Download headers for an attachment served by the CRM: forced download unless it is a known-safe inline type.
function attachmentDisposition(name, contentType, wantInline) {
    const safeName = sanitizeFileName(name);
    const inline = wantInline && INLINE_SAFE_TYPES.has(String(contentType).toLowerCase());
    const encoded = encodeURIComponent(safeName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return {
        inline,
        disposition: `${inline ? "inline" : "attachment"}; filename="${safeName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_")}"; filename*=UTF-8''${encoded}`,
        contentType: inline ? String(contentType).toLowerCase() : "application/octet-stream",
    };
}

function clampInt(value, { min, max, fallback }) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

module.exports = {
    EmailValidationError,
    MAX_RECIPIENTS,
    MAX_ATTACHMENT_BYTES,
    MAX_TOTAL_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS,
    SIMPLE_ATTACHMENT_LIMIT,
    WELL_KNOWN_FOLDERS,
    BLOCKED_EXTENSIONS,
    assertGraphId,
    assertFolderRef,
    parseAddress,
    parseRecipientList,
    toGraphRecipient,
    validateCompose,
    sanitizeFileName,
    validateAttachment,
    attachmentDisposition,
    clampInt,
};
