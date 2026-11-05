import { WORDLIST, BITS_PER_WORD } from "./wordlist.js";

// ==========================================
// ZIOVAULT -- password health (entirely local)
//
// Everything here runs on passwords that are ALREADY decrypted in this browser tab. Nothing is sent anywhere: no request, no
// external breach service, no analytics. The REPORT it returns contains item ids, titles and numbers -- never a password -- so a
// finding can be shown, logged or kept without becoming a copy of a secret.
//
// Findings: weak (estimated guessing cost too low), reused (the same password on several items), old (not changed for a long
// time), missing (a login without a password). The strength estimate is deliberately conservative and simple (character-class
// entropy minus penalties for common passwords, repeats, sequences, keyboard runs, dates and the item's own name); it is guidance,
// not a proof.
// ==========================================

const COMMON = new Set(
  ("123456 password 12345678 qwerty 123456789 12345 1234 111111 1234567 dragon 123123 baseball abc123 football monkey letmein 696969 shadow master " +
    "666666 qwertyuiop 123321 mustang 1234567890 michael 654321 superman 1qaz2wsx 7777777 121212 000000 qazwsx 123qwe killer trustno1 jordan jennifer zxcvbnm " +
    "asdfgh hunter buster soccer harley batman andrew tigger sunshine iloveyou 2000 charlie robert thomas hockey ranger daniel starwars klaster 112233 george " +
    "computer michelle jessica pepper 1111 zxcvbn 555555 11111111 131313 freedom 777777 pass maggie 159753 aaaaaa ginger princess joshua cheese amanda summer love " +
    "ashley nicole chelsea biteme matthew access yankees 987654321 dallas austin thunder taylor matrix welcome admin administrator passw0rd password1 password123 " +
    "p@ssw0rd p@ssword qwerty123 qwerty1 admin123 root toor changeme default guest login test test123 temp temp123 secret letmein1 welcome1 monkey1 abcd1234 " +
    "iloveyou1 1q2w3e4r 1q2w3e q1w2e3r4 zaq12wsx google1 azerty passpass pa55word welcome123 company123 office123 summer2020 winter2020 spring2021 autumn2021").split(" ")
);
const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890", "qazwsxedcrfv", "1qaz2wsx3edc"];
const WORD_SET = new Set(WORDLIST);

export const THRESHOLDS = Object.freeze({ weakBits: 45, fairBits: 60, goodBits: 80, defaultOldDays: 180, minRotationAgeDays: 1 });

const SEASONS = new Set(["spring", "summer", "autumn", "fall", "winter", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "welcome", "admin", "login", "monday", "friday"]);

const poolSize = (password) => {
  let size = 0;
  if (/[a-z]/.test(password)) size += 26;
  if (/[A-Z]/.test(password)) size += 26;
  if (/[0-9]/.test(password)) size += 10;
  if (/[^a-zA-Z0-9]/.test(password)) size += 32;
  return size || 1;
};

function longestRun(password, step) {
  let best = 1;
  let run = 1;
  for (let i = 1; i < password.length; i += 1) {
    const delta = password.codePointAt(i) - password.codePointAt(i - 1);
    if (delta === step) {
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 1;
    }
  }
  return best;
}

function hasKeyboardRun(lower) {
  for (const row of KEYBOARD_ROWS) {
    for (let size = 4; size <= row.length; size += 1) {
      for (let start = 0; start + size <= row.length; start += 1) {
        const piece = row.slice(start, start + size);
        if (lower.includes(piece) || lower.includes([...piece].reverse().join(""))) return true;
      }
    }
  }
  return false;
}

// -> { bits, score 0..4, label, issues: [code] }  (codes: common, short, repeated, sequence, keyboard, date, personal, single-word, passphrase-ok)
export function estimateStrength(password, context = []) {
  const text = String(password || "");
  if (text.length === 0) return { bits: 0, score: 0, label: "Weak", issues: ["empty"] };
  const lower = text.toLowerCase();
  const issues = [];

  // a passphrase made of dictionary words is judged by the words, not by its letters
  const tokens = lower.split(/[^a-z]+/).filter(Boolean);
  if (tokens.length >= 3 && tokens.every((token) => WORD_SET.has(token))) {
    const bits = Math.min(110, tokens.length * BITS_PER_WORD);
    return finish(bits, ["passphrase"]);
  }

  if (COMMON.has(lower) || COMMON.has(lower.replace(/[^a-z0-9]/g, ""))) return finish(Math.min(6, text.length), ["common"]);

  // one dictionary word (or a month/season), optionally capitalised, with digits/symbols tacked on: the classic "Summer2024!". Judged as
  // the word (one pick from the list) plus the cost of the tacked-on part, not by its length.
  const stem = /^([A-Za-z]{3,12})([^A-Za-z]{0,8})$/.exec(text);
  if (stem && (WORD_SET.has(stem[1].toLowerCase()) || SEASONS.has(stem[1].toLowerCase()))) {
    const tail = stem[2];
    const tailBits = [...tail].reduce((sum, ch) => sum + (/[0-9]/.test(ch) ? Math.log2(10) : Math.log2(32)), 0);
    return finish(BITS_PER_WORD + tailBits + 2, ["single-word"]);
  }

  let bits = text.length * Math.log2(poolSize(text));
  const unique = new Set(Array.from(text)).size;
  if (unique <= Math.max(2, Math.floor(text.length / 4))) {
    bits = Math.min(bits, unique * Math.log2(poolSize(text)) + 2);
    issues.push("repeated");
  } else if (unique < text.length * 0.6) {
    bits *= 0.75;
    issues.push("repeated");
  }
  if (longestRun(text, 1) >= 4 || longestRun(text, -1) >= 4) {
    bits *= 0.7;
    issues.push("sequence");
  }
  if (hasKeyboardRun(lower)) {
    bits *= 0.7;
    issues.push("keyboard");
  }
  if (/(19|20)\d\d\b/.test(text) || /\b(0?[1-9]|[12]\d|3[01])[./-](0?[1-9]|1[0-2])[./-](\d{2}|\d{4})\b/.test(text)) {
    bits -= 8;
    issues.push("date");
  }
  for (const word of context.map((part) => String(part || "").toLowerCase()).flatMap((part) => part.split(/[^a-z0-9]+/)).filter((part) => part.length >= 4)) {
    if (lower.includes(word)) {
      bits *= 0.6;
      issues.push("personal");
      break;
    }
  }
  if (issues.includes("personal")) {
    // nothing but the item's own name (and digits/punctuation) is guessable from the item itself
    let rest = lower;
    for (const word of context.map((part) => String(part || "").toLowerCase()).flatMap((part) => part.split(/[^a-z0-9]+/)).filter((part) => part.length >= 3)) rest = rest.split(word).join("");
    if (!/[a-z]/.test(rest)) bits = Math.min(bits, 28);
  }
  if (/^[a-zA-Z]+$/.test(text) && text.length <= 12) {
    bits = Math.min(bits, 30);
    issues.push("single-word");
  }
  if (text.length < 10) issues.push("short");
  return finish(bits, [...new Set(issues)]);
}

