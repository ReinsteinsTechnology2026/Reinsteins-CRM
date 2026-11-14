// Small pure helpers for the mail screens (no React, no network).

export const FOLDER_ORDER = ["inbox", "sentitems", "drafts", "deleteditems", "junkemail", "archive"];

export function senderLabel(person) {
  if (!person) return "(unknown sender)";
  return person.name || person.address || "(unknown sender)";
}

export function recipientsLabel(list) {
  if (!list || list.length === 0) return "(no recipients)";
  return list.map((p) => p.name || p.address).join(", ");
}

export function initialsOf(person) {
  const source = (person && (person.name || person.address)) || "?";
  const words = source.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] || "?") + (words[1]?.[0] || "")).toUpperCase();
}

// Outlook-style: time today, weekday this week, otherwise a short date (with the year when it is not this year).
export function formatListDate(value, now = new Date()) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (days === 0) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days > 0 && days < 7) return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString([], date.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

export function formatFullDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} KB`;
  return `${(size / 1048576).toFixed(1)} MB`;
}

// "Re:" / "Fw:" prefixes are removed so two replies in one thread share a title.
export function threadSubject(subject) {
  return String(subject || "").replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "").trim() || "(no subject)";
}

export function isValidAddress(value) {
  return /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(String(value).trim());
}

// Accepts "Jane <jane@acme.com>", "jane@acme.com", or several separated by , or ;
export function parseAddressText(text) {
  const out = [];
  for (const part of String(text || "").split(/[;,]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const angle = /^(.*)<([^<>]+)>$/.exec(trimmed);
    const address = (angle ? angle[2] : trimmed).trim();
    const name = angle ? angle[1].replace(/^["'\s]+|["'\s]+$/g, "") : "";
    out.push({ address, name, valid: isValidAddress(address) });
  }
  return out;
}

// The document shown inside the sandboxed message frame. Scripts are not allowed to run in the frame at all
// (sandbox without allow-scripts), and this policy forbids every network load except inline data: images.
export function buildMessageFrame(html) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<base target="_blank">
<style>
  html,body{margin:0;padding:0}
  body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#17211D;word-wrap:break-word;overflow-wrap:anywhere}
  img{max-width:100%;height:auto}
  table{max-width:100%}
  a{color:#0E744A}
  blockquote{margin:8px 0 8px 4px;padding-left:12px;border-left:3px solid #CBECDD;color:#53615A}
  pre{white-space:pre-wrap}
</style></head><body>${html}</body></html>`;
}

export function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
