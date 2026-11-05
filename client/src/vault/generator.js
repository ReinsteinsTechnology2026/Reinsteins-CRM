import { getSodium } from "./crypto/sodium.js";
import { WORDLIST, WORDLIST_SIZE, BITS_PER_WORD } from "./wordlist.js";

// ==========================================
// ZIOVAULT -- password and passphrase generator (runs entirely in the browser)
//
// Every random choice is libsodium's randombytes_uniform (the operating system's CSPRNG, with the modulo bias removed): the
// same source as the keys. Math.random is never used (a test scans for it). A generated value exists only in the page's memory
// until the user explicitly saves it as an item, where it is encrypted like any other secret; nothing here touches the network.
// ==========================================

export const SETS = Object.freeze({
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digits: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{};:,.<>?/~",
});
export const AMBIGUOUS = "Il1O0o|`'\"";
export const LENGTH_LIMITS = Object.freeze({ min: 8, max: 128 });
export const WORD_LIMITS = Object.freeze({ min: 3, max: 12 });
export const DEFAULT_PASSWORD_OPTIONS = Object.freeze({ length: 20, lower: true, upper: true, digits: true, symbols: true, exclude: "", excludeAmbiguous: false });
export const DEFAULT_PASSPHRASE_OPTIONS = Object.freeze({ words: 6, separator: "-", capitalize: false, includeNumber: false });

export class GeneratorError extends Error {
  constructor(message) {
    super(message);
    this.name = "GeneratorError";
  }
}

async function uniform(upperBound) {
  const sodium = await getSodium();
  return sodium.randombytes_uniform(upperBound);
}

async function shuffle(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = await uniform(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// The character pools the options select, after removing excluded and (optionally) ambiguous characters. Characters are code points.
export function buildPools(options) {
  const o = { ...DEFAULT_PASSWORD_OPTIONS, ...options };
  const removed = new Set(Array.from(String(o.exclude || "")).concat(o.excludeAmbiguous ? Array.from(AMBIGUOUS) : []));
  const pools = [];
  for (const name of ["lower", "upper", "digits", "symbols"]) {
    if (!o[name]) continue;
    const chars = Array.from(SETS[name]).filter((char) => !removed.has(char));
    if (chars.length > 0) pools.push({ name, chars });
  }
  return pools;
}

export function validatePasswordOptions(options) {
  const o = { ...DEFAULT_PASSWORD_OPTIONS, ...options };
  if (!Number.isInteger(o.length) || o.length < LENGTH_LIMITS.min || o.length > LENGTH_LIMITS.max) {
    throw new GeneratorError(`Choose a length between ${LENGTH_LIMITS.min} and ${LENGTH_LIMITS.max}.`);
  }
  const pools = buildPools(o);
  if (pools.length === 0) throw new GeneratorError("Select at least one kind of character (and do not exclude all of them).");
  return { options: o, pools };
}

// Estimated strength of what the options can produce (bits), assuming every position is drawn uniformly from the union of the pools.
export function passwordEntropyBits(options) {
  const { options: o, pools } = validatePasswordOptions(options);
  const size = new Set(pools.flatMap((pool) => pool.chars)).size;
  return Math.round(o.length * Math.log2(size) * 10) / 10;
}

export async function generatePassword(options = {}) {
  const { options: o, pools } = validatePasswordOptions(options);
  const union = Array.from(new Set(pools.flatMap((pool) => pool.chars)));
  const chars = [];
  // at least one character from every selected kind, then the rest from everything allowed; then shuffled (uniformly) so the
  // guaranteed characters are not in predictable positions
  for (const pool of pools) chars.push(pool.chars[await uniform(pool.chars.length)]);
  while (chars.length < o.length) chars.push(union[await uniform(union.length)]);
  return (await shuffle(chars)).join("");
}

export function validatePassphraseOptions(options) {
  const o = { ...DEFAULT_PASSPHRASE_OPTIONS, ...options };
  if (!Number.isInteger(o.words) || o.words < WORD_LIMITS.min || o.words > WORD_LIMITS.max) {
    throw new GeneratorError(`Choose between ${WORD_LIMITS.min} and ${WORD_LIMITS.max} words.`);
  }
  if (typeof o.separator !== "string" || o.separator.length > 3) throw new GeneratorError("The separator can be at most 3 characters.");
  return o;
}

export function passphraseEntropyBits(options) {
  const o = validatePassphraseOptions(options);
  const bits = o.words * BITS_PER_WORD + (o.includeNumber ? Math.log2(10 * o.words) : 0);
  return Math.round(bits * 10) / 10;
}

export async function generatePassphrase(options = {}) {
  const o = validatePassphraseOptions(options);
  const words = [];
  for (let i = 0; i < o.words; i += 1) {
    const word = WORDLIST[await uniform(WORDLIST_SIZE)];
    words.push(o.capitalize ? word.charAt(0).toUpperCase() + word.slice(1) : word);
  }
  if (o.includeNumber) words[await uniform(words.length)] += String(await uniform(10));
  return words.join(o.separator);
}

export const strengthLabel = (bits) => (bits < 45 ? "Weak" : bits < 60 ? "Fair" : bits < 80 ? "Good" : "Strong");
