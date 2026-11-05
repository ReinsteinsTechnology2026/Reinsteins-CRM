// ZioVault Stage 3 -- client logic that needs no database: generator, password health, item model, clipboard, folder/draft crypto and
// source hygiene of everything under client/src/vault.  Run: node --test _test_ziovault_client.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const VAULT = path.join(__dirname, "..", "client", "src", "vault");
const load = (name) => import(pathToFileURL(path.join(VAULT, name)).href);
const FAST = { alg: "argon2id13", ops: 2, mem: 32 * 1024 * 1024 };

// ------------------------------------------------------------------------------------------------------------ generator
test("generator: honours length and every selected character set, and never uses an excluded character", async () => {
    const g = await load("generator.js");
    for (let i = 0; i < 200; i += 1) {
        const pw = await g.generatePassword({ length: 12, lower: true, upper: true, digits: true, symbols: true });
        assert.equal(pw.length, 12);
        assert.match(pw, /[a-z]/); assert.match(pw, /[A-Z]/); assert.match(pw, /[0-9]/); assert.match(pw, /[^A-Za-z0-9]/);
    }
    const noAmbiguous = await g.generatePassword({ length: 128, excludeAmbiguous: true, exclude: "abc" });
    for (const ch of g.AMBIGUOUS + "abc") assert.ok(!noAmbiguous.includes(ch), `contains excluded ${ch}`);
    const digitsOnly = await g.generatePassword({ length: 30, lower: false, upper: false, digits: true, symbols: false });
    assert.match(digitsOnly, /^[0-9]{30}$/);
});

test("generator: rejects impossible or out-of-range options instead of weakening them", async () => {
    const g = await load("generator.js");
    await assert.rejects(g.generatePassword({ lower: false, upper: false, digits: false, symbols: false }), (e) => e.name === "GeneratorError");
    await assert.rejects(g.generatePassword({ length: 4 }), (e) => e.name === "GeneratorError");
    await assert.rejects(g.generatePassword({ length: 500 }), (e) => e.name === "GeneratorError");
    await assert.rejects(g.generatePassword({ lower: true, upper: false, digits: false, symbols: false, exclude: "abcdefghijklmnopqrstuvwxyz" }), (e) => e.name === "GeneratorError");
    await assert.rejects(g.generatePassphrase({ words: 1 }), (e) => e.name === "GeneratorError");
});

test("generator: output is random (no repeats, uniform characters, uniform words), and only the CSPRNG is used", async () => {
    const g = await load("generator.js");
    const seen = new Set();
    for (let i = 0; i < 500; i += 1) seen.add(await g.generatePassword({ length: 20 }));
    assert.equal(seen.size, 500);
    // a digits-only generator must hit every digit about equally often (chi-square, 9 degrees of freedom, p ~ 0.001 -> 27.9)
    const counts = new Array(10).fill(0);
    const total = 20000;
    for (let i = 0; i < total / 50; i += 1) for (const ch of await g.generatePassword({ length: 50, lower: false, upper: false, digits: true, symbols: false })) counts[Number(ch)] += 1;
    const expected = total / 10;
    const chi = counts.reduce((sum, c) => sum + ((c - expected) ** 2) / expected, 0);
    assert.ok(chi < 27.9, `digit distribution is not uniform (chi-square ${chi.toFixed(1)})`);
    const source = fs.readFileSync(path.join(VAULT, "generator.js"), "utf8").split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
    assert.ok(!/Math\.random/.test(source), "generator must not use Math.random");
});

test("passphrase: words come from the 7776-word list, entropy is reported honestly", async () => {
    const g = await load("generator.js");
    const w = await load("wordlist.js");
    assert.equal(w.WORDLIST.length, 7776);
    assert.equal(new Set(w.WORDLIST).size, 7776);
    const phrase = await g.generatePassphrase({ words: 6, separator: "-" });
    const parts = phrase.split("-");
    assert.equal(parts.length, 6);
    for (const part of parts) assert.ok(w.WORDLIST.includes(part), `${part} not in list`);
    assert.ok(Math.abs(g.passphraseEntropyBits({ words: 6 }) - 6 * Math.log2(7776)) < 0.1);
    const capital = await g.generatePassphrase({ words: 4, capitalize: true, includeNumber: true, separator: "." });
    assert.match(capital, /^[A-Z]/);
    assert.match(capital, /[0-9]/);
});

