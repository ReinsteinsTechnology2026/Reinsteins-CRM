// ZioVault cryptography -- security tests for client/src/vault/crypto (the code that ships to the browser).
//
// This is NOT a CRUD test. It checks: independent re-computation of the primitives (a from-scratch HChaCha20 + Node's OpenSSL
// ChaCha20-Poly1305 against libsodium's XChaCha20-Poly1305; Node's OpenSSL Argon2id against libsodium's), tamper and
// substitution resistance, domain separation (tenant / user / item / purpose / key version), nonce behaviour, the key
// hierarchy (what the server receives), recovery, sharing and the attachment stream.
// Run: node --test _test_ziovault_crypto.js

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const CRYPTO_DIR = path.join(__dirname, "..", "client", "src", "vault", "crypto");
const load = () => import(pathToFileURL(path.join(CRYPTO_DIR, "index.js")).href);

// Smallest parameters the client accepts (keeps the suite fast); the default (64 MiB, 3 passes) is exercised once below.
const FAST = { alg: "argon2id13", ops: 2, mem: 32 * 1024 * 1024 };
const PASSWORD = "correct horse battery staple";
const T = 7; // tenant id
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const flip = (bytes, index) => {
    const copy = new Uint8Array(bytes);
    copy[index] ^= 0x01;
    return copy;
};
const rejects = (promise, name = "VaultCryptoError") => assert.rejects(promise, (error) => error.name === name || error.constructor.name === name);

// ---------------------------------------------------------------------------------------------- independent implementations

// HChaCha20 (draft-irtf-cfrg-xchacha-03 section 2.2) written from the specification, not taken from libsodium.
const rotl = (v, c) => ((v << c) | (v >>> (32 - c))) >>> 0;
function quarter(s, a, b, c, d) {
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
}
function hchacha20(key, nonce16) {
    const s = new Uint32Array(16);
    s.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574], 0);
    const kv = new DataView(new Uint8Array(key).buffer);
    const nv = new DataView(new Uint8Array(nonce16).buffer);
    for (let i = 0; i < 8; i += 1) s[4 + i] = kv.getUint32(i * 4, true);
    for (let i = 0; i < 4; i += 1) s[12 + i] = nv.getUint32(i * 4, true);
    for (let i = 0; i < 10; i += 1) {
        quarter(s, 0, 4, 8, 12); quarter(s, 1, 5, 9, 13); quarter(s, 2, 6, 10, 14); quarter(s, 3, 7, 11, 15);
        quarter(s, 0, 5, 10, 15); quarter(s, 1, 6, 11, 12); quarter(s, 2, 7, 8, 13); quarter(s, 3, 4, 9, 14);
    }
    const out = Buffer.alloc(32);
    [0, 1, 2, 3, 12, 13, 14, 15].forEach((word, i) => out.writeUInt32LE(s[word], i * 4));
    return out;
}
// XChaCha20-Poly1305 = ChaCha20-Poly1305 (OpenSSL, 96-bit nonce) under an HChaCha20 subkey.
function xchachaSeal(key, nonce24, aad, plaintext) {
    const subkey = hchacha20(key, nonce24.subarray(0, 16));
    const nonce12 = Buffer.concat([Buffer.alloc(4), Buffer.from(nonce24.subarray(16))]);
    const cipher = crypto.createCipheriv("chacha20-poly1305", subkey, nonce12, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([body, cipher.getAuthTag()]);
}

test("independent check: HChaCha20 matches the published test vector (so the reference implementation below is trustworthy)", () => {
    const key = Buffer.from([...Array(32).keys()]);
    const nonce = Buffer.from("000000090000004a0000000031415927", "hex");
    assert.equal(hchacha20(key, nonce).toString("hex"), "82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc");
});

test("independent check: libsodium's XChaCha20-Poly1305 equals HChaCha20 + OpenSSL ChaCha20-Poly1305 on the published vector and on random inputs", async () => {
    const { getSodium } = await load();
    const sodium = await getSodium();
    // draft-irtf-cfrg-xchacha-03 appendix A.3.1
    const key = Buffer.from("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f", "hex");
    const nonce = Buffer.from("404142434445464748494a4b4c4d4e4f5051525354555657", "hex");
    const aad = Buffer.from("50515253c0c1c2c3c4c5c6c7", "hex");
    const plaintext = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
    const reference = xchachaSeal(key, nonce, aad, plaintext);
    const libsodium = Buffer.from(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key));
    assert.equal(libsodium.toString("hex"), reference.toString("hex"), "libsodium == independent implementation");
    assert.equal(reference.subarray(-16).toString("hex"), "c0875924c1c7987947deafd8780acf49", "tag matches the published vector");
    for (let i = 0; i < 25; i += 1) {
        const k = crypto.randomBytes(32);
        const n = crypto.randomBytes(24);
        const a = crypto.randomBytes(i * 3);
        const p = crypto.randomBytes(i * 41);
        assert.equal(Buffer.from(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(p, a, null, n, k)).toString("hex"), xchachaSeal(k, n, a, p).toString("hex"));
    }
});

