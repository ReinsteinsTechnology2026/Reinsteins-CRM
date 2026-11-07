import { getSodium } from "./sodium.js";

// A person's public key shown as a short fingerprint (BLAKE2b-128 of the key, 8 groups of 4 hex characters), so two people can
// compare it over another channel and notice if the server ever handed out a substituted key.
export async function publicKeyFingerprint(publicKey) {
  const sodium = await getSodium();
  const hex = sodium.to_hex(sodium.crypto_generichash(16, publicKey));
  return hex.match(/.{4}/g).join(" ");
}
