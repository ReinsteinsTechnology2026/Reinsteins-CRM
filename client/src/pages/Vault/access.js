// Small helpers for showing access: what a share or membership allows, and whether it has ended.
export const isExpired = (expiresAt, now = Date.now()) => Boolean(expiresAt) && Date.parse(expiresAt) <= now;

export const formatDate = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

export function expiryText(expiresAt, now = Date.now()) {
  if (!expiresAt) return "No expiry";
  return isExpired(expiresAt, now) ? `Expired ${formatDate(expiresAt)}` : `Until ${formatDate(expiresAt)}`;
}

// Turns the choice in the "expires" control into the ISO time the server wants (or null for none).
export function expiryFromChoice(choice, customDate, now = Date.now()) {
  if (choice === "none") return null;
  if (choice === "custom") {
    if (!customDate) return undefined;
    const end = new Date(`${customDate}T23:59:59`);
    return Number.isNaN(end.getTime()) ? undefined : end.toISOString();
  }
  const days = Number(choice);
  return Number.isFinite(days) && days > 0 ? new Date(now + days * 86400000).toISOString() : null;
}

export const PERMISSIONS = Object.freeze([
  { id: "reveal", label: "Reveal password", help: "Can show the password, notes and hidden fields." },
  { id: "copy", label: "Copy password", help: "Can copy the password to the clipboard (needs Reveal)." },
  { id: "edit", label: "Edit item", help: "Can change the item's details and password (needs Reveal)." },
  { id: "share", label: "Manage access", help: "Can share this item with others and change or end their access." },
]);

export const resolveExpiry = (value) => expiryFromChoice(value.choice, value.custom);