test("independent check: libsodium's Argon2id equals Node's OpenSSL Argon2id for the parameters ZioVault uses", async () => {
    const { deriveMasterKey } = await load();
    assert.equal(typeof crypto.argon2Sync, "function", "this Node build has no crypto.argon2Sync (CI uses Node 24)");
    for (const params of [FAST, { alg: "argon2id13", ops: 3, mem: 64 * 1024 * 1024 }]) {
        const salt = crypto.randomBytes(16);
        const ours = await deriveMasterKey(PASSWORD, salt, params);
        const reference = crypto.argon2Sync("argon2id", { message: Buffer.from(PASSWORD.normalize("NFKC")), nonce: salt, parallelism: 1, tagLength: 32, memory: params.mem / 1024, passes: params.ops });
        assert.equal(Buffer.from(ours).toString("hex"), reference.toString("hex"), `ops=${params.ops} mem=${params.mem / 1048576}MiB`);
    }
});

// ---------------------------------------------------------------------------------------------- AEAD

test("AEAD: round trip, envelope layout (version | 24-byte nonce | ciphertext+tag), no plaintext in the output", async () => {
    const { encryptBytes, decryptBytes, randomKey, buildAad, ENVELOPE_VERSION } = await load();
    const key = await randomKey();
    const aad = buildAad("item-secret", [T, "u1", 1]);
    const message = Buffer.from("hunter2-very-secret-password");
    const envelope = await encryptBytes(key, message, aad);
    assert.equal(envelope[0], ENVELOPE_VERSION);
    assert.equal(envelope.length, 1 + 24 + message.length + 16);
    assert.equal(Buffer.from(envelope).includes(message), false);
    assert.ok(same(await decryptBytes(key, envelope, aad), message));
});

test("NONCES: 20,000 encryptions of the same plaintext under the same key never repeat a nonce or a ciphertext", async () => {
    const { encryptBytes, randomKey, buildAad } = await load();
    const key = await randomKey();
    const aad = buildAad("item-secret", [T, "u1", 1]);
    const nonces = new Set();
    const ciphertexts = new Set();
    for (let i = 0; i < 20000; i += 1) {
        const envelope = await encryptBytes(key, new Uint8Array(16), aad);
        nonces.add(Buffer.from(envelope.subarray(1, 25)).toString("hex"));
        ciphertexts.add(Buffer.from(envelope.subarray(25)).toString("hex"));
    }
    assert.equal(nonces.size, 20000);
    assert.equal(ciphertexts.size, 20000);
});

test("TAMPERING: a change to ANY byte of an envelope (version, nonce, ciphertext, tag), truncation or extension is rejected", async () => {
    const { encryptBytes, decryptBytes, randomKey, buildAad } = await load();
    const key = await randomKey();
    const aad = buildAad("item-secret", [T, "u1", 1]);
    const envelope = await encryptBytes(key, Buffer.from("a secret of some length"), aad);
    for (let index = 0; index < envelope.length; index += 1) await rejects(decryptBytes(key, flip(envelope, index), aad));
    await rejects(decryptBytes(key, envelope.slice(0, envelope.length - 1), aad));
    await rejects(decryptBytes(key, envelope.slice(1), aad));
    await rejects(decryptBytes(key, new Uint8Array([...envelope, 0]), aad));
    await rejects(decryptBytes(key, new Uint8Array(0), aad));
    const unknownVersion = new Uint8Array(envelope);
    unknownVersion[0] = 2;
    await rejects(decryptBytes(key, unknownVersion, aad));
});

test("DOMAIN SEPARATION: a ciphertext cannot be opened under another tenant, item, purpose or key version, nor with another key", async () => {
    const { encryptBytes, decryptBytes, randomKey, buildAad } = await load();
    const key = await randomKey();
    const envelope = await encryptBytes(key, Buffer.from("secret"), buildAad("item-secret", [T, "item-1", 1]));
    assert.ok(await decryptBytes(key, envelope, buildAad("item-secret", [T, "item-1", 1])));
    await rejects(decryptBytes(key, envelope, buildAad("item-secret", [T + 1, "item-1", 1])), "VaultCryptoError"); // another tenant
    await rejects(decryptBytes(key, envelope, buildAad("item-secret", [T, "item-2", 1]))); // another item
    await rejects(decryptBytes(key, envelope, buildAad("item-meta", [T, "item-1", 1]))); // another purpose
    await rejects(decryptBytes(key, envelope, buildAad("item-secret", [T, "item-1", 2]))); // another key version
    await rejects(decryptBytes(await randomKey(), envelope, buildAad("item-secret", [T, "item-1", 1]))); // another key
});

test("AAD framing is unambiguous and unknown purposes are refused", async () => {
    const { buildAad, frameFields, unframeFields } = await load();
    assert.notDeepEqual([...buildAad("item-meta", ["ab", "c"])], [...buildAad("item-meta", ["a", "bc"])]);
    assert.throws(() => buildAad("made-up-purpose", [T]), /Unknown ZioVault purpose/);
    assert.throws(() => buildAad("item-meta", [""]), /must not be empty/);
    const framed = frameFields(["x", "yy", "zzz"]);
    const { fields, rest } = unframeFields(framed, 3);
    assert.deepEqual(fields.map((f) => Buffer.from(f).toString()), ["x", "yy", "zzz"]);
    assert.equal(rest.length, 0);
    assert.throws(() => unframeFields(framed.slice(0, 6), 3), /Malformed/);
});

