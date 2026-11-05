import { useEffect, useMemo, useState } from "react";
import { FaLock, FaPlus, FaStar, FaRegStar, FaFolder, FaKey, FaStickyNote, FaHeartbeat, FaCog, FaTrash, FaList, FaClock, FaSearch } from "react-icons/fa";

import { matchesQuery, safeUrl, hostOf, ITEM_KINDS } from "../../vault/itemModel";
import { getClipboard } from "../../vault/vaultRuntime";
import ItemEditor from "./ItemEditor";
import HealthPanel from "./HealthPanel";
import SettingsPanel from "./SettingsPanel";
import GeneratorPanel from "./GeneratorPanel";

const kindLabel = (id) => (ITEM_KINDS.find((k) => k.id === id) || { label: "Item" }).label;
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

function ItemDetail({ session, state, uid, onEdit, onClose }) {
  const item = state.items.find((i) => i.uid === uid) || state.trash.find((i) => i.uid === uid);
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
          <span className="zv-badge">{kindLabel(item.kind)}</span>
        </div>
        <div className="zv-row">
          {!trashed && (
            <button type="button" className="zv-icon-btn" data-testid="vault-favorite" aria-pressed={item.favorite} aria-label={item.favorite ? "Remove from favorites" : "Add to favorites"} onClick={() => session.setFavorite(uid, !item.favorite).catch((e) => setMessage(session.describe(e)))}>
              {item.favorite ? <FaStar /> : <FaRegStar />}
            </button>
          )}
          <button type="button" className="zv-link" onClick={onClose}>Close</button>
        </div>
      </header>

      {item.corrupt && <p className="zv-error" role="alert" data-testid="vault-corrupt">This item could not be decrypted or is damaged, so its details cannot be shown.</p>}

      {!item.corrupt && (
        <dl>
          {item.url && <><dt>Website</dt><dd>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{hostOf(item.url) || item.url}</a> : <span>{item.url}</span>}</dd></>}
          {item.username && <><dt>Username</dt><dd><span data-testid="vault-detail-username">{item.username}</span> <button type="button" className="zv-link" onClick={() => copyValue(item.username, "Username")}>Copy</button></dd></>}
          {item.hasSecret && (
            <>
              <dt>{item.kind === "api_key" ? "Key" : "Password"}</dt>
              <dd>
                <span className="zv-secret" data-testid="vault-password-text">{shown && secret ? secret.password : "••••••••••••"}</span>
                <button type="button" className="zv-btn" data-testid="vault-reveal" onClick={reveal} aria-pressed={shown}>{shown ? "Hide" : "Reveal"}</button>
                {item.canCopy && <button type="button" className="zv-btn" data-testid="vault-copy-password" onClick={copyPassword}>Copy</button>}
              </dd>
            </>
          )}
          {item.fields.map((f, index) => <div key={index} className="zv-pair"><dt>{f.label}</dt><dd>{f.value}</dd></div>)}
          {shown && secret && secret.hidden.map((f, index) => <div key={`h${index}`} className="zv-pair"><dt>{f.label}</dt><dd>{f.value}</dd></div>)}
          {shown && secret && secret.notes && <><dt>Notes</dt><dd className="zv-notes" data-testid="vault-notes-text">{secret.notes}</dd></>}
          {item.folderUid && <><dt>Folder</dt><dd>{(state.folders.find((f) => f.uid === item.folderUid) || { name: "—" }).name}</dd></>}
          <dt>Created</dt><dd>{when(item.createdAt)}</dd>
          <dt>Last updated</dt><dd>{when(item.updatedAt)}</dd>
          {item.lastRotatedAt && <><dt>Password changed</dt><dd>{when(item.lastRotatedAt)}</dd></>}
        </dl>
      )}

      {message && <p className="zv-notice" role="status" data-testid="vault-message">{message}</p>}

      <div className="zv-row">
        {!trashed && !item.corrupt && <button type="button" className="zv-btn" data-testid="vault-edit" onClick={() => onEdit(uid)}>Edit</button>}
        {!trashed && state.folders.length > 0 && (
          <select aria-label="Move to folder" data-testid="vault-move" value={item.folderUid || ""} onChange={(e) => session.moveToFolder(uid, e.target.value || null).catch((err) => setMessage(session.describe(err)))}>
            <option value="">No folder</option>
            {state.folders.map((f) => <option key={f.uid} value={f.uid}>{f.name}</option>)}
          </select>
        )}
        {!trashed && !confirmDelete && <button type="button" className="zv-btn zv-btn-danger" data-testid="vault-delete" onClick={() => setConfirmDelete(true)}><FaTrash /> Delete</button>}
        {!trashed && confirmDelete && (
          <span className="zv-confirm">Move to trash? <button type="button" className="zv-btn zv-btn-danger" data-testid="vault-delete-confirm" onClick={remove}>Yes, delete</button> <button type="button" className="zv-link" onClick={() => setConfirmDelete(false)}>No</button></span>
        )}
        {trashed && <button type="button" className="zv-btn" data-testid="vault-restore" onClick={() => session.restoreItem(uid).then(onClose).catch((e) => setMessage(session.describe(e)))}>Restore</button>}
      </div>
      <p className="zv-hint">Revealing or copying a password is recorded in your vault's activity log. Copying uses the clipboard, which other programs can read.</p>
    </article>
  );
}

