import { encryptJson, decryptJson } from "./aead.js";

// ==========================================
// ZIOVAULT -- folder names and unsaved-draft protection (both are small documents sealed under the user's vault key)
//
// A folder name is encrypted under the vault key, bound to the tenant, the folder's id and the user (purpose "folder-name"), so the
// server stores a label it cannot read and cannot attach to another folder or person.
//
// A DRAFT is an item the user is editing when the vault locks (inactivity, another tab, ...). Rather than lose it -- or keep it in
// the clear -- the editor's content is sealed under the vault key (purpose "draft", added for exactly this) and held as CIPHERTEXT in
// the page's session storage; it can only be read again after unlocking, and is deleted once restored or discarded.
// ==========================================

export const encryptFolderName = ({ tenantId, folderUid, userId, vaultKey, name }) => encryptJson(vaultKey, { name }, "folder-name", [tenantId, folderUid, userId]);

export const decryptFolderName = async ({ tenantId, folderUid, userId, vaultKey, envelope }) => {
  const document = await decryptJson(vaultKey, envelope, "folder-name", [tenantId, folderUid, userId]);
  return document.name;
};

export const sealDraft = ({ tenantId, userId, vaultKey, draft }) => encryptJson(vaultKey, draft, "draft", [tenantId, userId]);

export const openDraft = ({ tenantId, userId, vaultKey, envelope }) => decryptJson(vaultKey, envelope, "draft", [tenantId, userId]);