test("keys must be exactly 32 bytes; wrapping rejects anything else", async () => {
    const { encryptBytes, wrapKey, randomKey, buildAad } = await load();
    await rejects(encryptBytes(new Uint8Array(16), new Uint8Array(1), buildAad("item-meta", [T])));
    await rejects(wrapKey(await randomKey(), new Uint8Array(31), "item-meta-key", [T]));
});

// ---------------------------------------------------------------------------------------------- the account and key hierarchy

test("ACCOUNT: setup then unlock reproduces the same vault key and key pair; a wrong password fails locally", async () => {
    const { createAccount, unlockAccount } = await load();
    const account = await createAccount({ password: PASSWORD, tenantId: T, userId: 3, kdf: FAST });
    const opened = await unlockAccount({ password: PASSWORD, server: account.server, tenantId: T, userId: 3 });
    assert.ok(same(opened.vaultKey, account.session.vaultKey));
    assert.ok(same(opened.privateKey, account.session.privateKey));
    assert.ok(same(opened.publicKey, account.server.publicKey));
    await rejects(unlockAccount({ password: "not the right password", server: account.server, tenantId: T, userId: 3 }));
    await rejects(unlockAccount({ password: PASSWORD + " ", server: account.server, tenantId: T, userId: 3 }));
});

test("ZERO KNOWLEDGE: the material meant for the server contains none of the secrets (password, master key, vault key, private key, recovery secret)", async () => {
    const { createAccount, getSodium, deriveMasterKey, deriveSubkey, KDF_CONTEXTS } = await load();
    void KDF_CONTEXTS;
    const sodium = await getSodium();
    const account = await createAccount({ password: PASSWORD, tenantId: T, userId: 3, kdf: FAST });
    const wire = Buffer.concat([
        Buffer.from(JSON.stringify({ alg: account.server.kdf.alg, ops: account.server.kdf.ops, mem: account.server.kdf.mem })),
        Buffer.from(account.server.kdf.salt),
        Buffer.from(account.server.vaultKeyEnvelope),
        Buffer.from(account.server.privateKeyEnvelope),
        Buffer.from(account.server.recoveryEnvelope),
        Buffer.from(account.server.publicKey),
    ]);
    const masterKey = await deriveMasterKey(PASSWORD, account.server.kdf.salt, FAST);
    const kek = await deriveSubkey(masterKey, "ZVKEK001");
    const forbidden = {
        "master password": Buffer.from(PASSWORD),
        "master key": Buffer.from(masterKey),
        "key-encryption key": Buffer.from(kek),
        "vault key": Buffer.from(account.session.vaultKey),
        "private key": Buffer.from(account.session.privateKey),
        "recovery secret (text)": Buffer.from(account.recoverySecretText.replace(/-/g, "")),
    };
    for (const [name, bytes] of Object.entries(forbidden)) assert.equal(wire.includes(bytes), false, `${name} must not appear in what the server receives`);
    assert.deepEqual(Object.keys(account.server).sort(), ["kdf", "privateKeyEnvelope", "publicKey", "recoveryEnvelope", "vaultKeyEnvelope"], "exactly these fields leave the browser");
    void sodium;
});

test("ACCOUNT envelopes are bound to the tenant and the user: unlocking under another identity, or with swapped envelopes, fails", async () => {
    const { createAccount, unlockAccount } = await load();
    const a = await createAccount({ password: PASSWORD, tenantId: T, userId: 3, kdf: FAST });
    const b = await createAccount({ password: PASSWORD, tenantId: T, userId: 4, kdf: FAST });
    await rejects(unlockAccount({ password: PASSWORD, server: a.server, tenantId: T + 1, userId: 3 })); // other tenant
    await rejects(unlockAccount({ password: PASSWORD, server: a.server, tenantId: T, userId: 4 })); // other user
    // same password, but the server hands user 3 user 4's private-key envelope: refused
    await rejects(unlockAccount({ password: PASSWORD, server: { ...a.server, privateKeyEnvelope: b.server.privateKeyEnvelope }, tenantId: T, userId: 3 }));
    assert.notDeepEqual([...a.server.kdf.salt], [...b.server.kdf.salt], "every account has its own random salt");
    assert.notDeepEqual([...a.server.vaultKeyEnvelope], [...b.server.vaultKeyEnvelope]);
});

test("KEY SUBSTITUTION: if the server swaps the stored public key, unlock detects that it does not match the private key", async () => {
    const { createAccount, unlockAccount, generateKeyPair } = await load();
    const a = await createAccount({ password: PASSWORD, tenantId: T, userId: 3, kdf: FAST });
    const stranger = await generateKeyPair();
    await rejects(unlockAccount({ password: PASSWORD, server: { ...a.server, publicKey: stranger.publicKey }, tenantId: T, userId: 3 }));
});

