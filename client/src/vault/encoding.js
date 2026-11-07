// base64url (no padding) for the API: pure JavaScript on top of btoa/atob, so it behaves the same in a browser and in Node tests.
// Strict on input: anything that is not canonical base64url is refused (the server is equally strict).

const CHUNK = 0x8000;

export function toB64(bytes) {
  if (bytes === null || bytes === undefined) return null;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64(text) {
  if (text === null || text === undefined) return null;
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("Invalid encoding");
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
