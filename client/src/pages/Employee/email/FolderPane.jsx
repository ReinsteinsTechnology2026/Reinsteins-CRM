import { useState } from "react";
import { FaInbox, FaPaperPlane, FaRegFileAlt, FaTrashAlt, FaBan, FaArchive, FaFolder, FaStar, FaPlus, FaPen, FaTrash } from "react-icons/fa";

// ==========================================
// FOLDER PANE -- Inbox, Sent Items, Drafts, Deleted Items, Junk Email, Archive, favourites and the employee's own folders,
// with unread counts. Built-in folders cannot be renamed or deleted (the server refuses that too).
// ==========================================

const ICONS = {
  inbox: FaInbox,
  sentitems: FaPaperPlane,
  drafts: FaRegFileAlt,
  deleteditems: FaTrashAlt,
  junkemail: FaBan,
  archive: FaArchive,
};

function FolderRow({ folder, current, onSelect, favorite, onToggleFavorite, onRename, onDelete }) {
  const Icon = (folder.wellKnown && ICONS[folder.wellKnown]) || FaFolder;
  // Drafts show how many drafts there are; every other folder shows UNREAD messages.
  const count = folder.wellKnown === "drafts" ? folder.total : folder.unread;
  const selected = current === (folder.wellKnown || folder.id);
  return (
    <li>
      <div className={`em-folder ${selected ? "em-folder-active" : ""}`}>
        <button
          type="button"
          className="em-folder-main"
          aria-current={selected ? "page" : undefined}
          onClick={() => onSelect(folder)}
        >
          <Icon aria-hidden="true" />
          <span className="em-folder-name">{folder.name}</span>
          {count > 0 && <span className={`em-badge ${folder.wellKnown === "inbox" ? "em-badge-strong" : ""}`} aria-label={`${count} ${folder.wellKnown === "drafts" ? "drafts" : "unread"}`}>{count}</span>}
        </button>
        <span className="em-folder-actions">
          <button
            type="button"
            className={`em-icon-btn ${favorite ? "em-fav-on" : ""}`}
            aria-label={favorite ? `Remove ${folder.name} from favorites` : `Add ${folder.name} to favorites`}
            aria-pressed={favorite}
            onClick={() => onToggleFavorite(folder)}
          >
            <FaStar />
          </button>
          {!folder.wellKnown && (
            <>
              <button type="button" className="em-icon-btn" aria-label={`Rename ${folder.name}`} onClick={() => onRename(folder)}><FaPen /></button>
              <button type="button" className="em-icon-btn" aria-label={`Delete ${folder.name}`} onClick={() => onDelete(folder)}><FaTrash /></button>
            </>
          )}
        </span>
      </div>
    </li>
  );
}

function FolderPane({ folders, current, favorites, loading, onSelect, onToggleFavorite, onCreate, onRename, onDelete, onCompose }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  const favoriteFolders = folders.filter((f) => favorites.includes(f.id));
  const builtIn = folders.filter((f) => f.wellKnown);
  const mine = folders.filter((f) => !f.wellKnown);

  async function submit(event) {
    event.preventDefault();
    const clean = name.trim();
    if (!clean) return;
    const ok = await onCreate(clean);
    if (ok) {
      setName("");
      setAdding(false);
    }
  }

  const row = (folder) => (
    <FolderRow
      key={folder.id}
      folder={folder}
      current={current}
      onSelect={onSelect}
      favorite={favorites.includes(folder.id)}
      onToggleFavorite={onToggleFavorite}
      onRename={onRename}
      onDelete={onDelete}
    />
  );

  return (
    <nav className="em-folders" aria-label="Mail folders">
      <button type="button" className="em-btn em-btn-primary em-new-message" onClick={onCompose}>
        <FaPlus /> New message
      </button>

      {loading && folders.length === 0 && (
        <ul className="em-folder-skeleton" aria-hidden="true">{[0, 1, 2, 3, 4].map((i) => <li key={i} />)}</ul>
      )}

      {favoriteFolders.length > 0 && (
        <>
          <h3 className="em-folder-heading">Favorites</h3>
          <ul>{favoriteFolders.map((f) => <FolderRow key={`fav-${f.id}`} folder={f} current={current} onSelect={onSelect} favorite onToggleFavorite={onToggleFavorite} onRename={onRename} onDelete={onDelete} />)}</ul>
        </>
      )}

      <h3 className="em-folder-heading">Folders</h3>
      <ul>{builtIn.map(row)}</ul>

      <h3 className="em-folder-heading">
        My folders
        <button type="button" className="em-icon-btn" aria-label="Create folder" onClick={() => setAdding((v) => !v)}><FaPlus /></button>
      </h3>
      {adding && (
        <form onSubmit={submit} className="em-folder-form">
          <label className="em-sr-only" htmlFor="em-new-folder">Folder name</label>
          <input id="em-new-folder" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="Folder name" autoFocus />
          <button type="submit" className="em-btn">Add</button>
        </form>
      )}
      <ul>{mine.map(row)}</ul>
      {mine.length === 0 && !adding && !loading && <p className="em-muted em-folder-empty">No folders of your own yet.</p>}
    </nav>
  );
}

export default FolderPane;