test("KDF policy: weak or abusive parameters and weak master passwords are refused", async () => {
    const { createAccount, unlockAccount, validateKdfParams, checkMasterPassword, DEFAULT_KDF } = await load();
    for (const bad of [{ ...FAST, ops: 1 }, { ...FAST, mem: 8 * 1024 * 1024 }, { ...FAST, ops: 11 }, { ...FAST, mem: 512 * 1024 * 1024 }, { ...FAST, alg: "argon2i" }, { ...FAST, ops: 2.5 }, null]) {
        assert.throws(() => validateKdfParams(bad), /Unsupported key-derivation parameters/);
    }
    assert.doesNotThrow(() => validateKdfParams(DEFAULT_KDF));
    await rejects(createAccount({ password: "short1", tenantId: T, userId: 3, kdf: FAST }));
    await rejects(createAccount({ password: "aaaaaaaaaaaaaaaa", tenantId: T, userId: 3, kdf: FAST }));
    await rejects(createAccount({ password: PASSWORD, tenantId: T, userId: 3, kdf: { ...FAST, ops: 1 } }));
    assert.equal(checkMasterPassword("correct horse battery").ok, true);
    // a server that tries to downgrade the parameters used at unlock is refused before any derivation
    const a = await createAccount({ password: PASSWORD, tenantId: T, userId: 3, kdf: FAST });
    await rejects(unlockAccount({ password: PASSWORD, server: { ...a.server, kdf: { ...a.server.kdf, ops: 1 } }, tenantId: T, userId: 3 }));
});

test("DEFAULT parameters (Argon2id, 64 MiB, 3 passes): setup + unlock round trip and timing", async () => {
    const { createAccount, unlockAccount, DEFAULT_KDF } = await load();
    assert.deepEqual({ ...DEFAULT_KDF }, { alg: "argon2id13", ops: 3, mem: 64 * 1024 * 1024 });
    const started = process.hrtime.bigint();
    const account = await createAccount({ password: PASSWORD, tenantId: T, userId: 3 });
    const setupMs = Number((process.hrtime.bigint() - started) / 1000000n);
    const unlockStarted = process.hrtime.bigint();
    const opened = await unlockAccount({ password: PASSWORD, server: account.server, tenantId: T, userId: 3 });
    const unlockMs = Number((process.hrtime.bigint() - unlockStarted) / 1000000n);
    assert.ok(same(opened.vaultKey, account.session.vaultKey));
    console.log(`  [timing] default Argon2id parameters: setup ${setupMs} ms, unlock ${unlockMs} ms (Node ${process.version})`);
    assert.ok(unlockMs < 5000, `unlock took ${unlockMs} ms`);
});

test("CHANGE PASSWORD: the vault key is re-wrapped (old password stops working, items still decrypt, no item is re-encrypted)", async () => {
    const { createAccount, unlockAccount, changeMasterPassword, newItemKeys, encryptItem, decryptItemSecret, wrapItemKeysForOwner, unwrapItemKeysForOwner } = await load();
    const account = await createAccount({ password: PASSWORD, tenantId: T, userId: 3, kdf: FAST });
    const keys = await newItemKeys();
    const item = await encryptItem({ tenantId: T, itemUid: "i1", keys, meta: { title: "t" }, secret: { password: "p4ss" } });
    const wrapped = await wrapItemKeysForOwner({ tenantId: T, itemUid: "i1", ownerUserId: 3, vaultKey: account.session.vaultKey, keys });

    const updated = await changeMasterPassword({ session: account.session, newPassword: "a brand new long passphrase", tenantId: T, userId: 3, kdf: FAST, server: account.server });
    await rejects(unlockAccount({ password: PASSWORD, server: updated, tenantId: T, userId: 3 }));
    const reopened = await unlockAccount({ password: "a brand new long passphrase", server: updated, tenantId: T, userId: 3 });
    const unwrapped = await unwrapItemKeysForOwner({ tenantId: T, itemUid: "i1", ownerUserId: 3, vaultKey: reopened.vaultKey, ...wrapped });
    assert.deepEqual(await decryptItemSecret({ tenantId: T, itemUid: "i1", secretKey: unwrapped.secretKey, secretCiphertext: item.secretCiphertext }), { password: "p4ss" });
    await rejects(changeMasterPassword({ session: account.session, newPassword: "short", tenantId: T, userId: 3, kdf: FAST, server: account.server }));
});