// ------------------------------------------------------------------------------------------------------------ health
test("strength: common, patterned and personal passwords score low; long random ones score high", async () => {
    const h = await load("health.js");
    const g = await load("generator.js");
    for (const weak of ["password", "Password123!", "qwerty123456", "12345678", "aaaaaaaaaaaa", "abcdef123456", "Summer2024!", "letmein"]) {
        assert.ok(h.estimateStrength(weak).bits < 45, `${weak} should be weak, got ${h.estimateStrength(weak).bits}`);
    }
    assert.ok(h.estimateStrength("acme-portal-2020", ["Acme Portal"]).bits < 45);
    assert.ok(h.estimateStrength(await g.generatePassword({ length: 20 })).bits >= 80);
    assert.ok(h.estimateStrength("correct-horse-battery-staple-lantern").bits >= 60);
});

test("health: finds weak, reused, old and missing passwords; the report never contains a password", async () => {
    const h = await load("health.js");
    const now = Date.parse("2026-06-01T00:00:00Z");
    const day = 86400000;
    const entries = [
        { uid: "1", title: "Bank", kind: "login", username: "a", password: "T7#kq9Lm!x2Vp0Zr", lastRotatedAt: new Date(now - 10 * day).toISOString() },
        { uid: "2", title: "Shop", kind: "login", username: "a", password: "password123", lastRotatedAt: new Date(now - 10 * day).toISOString() },
        { uid: "3", title: "Mail", kind: "login", username: "a", password: "Xk4$mP9#vL2@qW8z", lastRotatedAt: new Date(now - 400 * day).toISOString() },
        { uid: "4", title: "Forum", kind: "login", username: "a", password: "Xk4$mP9#vL2@qW8z", lastRotatedAt: new Date(now - 5 * day).toISOString() },
        { uid: "5", title: "Empty", kind: "login", username: "a", password: "", lastRotatedAt: null },
        { uid: "6", title: "Note", kind: "secure_note", username: "", password: "ignored-because-note", lastRotatedAt: null },
    ];
    const report = h.analyzeVault(entries, { now, oldDays: 180 });
    assert.deepEqual(report.findings.weak.map((f) => f.uid), ["2"]);
    assert.deepEqual(report.findings.reused.map((g) => g.items.map((i) => i.uid).sort()), [["3", "4"]]);
    assert.deepEqual(report.findings.old.map((f) => f.uid), ["3"]);
    assert.deepEqual(report.findings.missing.map((f) => f.uid), ["5"]);
    assert.equal(report.summary.total, 5);
    assert.ok(report.recommendations.length >= 3);
    const text = JSON.stringify(report);
    for (const entry of entries) if (entry.password) assert.ok(!text.includes(entry.password), "report leaked a password");
    const clean = h.analyzeVault([entries[0]], { now });
    assert.match(clean.recommendations[0], /No problems/);
});

