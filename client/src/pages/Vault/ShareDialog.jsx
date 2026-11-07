import { useCallback, useEffect, useState } from "react";

import Modal from "./Modal";
import { ExpiryPicker, PermissionPicker, RightsChips } from "./Permissions";
import { expiryText, resolveExpiry } from "./access";

const NO_RIGHTS = { reveal: false, copy: false, edit: false, share: false };

// Manage who can open ONE item: see who has access and until when, change permissions, end access, or share with someone new.
// Sharing one item never opens the rest of the owner's vault: only this item's keys are wrapped for the recipient.
export default function ShareDialog({ session, item, onClose, onChanged }) {
  const [grants, setGrants] = useState(null);
  const [people, setPeople] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [recipientId, setRecipientId] = useState("");
  const [rights, setRights] = useState({ ...NO_RIGHTS });
  const [expiry, setExpiry] = useState({ choice: "none", custom: "" });
  const [editing, setEditing] = useState(null); // { userId, rights, expiry }
  const [confirmRemove, setConfirmRemove] = useState(null);

  const held = { reveal: item.rights.reveal, copy: item.rights.copy, edit: item.rights.edit, share: item.via === "owner" || Boolean(item.rights.manage) };

  const refresh = useCallback(async () => {
    try {
      const [list, directory] = await Promise.all([session.listGrants(item.uid), session.loadDirectory()]);
      setGrants(list);
      setPeople(directory);
    } catch (e) {
      setError(session.describe(e));
      setGrants([]);
    }
  }, [session, item.uid]);

  useEffect(() => { refresh(); }, [refresh]);

  const taken = new Set((grants || []).map((g) => g.recipientUserId));
  const choices = people.filter((p) => !taken.has(p.userId));

  const run = async (work, done) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
      await refresh();
      if (onChanged) onChanged();
      return true;
    } catch (e) {
      setError(session.describe(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const share = async (event) => {
    event.preventDefault();
    if (!recipientId) return setError("Choose who to share with.");
    const ends = resolveExpiry(expiry);
    if (ends === undefined) return setError("Choose the date the access ends.");
    const ok = await run(() => session.shareItem(item.uid, { recipientUserId: Number(recipientId), rights, expiresAt: ends }), "Shared. They can now open this item with the permissions you chose.");
    if (ok) { setRecipientId(""); setRights({ ...NO_RIGHTS }); setExpiry({ choice: "none", custom: "" }); }
  };

  const saveEdit = async () => {
    const ends = resolveExpiry(editing.expiry);
    if (ends === undefined) return setError("Choose the date the access ends.");
    const ok = await run(() => session.updateGrant(item.uid, editing.userId, { rights: editing.rights, expiresAt: ends }), "Access updated.");
    if (ok) setEditing(null);
  };

  const remove = async (userId) => {
    const ok = await run(() => session.revokeGrant(item.uid, userId), "Access ended. If they could reveal the password, consider changing it.");
    if (ok) setConfirmRemove(null);
  };

  return (
    <Modal title={`Share “${item.title}”`} onClose={onClose} wide labelId="zv-share-title">
      <div className="zv-modal-body" data-testid="vault-share-dialog">
        {error && <p className="zv-error" role="alert" data-testid="vault-share-error">{error}</p>}
        {notice && <p className="zv-notice" role="status" data-testid="vault-share-notice">{notice}</p>}

        <h3>People with access</h3>
        {grants === null ? <p className="zv-hint">Loading…</p> : grants.length === 0 ? <p className="zv-hint" data-testid="vault-share-none">Not shared with anyone yet.</p> : (
          <ul className="zv-grants">
            {grants.map((g) => (
              <li key={g.grantId} data-testid={`vault-grant-${g.recipientUserId}`}>
                <div className="zv-grant-head">
                  <strong>{g.name}</strong><small>{g.employeeId}</small>
                  <RightsChips rights={g.rights} />
                  <span className={`zv-status ${g.expired ? "expired" : "active"}`}>{g.expired ? "Expired" : "Active"} · {expiryText(g.expiresAt)}</span>
                </div>
                {editing && editing.userId === g.recipientUserId ? (
                  <div className="zv-grant-edit">
                    <PermissionPicker idPrefix="edit" value={editing.rights} held={held} onChange={(r) => setEditing({ ...editing, rights: r })} />
                    <ExpiryPicker idPrefix="edit-expiry" value={editing.expiry} onChange={(x) => setEditing({ ...editing, expiry: x })} />
                    <div className="zv-row">
                      <button type="button" className="zv-btn zv-btn-primary" data-testid="vault-grant-save" disabled={busy} onClick={saveEdit}>Save changes</button>
                      <button type="button" className="zv-btn" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="zv-row">
                    <button type="button" className="zv-btn" data-testid={`vault-grant-edit-${g.recipientUserId}`} onClick={() => setEditing({ userId: g.recipientUserId, rights: { ...g.rights }, expiry: { choice: "none", custom: "" } })}>Change access</button>
                    {confirmRemove === g.recipientUserId ? (
                      <span className="zv-confirm">End access for {g.name}? <button type="button" className="zv-btn zv-btn-danger" data-testid="vault-grant-revoke-confirm" disabled={busy} onClick={() => remove(g.recipientUserId)}>Yes, end access</button> <button type="button" className="zv-link" onClick={() => setConfirmRemove(null)}>No</button></span>
                    ) : (
                      <button type="button" className="zv-btn zv-btn-danger" data-testid={`vault-grant-revoke-${g.recipientUserId}`} onClick={() => setConfirmRemove(g.recipientUserId)}>End access</button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <h3>Share with someone</h3>
        <form className="zv-form" onSubmit={share}>
          <label className="zv-field">Person
            <select data-testid="vault-share-recipient" value={recipientId} onChange={(e) => setRecipientId(e.target.value)}>
              <option value="">Choose a colleague…</option>
              {choices.map((p) => <option key={p.userId} value={p.userId}>{p.name} ({p.employeeId})</option>)}
            </select>
          </label>
          <p className="zv-hint">Only colleagues who have set up their ZioVault appear here, because the item is encrypted for their personal key. If someone is missing, ask them to open ZioVault once.</p>
          <PermissionPicker idPrefix="share" value={rights} held={held} onChange={setRights} />
          <ExpiryPicker idPrefix="share-expiry" value={expiry} onChange={setExpiry} />
          <div className="zv-row">
            <button type="submit" className="zv-btn zv-btn-primary" data-testid="vault-share-submit" disabled={busy || !recipientId}>{busy ? "Encrypting and sharing…" : "Share"}</button>
          </div>
        </form>
        <p className="zv-hint">Only this item is shared. Nothing else in your vault becomes visible to them. If you end someone's access after they could reveal the password, change the password: they have already seen it.</p>
      </div>
    </Modal>
  );
}