test("RECOVERY: the recovery secret restores access under a NEW password; typos, wrong secrets and other users' secrets do not", async () => {
    const { createAccount, unlockAccount, recoverAccount, rotateRecoverySecret, parseRecoverySecret } = await load();
    const account = await createAccount({ password: PASSWORD, tenantId: T, userId: 3, kdf: FAST });
    const other = await createAccount({ password: PASSWORD, tenantId: T, userId: 4, kdf: FAST });
    assert.match(account.recoverySecretText, /^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/, "14 groups of 4 Crockford Base32 characters");

    const recovered = await recoverAccount({ recoverySecretText: account.recoverySecretText.toLowerCase().replace(/-/g, " "), newPassword: "recovered into a new password", server: account.server, tenantId: T, userId: 3, kdf: FAST });
    assert.ok(same(recovered.session.vaultKey, account.session.vaultKey), "the SAME vault key: nothing is lost");
    await rejects(unlockAccount({ password: PASSWORD, server: recovered.server, tenantId: T, userId: 3 }));
    assert.ok(await unlockAccount({ password: "recovered into a new password", server: recovered.server, tenantId: T, userId: 3 }));

    const typo = account.recoverySecretText.replace(/^./, (c) => (c === "2" ? "3" : "2"));
    await rejects(recoverAccount({ recoverySecretText: typo, newPassword: "recovered into a new password", server: account.server, tenantId: T, userId: 3, kdf: FAST }));
    await rejects(recoverAccount({ recoverySecretText: other.recoverySecretText, newPassword: "recovered into a new password", server: account.server, tenantId: T, userId: 3, kdf: FAST }));
    await rejects(recoverAccount({ recoverySecretText: "", newPassword: "recovered into a new password", server: account.server, tenantId: T, userId: 3, kdf: FAST }));
    await rejects(parseRecoverySecret("ZZZZ-ZZZZ"));

    // rotating the recovery secret invalidates the old one once the new envelope is stored
    const rotated = await rotateRecoverySecret({ session: account.session, tenantId: T, userId: 3 });
    const newServer = { ...account.server, recoveryEnvelope: rotated.recoveryEnvelope };
    await rejects(recoverAccount({ recoverySecretText: account.recoverySecretText, newPassword: "recovered into a new password", server: newServer, tenantId: T, userId: 3, kdf: FAST }));
    assert.ok(await recoverAccount({ recoverySecretText: rotated.recoverySecretText, newPassword: "recovered into a new password", server: newServer, tenantId: T, userId: 3, kdf: FAST }));
});

test("RECOVERY SECRET: 256 random bits, checksum, tolerant parsing, and no repeats", async () => {
    const { generateRecoverySecret, parseRecoverySecret } = await load();
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
        const secret = await generateRecoverySecret();
        assert.equal(secret.bytes.length, 32);
        assert.ok(same(await parseRecoverySecret(secret.text), secret.bytes));
        seen.add(secret.text);
    }
    assert.equal(seen.size, 200);
    const one = await generateRecoverySecret();
    assert.ok(same(await parseRecoverySecret(` ${one.text.toLowerCase()} `), one.bytes), "case and surrounding spaces are tolerated");
    await rejects(parseRecoverySecret(one.text.slice(0, -1)));
    await rejects(parseRecoverySecret(one.text.replace(/.$/, (c) => (c === "A" ? "B" : "A"))));
});

test("lockSession overwrites the key bytes held by the session (best effort)", async () => {
    const { createAccount, lockSession } = await load();
    const account = await createAccount({ password: PASSWORD, tenantId: T, userId: 3, kdf: FAST });
    lockSession(account.session);
    assert.ok(account.session.vaultKey.every((byte) => byte === 0));
    assert.ok(account.session.privateKey.every((byte) => byte === 0));
});

// ---------------------------------------------------------------------------------------------- items and sharing

test("ITEMS: metadata and secret use different keys; the meta key cannot read the secret", async () => {
    const { newItemKeys, encryptItem, decryptItemMeta, decryptItemSecret } = await load();
    const keys = await newItemKeys();
    assert.notDeepEqual([...keys.metaKey], [...keys.secretKey]);
    const item = await encryptItem({ tenantId: T, itemUid: "i1", keys, meta: { title: "AWS root", username: "ops@acme.test" }, secret: { password: "Tr0ub4dor&3", notes: "recovery codes" } });
    assert.deepEqual(await decryptItemMeta({ tenantId: T, itemUid: "i1", metaKey: keys.metaKey, metaCiphertext: item.metaCiphertext }), { title: "AWS root", username: "ops@acme.test" });
    await rejects(decryptItemSecret({ tenantId: T, itemUid: "i1", secretKey: keys.metaKey, secretCiphertext: item.secretCiphertext }));
    assert.equal(Buffer.from(item.secretCiphertext).includes(Buffer.from("Tr0ub4dor")), false);
    assert.equal(Buffer.from(item.metaCiphertext).includes(Buffer.from("AWS root")), false, "titles and usernames are encrypted too");
});

test("ITEMS: a ciphertext moved to another item, tenant or key version is rejected (server cannot transplant)", async () => {
    const { newItemKeys, encryptItem, decryptItemSecret, rotateItem } = await load();
    const keys = await newItemKeys();
    const item = await encryptItem({ tenantId: T, itemUid: "i1", keys, meta: {}, secret: { password: "p" } });
    const open = (over) => decryptItemSecret({ tenantId: T, itemUid: "i1", keyVersion: 1, secretKey: keys.secretKey, secretCiphertext: item.secretCiphertext, ...over });
    assert.deepEqual(await open({}), { password: "p" });
    await rejects(open({ itemUid: "i2" }));
    await rejects(open({ tenantId: T + 1 }));
    await rejects(open({ keyVersion: 2 }));

    const rotated = await rotateItem({ tenantId: T, itemUid: "i1", keyVersion: 1, meta: {}, secret: { password: "p2" } });
    assert.equal(rotated.keyVersion, 2);
    assert.notDeepEqual([...rotated.keys.secretKey], [...keys.secretKey], "rotation uses brand-new keys");
    await rejects(decryptItemSecret({ tenantId: T, itemUid: "i1", keyVersion: 2, secretKey: rotated.keys.secretKey, secretCiphertext: item.secretCiphertext }), "VaultCryptoError");
    await rejects(decryptItemSecret({ tenantId: T, itemUid: "i1", keyVersion: 1, secretKey: keys.secretKey, secretCiphertext: rotated.secretCiphertext }));
});

