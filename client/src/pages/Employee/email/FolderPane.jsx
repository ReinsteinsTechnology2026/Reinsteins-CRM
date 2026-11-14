import { useState } from "react";
import { FaInbox, FaPaperPlane, FaRegFileAlt, FaTrashAlt, FaBan, FaArchive, FaFolder, FaStar, FaRegStar, FaPlus, FaPen, FaTrash, FaGoogle, FaMicrosoft, FaLayerGroup, FaExclamationTriangle, FaCog } from "react-icons/fa";

// ==========================================
// FOLDER PANE -- the account switcher on top (Unified inbox + every connected account, each with its unread count and state), then the
// selected account's folders (Inbox, Starred, Drafts, Sent, Archive, Spam / Junk, Trash, its own folders or labels).
//
// Folder names are the same for every provider (inbox, sent, drafts, trash, junk, archive, starred): the server translates them to
// Gmail labels or Outlook folders. Built-in folders cannot be renamed or deleted (the provider refuses that too).
// ==========================================

const ICONS = { inbox: FaInbox, starred: FaStar, sent: FaPaperPlane, drafts: FaRegFileAlt, trash: FaTrashAlt, junk: FaBan, archive: FaArchive };

function FolderRow({ folder, current, onSelect, favorite, onToggleFavorite, onRename, onDelete, labelWord }) {
  const Icon = (folder.wellKnown && ICONS[folder.wellKnown]) || FaFolder;
  // Drafts show how many drafts there are; every other folder shows UNREAD messages.
  const count = folder.wellKnown === "drafts" ? folder.total : folder.unread;
  const selected = current === (folder.wellKnown || folder.id);
  return (
    <li>
      <div className={`em-folder ${selected ? "em-folder-active" : ""}`}>
        <button type="button" className="em-folder-main" aria-current={selected ? "page" : undefined} onClick={() => onSelect(folder)}>
          <Icon aria-hidden="true" />
          <span className="em-folder-name">{folder.name}</span>
          {count > 0 && <span className={`em-badge ${folder.wellKnown === "inbox" ? "em-badge-strong" : ""}`} aria-label={`${count} ${folder.wellKnown === "drafts" ? "drafts" : "unread"}`}>{count}</span>}
        </button>
        <span className="em-folder-actions">
          <button type="button" className={`em-icon-btn ${favorite ? "em-fav-on" : ""}`} aria-label={favorite ? `Remove ${folder.name} from favorites` : `Add ${folder.name} to favorites`} aria-pressed={favorite} onClick={() => onToggleFavorite(folder)}>
            {favorite ? <FaStar /> : <FaRegStar />}
          </button>
          {!folder.wellKnown && (
            <>
              <button type="button" className="em-icon-btn" aria-label={`Rename ${folder.name}`} onClick={() => onRename(folder)}><FaPen /></button>
              <button type="button" className="em-icon-btn" aria-label={`Delete ${labelWord} ${folder.name}`} onClick={() => onDelete(folder)}><FaTrash /></button>
            </>
          )}
        </span>
      </div>
    </li>
  );
}

function AccountRow({ account, active, onSelect }) {
  const needsAttention = account.status !== "connected";
  const ProviderIcon = account.provider === "google" ? FaGoogle : FaMicrosoft;
  return (
    <li>
      <button type="button" className={`em-account ${active ? "em-account-active" : ""}`} aria-current={active ? "true" : undefined} onClick={() => onSelect(account.id)} title={`${account.kindLabel}: ${account.address}`}>
        <span className="em-account-dot" style={{ background: account.color }} aria-hidden="true" />
        <ProviderIcon aria-hidden="true" className="em-account-provider" />
        <span className="em-account-text">
          <strong>{account.displayName || account.address.split("@")[0]}</strong>
          <span className="em-muted">{account.address}</span>
        </span>
        {needsAttention ? (
          <span className="em-badge em-badge-warn" title="Reconnect this account"><FaExclamationTriangle aria-hidden="true" /> Reconnect</span>
        ) : account.syncError ? (
          <span className="em-badge em-badge-warn" title="Synchronisation is having problems"><FaExclamationTriangle aria-label="Sync problem" /></span>
        ) : (
          account.unread > 0 && <span className="em-badge em-badge-strong" aria-label={`${account.unread} unread`}>{account.unread}</span>
        )}
      </button>
    </li>
  );
}