// ------------------------------------------------------------------------------------------------------------ item model
test("item model: validation, meta/secret split, strict parsing, safe links and local search", async () => {
    const m = await load("itemModel.js");
    assert.ok(m.validateDraft({ ...m.emptyDraft(), title: "" }).errors.title);
    assert.deepEqual(m.validateDraft({ ...m.emptyDraft(), title: "ok" }), { ok: true, errors: {} });
    assert.ok(m.validateDraft({ ...m.emptyDraft(), title: "x".repeat(201) }).errors.title);
    assert.ok(m.validateDraft({ ...m.emptyDraft(), title: "x", fields: [{ label: "", value: "v", hidden: false }] }).errors.fields);

    const draft = { ...m.emptyDraft(), title: "GitHub", url: "https://github.com", username: "me", password: "S3cret!", notes: "private note", folderUid: "f1",
        fields: [{ label: "Region", value: "eu", hidden: false }, { label: "PIN", value: "1234", hidden: true }] };
    const p = m.draftToPayloads(draft);
    const metaText = JSON.stringify(p.meta);
    assert.ok(!metaText.includes("S3cret!") && !metaText.includes("private note") && !metaText.includes("1234"), "the details must not contain secret material");
    assert.ok(JSON.stringify(p.secret).includes("S3cret!") && JSON.stringify(p.secret).includes("1234"));
    const back = m.payloadsToDraft({ kind: "login", favorite: true }, m.parseMeta(p.meta), m.parseSecret(p.secret));
    assert.equal(back.password, "S3cret!"); assert.equal(back.fields.length, 2); assert.equal(back.folderUid, "f1");

    assert.throws(() => m.parseMeta({ v: 2, title: "x" }), (e) => e.name === "InvalidItemError");
    assert.throws(() => m.parseMeta({ v: 1, title: 5 }), (e) => e.name === "InvalidItemError");
    assert.throws(() => m.parseSecret(null), (e) => e.name === "InvalidItemError");

    assert.equal(m.safeUrl("javascript:alert(1)"), null);
    assert.equal(m.safeUrl("data:text/html,x"), null);
    assert.equal(m.safeUrl("https://example.com/a"), "https://example.com/a");
    assert.equal(m.safeUrl("example.com"), "https://example.com/");

    const view = { title: "GitHub", url: "https://github.com", username: "me", fields: [{ label: "Region", value: "eu" }] };
    assert.ok(m.matchesQuery(view, "git")); assert.ok(m.matchesQuery(view, "ME")); assert.ok(m.matchesQuery(view, "eu"));
    assert.ok(m.matchesQuery(view, "work", "Work stuff"));
    assert.ok(!m.matchesQuery(view, "S3cret") && !m.matchesQuery(view, "private"));
    assert.ok(m.matchesQuery(view, ""));
});

// ------------------------------------------------------------------------------------------------------------ clipboard
test("clipboard: clears after the delay only if it still holds what was copied; falls back to overwriting; clearNow works", async () => {
    const { createClipboard } = await load("clipboard.js");
    const make = (initial, canRead = true) => {
        const board = { value: initial, writes: [] };
        board.clipboard = { writeText: async (t) => { board.value = t; board.writes.push(t); }, readText: async () => { if (!canRead) throw new Error("denied"); return board.value; } };
        return board;
    };
    const timers = [];
    const opts = (board) => ({ clipboard: board.clipboard, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, getSeconds: () => 30 });

    let b = make("");
    let c = createClipboard(opts(b));
    await c.copy("hunter2");
    assert.equal(b.value, "hunter2"); assert.equal(c.pending, true);
    await timers.pop()();
    assert.equal(b.value, ""); assert.equal(c.pending, false);

    b = make(""); c = createClipboard(opts(b));
    await c.copy("hunter2");
    b.value = "something the user copied later";
    await timers.pop()();
    assert.equal(b.value, "something the user copied later", "must not clobber newer clipboard content");

    b = make("", false); c = createClipboard(opts(b));
    await c.copy("hunter2");
    await timers.pop()();
    assert.equal(b.value, "", "when reading is not allowed the clipboard is overwritten");

    b = make(""); c = createClipboard(opts(b));
    await c.copy("hunter2");
    await c.clearNow();
    assert.equal(b.value, "");
    await assert.rejects(createClipboard({ clipboard: null }).copy("x"));
});