test("OWNER wrapping: keys unwrap only under the owner's vault key, for that item, tenant and owner", async () => {
    const { createAccount, newItemKeys, wrapItemKeysForOwner, unwrapItemKeysForOwner } = await load();
    const owner = await createAccount({ password: PASSWORD, tenantId: T, userId: 3, kdf: FAST });
    const other = await createAccount({ password: PASSWORD, tenantId: T, userId: 4, kdf: FAST });
    const keys = await newItemKeys();
    const wrapped = await wrapItemKeysForOwner({ tenantId: T, itemUid: "i1", ownerUserId: 3, vaultKey: owner.session.vaultKey, keys });
    const ok = await unwrapItemKeysForOwner({ tenantId: T, itemUid: "i1", ownerUserId: 3, vaultKey: owner.session.vaultKey, ...wrapped });
    assert.ok(same(ok.metaKey, keys.metaKey) && same(ok.secretKey, keys.secretKey));
    await rejects(unwrapItemKeysForOwner({ tenantId: T, itemUid: "i1", ownerUserId: 3, vaultKey: other.session.vaultKey, ...wrapped }));
    await rejects(unwrapItemKeysForOwner({ tenantId: T, itemUid: "i2", ownerUserId: 3, vaultKey: owner.session.vaultKey, ...wrapped }));
    await rejects(unwrapItemKeysForOwner({ tenantId: T + 1, itemUid: "i1", ownerUserId: 3, vaultKey: owner.session.vaultKey, ...wrapped }));
    await rejects(unwrapItemKeysForOwner({ tenantId: T, itemUid: "i1", ownerUserId: 4, vaultKey: owner.session.vaultKey, ...wrapped }));
});

test("SHARING: only the intended recipient opens the keys; a viewer receives the meta key only and cannot read the secret", async () => {
    const { createAccount, newItemKeys, encryptItem, decryptItemMeta, decryptItemSecret, wrapItemKeysForRecipient, openItemKeysFromSender } = await load();
    const alice = await createAccount({ password: PASSWORD, tenantId: T, userId: 3, kdf: FAST });
    const bob = await createAccount({ password: PASSWORD, tenantId: T, userId: 4, kdf: FAST });
    const carol = await createAccount({ password: PASSWORD, tenantId: T, userId: 5, kdf: FAST });
    const keys = await newItemKeys();
    const item = await encryptItem({ tenantId: T, itemUid: "i1", keys, meta: { title: "Shared login", username: "svc" }, secret: { password: "s3cret" } });

    // Bob may VIEW only
    const forBob = await wrapItemKeysForRecipient({ tenantId: T, itemUid: "i1", recipientUserId: 4, recipientPublicKey: bob.session.publicKey, senderPrivateKey: alice.session.privateKey, keys, include: { meta: true, secret: false } });
    assert.equal(forBob.boxedSecretKey, null, "the secret key is not even created for a viewer");
    const bobKeys = await openItemKeysFromSender({ tenantId: T, itemUid: "i1", recipientUserId: 4, senderPublicKey: alice.session.publicKey, recipientPrivateKey: bob.session.privateKey, ...forBob });
    assert.deepEqual(await decryptItemMeta({ tenantId: T, itemUid: "i1", metaKey: bobKeys.metaKey, metaCiphertext: item.metaCiphertext }), { title: "Shared login", username: "svc" });
    assert.equal(bobKeys.secretKey, null);
    await rejects(decryptItemSecret({ tenantId: T, itemUid: "i1", secretKey: bobKeys.metaKey, secretCiphertext: item.secretCiphertext }));

    // Bob later gets REVEAL: the secret box is created and opens
    const upgrade = await wrapItemKeysForRecipient({ tenantId: T, itemUid: "i1", recipientUserId: 4, recipientPublicKey: bob.session.publicKey, senderPrivateKey: alice.session.privateKey, keys, include: { meta: true, secret: true } });
    const full = await openItemKeysFromSender({ tenantId: T, itemUid: "i1", recipientUserId: 4, senderPublicKey: alice.session.publicKey, recipientPrivateKey: bob.session.privateKey, ...upgrade });
    assert.deepEqual(await decryptItemSecret({ tenantId: T, itemUid: "i1", secretKey: full.secretKey, secretCiphertext: item.secretCiphertext }), { password: "s3cret" });

    // Carol (not a recipient) cannot open Bob's boxes, with any sender key
    for (const senderPublicKey of [alice.session.publicKey, bob.session.publicKey, carol.session.publicKey]) {
        await rejects(openItemKeysFromSender({ tenantId: T, itemUid: "i1", recipientUserId: 4, senderPublicKey, recipientPrivateKey: carol.session.privateKey, ...upgrade }));
    }
});

