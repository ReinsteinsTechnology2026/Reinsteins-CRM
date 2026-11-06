// ==========================================
// ZIOVAULT -- what may be attached, and how a file name is made safe to show and to save
//
// The file itself is encrypted in the browser (crypto/attachments.js); this module only decides, BEFORE any encryption or upload, whether a
// file is acceptable, and cleans its name. A downloaded file is always handed to the browser as an opaque download (never rendered, never
// opened inline, never given the type the uploader claimed), so a hostile attachment cannot run in the CRM's page.
// ==========================================

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_ITEM = 20;
export const MAX_NAME_LENGTH = 120;

// Programs and scripts that a person might double-click: refused, because a password vault is not a place to pass them around.
export const BLOCKED_EXTENSIONS = Object.freeze([
  "exe", "dll", "com", "bat", "cmd", "scr", "msi", "msp", "ps1", "psm1", "vbs", "vbe", "wsf", "wsh", "jar", "app", "pif", "cpl", "hta", "reg", "lnk", "sh", "apk", "dmg", "iso", "js", "mjs",
]);

export class AttachmentError extends Error {
  constructor(message, code = "ATTACHMENT_INVALID") {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
  }
}

// Path parts, control characters, bidirectional overrides (which can make "txt.exe" look like "exe.txt"), and leading dots are removed;
// the result is never empty and never longer than MAX_NAME_LENGTH (the extension is kept).
export function sanitizeFileName(input) {
  let name = String(input === undefined || input === null ? "" : input);
  name = name.split(/[\\/]/).pop();
  name = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!name) return "file";
  if (name.length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
    name = name.slice(0, MAX_NAME_LENGTH - extension.length) + extension;
  }
  return name;
}

export const extensionOf = (name) => {
  const dot = String(name).lastIndexOf(".");
  return dot > 0 ? String(name).slice(dot + 1).toLowerCase() : "";
};

// -> { name } or throws AttachmentError with a message a person can act on
export function validateAttachment({ name, size }, { existingCount = 0, existingBytes = 0 } = {}) {
  const clean = sanitizeFileName(name);
  if (!Number.isInteger(size) || size <= 0) throw new AttachmentError("That file is empty.", "EMPTY");
  if (size > MAX_ATTACHMENT_BYTES) throw new AttachmentError(`That file is too large. The limit is ${formatSize(MAX_ATTACHMENT_BYTES)}.`, "TOO_LARGE");
  if (BLOCKED_EXTENSIONS.includes(extensionOf(clean))) throw new AttachmentError(`Programs and scripts (.${extensionOf(clean)}) cannot be attached. Put the file in a compressed archive if you really need to store it.`, "BLOCKED_TYPE");
  if (existingCount >= MAX_ATTACHMENTS_PER_ITEM) throw new AttachmentError(`An item can hold at most ${MAX_ATTACHMENTS_PER_ITEM} attachments.`, "TOO_MANY");
  if (existingBytes + size > 50 * 1024 * 1024) throw new AttachmentError("This item would hold more than 50 MB of attachments.", "TOO_MUCH");
  return { name: clean };
}

export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