// ------------------------------------------------------------------------------------------------------------ folder + draft crypto, encoding
test("folder names and drafts: round trip, bound to tenant/user/folder, tamper detected, ciphertext hides the text", async () => {
    const crypto = await load("crypto/index.js");
    const enc = await load("encoding.js");
    const account = await crypto.createAccount({ password: "correct horse battery staple", tenantId: 1, userId: 5, kdf: FAST });
    const vaultKey = account.session.vaultKey;
    const envelope = await crypto.encryptFolderName({ tenantId: 1, userId: 5, folderUid: "f1", vaultKey, name: "Banking" });
    assert.ok(!Buffer.from(envelope).includes(Buffer.from("Banking")));
    assert.equal(await crypto.decryptFolderName({ tenantId: 1, userId: 5, folderUid: "f1", vaultKey, envelope }), "Banking");
    for (const wrong of [{ tenantId: 2, userId: 5, folderUid: "f1" }, { tenantId: 1, userId: 6, folderUid: "f1" }, { tenantId: 1, userId: 5, folderUid: "f2" }]) {
        await assert.rejects(crypto.decryptFolderName({ ...wrong, vaultKey, envelope }), (e) => e.name === "VaultCryptoError");
    }
    const bad = new Uint8Array(envelope); bad[bad.length - 1] ^= 1;
    await assert.rejects(crypto.decryptFolderName({ tenantId: 1, userId: 5, folderUid: "f1", vaultKey, envelope: bad }), (e) => e.name === "VaultCryptoError");

    const draft = { title: "Draft title", password: "very-secret-pw" };
    const sealed = await crypto.sealDraft({ tenantId: 1, userId: 5, vaultKey, draft });
    assert.ok(!Buffer.from(sealed).includes(Buffer.from("very-secret-pw")));
    assert.deepEqual(await crypto.openDraft({ tenantId: 1, userId: 5, vaultKey, envelope: sealed }), draft);
    await assert.rejects(crypto.openDraft({ tenantId: 1, userId: 6, vaultKey, envelope: sealed }), (e) => e.name === "VaultCryptoError");

    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    assert.deepEqual([...enc.fromB64(enc.toB64(bytes))], [...bytes]);
    assert.ok(!/[+/=]/.test(enc.toB64(bytes)));
    assert.throws(() => enc.fromB64("not valid!!"));
    crypto.lockSession(account.session);
});

// ------------------------------------------------------------------------------------------------------------ source hygiene
test("source hygiene: nothing under client/src/vault or pages/Vault logs, uses Math.random, talks to a third party or touches storage outside the runtime", () => {
    const files = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|jsx)$/.test(e.name)) files.push(p); } };
    walk(VAULT);
    walk(path.join(__dirname, "..", "client", "src", "pages", "Vault"));
    assert.ok(files.length > 20);
    for (const file of files) {
        const code = fs.readFileSync(file, "utf8").split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
        const rel = path.relative(path.join(__dirname, ".."), file);
        if (!/wordlist\.js$/.test(file)) {
            assert.ok(!/\bconsole\./.test(code), `${rel}: must not use console`);
            assert.ok(!/Math\.random/.test(code), `${rel}: must not use Math.random`);
            assert.ok(!/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|https?:\/\/[a-z0-9](?<!github\.com)/.test(code.replace(/placeholder="https:\/\/"/g, "")), `${rel}: must not contact anything but the CRM API`);
            assert.ok(!/\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/.test(code) || /vaultRuntime\.js$/.test(file), `${rel}: browser storage is only touched by vaultRuntime.js`);
            assert.ok(!/location\.(search|hash)|history\.(push|replace)State|URLSearchParams/.test(code), `${rel}: must not put anything in the URL`);
            assert.ok(!/dangerouslySetInnerHTML|\beval\(|new Function\(/.test(code), `${rel}: unsafe HTML or code execution`);
        }
    }
    // the only things the runtime stores
    const runtime = fs.readFileSync(path.join(VAULT, "vaultRuntime.js"), "utf8");
    assert.deepEqual([...new Set([...runtime.matchAll(/(?:local|session)Storage\.(?:get|set|remove)Item\(([^,)]+)/g)].map((m) => m[1].trim()))].sort(), ['"company"', '"token"', '"user"', "PREFS_KEY", "key"].sort());
});