test("SHARING is authenticated and context-bound: wrong sender, another item/tenant/recipient, or a tampered box is rejected", async () => {
    const { createAccount, newItemKeys, wrapItemKeysForRecipient, openItemKeysFromSender } = await load();
    const alice = await createAccount({ password: PASSWORD, tenantId: T, userId: 3, kdf: FAST });
    const bob = await createAccount({ password: PASSWORD, tenantId: T, userId: 4, kdf: FAST });
    const mallory = await createAccount({ password: PASSWORD, tenantId: T, userId: 6, kdf: FAST });
    const keys = await newItemKeys();
    const boxed = await wrapItemKeysForRecipient({ tenantId: T, itemUid: "i1", recipientUserId: 4, recipientPublicKey: bob.session.publicKey, senderPrivateKey: alice.session.privateKey, keys, include: { meta: true, secret: true } });
    const open = (over) => openItemKeysFromSender({ tenantId: T, itemUid: "i1", recipientUserId: 4, senderPublicKey: alice.session.publicKey, recipientPrivateKey: bob.session.privateKey, ...boxed, ...over });
    assert.ok((await open({})).secretKey);
    await rejects(open({ senderPublicKey: mallory.session.publicKey })); // a box must verify against the claimed sender
    await rejects(open({ itemUid: "i2" }));
    await rejects(open({ tenantId: T + 1 }));
    await rejects(open({ recipientUserId: 5 }));
    await rejects(open({ keyVersion: 2 }));
    for (let index = 0; index < boxed.boxedSecretKey.length; index += 1) await rejects(open({ boxedSecretKey: flip(boxed.boxedSecretKey, index) }));
    // a meta-key box presented as a secret-key box (purpose confusion)
    await rejects(open({ boxedSecretKey: boxed.boxedMetaKey }));
    // an attacker who forges a box to Bob with their own key: it opens only against THEIR public key, so Bob rejects it for Alice's
    const forged = await wrapItemKeysForRecipient({ tenantId: T, itemUid: "i1", recipientUserId: 4, recipientPublicKey: bob.session.publicKey, senderPrivateKey: mallory.session.privateKey, keys, include: { meta: true, secret: true } });
    await rejects(open({ ...forged }));
});

test("FINGERPRINTS: stable, formatted, and different for different keys", async () => {
    const { generateKeyPair, publicKeyFingerprint } = await load();
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const fa = await publicKeyFingerprint(a.publicKey);
    assert.match(fa, /^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
    assert.equal(fa, await publicKeyFingerprint(a.publicKey));
    assert.notEqual(fa, await publicKeyFingerprint(b.publicKey));
});

// ---------------------------------------------------------------------------------------------- attachments

test("ATTACHMENTS: round trips for empty, tiny, frame-sized, frame-multiple and multi-frame files; the ciphertext contains no plaintext", async () => {
    const { newAttachmentKey, encryptAttachmentContent, decryptAttachmentContent, FRAME_BYTES } = await load();
    const key = await newAttachmentKey();
    const ids = { tenantId: T, itemUid: "i1", attachmentUid: "a1" };
    for (const size of [0, 1, 100, FRAME_BYTES - 1, FRAME_BYTES, FRAME_BYTES + 1, FRAME_BYTES * 3, FRAME_BYTES * 3 + 17]) {
        const bytes = crypto.randomBytes(size);
        const sealed = await encryptAttachmentContent({ fileKey: key, bytes, ...ids });
        assert.ok(same(await decryptAttachmentContent({ fileKey: key, ciphertext: sealed, ...ids }), bytes), `size ${size}`);
        if (size >= 64) assert.equal(Buffer.from(sealed).includes(bytes.subarray(0, 32)), false);
    }
    const text = Buffer.from("CONFIDENTIAL ".repeat(5000));
    assert.equal(Buffer.from(await encryptAttachmentContent({ fileKey: key, bytes: text, ...ids })).includes(Buffer.from("CONFIDENTIAL")), false);
});

test("ATTACHMENTS: truncation, appended data, reordered or dropped frames, a changed byte, other ids or another key are all rejected", async () => {
    const { newAttachmentKey, encryptAttachmentContent, decryptAttachmentContent, FRAME_BYTES } = await load();
    const key = await newAttachmentKey();
    const ids = { tenantId: T, itemUid: "i1", attachmentUid: "a1" };
    const sealed = await encryptAttachmentContent({ fileKey: key, bytes: crypto.randomBytes(FRAME_BYTES * 3 + 5), ...ids });
    const frame = FRAME_BYTES + 17;
    const header = 24;
    const open = (ciphertext, over = {}) => decryptAttachmentContent({ fileKey: key, ciphertext, ...ids, ...over });
    await open(sealed); // control

    await rejects(open(sealed.slice(0, sealed.length - 1)), "VaultCryptoError");
    await rejects(open(sealed.slice(0, header + frame * 3)), "VaultCryptoError"); // final frame removed (truncation at a frame boundary)
    await rejects(open(new Uint8Array([...sealed, 1, 2, 3])));
    await rejects(open(new Uint8Array([...sealed, ...sealed.slice(header, header + frame)])));
    const swapped = new Uint8Array(sealed);
    swapped.set(sealed.slice(header + frame, header + frame * 2), header);
    swapped.set(sealed.slice(header, header + frame), header + frame);
    await rejects(open(swapped)); // reordered frames
    const dropped = new Uint8Array([...sealed.slice(0, header), ...sealed.slice(header + frame)]);
    await rejects(open(dropped)); // first frame dropped
    for (const index of [0, header, header + 100, sealed.length - 1]) await rejects(open(flip(sealed, index)));
    await rejects(open(sealed, { attachmentUid: "a2" }));
    await rejects(open(sealed, { itemUid: "i2" }));
    await rejects(open(sealed, { tenantId: T + 1 }));
    await rejects(decryptAttachmentContent({ fileKey: await newAttachmentKey(), ciphertext: sealed, ...ids }));
});

test("ATTACHMENTS: size limit, and the file key / metadata are wrapped and bound to their item", async () => {
    const { newAttachmentKey, encryptAttachmentContent, MAX_ATTACHMENT_BYTES, wrapAttachmentKey, unwrapAttachmentKey, encryptAttachmentMeta, decryptAttachmentMeta, randomKey } = await load();
    const key = await newAttachmentKey();
    const ids = { tenantId: T, itemUid: "i1", attachmentUid: "a1" };
    await rejects(encryptAttachmentContent({ fileKey: key, bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1), ...ids }));

    const itemSecretKey = await randomKey();
    const wrapped = await wrapAttachmentKey({ itemSecretKey, fileKey: key, ...ids });
    assert.ok(same(await unwrapAttachmentKey({ itemSecretKey, wrappedFileKey: wrapped, ...ids }), key));
    await rejects(unwrapAttachmentKey({ itemSecretKey, wrappedFileKey: wrapped, ...ids, attachmentUid: "a2" }));
    await rejects(unwrapAttachmentKey({ itemSecretKey: await randomKey(), wrappedFileKey: wrapped, ...ids }));

    const meta = await encryptAttachmentMeta({ fileKey: key, meta: { name: "passwords.kdbx", type: "application/octet-stream", size: 123 }, ...ids });
    assert.equal(Buffer.from(meta).includes(Buffer.from("passwords.kdbx")), false, "the file name is encrypted");
    assert.deepEqual(await decryptAttachmentMeta({ fileKey: key, metaCiphertext: meta, ...ids }), { name: "passwords.kdbx", type: "application/octet-stream", size: 123 });
});