function finish(bits, issues) {
  const rounded = Math.max(0, Math.round(bits * 10) / 10);
  const score = rounded < 30 ? 0 : rounded < THRESHOLDS.weakBits ? 1 : rounded < THRESHOLDS.fairBits ? 2 : rounded < THRESHOLDS.goodBits ? 3 : 4;
  return { bits: rounded, score, label: ["Weak", "Weak", "Fair", "Good", "Strong"][score], issues };
}

// The human advice for a finding code.
export const ADVICE = Object.freeze({
  common: "This is one of the most commonly used passwords; attackers try it first. Replace it with a generated one.",
  short: "Use at least 12 characters (a generated 20-character password or a 6-word passphrase is better).",
  repeated: "Repeated characters make a password much easier to guess.",
  sequence: "Avoid runs such as abcd or 1234.",
  keyboard: "Avoid keyboard patterns such as qwerty.",
  date: "Avoid dates and years: they are among the first things guessed.",
  personal: "Do not build a password from the item's own name or username.",
  "single-word": "A single word, even with a number added, is quick to crack. Use a passphrase of several random words.",
  empty: "No password has been stored.",
});

// entries: [{ uid, title, kind, password, username, lastRotatedAt }]. The passwords are used here and NOT copied into the report.
export function analyzeVault(entries, { now = Date.now(), oldDays = THRESHOLDS.defaultOldDays } = {}) {
  const logins = entries.filter((entry) => entry.kind === "login" || entry.kind === "api_key" || entry.kind === "other");
  const weak = [];
  const missing = [];
  const old = [];
  const byPassword = new Map();

  for (const entry of logins) {
    const password = entry.password || "";
    if (!password) {
      if (entry.kind === "login") missing.push({ uid: entry.uid, title: entry.title });
      continue;
    }
    const strength = estimateStrength(password, [entry.title, entry.username]);
    if (strength.score <= 1) weak.push({ uid: entry.uid, title: entry.title, bits: strength.bits, label: strength.label, issues: strength.issues.filter((code) => ADVICE[code]) });
    const ageDays = entry.lastRotatedAt ? Math.floor((now - new Date(entry.lastRotatedAt).getTime()) / 86400000) : null;
    if (ageDays !== null && ageDays >= oldDays) old.push({ uid: entry.uid, title: entry.title, ageDays });
    if (!byPassword.has(password)) byPassword.set(password, []);
    byPassword.get(password).push({ uid: entry.uid, title: entry.title });
  }

  const reused = [...byPassword.values()].filter((group) => group.length > 1).map((items) => ({ items }));
  const reusedUids = new Set(reused.flatMap((group) => group.items.map((item) => item.uid)));
  const problemUids = new Set([...weak.map((w) => w.uid), ...missing.map((m) => m.uid), ...old.map((o) => o.uid), ...reusedUids]);
  const total = logins.length;
  const recommendations = [];
  if (weak.length) recommendations.push(`Replace ${weak.length} weak password${weak.length === 1 ? "" : "s"} with generated ones.`);
  if (reused.length) recommendations.push(`${reusedUids.size} items share a password with another item: give each account its own.`);
  if (old.length) recommendations.push(`${old.length} password${old.length === 1 ? " has" : "s have"} not changed for ${oldDays}+ days: rotate the important ones.`);
  if (missing.length) recommendations.push(`${missing.length} login${missing.length === 1 ? " has" : "s have"} no password stored.`);
  if (recommendations.length === 0 && total > 0) recommendations.push("No problems found in the passwords checked.");

  return {
    summary: { total, weak: weak.length, reused: reusedUids.size, reusedGroups: reused.length, old: old.length, missing: missing.length, healthy: total - problemUids.size, healthyPercent: total ? Math.round(((total - problemUids.size) / total) * 100) : 100 },
    findings: { weak, reused, old, missing },
    recommendations,
    oldDays,
  };
}
