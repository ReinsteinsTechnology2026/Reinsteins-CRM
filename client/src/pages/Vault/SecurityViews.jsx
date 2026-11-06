import { useCallback, useEffect, useMemo, useState } from "react";
import { FaPaperclip, FaSyncAlt, FaHistory, FaUserSlash, FaKey as FaKeyIcon, FaExclamationTriangle } from "react-icons/fa";

import { formatSize } from "../../vault/attachmentModel";
import { REMINDER_WINDOWS, SEVERITY, STATUS_LABELS, describeRotation, rotationStatus } from "../../vault/rotation";
import { AUDIT_ACTIONS, auditSentence, evidenceNote } from "./auditLabels";
import { formatDate } from "./access";
import Modal from "./Modal";
import { RotationBadge } from "./RotationPanel";

const sourceOf = (item) => (item.via === "owner" ? "Personal" : item.via === "collection" ? "Company" : "Shared with you");

// ---------------------------------------------------------------------------------------------------------------- attachments
// Every file attached to anything this person can see: size and date only (names are encrypted under each item's own keys, so they appear
// when the item is opened).
export function AttachmentsView({ session, state, onOpenItem }) {
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    session.loadAllAttachments().catch((e) => live && setError(session.describe(e))).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [session]);

  const items = new Map([...state.items, ...state.companyItems, ...state.sharedItems].map((i) => [i.uid, i]));
  const groups = new Map();
  for (const a of state.attachments) {
    if (!groups.has(a.itemUid)) groups.set(a.itemUid, []);
    groups.get(a.itemUid).push(a);
  }
  const rows = [...groups.entries()].filter(([uid]) => items.has(uid)).sort((a, b) => items.get(a[0]).title.localeCompare(items.get(b[0]).title, undefined, { sensitivity: "base" }));

  return (
    <section className="zv-company" data-testid="vault-attachments-view">
      <div className="zv-pagehead"><div><h2>Secure attachments</h2><p className="zv-hint">Files stored with your items, encrypted in your browser. Open an item to see file names, download or add files.</p></div></div>
      {error && <p className="zv-error" role="alert">{error}</p>}
      {loading ? <p className="zv-hint">Loading…</p> : rows.length === 0 ? (
        <div className="zv-empty" data-testid="vault-attachments-empty"><FaPaperclip aria-hidden="true" /><p>No attachments yet.</p><p className="zv-hint">Open an item and choose Add a file.</p></div>
      ) : (
        <table className="zv-table" data-testid="vault-attachments-table">
          <thead><tr><th>Item</th><th>Where</th><th>Files</th><th>Size</th><th>Latest</th><th><span className="zv-sr">Actions</span></th></tr></thead>
          <tbody>
            {rows.map(([uid, list]) => {
              const item = items.get(uid);
              return (
                <tr key={uid} data-testid={`vault-attachments-row-${uid}`}>
                  <td data-label="Item">{item.title}</td>
                  <td data-label="Where">{sourceOf(item)}</td>
                  <td data-label="Files">{list.length}</td>
                  <td data-label="Size">{formatSize(list.reduce((n, a) => n + a.size, 0))}</td>
                  <td data-label="Latest">{formatDate(list.map((a) => a.createdAt).sort().pop())}</td>
                  <td><button type="button" className="zv-btn" data-testid={`vault-attachments-open-${uid}`} onClick={() => onOpenItem(item)}>Open item</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------- rotation status
export function RotationView({ session, state, onOpenItem }) {
  const [filter, setFilter] = useState("attention");
  const [busyUid, setBusyUid] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const warnDays = state.prefs.rotationWarnDays;
  const now = Date.now();

  const rows = useMemo(() => {
    const all = [...state.items, ...state.companyItems, ...state.sharedItems.filter((i) => i.rights && (i.rights.manage || i.rights.edit))]
      .filter((i) => !i.corrupt && !(i.expiresAt && Date.parse(i.expiresAt) <= now))
      .map((item) => ({ item, status: rotationStatus(item, { now, warnDays }) }))
      .filter((r) => r.status.status !== "none");
    return all.sort((a, b) => SEVERITY[a.status.status] - SEVERITY[b.status.status] || String(a.status.dueAt).localeCompare(String(b.status.dueAt)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.items, state.companyItems, state.sharedItems, warnDays]);

  const counts = { required: 0, overdue: 0, due: 0, upcoming: 0, ok: 0 };
  for (const r of rows) counts[r.status.status] += 1;
  const shown = rows.filter((r) => (filter === "attention" ? ["required", "overdue", "due", "upcoming"].includes(r.status.status) : filter === "all" ? true : r.status.status === filter));

  const complete = async (item) => {
    setBusyUid(item.uid);
    setError(null);
    setNotice(null);
    try {
      await session.completeRotation(item.uid);
      setNotice(`Recorded: "${item.title}" was changed.`);
    } catch (e) {
      setError(session.describe(e));
    } finally {
      setBusyUid(null);
    }
  };

  return (
    <section className="zv-company" data-testid="vault-rotation-view">
      <div className="zv-pagehead">
        <div><h2>Rotation status</h2><p className="zv-hint">Which passwords are due to be changed. Set a schedule on an item; reminders go to its owner, or to the managers of its collection.</p></div>
        <label className="zv-field zv-inline-field">Warn me
          <select data-testid="vault-rotation-warn" value={warnDays} onChange={(e) => session.setPrefs({ rotationWarnDays: Number(e.target.value) })}>
            {REMINDER_WINDOWS.map((d) => <option key={d} value={d}>{d} days before</option>)}
          </select>
        </label>
      </div>
      <div className="zv-stats" data-testid="vault-rotation-summary">
        {["required", "overdue", "due", "upcoming", "ok"].map((k) => <div key={k} className={`zv-stat ${k === "overdue" || k === "required" ? "bad" : k === "due" ? "warn" : k === "ok" ? "good" : ""}`}><strong>{counts[k]}</strong><span>{STATUS_LABELS[k]}</span></div>)}
      </div>
      <label className="zv-field">Show
        <select data-testid="vault-rotation-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="attention">Needs attention</option><option value="all">Everything scheduled</option>
          {["required", "overdue", "due", "upcoming", "ok"].map((k) => <option key={k} value={k}>{STATUS_LABELS[k]}</option>)}
        </select>
      </label>
      {error && <p className="zv-error" role="alert" data-testid="vault-rotation-view-error">{error}</p>}
      {notice && <p className="zv-notice" role="status" data-testid="vault-rotation-view-notice">{notice}</p>}
      {shown.length === 0 ? (
        <div className="zv-empty" data-testid="vault-rotation-empty"><FaSyncAlt aria-hidden="true" /><p>{rows.length === 0 ? "No passwords have a rotation schedule yet." : "Nothing in this group."}</p><p className="zv-hint">Open an item and set how often it should be changed.</p></div>
      ) : (
        <table className="zv-table" data-testid="vault-rotation-table">
          <thead><tr><th>Item</th><th>Where</th><th>Status</th><th>When</th><th><span className="zv-sr">Actions</span></th></tr></thead>
          <tbody>
            {shown.map(({ item, status }) => {
              const mayComplete = item.via === "owner" || (item.rights && (item.rights.manage || item.rights.edit));
              return (
                <tr key={item.uid} data-testid={`vault-rotation-row-${item.uid}`} data-status={status.status}>
                  <td data-label="Item">{item.title}</td>
                  <td data-label="Where">{sourceOf(item)}</td>
                  <td data-label="Status"><RotationBadge item={item} warnDays={warnDays} /></td>
                  <td data-label="When">{describeRotation(status)}</td>
                  <td className="zv-row">
                    <button type="button" className="zv-btn" data-testid={`vault-rotation-open-${item.uid}`} onClick={() => onOpenItem(item)}>Open</button>
                    {mayComplete && <button type="button" className="zv-btn" data-testid={`vault-rotation-done-${item.uid}`} disabled={busyUid === item.uid} onClick={() => complete(item)}>I changed it</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------- audit activity (managers)
const dayStart = (value) => (value ? new Date(`${value}T00:00:00`).toISOString() : undefined);
const dayEnd = (value) => (value ? new Date(`${value}T23:59:59.999`).toISOString() : undefined);

export function AuditView({ session, state }) {
  const managed = state.collections.filter((c) => c.rights.manage);
  const [filters, setFilters] = useState({ collectionUid: "", userId: "", kind: "", from: "", to: "" });
  const [events, setEvents] = useState(null);
  const [next, setNext] = useState(null);
  const [people, setPeople] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const query = useCallback((f, before) => ({ collectionUid: f.collectionUid, userId: f.userId, kind: f.kind, from: dayStart(f.from), to: dayEnd(f.to), limit: 25, before }), []);

  const run = useCallback(async (f) => {
    setBusy(true);
    setError(null);
    try {
      const data = await session.loadAudit(query(f));
      setEvents(data.events);
      setNext(data.nextBefore);
    } catch (e) {
      setError(session.describe(e));
      setEvents([]);
      setNext(null);
    } finally {
      setBusy(false);
    }
  }, [session, query]);

  useEffect(() => {
    run({ collectionUid: "", userId: "", kind: "", from: "", to: "" });
    session.loadDirectory().then(setPeople).catch(() => {});
  }, [session, run]);

  const more = async () => {
    setBusy(true);
    try {
      const data = await session.loadAudit(query(filters, next));
      setEvents((prev) => [...prev, ...data.events]);
      setNext(data.nextBefore);
    } catch (e) {
      setError(session.describe(e));
    } finally {
      setBusy(false);
    }
  };

  const set = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }));
  const apply = (event) => { event.preventDefault(); run(filters); };
  const reset = () => { const blank = { collectionUid: "", userId: "", kind: "", from: "", to: "" }; setFilters(blank); run(blank); };

  return (
    <section className="zv-company" data-testid="vault-audit-view">
      <div className="zv-pagehead"><div><h2>Audit activity</h2><p className="zv-hint">Who revealed, shared, changed or removed what in the collections you manage. Only completed actions are recorded; passwords and notes are never part of it.</p></div></div>
      <form className="zv-filters" onSubmit={apply} data-testid="vault-audit-filters">
        <label className="zv-field">Collection
          <select data-testid="vault-audit-collection" value={filters.collectionUid} onChange={set("collectionUid")}><option value="">All I manage</option>{managed.map((c) => <option key={c.uid} value={c.uid}>{c.name}</option>)}</select>
        </label>
        <label className="zv-field">Employee
          <select data-testid="vault-audit-user" value={filters.userId} onChange={set("userId")}><option value="">Anyone</option>{people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}</select>
        </label>
        <label className="zv-field">Action
          <select data-testid="vault-audit-kind" value={filters.kind} onChange={set("kind")}><option value="">Any action</option>{AUDIT_ACTIONS.map((a) => <option key={a.kind} value={a.kind}>{a.label}</option>)}</select>
        </label>
        <label className="zv-field">From<input type="date" data-testid="vault-audit-from" value={filters.from} onChange={set("from")} /></label>
        <label className="zv-field">To<input type="date" data-testid="vault-audit-to" value={filters.to} onChange={set("to")} /></label>
        <div className="zv-row"><button type="submit" className="zv-btn zv-btn-primary" data-testid="vault-audit-apply" disabled={busy}>Apply</button><button type="button" className="zv-btn" onClick={reset}>Reset</button></div>
      </form>
      {error && <p className="zv-error" role="alert" data-testid="vault-audit-error">{error}</p>}
      {events === null ? <p className="zv-hint">Loading…</p> : events.length === 0 ? (
        <div className="zv-empty" data-testid="vault-audit-empty"><FaHistory aria-hidden="true" /><p>No activity matches.</p></div>
      ) : (
        <table className="zv-table" data-testid="vault-audit-table">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Result</th><th>How we know</th></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} data-testid={`vault-audit-event-${e.id}`} data-kind={e.kind}>
                <td data-label="When">{formatDate(e.at)}</td>
                <td data-label="Who">{e.actorName || "The system"}</td>
                <td data-label="What">{auditSentence(e)}</td>
                <td data-label="Result">Completed</td>
                <td data-label="How we know"><span className="zv-chip">{evidenceNote(e.evidence)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next && <div className="zv-row"><button type="button" className="zv-btn" data-testid="vault-audit-more" disabled={busy} onClick={more}>Load older activity</button></div>}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------- collection key management
export function KeysView({ session, state }) {
  const managed = state.collections.filter((c) => c.rights.manage);
  const [target, setTarget] = useState(null);
  return (
    <section className="zv-company" data-testid="vault-keys-view">
      <div className="zv-pagehead"><div><h2>Collection keys</h2><p className="zv-hint">Each collection is protected by its own keys, held only by its members. Re-keying makes new keys for the collection and every item, so people who were removed cannot use old keys on anything new.</p></div></div>
      {managed.length === 0 ? (
        <div className="zv-empty" data-testid="vault-keys-empty"><FaKeyIcon aria-hidden="true" /><p>You do not manage any collection.</p><p className="zv-hint">Only a collection's managers can re-key it.</p></div>
      ) : (
        <table className="zv-table" data-testid="vault-keys-table">
          <thead><tr><th>Collection</th><th>Key version</th><th>Items</th><th>Status</th><th><span className="zv-sr">Actions</span></th></tr></thead>
          <tbody>
            {managed.map((c) => (
              <tr key={c.uid} data-testid={`vault-keys-row-${c.uid}`}>
                <td data-label="Collection">{c.name}</td>
                <td data-label="Key version" data-testid={`vault-keys-version-${c.uid}`}>{c.keyVersion}</td>
                <td data-label="Items">{c.itemCount}</td>
                <td data-label="Status">{c.rotationRequired ? <span className="zv-rot zv-rot-required"><FaExclamationTriangle aria-hidden="true" /> Re-key recommended</span> : <span className="zv-rot zv-rot-ok">Up to date</span>}</td>
                <td><button type="button" className="zv-btn" data-testid={`vault-keys-rekey-${c.uid}`} onClick={() => setTarget(c)}>Re-key…</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {target && <RekeyDialog session={session} collection={state.collections.find((c) => c.uid === target.uid) || target} onClose={() => setTarget(null)} />}
    </section>
  );
}

export function RekeyDialog({ session, collection, onClose }) {
  const [members, setMembers] = useState(null);
  const [phase, setPhase] = useState("review"); // review | running | done | failed
  const [progress, setProgress] = useState({ stage: "", done: 0, total: 0 });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [understood, setUnderstood] = useState(false);

  useEffect(() => {
    let live = true;
    session.collectionDetail(collection.uid).then((d) => live && setMembers(d.members)).catch((e) => live && setError(session.describe(e)));
    return () => { live = false; };
  }, [session, collection.uid]);

  const start = async () => {
    setPhase("running");
    setError(null);
    try {
      setResult(await session.rekeyCollection(collection.uid, setProgress));
      setPhase("done");
    } catch (e) {
      setError(session.describe(e));
      setPhase("failed");
    }
  };

  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <Modal title={`Re-key “${collection.name}”`} onClose={phase === "running" ? () => {} : onClose} wide labelId="zv-rekey-title">
      <div className="zv-modal-body" data-testid="vault-rekey-dialog">
        <p className="zv-hint">Current key version: <strong data-testid="vault-rekey-version">{collection.keyVersion}</strong> · {collection.itemCount} item{collection.itemCount === 1 ? "" : "s"}</p>
        {error && <p className="zv-error" role="alert" data-testid="vault-rekey-error">{error}</p>}

        {phase === "review" && (
          <>
            <h3>Members who will keep access</h3>
            {members === null ? <p className="zv-hint">Loading…</p> : (
              <ul className="zv-grants" data-testid="vault-rekey-members">{members.map((m) => <li key={m.userId}><strong>{m.name}</strong> <small>{m.employeeId}</small></li>)}</ul>
            )}
            <div className="zv-warning" role="note">
              <FaExclamationTriangle aria-hidden="true" />
              <p><strong>What this can and cannot do.</strong> Re-keying cuts off people who are no longer members: their old keys will not open anything new. It <em>cannot</em> erase a password someone already saw, copied or wrote down. If they could reveal a password, change it at the service it belongs to.</p>
            </div>
            <p className="zv-hint">Your browser will open every item in this collection (each opening is recorded), make new keys, re-encrypt everything and check it, then save it all in one step. If anything goes wrong nothing is changed and you can simply try again. Keep this page open until it finishes.</p>
            <label className="zv-check"><input type="checkbox" data-testid="vault-rekey-ack" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /><span>I understand that re-keying does not undo what someone has already seen.</span></label>
            <div className="zv-row">
              <button type="button" className="zv-btn zv-btn-primary" data-testid="vault-rekey-start" disabled={!understood || members === null} onClick={start}>Start re-keying</button>
              <button type="button" className="zv-btn" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {phase === "running" && (
          <div data-testid="vault-rekey-progress" role="status" aria-live="polite">
            <p><strong>{progress.stage || "Starting"}…</strong></p>
            <div className="zv-strength-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span className="zv-strength-fill s3" style={{ width: `${percent}%` }} /></div>
            <p className="zv-hint">{progress.done} of {progress.total} items. Please keep this page open.</p>
          </div>
        )}

        {phase === "done" && result && (
          <div data-testid="vault-rekey-done">
            <p className="zv-notice" role="status">Done. The collection is now on key version {result.keyVersion}: {result.items} item{result.items === 1 ? "" : "s"} re-encrypted for {result.members} member{result.members === 1 ? "" : "s"}, and everything opened again successfully.</p>
            <p className="zv-hint">Remember: anyone who could reveal a password before may still know it. Change the important ones.</p>
            <div className="zv-row"><button type="button" className="zv-btn zv-btn-primary" onClick={onClose}>Close</button></div>
          </div>
        )}

        {phase === "failed" && (
          <div data-testid="vault-rekey-failed">
            <p className="zv-hint">Re-keying is all-or-nothing: if the final step did not complete, the collection is exactly as it was and nobody lost access. Check your connection and try again. If this page lost its connection at the very end, close this and look at the key version in the table: if it went up, the re-key did complete.</p>
            <div className="zv-row"><button type="button" className="zv-btn" onClick={() => { setPhase("review"); setError(null); }}>Back</button><button type="button" className="zv-btn" onClick={onClose}>Close</button></div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------- employee offboarding (administrators)
export function OffboardingView({ session, state }) {
  const [people, setPeople] = useState(null);
  const [error, setError] = useState(null);
  const [target, setTarget] = useState(null);
  const [outcome, setOutcome] = useState(null);

  const load = useCallback(async () => {
    try {
      setPeople(await session.loadOffboardingPeople());
    } catch (e) {
      setError(session.describe(e));
      setPeople([]);
    }
  }, [session]);
  useEffect(() => { load(); }, [load]);

  const nameOf = (uid) => (state.collections.find((c) => c.uid === uid) || { name: "A collection" }).name;
  return (
    <section className="zv-company" data-testid="vault-offboarding-view">
      <div className="zv-pagehead"><div><h2>Employee offboarding</h2><p className="zv-hint">End a person's access to the company vault. Their personal vault is never touched and never visible to you. Deactivating someone in the CRM does this automatically; use this when you need to do it without deactivating the account.</p></div></div>
      {error && <p className="zv-error" role="alert" data-testid="vault-offboarding-error">{error}</p>}
      {outcome && (
        <div className="zv-notice zv-outcome" role="status" data-testid="vault-offboarding-outcome">
          <div>
            <strong>Company vault access ended for {outcome.name}.</strong> {outcome.membershipsRemoved} membership{outcome.membershipsRemoved === 1 ? "" : "s"} removed, {outcome.sharesRevoked} share{outcome.sharesRevoked === 1 ? "" : "s"} of company items ended. Nothing was deleted.
            {outcome.collectionsNeedingRekey.length > 0 && (
              <p>Follow-up: re-key {outcome.collectionsNeedingRekey.map(nameOf).join(", ")} (under Collection keys) and change the important passwords they could reveal.</p>
            )}
          </div>
          <button type="button" className="zv-link" onClick={() => setOutcome(null)}>Dismiss</button>
        </div>
      )}
      {people === null ? <p className="zv-hint">Loading…</p> : people.length === 0 ? (
        <div className="zv-empty" data-testid="vault-offboarding-empty"><FaUserSlash aria-hidden="true" /><p>Nobody has company vault access.</p></div>
      ) : (
        <table className="zv-table" data-testid="vault-offboarding-table">
          <thead><tr><th>Employee</th><th>Account</th><th>Collections</th><th>Managing</th><th>Shared company items</th><th><span className="zv-sr">Actions</span></th></tr></thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.userId} data-testid={`vault-offboarding-row-${p.userId}`}>
                <td data-label="Employee">{p.name} <small>{p.employeeId}</small>{p.isYou ? " (you)" : ""}</td>
                <td data-label="Account">{p.active ? "Active" : "Inactive"}</td>
                <td data-label="Collections">{p.memberships}</td>
                <td data-label="Managing">{p.managed}</td>
                <td data-label="Shared company items">{p.companyShares}</td>
                <td>{!p.isYou && <button type="button" className="zv-btn zv-btn-danger" data-testid={`vault-offboarding-start-${p.userId}`} onClick={() => { setTarget(p); setError(null); }}>End access…</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {target && <OffboardDialog session={session} person={target} onClose={() => setTarget(null)} onDone={async (result) => { setOutcome({ ...result, name: target.name }); setTarget(null); await load(); }} />}
    </section>
  );
}

function OffboardDialog({ session, person, onClose, onDone }) {
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await session.revokeCompanyAccess(person.userId));
    } catch (e) {
      setError(session.describe(e));
      setBusy(false);
    }
  };

  return (
    <Modal title={`End company vault access for ${person.name}?`} onClose={busy ? () => {} : onClose} labelId="zv-offboard-title">
      <div className="zv-modal-body" data-testid="vault-offboarding-dialog">
        <h3>What will happen</h3>
        <ul className="zv-points">
          <li>They are removed from <strong>{person.memberships}</strong> collection{person.memberships === 1 ? "" : "s"}, and their copies of those collections' keys are deleted.</li>
          <li><strong>{person.companyShares}</strong> share{person.companyShares === 1 ? "" : "s"} of company items to them end, together with any re-shares they made.</li>
          <li>Those collections and any item they could reveal are flagged so they get re-keyed and the passwords changed.</li>
          <li>The credentials themselves are kept, encrypted. Nothing is deleted.</li>
          <li>Their <strong>personal vault is not touched</strong> and you cannot see it.</li>
          <li>It all happens in one step: if anything fails, nothing is changed.</li>
        </ul>
        <div className="zv-warning" role="note"><FaExclamationTriangle aria-hidden="true" /><p>This cannot make them forget passwords they already saw or copied. Re-key the collections and change the important passwords afterwards.</p></div>
        {person.managed > 0 && <p className="zv-hint" data-testid="vault-offboarding-manager-note">They manage {person.managed} collection{person.managed === 1 ? "" : "s"}. If they are the only manager of one, you must make someone else a manager first.</p>}
        {error && <p className="zv-error" role="alert" data-testid="vault-offboarding-dialog-error">{error}</p>}
        <label className="zv-check"><input type="checkbox" data-testid="vault-offboarding-ack" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /><span>I understand and want to end {person.name}'s company vault access.</span></label>
        <div className="zv-row">
          <button type="button" className="zv-btn zv-btn-danger" data-testid="vault-offboarding-confirm" disabled={!understood || busy} onClick={confirm}>{busy ? "Ending access…" : "End access"}</button>
          <button type="button" className="zv-btn" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
