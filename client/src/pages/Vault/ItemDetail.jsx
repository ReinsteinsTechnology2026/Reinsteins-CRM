import { useEffect, useState } from "react";
import { FaStar, FaRegStar, FaTrash, FaShareAlt } from "react-icons/fa";

import { safeUrl, hostOf, ITEM_KINDS } from "../../vault/itemModel";
import { getClipboard } from "../../vault/vaultRuntime";
import { expiryText, formatDate, isExpired } from "./access";
import { RightsChips } from "./Permissions";

const kindLabel = (id) => (ITEM_KINDS.find((k) => k.id === id) || { label: "Item" }).label;

// One item, whoever it belongs to. What is offered follows the rights the SERVER reported for this person (reveal, copy, edit, manage
// access, delete); the server enforces the same rights on every request, so hiding a button here is a courtesy, not the control.
export default function ItemDetail({ session, state, uid, onEdit, onClose, onShare }) {
  const item = state.items.find((i) => i.uid === uid) || state.companyItems.find((i) => i.uid === uid) || state.sharedItems.find((i) => i.uid === uid) || state.trash.find((i) => i.uid === uid);
  const [secret, setSecret] = useState(null); // decrypted only while shown; dropped on hide, on selecting another item and on lock
  const [shown, setShown] = useState(false);
  const [message, setMessage] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setSecret(null);
    setShown(false);
    setMessage(null);
    setConfirmDelete(false);
  }, [uid]);
  useEffect(() => {
    if (state.status !== "unlocked") setSecret(null);
  }, [state.status]);

  if (!item) return null;
  const trashed = Boolean(item.deletedAt);
  const url = safeUrl(item.url);
  const rights = item.rights || { reveal: true, copy: true, edit: true, share: true, manage: true };
  const owned = item.via === "owner" || item.via === undefined;
  const expired = isExpired(item.expiresAt);
  const usable = !expired && !item.corrupt;
  const canManageAccess = !trashed && usable && (owned || rights.share);
  const canDelete = !trashed && (owned || rights.manage);
  const collection = item.collectionUid ? state.collections.find((c) => c.uid === item.collectionUid) : null;
  const sharedBy = item.sharedBy ? session.nameOfUser(item.sharedBy) : null;

  const load = async () => {
    try {
      return secret || (await session.revealItem(uid));
    } catch (error) {
      setMessage(session.describe(error));
      return null;
    }
  };
  const reveal = async () => {
    if (shown) {
      setShown(false);
      setSecret(null);
      return;
    }
    const value = await load();
    if (value) {
      setSecret(value);
      setShown(true);
    }
  };
  const copyValue = async (text, label) => {
    try {
      await getClipboard().copy(text);
      session.noteCopy(uid);
      setMessage(`${label} copied. It will be cleared from the clipboard in ${state.prefs.clipboardClearSeconds || "—"} seconds where the browser allows.`);
    } catch (error) {
      setMessage(error && error.message ? error.message : "Copying failed.");
    }
  };
  const copyPassword = async () => {
    const value = await load();
    if (value) await copyValue(value.password, "Password");
  };
  const remove = async () => {
    try {
      await session.deleteItem(uid);
      onClose();
    } catch (error) {
      setMessage(session.describe(error));
    }
  };

  return (
    <article className="zv-detail" data-testid="vault-detail">
      <header>
        <div>
          <h2>{item.title}</h2>
          <span className="zv-badge">{kindLabel(item.kind)}</span>{" "}
          {item.via === "collection" && <span className="zv-badge company" data-testid="vault-source">Company{collection ? ` · ${collection.name}` : ""}</span>}
          {item.via === "grant" && <span className="zv-badge shared" data-testid="vault-source">Shared with you{sharedBy ? ` by ${sharedBy}` : ""}</span>}
          {owned && <span className="zv-badge" data-testid="vault-source">Personal</span>}
        </div>
        <div className="zv-row">
          {!trashed && owned && (
            <button type="button" className="zv-icon-btn" data-testid="vault-favorite" aria-pressed={item.favorite} aria-label={item.favorite ? "Remove from favorites" : "Add to favorites"} onClick={() => session.setFavorite(uid, !item.favorite).catch((e) => setMessage(session.describe(e)))}>
              {item.favorite ? <FaStar /> : <FaRegStar />}
            </button>
          )}
          <button type="button" className="zv-link" onClick={onClose}>Close</button>
        </div>
      </header>

      {item.corrupt && <p className="zv-error" role="alert" data-testid="vault-corrupt">This item could not be decrypted or is damaged, so its details cannot be shown.</p>}
      {!owned && item.expiresAt && (
        <p className={expired ? "zv-error" : "zv-notice"} role="status" data-testid="vault-expiry">
          {expired ? "Your access to this item has ended. Reload to remove it from your list." : `Your access ends ${formatDate(item.expiresAt)}.`}
        </p>
      )}
      {!owned && !expired && !item.corrupt && (
        <p className="zv-hint" data-testid="vault-rights">Your access: <RightsChips rights={rights} /> · {expiryText(item.expiresAt)}</p>
      )}

      {usable && (
        <dl>
          {item.url && <><dt>Website</dt><dd>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{hostOf(item.url) || item.url}</a> : <span>{item.url}</span>}</dd></>}
          {item.username && <><dt>Username</dt><dd><span data-testid="vault-detail-username">{item.username}</span> <button type="button" className="zv-link" onClick={() => copyValue(item.username, "Username")}>Copy</button></dd></>}
          {item.hasSecret && (
            <>
              <dt>{item.kind === "api_key" ? "Key" : "Password"}</dt>
              <dd>
                <span className="zv-secret" data-testid="vault-password-text">{shown && secret ? secret.password : "••••••••••••"}</span>
                {rights.reveal ? (
                  <button type="button" className="zv-btn" data-testid="vault-reveal" onClick={reveal} aria-pressed={shown}>{shown ? "Hide" : "Reveal"}</button>
                ) : (
                  <small className="zv-hint" data-testid="vault-no-reveal">You can see this item's details but not reveal its password.</small>
                )}
                {rights.reveal && rights.copy && <button type="button" className="zv-btn" data-testid="vault-copy-password" onClick={copyPassword}>Copy</button>}
              </dd>
            </>
          )}
          {item.fields.map((f, index) => <div key={index} className="zv-pair"><dt>{f.label}</dt><dd>{f.value}</dd></div>)}
          {shown && secret && secret.hidden.map((f, index) => <div key={`h${index}`} className="zv-pair"><dt>{f.label}</dt><dd>{f.value}</dd></div>)}
          {shown && secret && secret.notes && <><dt>Notes</dt><dd className="zv-notes" data-testid="vault-notes-text">{secret.notes}</dd></>}
          {owned && item.folderUid && <><dt>Folder</dt><dd>{(state.folders.find((f) => f.uid === item.folderUid) || { name: "—" }).name}</dd></>}
          <dt>Created</dt><dd>{formatDate(item.createdAt)}</dd>
          <dt>Last updated</dt><dd>{formatDate(item.updatedAt)}</dd>
          {item.lastRotatedAt && <><dt>Password changed</dt><dd>{formatDate(item.lastRotatedAt)}</dd></>}
        </dl>
      )}

      {message && <p className="zv-notice" role="status" data-testid="vault-message">{message}</p>}

      <div className="zv-row">
        {!trashed && usable && rights.edit && <button type="button" className="zv-btn" data-testid="vault-edit" onClick={() => onEdit(uid)}>Edit</button>}
        {canManageAccess && onShare && <button type="button" className="zv-btn" data-testid="vault-share" onClick={() => onShare(item)}><FaShareAlt /> Share</button>}
        {!trashed && owned && state.folders.length > 0 && usable && (
          <select aria-label="Move to folder" data-testid="vault-move" value={item.folderUid || ""} onChange={(e) => session.moveToFolder(uid, e.target.value || null).catch((err) => setMessage(session.describe(err)))}>
            <option value="">No folder</option>
            {state.folders.map((f) => <option key={f.uid} value={f.uid}>{f.name}</option>)}
          </select>
        )}
        {canDelete && !confirmDelete && <button type="button" className="zv-btn zv-btn-danger" data-testid="vault-delete" onClick={() => setConfirmDelete(true)}><FaTrash /> Delete</button>}
        {canDelete && confirmDelete && (
          <span className="zv-confirm">Move to trash? <button type="button" className="zv-btn zv-btn-danger" data-testid="vault-delete-confirm" onClick={remove}>Yes, delete</button> <button type="button" className="zv-link" onClick={() => setConfirmDelete(false)}>No</button></span>
        )}
        {trashed && <button type="button" className="zv-btn" data-testid="vault-restore" onClick={() => session.restoreItem(uid).then(onClose).catch((e) => setMessage(session.describe(e)))}>Restore</button>}
      </div>
      {rights.reveal && <p className="zv-hint">Revealing or copying a password is recorded in the item's activity log. Copying uses the clipboard, which other programs can read.</p>}
    </article>
  );
}
