// ==========================================
// ZIOVAULT -- what an item contains, and how it is validated and searched
//
// The server stores two opaque ciphertexts per item; THIS file defines what is inside them:
//   meta   (what a viewer may see without the secret):  { v, title, url, username, folderUid, fields: [{ label, value }] }
//   secret (revealed on request):                       { v, password, notes, hidden: [{ label, value }] }
// Folder membership lives inside the encrypted meta, so the server never learns how items are organised (it stores only the folder's
// encrypted name). Visible custom fields are searchable locally; hidden ones and notes are not part of search.
//
// Everything decrypted is validated against this schema before the UI touches it: a ciphertext that authenticates but contains
// something unexpected is rejected like any other invalid item.
// ==========================================

export const ITEM_KINDS = Object.freeze([
  { id: "login", label: "Login" },
  { id: "secure_note", label: "Secure note" },
  { id: "api_key", label: "API key / token" },
  { id: "other", label: "Other secret" },
]);

export const LIMITS = Object.freeze({ TITLE: 200, URL: 2000, USERNAME: 500, PASSWORD: 4000, NOTES: 50000, FIELD_LABEL: 100, FIELD_VALUE: 5000, FIELDS: 50, FOLDER_NAME: 100 });
const SCHEMA_VERSION = 1;

export class InvalidItemError extends Error {
  constructor(message = "This item could not be read.") {
    super(message);
    this.name = "InvalidItemError";
  }
}

export const emptyDraft = (kind = "login") => ({ kind, title: "", url: "", username: "", password: "", notes: "", folderUid: null, favorite: false, fields: [], rotationIntervalDays: null });

const isText = (value, max) => typeof value === "string" && value.length <= max;
const isFields = (list, valueMax) =>
  Array.isArray(list) && list.length <= LIMITS.FIELDS && list.every((f) => f && typeof f === "object" && isText(f.label, LIMITS.FIELD_LABEL) && isText(f.value, valueMax));

// -> { ok: boolean, errors: { field: message } }
export function validateDraft(draft) {
  const errors = {};
  if (!ITEM_KINDS.some((kind) => kind.id === draft.kind)) errors.kind = "Choose what kind of item this is.";
  if (!String(draft.title || "").trim()) errors.title = "Give the item a name.";
  else if (draft.title.length > LIMITS.TITLE) errors.title = `Keep the name under ${LIMITS.TITLE} characters.`;
  if (draft.url && draft.url.length > LIMITS.URL) errors.url = "That address is too long.";
  if (draft.username && draft.username.length > LIMITS.USERNAME) errors.username = "That username is too long.";
  if (draft.password && draft.password.length > LIMITS.PASSWORD) errors.password = "That value is too long.";
  if (draft.notes && draft.notes.length > LIMITS.NOTES) errors.notes = "The note is too long.";
  if (draft.kind === "secure_note" && !String(draft.notes || "").trim()) errors.notes = "A secure note needs some text.";
  if (draft.kind === "api_key" && !String(draft.password || "").trim()) errors.password = "Enter the key or token.";
  const fields = draft.fields || [];
  if (fields.length > LIMITS.FIELDS) errors.fields = `At most ${LIMITS.FIELDS} custom fields.`;
  else if (fields.some((f) => !String(f.label || "").trim())) errors.fields = "Every custom field needs a label.";
  else if (fields.some((f) => f.label.length > LIMITS.FIELD_LABEL || String(f.value || "").length > LIMITS.FIELD_VALUE)) errors.fields = "A custom field is too long.";
  if (draft.rotationIntervalDays !== null && draft.rotationIntervalDays !== undefined && (!Number.isInteger(draft.rotationIntervalDays) || draft.rotationIntervalDays < 1 || draft.rotationIntervalDays > 3650)) {
    errors.rotationIntervalDays = "Choose between 1 and 3650 days.";
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

// A draft becomes the two documents that get encrypted, and the item's server-visible kind.
export function draftToPayloads(draft) {
  const result = validateDraft(draft);
  if (!result.ok) throw new InvalidItemError(Object.values(result.errors)[0]);
  const visible = (draft.fields || []).filter((field) => !field.hidden).map((field) => ({ label: field.label.trim(), value: String(field.value || "") }));
  const hidden = (draft.fields || []).filter((field) => field.hidden).map((field) => ({ label: field.label.trim(), value: String(field.value || "") }));
  return {
    kind: draft.kind,
    meta: { v: SCHEMA_VERSION, title: draft.title.trim(), url: (draft.url || "").trim(), username: draft.username || "", folderUid: draft.folderUid || null, fields: visible },
    secret: { v: SCHEMA_VERSION, password: draft.password || "", notes: draft.notes || "", hidden },
  };
}

export function parseMeta(value) {
  const ok =
    value && typeof value === "object" && value.v === SCHEMA_VERSION && isText(value.title, LIMITS.TITLE) && isText(value.url ?? "", LIMITS.URL) &&
    isText(value.username ?? "", LIMITS.USERNAME) && (value.folderUid === null || value.folderUid === undefined || typeof value.folderUid === "string") && isFields(value.fields ?? [], LIMITS.FIELD_VALUE);
  if (!ok) throw new InvalidItemError();
  return { title: value.title, url: value.url ?? "", username: value.username ?? "", folderUid: value.folderUid || null, fields: (value.fields ?? []).map((f) => ({ label: f.label, value: f.value })) };
}

export function parseSecret(value) {
  const ok = value && typeof value === "object" && value.v === SCHEMA_VERSION && isText(value.password ?? "", LIMITS.PASSWORD) && isText(value.notes ?? "", LIMITS.NOTES) && isFields(value.hidden ?? [], LIMITS.FIELD_VALUE);
  if (!ok) throw new InvalidItemError();
  return { password: value.password ?? "", notes: value.notes ?? "", hidden: (value.hidden ?? []).map((f) => ({ label: f.label, value: f.value })) };
}

// Meta + secret (+ the server-visible flags) back into an editable draft.
export function payloadsToDraft({ kind, favorite = false, rotationIntervalDays = null }, meta, secret) {
  return {
    kind, favorite, rotationIntervalDays,
    title: meta.title, url: meta.url, username: meta.username, folderUid: meta.folderUid,
    password: secret ? secret.password : "", notes: secret ? secret.notes : "",
    fields: [...meta.fields.map((f) => ({ ...f, hidden: false })), ...(secret ? secret.hidden.map((f) => ({ ...f, hidden: true })) : [])],
  };
}

// A link is only ever built from http(s) addresses: a stored "javascript:..." or "data:..." value must never become a clickable link.
export function safeUrl(input) {
  const text = String(input || "").trim();
  if (!text) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export const hostOf = (input) => {
  const href = safeUrl(input);
  return href ? new URL(href).host : "";
};

// Local search over DECRYPTED details only: name, address, username, folder name and visible custom fields. Never the password, the
// notes or hidden fields, and never sent anywhere: the term stays in this tab.
export function matchesQuery(view, query, folderName = "") {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [view.title, view.url, view.username, folderName, ...(view.fields || []).flatMap((f) => [f.label, f.value])].join("\n").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}