function FolderPane({ accounts, scope, onScope, totalUnread, onAddAccount, onManageAccounts, folders, current, favorites, loading, onSelect, onToggleFavorite, onCreate, onRename, onDelete, onCompose, capabilities = {} }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const unified = scope === "all";
  const labelWord = capabilities.folders === "labels" ? "label" : "folder";

  const favoriteFolders = folders.filter((f) => favorites.includes(f.id));
  const builtIn = folders.filter((f) => f.wellKnown);
  const mine = folders.filter((f) => !f.wellKnown);

  async function submit(event) {
    event.preventDefault();
    const clean = name.trim();
    if (!clean) return;
    if (await onCreate(clean)) {
      setName("");
      setAdding(false);
    }
  }

  const row = (folder, key = folder.id) => (
    <FolderRow key={key} folder={folder} current={current} onSelect={onSelect} favorite={favorites.includes(folder.id)} onToggleFavorite={onToggleFavorite} onRename={onRename} onDelete={onDelete} labelWord={labelWord} />
  );

  return (
    <nav className="em-folders" aria-label="Mail accounts and folders">
      <button type="button" className="em-btn em-btn-primary em-new-message" onClick={onCompose} disabled={accounts.every((a) => a.status !== "connected")}>
        <FaPlus /> New message
      </button>

      <h3 className="em-folder-heading">
        Accounts
        <span>
          <button type="button" className="em-icon-btn" aria-label="Manage accounts" title="Manage accounts" onClick={onManageAccounts}><FaCog /></button>
          <button type="button" className="em-icon-btn" aria-label="Add an account" title="Add an account" onClick={onAddAccount}><FaPlus /></button>
        </span>
      </h3>
      <ul className="em-accounts">
        {accounts.length > 1 && (
          <li>
            <button type="button" className={`em-account ${unified ? "em-account-active" : ""}`} aria-current={unified ? "true" : undefined} onClick={() => onScope("all")}>
              <FaLayerGroup aria-hidden="true" className="em-account-provider" />
              <span className="em-account-text"><strong>All accounts</strong><span className="em-muted">Unified inbox</span></span>
              {totalUnread > 0 && <span className="em-badge em-badge-strong" aria-label={`${totalUnread} unread in all accounts`}>{totalUnread}</span>}
            </button>
          </li>
        )}
        {accounts.map((a) => <AccountRow key={a.id} account={a} active={scope === a.id} onSelect={onScope} />)}
      </ul>

      {unified ? (
        <p className="em-muted em-folder-empty">The unified inbox shows the Inbox of every connected account, newest first. Pick an account to see its folders.</p>
      ) : (
        <>
          {loading && folders.length === 0 && <ul className="em-folder-skeleton" aria-hidden="true">{[0, 1, 2, 3, 4].map((i) => <li key={i} />)}</ul>}

          {favoriteFolders.length > 0 && (
            <>
              <h3 className="em-folder-heading">Favorites</h3>
              <ul>{favoriteFolders.map((f) => row(f, `fav-${f.id}`))}</ul>
            </>
          )}

          <h3 className="em-folder-heading">Folders</h3>
          <ul>{builtIn.map((f) => row(f))}</ul>

          <h3 className="em-folder-heading">
            {labelWord === "label" ? "Labels" : "My folders"}
            <button type="button" className="em-icon-btn" aria-label={`Create ${labelWord}`} onClick={() => setAdding((v) => !v)}><FaPlus /></button>
          </h3>
          {adding && (
            <form onSubmit={submit} className="em-folder-form">
              <label className="em-sr-only" htmlFor="em-new-folder">{labelWord === "label" ? "Label name" : "Folder name"}</label>
              <input id="em-new-folder" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder={labelWord === "label" ? "Label name" : "Folder name"} autoFocus />
              <button type="submit" className="em-btn">Add</button>
            </form>
          )}
          <ul>{mine.map((f) => row(f))}</ul>
          {mine.length === 0 && !adding && !loading && <p className="em-muted em-folder-empty">No {labelWord}s of your own yet.</p>}
        </>
      )}
    </nav>
  );
}

export default FolderPane;
