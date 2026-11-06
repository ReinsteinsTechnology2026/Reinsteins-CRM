import { useCallback, useEffect, useState } from "react";

import { COLLECTION_KINDS, COLLECTION_LIMITS } from "../../vault/vaultCompany";
import Modal from "./Modal";
import { ExpiryPicker, PermissionPicker, RightsChips } from "./Permissions";
import { expiryText, resolveExpiry } from "./access";

// Create a collection, or change its name/description. Both are encrypted in this browser with the collection's key before they are sent.
export function CollectionForm({ session, collection, onClose, onDone }) {
  const [name, setName] = useState(collection ? collection.name : "");
  const [description, setDescription] = useState(collection ? collection.description : "");
  const [kind, setKind] = useState("general");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (collection) {
        await session.renameCollection(collection.uid, { name, description });
        onDone(collection.uid);
      } else {
        onDone(await session.createCollection({ name, description, kind }));
      }
    } catch (e) {
      setError(session.describe(e));
      setBusy(false);
    }
  };

  return (
    <Modal title={collection ? "Edit collection" : "New collection"} onClose={onClose} labelId="zv-collection-title">
      <form className="zv-modal-body zv-form" onSubmit={save} data-testid="vault-collection-form" noValidate>
        <label className="zv-field">Name
          <input data-testid="vault-collection-name" value={name} maxLength={COLLECTION_LIMITS.NAME} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="zv-field">Description (optional)
          <textarea data-testid="vault-collection-description" rows={3} value={description} maxLength={COLLECTION_LIMITS.DESCRIPTION} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {!collection && (
          <label className="zv-field">Type
            <select data-testid="vault-collection-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {COLLECTION_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
          </label>
        )}
        <p className="zv-hint">The name and description are encrypted in your browser. ZioVenture's servers store only the encrypted text.</p>
        {error && <p className="zv-error" role="alert" data-testid="vault-collection-error">{error}</p>}
        <div className="zv-row">
          <button type="submit" className="zv-btn zv-btn-primary" data-testid="vault-collection-save" disabled={busy || !name.trim()}>{busy ? "Saving…" : collection ? "Save" : "Create collection"}</button>
          <button type="button" className="zv-btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

const MEMBER_DEFAULT = { reveal: false, copy: false, edit: false, share: false, manager: false };

// Who belongs to a collection (shown to its managers only): add a colleague, change what they may do and until when, or remove them.
export function MembersDialog({ session, collection, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [people, setPeople] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [userId, setUserId] = useState("");
  const [rights, setRights] = useState({ ...MEMBER_DEFAULT });
  const [expiry, setExpiry] = useState({ choice: "none", custom: "" });
  const [editing, setEditing] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [d, directory] = await Promise.all([session.collectionDetail(collection.uid), session.loadDirectory()]);
      setDetail(d);
      setPeople(directory);
    } catch (e) {
      setError(session.describe(e));
      setDetail({ members: [] });
    }
  }, [session, collection.uid]);
  useEffect(() => { refresh(); }, [refresh]);

  const memberIds = new Set((detail ? detail.members : []).map((m) => m.userId));
  const choices = people.filter((p) => !memberIds.has(p.userId));
  const held = { reveal: true, copy: true, edit: true, share: true };

  const run = async (work, done) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await work();
      setNotice(typeof done === "function" ? done(result) : done);
      await refresh();
      await onChanged();
      return true;
    } catch (e) {
      setError(session.describe(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (event) => {
    event.preventDefault();
    if (!userId) return setError("Choose who to add.");
    const ends = resolveExpiry(expiry);
    if (ends === undefined) return setError("Choose the date the membership ends.");
    const ok = await run(() => session.addMember(collection.uid, { userId: Number(userId), rights, expiresAt: ends }), "Added. They can now open this collection with the permissions you chose.");
    if (ok) { setUserId(""); setRights({ ...MEMBER_DEFAULT }); setExpiry({ choice: "none", custom: "" }); }
  };

  const saveEdit = async () => {
    const ends = resolveExpiry(editing.expiry);
    if (ends === undefined) return setError("Choose the date the membership ends.");
    const ok = await run(() => session.updateMember(collection.uid, editing.userId, { rights: editing.rights, expiresAt: ends }), "Membership updated.");
    if (ok) setEditing(null);
  };

  const remove = async (id) => {
    const ok = await run(() => session.removeMember(collection.uid, id), "Removed. Their access to the collection has ended. Because they could open its passwords, the collection's keys should be rotated and important passwords changed.");
    if (ok) setConfirmRemove(null);
  };

  return (
    <Modal title={`Members of “${collection.name}”`} onClose={onClose} wide labelId="zv-members-title">
      <div className="zv-modal-body" data-testid="vault-members-dialog">
        {error && <p className="zv-error" role="alert" data-testid="vault-members-error">{error}</p>}
        {notice && <p className="zv-notice" role="status" data-testid="vault-members-notice">{notice}</p>}
        <h3>Current members</h3>
        {detail === null ? <p className="zv-hint">Loading…</p> : (
          <ul className="zv-grants">
            {detail.members.map((m) => (
              <li key={m.userId} data-testid={`vault-member-${m.userId}`}>
                <div className="zv-grant-head">
                  <strong>{m.name}</strong><small>{m.employeeId}</small>
                  <RightsChips rights={m.rights} />
                  <span className="zv-status active">{expiryText(m.expiresAt)}</span>
                </div>
                {editing && editing.userId === m.userId ? (
                  <div className="zv-grant-edit">
                    <PermissionPicker idPrefix="member-edit" manager value={editing.rights} held={held} onChange={(r) => setEditing({ ...editing, rights: r })} />
                    <ExpiryPicker idPrefix="member-edit-expiry" value={editing.expiry} onChange={(x) => setEditing({ ...editing, expiry: x })} />
                    <div className="zv-row">
                      <button type="button" className="zv-btn zv-btn-primary" data-testid="vault-member-save" disabled={busy} onClick={saveEdit}>Save changes</button>
                      <button type="button" className="zv-btn" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="zv-row">
                    <button type="button" className="zv-btn" data-testid={`vault-member-edit-${m.userId}`} onClick={() => setEditing({ userId: m.userId, rights: { reveal: m.rights.reveal, copy: m.rights.copy, edit: m.rights.edit, share: m.rights.share, manager: m.rights.manage }, expiry: { choice: "none", custom: "" } })}>Change access</button>
                    {confirmRemove === m.userId ? (
                      <span className="zv-confirm">Remove {m.name}? <button type="button" className="zv-btn zv-btn-danger" data-testid="vault-member-remove-confirm" disabled={busy} onClick={() => remove(m.userId)}>Yes, remove</button> <button type="button" className="zv-link" onClick={() => setConfirmRemove(null)}>No</button></span>
                    ) : (
                      <button type="button" className="zv-btn zv-btn-danger" data-testid={`vault-member-remove-${m.userId}`} onClick={() => setConfirmRemove(m.userId)}>Remove</button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <h3>Add a member</h3>
        <form className="zv-form" onSubmit={add}>
          <label className="zv-field">Person
            <select data-testid="vault-member-person" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose a colleague…</option>
              {choices.map((p) => <option key={p.userId} value={p.userId}>{p.name} ({p.employeeId})</option>)}
            </select>
          </label>
          <p className="zv-hint">Only colleagues who have set up their ZioVault appear here, because the collection's keys are encrypted for their personal key. If someone is missing, ask them to open ZioVault once.</p>
          <PermissionPicker idPrefix="member" manager value={rights} held={held} onChange={setRights} />
          <ExpiryPicker idPrefix="member-expiry" value={expiry} onChange={setExpiry} />
          <div className="zv-row"><button type="submit" className="zv-btn zv-btn-primary" data-testid="vault-member-add" disabled={busy || !userId}>{busy ? "Encrypting and adding…" : "Add member"}</button></div>
        </form>
        <p className="zv-hint">There is no hidden administrator key: only members listed here hold the collection's keys, and only managers can add people.</p>
      </div>
    </Modal>
  );
}
