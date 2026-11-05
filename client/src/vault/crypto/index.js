// ZioVault cryptography -- the only entry point the rest of the client should import. See server/ZIOVAULT_ARCHITECTURE.md.
export { getSodium, assertSodium } from "./sodium.js";
export { buildAad, frameFields, unframeFields, PURPOSES, FORMAT, equalBytes } from "./aad.js";
export { VaultCryptoError, ENVELOPE_VERSION, KEY_BYTES, NONCE_BYTES, TAG_BYTES, randomKey, randomBytes, encryptBytes, decryptBytes, encryptJson, decryptJson, wrapKey, unwrapKey } from "./aead.js";
export { DEFAULT_KDF, KDF_LIMITS, MIN_PASSWORD_LENGTH, validateKdfParams, deriveMasterKey, deriveSubkey, checkMasterPassword } from "./kdf.js";
export { generateRecoverySecret, parseRecoverySecret } from "./recoverySecret.js";
export { generateKeyPair, publicKeyFromPrivate, sealKeyForRecipient, openKeyFromSender } from "./boxes.js";
export { createAccount, unlockAccount, changeMasterPassword, recoverAccount, rotateRecoverySecret, lockSession, accountAadIds } from "./account.js";
export * from "./items.js";
export * from "./attachments.js";
export * from "./collections.js";
export { publicKeyFingerprint } from "./fingerprint.js";
