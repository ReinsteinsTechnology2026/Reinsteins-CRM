import { useEffect, useState } from "react";
import { FaShareAlt } from "react-icons/fa";

import { hostOf } from "../../vault/itemModel";
import ItemDetail from "./ItemDetail";
import { RightsChips } from "./Permissions";
import { expiryText, formatDate, isExpired } from "./access";

// "Shared with me": single items other people shared with this person. Items whose access has ended are not listed (and the server no longer
// returns their content): only a count remains.
export function SharedWithMe({ session, state, selected, setSelected, onEdit }) {
  const [loadError, setLoadError] = useState(null);
  const [, setNamesLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    session.loadDirectory().then(() => live && setNamesLoaded(true)).catch((e) => live && setLoadError(session.describe(e))); // to show who shared each item
    return () => { live = false; };
  }, [session]);

  const now = Date.now();
  const live = state.sharedItems.filter((i) => !isExpired(i.expiresAt, now)).sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  const ended = state.sharedItems.length - live.length;
  const sender = (item) => (item.sharedBy ? session.nameOfUser(item.sharedBy) : null);

  return (
    <section className="zv-company" data-testid="vault-shared-with-me">
      <div className="zv-pagehead">
        <div>
          <h2>Shared with me</h2>
          <p className="zv-hint">Individual items colleagues shared with you. What you can do with each one depends on the permissions you were given.</p>
        </div>
      </div>
      {loadError && <p className="zv-error" role="alert">{loadError}</p>}
      {ended > 0 && <p className="zv-notice" role="status" data-testid="vault-shared-ended">{ended} shared item{ended === 1 ? " has" : "s have"} expired and {ended === 1 ? "is" : "are"} no longer available.</p>}
      <div className="zv-split">
        <div className="zv-listpane">
          <h2 className="zv-listtitle">Items <span>{live.length}</span></h2>
          {live.length === 0 ? (
            <div className="zv-empty" data-testid="vault-shared-empty"><FaShareAlt aria-hidden="true" /><p>Nothing has been shared with you.</p></div>
          ) : (
            <ul className="zv-list">
              {live.map((item) => (
                <li key={item.uid}>
                  <button type="button" className={selected === item.uid ? "on" : ""} data-testid={`vault-item-${item.uid}`} onClick={() => setSelected(item.uid)}>
                    <span className="zv-avatar" aria-hidden="true">{(item.title || "?").charAt(0).toUpperCase()}</span>
                    <span className="zv-itemtext"><strong>{item.title}</strong><small>{sender(item) ? `From ${sender(item)}` : item.username || hostOf(item.url) || "Shared item"} · {expiryText(item.expiresAt)}</small></span>
                    <RightsChips rights={item.rights} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="zv-detailpane">
          {selected && live.some((i) => i.uid === selected) ? <ItemDetail key={selected} session={session} state={state} uid={selected} onEdit={onEdit} onClose={() => setSelected(null)} /> : <div className="zv-empty"><p>Select an item to see its details.</p></div>}
        </div>
      </div>
    </section>
  );
}

// "Shared by me": every share this person made, with the recipient, permissions, expiry and status (active, expired or ended).
export function SharedByMe({ session, state, onManage }) {
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    session.loadOutgoing().catch((e) => live && setError(session.describe(e))).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [session]);

  const known = new Map([...state.items, ...state.companyItems, ...state.sharedItems].map((i) => [i.uid, i]));
  const rows = state.outgoing;

  return (
    <section className="zv-company" data-testid="vault-shared-by-me">
      <div className="zv-pagehead">
        <div>
          <h2>Shared by me</h2>
          <p className="zv-hint">Everything you have shared and with whom. Ended shares stay listed for 30 days.</p>
        </div>
      </div>
      {error && <p className="zv-error" role="alert" data-testid="vault-outgoing-error">{error}</p>}
      {loading ? <p className="zv-hint">Loading…</p> : rows.length === 0 ? (
        <div className="zv-empty" data-testid="vault-outgoing-empty"><FaShareAlt aria-hidden="true" /><p>You have not shared anything yet.</p><p className="zv-hint">Open an item and choose Share to give a colleague access to it.</p></div>
      ) : (
        <table className="zv-table" data-testid="vault-outgoing-table">
          <thead><tr><th>Item</th><th>Shared with</th><th>Permissions</th><th>Access</th><th>Status</th><th><span className="zv-sr">Actions</span></th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const item = known.get(r.itemUid);
              return (
                <tr key={r.grantId} data-testid={`vault-outgoing-${r.grantId}`} data-status={r.status}>
                  <td data-label="Item">{r.title}</td>
                  <td data-label="Shared with">{r.name} <small>{r.employeeId}</small></td>
                  <td data-label="Permissions"><RightsChips rights={r.rights} /></td>
                  <td data-label="Access">{r.status === "revoked" ? `Ended ${formatDate(r.revokedAt)}` : expiryText(r.expiresAt)}</td>
                  <td data-label="Status"><span className={`zv-status ${r.status}`}>{r.status === "active" ? "Active" : r.status === "expired" ? "Expired" : "Ended"}</span></td>
                  <td>{r.status === "active" && item && <button type="button" className="zv-btn" data-testid={`vault-outgoing-manage-${r.grantId}`} onClick={() => onManage(item)}>Manage</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
