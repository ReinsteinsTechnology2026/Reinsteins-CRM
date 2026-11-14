const crypto = require("crypto");

// ==========================================
// SECRET BOX -- AES-256-GCM authenticated encryption for stored OAuth tokens and PKCE verifiers.
//
//   * The key comes ONLY from the environment (MS_EMAIL_TOKEN_KEY, 32 bytes, base64). Missing or malformed key:
//     every call throws -- there is no fallback key and no plaintext fallback.
//   * A fresh random 96-bit IV per encryption; the 128-bit GCM tag authenticates the ciphertext.
//   * Additional authenticated data (AAD) BINDS a ciphertext to the row it belongs to (for example
//     "ms-user:<companyId>:<userId>"). A ciphertext copied into another company's or user's row fails to
//     decrypt, so a database-level mix-up cannot hand one tenant's token to another.
//   * Format: "v1.<iv>.<tag>.<ciphertext>" (base64url). The version prefix lets the key be rotated later.
// ==========================================

const VERSION = "v1";

class SecretBoxError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "SecretBoxError";
        this.code = code;
    }
}

function loadKey(rawKey) {
    if (!rawKey) throw new SecretBoxError("Token encryption key is not configured.", "KEY_MISSING");
    let key;
    try {
        key = Buffer.from(String(rawKey), "base64");
    } catch (_error) {
        throw new SecretBoxError("Token encryption key is malformed.", "KEY_INVALID");
    }
    if (key.length !== 32) throw new SecretBoxError("Token encryption key must be 32 bytes (base64).", "KEY_INVALID");
    return key;
}

const b64u = (buffer) => buffer.toString("base64url");
const fromB64u = (text) => Buffer.from(text, "base64url");

function encrypt(plaintext, aad, rawKey = process.env.MS_EMAIL_TOKEN_KEY) {
    if (typeof plaintext !== "string" || plaintext.length === 0) {
        throw new SecretBoxError("Nothing to encrypt.", "EMPTY");
    }
    const key = loadKey(rawKey);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(String(aad || ""), "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [VERSION, b64u(iv), b64u(cipher.getAuthTag()), b64u(ciphertext)].join(".");
}

function decrypt(payload, aad, rawKey = process.env.MS_EMAIL_TOKEN_KEY) {
    const key = loadKey(rawKey);
    const parts = String(payload || "").split(".");
    if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretBoxError("Unrecognised ciphertext.", "BAD_FORMAT");
    try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, fromB64u(parts[1]));
        decipher.setAAD(Buffer.from(String(aad || ""), "utf8"));
        decipher.setAuthTag(fromB64u(parts[2]));
        return Buffer.concat([decipher.update(fromB64u(parts[3])), decipher.final()]).toString("utf8");
    } catch (_error) {
        // Deliberately generic: never reveal whether the key, the tag or the AAD was wrong.
        throw new SecretBoxError("Could not decrypt the stored value.", "DECRYPT_FAILED");
    }
}

const sha256Hex = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

module.exports = { encrypt, decrypt, sha256Hex, SecretBoxError };
