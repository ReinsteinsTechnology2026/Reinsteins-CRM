const { invalid } = require("./vaultErrors");

// ==========================================
// ZIOVAULT -- request validation
//
// The server cannot read what it stores, so validation is about SHAPE only: strict base64url, exact envelope sizes and the
// envelope version byte, UUID format, bounded sizes, a whitelist for every enumerated value. A request that does not fit is refused
// with a generic message (never echoing what was sent).
// ==========================================

const ENVELOPE_VERSION = 1;
const LIMITS = Object.freeze({
    META_BYTES: 65536,
    SECRET_BYTES: 262144,
    NAME_BYTES: 2048,
    AEAD_ENVELOPE_BYTES: 73, // 1 version + 24 nonce + 32 key + 16 tag
    BOX_MIN_BYTES: 73,
    BOX_MAX_BYTES: 512,
    ITEM_KINDS: ["login", "secure_note", "api_key", "other"],
    COLLECTION_KINDS: ["general", "department", "project"],
    MAX_GRANT_DAYS: 365,
    MAX_ROTATION_INTERVAL_DAYS: 3650,
    MAX_ROTATION_BATCH_ITEMS: 2000,
    MAX_FOLDERS: 200,
    ATTACHMENT_META_BYTES: 4096,
    ATTACHMENT_MIN_BYTES: 41,
    ATTACHMENT_MAX_BYTES: 10489856, // 10 MiB of file + stream header and frame tags (the column's own CHECK)
    MAX_ATTACHMENTS_PER_ITEM: 20,
    MAX_ATTACHMENT_TOTAL_BYTES: 52428800, // 50 MiB per item
    MAX_ATTACHMENT_BYTES_PER_USER: 1073741824, // 1 GiB per person
    AUDIT_PAGE_MAX: 100,
});

const B64URL = /^[A-Za-z0-9_-]*$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function bytes(value, name, { min = 1, max, exact } = {}) {
    if (typeof value !== "string" || !B64URL.test(value)) throw invalid(`${name} is invalid.`);
    const ceiling = exact || max;
    if (value.length > Math.ceil((ceiling * 4) / 3) + 4) throw invalid(`${name} is too large.`);
    const buffer = Buffer.from(value, "base64url");
    if (buffer.toString("base64url") !== value) throw invalid(`${name} is invalid.`); // canonical encoding only
    if (exact !== undefined ? buffer.length !== exact : buffer.length < min || buffer.length > max) throw invalid(`${name} has an invalid size.`);
    return buffer;
}

// An AEAD envelope: [version=1 | nonce | ciphertext+tag]
function aeadEnvelope(value, name, { exact, min = 41, max } = {}) {
    const buffer = exact !== undefined ? bytes(value, name, { exact }) : bytes(value, name, { min, max });
    if (buffer[0] !== ENVELOPE_VERSION) throw invalid(`${name} has an unsupported version.`);
    return buffer;
}

const wrappedKey = (value, name) => aeadEnvelope(value, name, { exact: LIMITS.AEAD_ENVELOPE_BYTES });

// A public-key box: [version=1 | nonce | box]
const boxedKey = (value, name) => aeadEnvelope(value, name, { min: LIMITS.BOX_MIN_BYTES, max: LIMITS.BOX_MAX_BYTES });

function uuid(value, name = "id") {
    if (typeof value !== "string" || !UUID_V4.test(value)) throw invalid(`${name} is invalid.`);
    return value;
}

function oneOf(value, allowed, name) {
    if (typeof value !== "string" || !allowed.includes(value)) throw invalid(`${name} is invalid.`);
    return value;
}

function positiveInteger(value, name) {
    const number = typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : value;
    if (!Number.isInteger(number) || number < 1 || number > 2147483647) throw invalid(`${name} is invalid.`);
    return number;
}

function optionalDays(value, name, max) {
    if (value === undefined || value === null) return null;
    if (!Number.isInteger(value) || value < 1 || value > max) throw invalid(`${name} is invalid.`);
    return value;
}

function boolean(value, name) {
    if (value === undefined) return false;
    if (typeof value !== "boolean") throw invalid(`${name} is invalid.`);
    return value;
}

// Rights: view is implicit (a grant/membership IS the right to see the details).
//   reveal -> may receive the secret key        copy -> needs reveal (UI-level, see the architecture document)
//   edit   -> needs reveal (a new secret is written under the secret key)      share -> may grant (needs the keys)
function rights(input, name = "rights") {
    const source = input === undefined || input === null ? {} : input;
    if (typeof source !== "object" || Array.isArray(source)) throw invalid(`${name} is invalid.`);
    const allowed = ["reveal", "copy", "edit", "share", "manager"];
    for (const key of Object.keys(source)) if (!allowed.includes(key)) throw invalid(`${name} is invalid.`);
    const out = {
        reveal: boolean(source.reveal, name),
        copy: boolean(source.copy, name),
        edit: boolean(source.edit, name),
        share: boolean(source.share, name),
        manager: boolean(source.manager, name),
    };
    if (out.manager) {
        out.reveal = true;
        out.edit = true;
        out.share = true;
    }
    if ((out.copy || out.edit) && !out.reveal) throw invalid("Copying or editing needs the right to reveal.");
    return out;
}

// expiresAt: null/undefined = no expiry; otherwise an ISO-8601 instant. The DATABASE clock decides whether it is in the future.
function expiresAt(value, name = "expiresAt") {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.length > 40) throw invalid(`${name} is invalid.`);
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw invalid(`${name} is invalid.`);
    return date.toISOString();
}

function kdfParams(input) {
    if (!input || typeof input !== "object") throw invalid("kdf is invalid.");
    const { alg, ops, mem } = input;
    if (alg !== "argon2id13") throw invalid("kdf is invalid.");
    if (!Number.isInteger(ops) || ops < 2 || ops > 10) throw invalid("kdf is invalid.");
    if (!Number.isInteger(mem) || mem < 32 * 1024 * 1024 || mem > 256 * 1024 * 1024) throw invalid("kdf is invalid.");
    return { alg, ops, mem, salt: bytes(input.salt, "kdf.salt", { exact: 16 }) };
}

const encode = (buffer) => (buffer === null || buffer === undefined ? null : Buffer.from(buffer).toString("base64url"));

// A timestamp the caller may choose freely (a due date): ISO-8601 with an offset, or null to clear it.
function optionalTimestamp(value, name) {
    if (value === null) return null;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) throw invalid(`${name} is invalid.`);
    return new Date(value).toISOString();
}

module.exports = { optionalTimestamp, LIMITS, ENVELOPE_VERSION, bytes, aeadEnvelope, wrappedKey, boxedKey, uuid, oneOf, positiveInteger, optionalDays, boolean, rights, expiresAt, kdfParams, encode };
