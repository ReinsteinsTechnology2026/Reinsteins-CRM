import { useState } from "react";
import { FaPlus, FaUsers, FaFolderOpen, FaExclamationTriangle } from "react-icons/fa";

import { COLLECTION_KINDS } from "../../vault/vaultCompany";
import { hostOf } from "../../vault/itemModel";
import { CollectionForm, MembersDialog } from "./CollectionDialogs";
import ItemDetail from "./ItemDetail";
import { RightsChips } from "./Permissions";
import { expiryText, isExpired } from "./access";

const kindName = (id) => (COLLECTION_KINDS.find((k) => k.id === id) || { label: "General" }).label;

// The Company Vault: the collections this person belongs to (names and descriptions decrypted here), and inside one, its items.
export default function CompanyVault({ session, state, selected, setSelected, onEdit, onShare, onNewItem, openUid, setOpenUid }) {
  const [dialog, setDialog] = useState(null); // "create" | "edit" | "members"
  const [message, setMessage] = useState(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const now = Date.now();
  const collections = state.collections.filter((c) => !isExpired(c.expiresAt, now));
  const open = openUid ? collections.find((c) => c.uid === openUid) : null;

  const archive = async () => {
    try {
      await session.archiveCollection(open.uid);
      setOpenUid(null);
      setConfirmArchive(false);
      setMessage("Collection archived. Its items are hidden from everyone; nothing was deleted.");
    } catch (error) {
      setMessage(session.describe(error));
    }
  };

  if (!open) {
    return (
      <section className="zv-company" data-testid="vault-company">
        <div className="zv-pagehead">
          <div>
            <h2>Company Vault</h2>
            <p className="zv-hint">Shared collections of passwords and secrets. Each collection has its own encryption keys, held only by its members.</p>
          </div>
          {state.canCreateCollections && <button type="button" className="zv-btn zv-btn-primary" data-testid="vault-collection-new" onClick={() => setDialog("create")}><FaPlus /> New collection</button>}
        </div>
        {message && <p className="zv-notice" role="status" data-testid="vault-company-message">{message}</p>}
        {collections.length === 0 ? (
          <div className="zv-empty" data-testid="vault-company-empty">
            <FaFolderOpen aria-hidden="true" />
            <p>You are not a member of any company collection yet.</p>
            <p className="zv-hint">{state.canCreateCollections ? "Create the first collection, then add the colleagues who need it." : "A company administrator or a collection manager can add you to one."}</p>
          </div>
        ) : (
          <ul className="zv-cards">
            {collections.map((c) => (
              <li key={c.uid}>
                <button type="button" className="zv-card" data-testid={`vault-collection-${c.uid}`} onClick={() => { setOpenUid(c.uid); setSelected(null); setMessage(null); }}>
                  <span className="zv-card-top"><strong>{c.name}</strong><span className="zv-badge">{kindName(c.kind)}</span></span>
                  {c.description && <span className="zv-card-desc">{c.description}</span>}
                  <span className="zv-card-meta"><FaUsers aria-hidden="true" /> {c.itemCount} item{c.itemCount === 1 ? "" : "s"}</span>
                  <span className="zv-card-meta"><RightsChips rights={c.rights} /></span>
                  {c.expiresAt && <span className="zv-card-meta">{expiryText(c.expiresAt)}</span>}
                  {c.rotationRequired && <span className="zv-card-warn"><FaExclamationTriangle aria-hidden="true" /> Keys should be rotated</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {dialog === "create" && <CollectionForm session={session} onClose={() => setDialog(null)} onDone={(uid) => { setDialog(null); setOpenUid(uid); }} />}
      </section>
    );
  }

  const items = state.companyItems.filter((i) => i.collectionUid === open.uid && !isExpired(i.expiresAt, now)).sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  const manager = Boolean(open.rights.manage);

  return (
    <section className="zv-company" data-testid="vault-collection-view">
      <div className="zv-pagehead">
        <div>
          <button type="button" className="zv-link" data-testid="vault-collection-back" onClick={() => { setOpenUid(null); setSelected(null); }}>← All collections</button>
          <h2>{open.name} <span className="zv-badge">{kindName(open.kind)}</span></h2>
          {open.description && <p className="zv-lead" data-testid="vault-collection-about">{open.description}</p>}
          <p className="zv-hint">Your access: <RightsChips rights={open.rights} /> · {expiryText(open.expiresAt)}</p>
        </div>
        <div className="zv-row">
          {open.rights.edit && <button type="button" className="zv-btn zv-btn-primary" data-testid="vault-collection-additem" onClick={() => onNewItem(open.uid)}><FaPlus /> Add item</button>}
          {manager && <button type="button" className="zv-btn" data-testid="vault-collection-members" onClick={() => setDialog("members")}><FaUsers /> Members</button>}
          {manager && <button type="button" className="zv-btn" data-testid="vault-collection-edit" onClick={() => setDialog("edit")}>Rename</button>}
          {manager && !confirmArchive && <button type="button" className="zv-btn zv-btn-danger" data-testid="vault-collection-archive" onClick={() => setConfirmArchive(true)}>Archive</button>}
          {manager && confirmArchive && <span className="zv-confirm">Archive this collection? <button type="button" className="zv-btn zv-btn-danger" data-testid="vault-collection-archive-confirm" onClick={archive}>Yes, archive</button> <button type="button" className="zv-link" onClick={() => setConfirmArchive(false)}>No</button></span>}
        </div>
      </div>
      {open.rotationRequired && (
        <p className="zv-warning-line" role="status" data-testid="vault-collection-rotation"><FaExclamationTriangle aria-hidden="true" /> Someone who could open this collection's passwords lost access. Change the important passwords in it. Re-keying a whole collection is not available in this version.</p>
      )}
      {message && <p className="zv-notice" role="status">{message}</p>}

      <div className="zv-split">
        <div className="zv-listpane">
          <h2 className="zv-listtitle">Items <span>{items.length}</span></h2>
          {items.length === 0 ? (
            <div className="zv-empty" data-testid="vault-collection-empty"><p>No items in this collection yet.</p>{open.rights.edit && <button type="button" className="zv-btn zv-btn-primary" onClick={() => onNewItem(open.uid)}>Add the first item</button>}</div>
          ) : (
            <ul className="zv-list">
              {items.map((item) => (
                <li key={item.uid}>
                  <button type="button" className={selected === item.uid ? "on" : ""} data-testid={`vault-item-${item.uid}`} onClick={() => setSelected(item.uid)}>
                    <span className="zv-avatar" aria-hidden="true">{(item.title || "?").charAt(0).toUpperCase()}</span>
                    <span className="zv-itemtext"><strong>{item.title}</strong><small>{item.username || hostOf(item.url) || "Item"}</small></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="zv-detailpane">
          {selected && items.some((i) => i.uid === selected) ? <ItemDetail key={selected} session={session} state={state} uid={selected} onEdit={onEdit} onShare={onShare} onClose={() => setSelected(null)} /> : <div className="zv-empty"><p>Select an item to see its details.</p></div>}
        </div>
      </div>

      {dialog === "edit" && <CollectionForm session={session} collection={open} onClose={() => setDialog(null)} onDone={() => setDialog(null)} />}
      {dialog === "members" && <MembersDialog session={session} collection={open} onClose={() => setDialog(null)} onChanged={() => session.reload()} />}
    </section>
  );
}
