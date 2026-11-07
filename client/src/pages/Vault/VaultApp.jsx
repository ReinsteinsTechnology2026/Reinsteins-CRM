import { useEffect, useMemo, useState } from "react";
import { FaLock, FaPlus, FaStar, FaFolder, FaKey, FaStickyNote, FaHeartbeat, FaCog, FaTrash, FaList, FaClock, FaSearch, FaBuilding, FaInbox, FaShareAlt, FaSyncAlt, FaPaperclip, FaHistory, FaUserSlash } from "react-icons/fa";

import { matchesQuery, hostOf, ITEM_KINDS } from "../../vault/itemModel";
import ItemEditor from "./ItemEditor";
import ItemDetail from "./ItemDetail";
import HealthPanel from "./HealthPanel";
import SettingsPanel from "./SettingsPanel";
import GeneratorPanel from "./GeneratorPanel";
import CompanyVault from "./CompanyVault";
import ShareDialog from "./ShareDialog";
import { SharedByMe, SharedWithMe } from "./SharedViews";
import { AttachmentsView, AuditView, KeysView, OffboardingView, RotationView } from "./SecurityViews";

const kindLabel = (id) => (ITEM_KINDS.find((k) => k.id === id) || { label: "Item" }).label;

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
  const [sharing, setSharing] = useState(null); // the item whose access is being managed
  const [openCollection, setOpenCollection] = useState(null); // kept here so the editor (which replaces the screen) does not close the collection

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
    if (next === "company") setOpenCollection(null); // the sidebar entry always leads to the list of collections
    if (next === "trash") session.loadTrash().catch(() => {});
  };

  const openItem = (item) => {
    setEditing(null);
    setSelected(item.uid);
    if (item.via === "collection") { setOpenCollection(item.collectionUid); setView("company"); }
    else if (item.via === "grant") setView("shared-with-me");
    else setView("all");
  };

  const isManager = state.collections.some((c) => c.rights.manage);

  const startNewCompany = (collectionUid) => {
    setSelected(null);
    setEditing({ initial: { kind: "login" }, collectionUid, personal: false });
  };

  const startNew = () => {
    setSelected(null);
    setEditing({ initial: { folderUid: isFolder ? view.slice(7) : null, kind: view === "secure_note" || view === "api_key" ? view : "login" } });
    if (["health", "settings", "generator", "trash", "company", "shared-with-me", "shared-by-me", "rotation", "attachments", "audit", "keys", "offboarding"].includes(view)) setView("all");
  };

  const startEdit = async (uid) => {
    try {
      const { draft, version } = await session.loadForEditing(uid);
      const mine = state.items.some((i) => i.uid === uid);
      setEditing({ uid, initial: draft, version, personal: mine });
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
          <h3>Company</h3>
          <button type="button" className={view === "company" ? "on" : ""} data-testid="vault-nav-company" onClick={() => go("company")}><FaBuilding /><span>Company Vault</span></button>
          <button type="button" className={view === "shared-with-me" ? "on" : ""} data-testid="vault-nav-shared-with-me" onClick={() => go("shared-with-me")}><FaInbox /><span>Shared with me</span></button>
          <button type="button" className={view === "shared-by-me" ? "on" : ""} data-testid="vault-nav-shared-by-me" onClick={() => go("shared-by-me")}><FaShareAlt /><span>Shared by me</span></button>
          <h3>Security</h3>
          <button type="button" className={view === "rotation" ? "on" : ""} data-testid="vault-nav-rotation" onClick={() => go("rotation")}><FaSyncAlt /><span>Rotation status</span></button>
          <button type="button" className={view === "attachments" ? "on" : ""} data-testid="vault-nav-attachments" onClick={() => go("attachments")}><FaPaperclip /><span>Secure attachments</span></button>
          {isManager && <button type="button" className={view === "audit" ? "on" : ""} data-testid="vault-nav-audit" onClick={() => go("audit")}><FaHistory /><span>Audit activity</span></button>}
          {isManager && <button type="button" className={view === "keys" ? "on" : ""} data-testid="vault-nav-keys" onClick={() => go("keys")}><FaKey /><span>Collection keys</span></button>}
          {state.canCreateCollections && <button type="button" className={view === "offboarding" ? "on" : ""} data-testid="vault-nav-offboarding" onClick={() => go("offboarding")}><FaUserSlash /><span>Employee offboarding</span></button>}
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
            <button type="button" className="zv-btn" onClick={() => { setEditing({ uid: restored.uid || undefined, initial: restored, version: restored.version ?? undefined, collectionUid: restored.collectionUid || undefined, personal: restored.collectionUid ? false : restored.uid ? state.items.some((i) => i.uid === restored.uid) : true }); setRestored(null); }}>Continue editing</button>
            <button type="button" className="zv-link" onClick={() => setRestored(null)}>Discard</button>
          </div>
        )}

        {editing ? (
          <ItemEditor
            session={session} state={state} initial={editing.initial} uid={editing.uid} version={editing.version} collectionUid={editing.collectionUid} personal={editing.personal !== false}
            onSaved={(uid) => { setEditing(null); if (uid) setSelected(uid); }}
            onCancel={() => { session.discardDraft(); setEditing(null); }}
          />
        ) : view === "company" ? (
          <CompanyVault session={session} state={state} selected={selected} setSelected={setSelected} onEdit={startEdit} onShare={setSharing} onNewItem={startNewCompany} openUid={openCollection} setOpenUid={setOpenCollection} />
        ) : view === "shared-with-me" ? (
          <SharedWithMe session={session} state={state} selected={selected} setSelected={setSelected} onEdit={startEdit} />
        ) : view === "shared-by-me" ? (
          <SharedByMe session={session} state={state} onManage={setSharing} />
        ) : view === "rotation" ? (
          <RotationView session={session} state={state} onOpenItem={openItem} />
        ) : view === "attachments" ? (
          <AttachmentsView session={session} state={state} onOpenItem={openItem} />
        ) : view === "audit" && isManager ? (
          <AuditView session={session} state={state} />
        ) : view === "keys" && isManager ? (
          <KeysView session={session} state={state} />
        ) : view === "offboarding" && state.canCreateCollections ? (
          <OffboardingView session={session} state={state} />
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
              {selected ? <ItemDetail key={selected} session={session} state={state} uid={selected} onEdit={startEdit} onShare={setSharing} onClose={() => setSelected(null)} /> : <div className="zv-empty"><p>Select an item to see its details.</p></div>}
            </div>
          </div>
        )}
      </section>
      {sharing && (() => {
        const fresh = [...state.items, ...state.companyItems, ...state.sharedItems].find((i) => i.uid === sharing.uid);
        return fresh ? <ShareDialog session={session} item={fresh} onClose={() => setSharing(null)} onChanged={async () => { await session.reload(); await session.loadOutgoing().catch(() => {}); }} /> : null; // keep "Shared by me" current
      })()}
    </div>
  );
}