test("PERFORMANCE: encrypting and decrypting a 10 MiB attachment", async () => {
    const { newAttachmentKey, encryptAttachmentContent, decryptAttachmentContent, MAX_ATTACHMENT_BYTES } = await load();
    const key = await newAttachmentKey();
    const bytes = crypto.randomBytes(MAX_ATTACHMENT_BYTES);
    const ids = { tenantId: T, itemUid: "i1", attachmentUid: "a1" };
    const t0 = process.hrtime.bigint();
    const sealed = await encryptAttachmentContent({ fileKey: key, bytes, ...ids });
    const t1 = process.hrtime.bigint();
    const plain = await decryptAttachmentContent({ fileKey: key, ciphertext: sealed, ...ids });
    const t2 = process.hrtime.bigint();
    assert.ok(same(plain, bytes));
    console.log(`  [timing] 10 MiB attachment: encrypt ${Number((t1 - t0) / 1000000n)} ms, decrypt ${Number((t2 - t1) / 1000000n)} ms (Node ${process.version})`);
});

// ---------------------------------------------------------------------------------------------- source hygiene

test("HYGIENE: the vault code never uses Math.random, browser storage, console output, eval, or sends anything over the network", () => {
    const files = fs.readdirSync(CRYPTO_DIR).filter((name) => name.endsWith(".js"));
    assert.ok(files.length >= 10);
    for (const file of files) {
        const source = fs.readFileSync(path.join(CRYPTO_DIR, file), "utf8");
        const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
        for (const [pattern, why] of [
            [/Math\.random/, "Math.random is not a CSPRNG"],
            [/localStorage|sessionStorage|indexedDB|document\.cookie/, "no secret may be persisted by the crypto layer"],
            [/console\.(log|info|debug|warn|error)/, "never log (decrypted) values"],
            [/\beval\(|new Function\(/, "no dynamic code"],
            [/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|axios/, "the crypto layer has no network access"],
            [/from\s+"\.\.\/\.\.\/services/, "no dependency on the API layer"],
        ]) {
            assert.doesNotMatch(code, pattern, `${file}: ${why}`);
        }
    }
});

test("DEPENDENCY: libsodium-wrappers-sumo is pinned to an exact version in client/package.json and the lockfile", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "client", "package.json"), "utf8"));
    assert.match(pkg.dependencies["libsodium-wrappers-sumo"], /^\d+\.\d+\.\d+$/, "an exact version, no ^ or ~");
    const lock = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "client", "package-lock.json"), "utf8"));
    const entry = lock.packages["node_modules/libsodium-wrappers-sumo"];
    assert.equal(entry.version, pkg.dependencies["libsodium-wrappers-sumo"]);
    assert.match(entry.integrity, /^sha512-/);
});