const VIEWS = [
  { id: "all", label: "All items", icon: <FaList /> },
  { id: "favorites", label: "Favorites", icon: <FaStar /> },
  { id: "recent", label: "Recently updated", icon: <FaClock /> },
  { id: "login", label: "Logins", icon: <FaKey /> },
  { id: "secure_note", label: "Secure notes", icon: <FaStickyNote /> },
  { id: "api_key", label: "API keys", icon: <FaKey /> },
];

export default function VaultApp({ session, state }) {
  const [view, setView] = useState("all"); // a VIEWS id, "folder:<uid>", "trash", "health", "generator", "settings"
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(null); // { uid?, initial, version? }
  const [newFolder, setNewFolder] = useState("");
  const [folderError, setFolderError] = useState(null);
  const [restored, setRestored] = useState(null);

  // an interrupted edit, kept sealed while the vault was locked, is offered back after unlock
  useEffect(() => {
    if (!state.draftAvailable) return;
    session.restoreDraft().then((draft) => draft && setRestored(draft));
  }, [session, state.draftAvailable]);

  const folderName = (uid) => (state.folders.find((f) => f.uid === uid) || { name: "" }).name;
  const isFolder = view.startsWith("folder:");

  const list = useMemo(() => {
    if (view === "trash") return state.trash;
    let items = state.items;
    if (view === "favorites") items = items.filter((i) => i.favorite);
    else if (view === "login" || view === "secure_note" || view === "api_key") items = items.filter((i) => i.kind === view);
    else if (isFolder) items = items.filter((i) => i.folderUid === view.slice(7));
    if (query.trim()) items = items.filter((i) => matchesQuery(i, query, folderName(i.folderUid)));
    const sorted = [...items];
    if (view === "recent") sorted.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    else sorted.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
    return sorted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.items, state.trash, state.folders, view, query]);

  const go = (next) => {
    setView(next);
    setSelected(null);
    setEditing(null);
    if (next === "trash") session.loadTrash().catch(() => {});
  };

  const startNew = () => {
    setSelected(null);
    setEditing({ initial: { folderUid: isFolder ? view.slice(7) : null, kind: view === "secure_note" || view === "api_key" ? view : "login" } });
    if (["health", "settings", "generator", "trash"].includes(view)) setView("all");
  };

  const startEdit = async (uid) => {
    try {
      const { draft, version } = await session.loadForEditing(uid);
      setEditing({ uid, initial: draft, version });
    } catch (error) {
      setFolderError(session.describe(error));
    }
  };

  const addFolder = async (event) => {
    event.preventDefault();
    setFolderError(null);
    try {
      const uid = await session.createFolder(newFolder);
      setNewFolder("");
      go(`folder:${uid}`);
    } catch (error) {
      setFolderError(session.describe(error));
    }
  };

  const removeFolder = async (uid) => {
    try {
      await session.deleteFolder(uid);
      if (view === `folder:${uid}`) go("all");
      await session.reload();
    } catch (error) {
      setFolderError(session.describe(error));
    }
  };

  const panel = ["health", "settings", "generator"].includes(view);
  const title = panel || view === "trash" ? { health: "Password health", settings: "Settings", generator: "Password generator", trash: "Trash" }[view] : (VIEWS.find((v) => v.id === view) || { label: folderName(view.slice(7)) || "Folder" }).label;

  return (
    <div className="zv-app" data-testid="vault-app">
      <aside className="zv-side" aria-label="Vault navigation">
        <button type="button" className="zv-btn zv-btn-primary zv-add" data-testid="vault-add" onClick={startNew}><FaPlus /> Add item</button>
        <nav>
          {VIEWS.map((v) => (
            <button key={v.id} type="button" className={view === v.id ? "on" : ""} data-testid={`vault-nav-${v.id}`} onClick={() => go(v.id)}>{v.icon}<span>{v.label}</span></button>
          ))}
          <h3>Folders</h3>
          {state.folders.map((f) => (
            <div className="zv-folder" key={f.uid}>
              <button type="button" className={view === `folder:${f.uid}` ? "on" : ""} data-testid={`vault-folder-${f.uid}`} onClick={() => go(`folder:${f.uid}`)}><FaFolder /><span>{f.name}</span></button>
              <button type="button" className="zv-link" aria-label={`Delete folder ${f.name}`} onClick={() => removeFolder(f.uid)}>×</button>
            </div>
          ))}
          <form onSubmit={addFolder} className="zv-newfolder">
            <input data-testid="vault-folder-name" aria-label="New folder name" placeholder="New folder" value={newFolder} maxLength={100} onChange={(e) => setNewFolder(e.target.value)} />
            <button type="submit" className="zv-btn" data-testid="vault-folder-add" disabled={!newFolder.trim()}>Add</button>
          </form>
          {folderError && <p className="zv-error" role="alert">{folderError}</p>}
          <h3>Tools</h3>
          <button type="button" className={view === "generator" ? "on" : ""} data-testid="vault-nav-generator" onClick={() => go("generator")}><FaKey /><span>Generator</span></button>
          <button type="button" className={view === "health" ? "on" : ""} data-testid="vault-nav-health" onClick={() => go("health")}><FaHeartbeat /><span>Password health</span></button>
          <button type="button" className={view === "trash" ? "on" : ""} data-testid="vault-nav-trash" onClick={() => go("trash")}><FaTrash /><span>Trash</span></button>
          <button type="button" className={view === "settings" ? "on" : ""} data-testid="vault-nav-settings" onClick={() => go("settings")}><FaCog /><span>Settings</span></button>
        </nav>
        <button type="button" className="zv-btn zv-lockbtn" data-testid="vault-lock-button" onClick={() => session.lock("manual")}><FaLock /> Lock vault</button>
      </aside>

      <section className="zv-main">
        {restored && !editing && (
          <div className="zv-notice" role="status" data-testid="vault-restore-draft">
            Your unsaved changes to "{restored.title || "an item"}" were kept encrypted while the vault was locked.
            <button type="button" className="zv-btn" onClick={() => { setEditing({ uid: restored.uid || undefined, initial: restored, version: restored.version ?? undefined }); setRestored(null); }}>Continue editing</button>
            <button type="button" className="zv-link" onClick={() => setRestored(null)}>Discard</button>
          </div>
        )}

        {editing ? (
          <ItemEditor
            session={session} state={state} initial={editing.initial} uid={editing.uid} version={editing.version}
            onSaved={(uid) => { setEditing(null); if (uid) setSelected(uid); }}
            onCancel={() => { session.discardDraft(); setEditing(null); }}
          />
        ) : view === "health" ? (
          <HealthPanel session={session} state={state} onOpen={(uid) => { setView("all"); setSelected(uid); }} />
        ) : view === "settings" ? (
          <SettingsPanel session={session} state={state} />
        ) : view === "generator" ? (
          <section className="zv-panel"><h2>Password generator</h2><GeneratorPanel onUse={() => {}} /></section>
        ) : (
          <div className="zv-split">
            <div className="zv-listpane">
              <div className="zv-searchbar">
                <FaSearch aria-hidden="true" />
                <input data-testid="vault-search" type="search" placeholder="Search name, website, username, folder…" aria-label="Search the vault" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <h2 className="zv-listtitle">{title} <span>{list.length}</span></h2>
              {list.length === 0 ? (
                <div className="zv-empty" data-testid="vault-empty">
                  {state.items.length === 0 && view !== "trash" ? <><p>Your vault is empty.</p><button type="button" className="zv-btn zv-btn-primary" onClick={startNew}>Add your first item</button></> : <p>{query ? "Nothing matches your search." : "Nothing here yet."}</p>}
                </div>
              ) : (
                <ul className="zv-list">
                  {list.map((item) => (
                    <li key={item.uid}>
                      <button type="button" className={selected === item.uid ? "on" : ""} data-testid={`vault-item-${item.uid}`} onClick={() => setSelected(item.uid)}>
                        <span className="zv-avatar" aria-hidden="true">{(item.title || "?").charAt(0).toUpperCase()}</span>
                        <span className="zv-itemtext"><strong>{item.title}</strong><small>{item.username || hostOf(item.url) || kindLabel(item.kind)}</small></span>
                        {item.favorite && <FaStar className="zv-fav" aria-label="Favorite" />}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="zv-detailpane">
              {selected ? <ItemDetail key={selected} session={session} state={state} uid={selected} onEdit={startEdit} onClose={() => setSelected(null)} /> : <div className="zv-empty"><p>Select an item to see its details.</p></div>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
