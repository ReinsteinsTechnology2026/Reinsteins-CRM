// How the audit trail reads to a person. The server records a closed vocabulary of actions (never a title, a name or a secret); the titles shown
// beside them are looked up here, from items this person can already open.

export const AUDIT_ACTIONS = Object.freeze([
  { kind: "secret_delivered", label: "Password opened", verb: "opened the password of" },
  { kind: "reveal_reported", label: "Password shown (reported by the browser)", verb: "showed the password of" },
  { kind: "copy_reported", label: "Password copied (reported by the browser)", verb: "copied the password of" },
  { kind: "item_created", label: "Item created", verb: "created" },
  { kind: "item_updated", label: "Item edited", verb: "edited" },
  { kind: "item_deleted", label: "Item deleted", verb: "deleted" },
  { kind: "item_restored", label: "Item restored", verb: "restored" },
  { kind: "item_rotated", label: "Item re-keyed", verb: "re-keyed" },
  { kind: "rotation_completed", label: "Password changed (recorded)", verb: "recorded a password change for" },
  { kind: "rotation_reminded", label: "Rotation reminder sent", verb: "was reminded to rotate" },
  { kind: "item_shared", label: "Item shared", verb: "shared" },
  { kind: "share_changed", label: "Share changed", verb: "changed the access to" },
  { kind: "share_revoked", label: "Share ended", verb: "ended the access to" },
  { kind: "access_expired", label: "Access expired", verb: "access expired for" },
  { kind: "attachment_added", label: "File added", verb: "added a file to" },
  { kind: "attachment_delivered", label: "File opened", verb: "opened a file of" },
  { kind: "attachment_deleted", label: "File deleted", verb: "deleted a file from" },
  { kind: "collection_created", label: "Collection created", verb: "created the collection" },
  { kind: "collection_renamed", label: "Collection renamed", verb: "renamed the collection" },
  { kind: "collection_archived", label: "Collection archived", verb: "archived the collection" },
  { kind: "collection_member_added", label: "Member added", verb: "added a member to" },
  { kind: "collection_member_changed", label: "Member access changed", verb: "changed a member's access in" },
  { kind: "collection_member_removed", label: "Member removed", verb: "removed a member from" },
  { kind: "collection_rotated", label: "Collection re-keyed", verb: "re-keyed the collection" },
  { kind: "vault_access_revoked", label: "Company vault access ended", verb: "ended company vault access for" },
  { kind: "employee_deactivated", label: "Employee deactivated", verb: "was deactivated: vault access ended for" },
]);

const BY_KIND = new Map(AUDIT_ACTIONS.map((a) => [a.kind, a]));

export function auditSentence(event) {
  const action = BY_KIND.get(event.kind);
  const verb = action ? action.verb : event.kind.replace(/_/g, " ");
  const object = event.itemTitle ? `“${event.itemTitle}”` : event.collectionName ? `“${event.collectionName}”` : event.subjectName ? event.subjectName : "";
  const who = event.subjectName && event.subjectUserId !== event.actorUserId && !event.itemUid && !event.itemTitle ? ` (${event.subjectName})` : "";
  const target = event.itemTitle && event.subjectName && event.subjectUserId !== event.actorUserId ? ` for ${event.subjectName}` : "";
  return `${verb} ${object}${target}${who}`.replace(/\s+/g, " ").trim();
}

export function evidenceNote(evidence) {
  if (evidence === "server_observed_delivery") return "Recorded by the server";
  if (evidence === "client_reported") return "Reported by a browser";
  return "Recorded by the server";
}
