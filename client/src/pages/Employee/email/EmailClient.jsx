import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaCog, FaMicrosoft, FaUnlink } from "react-icons/fa";
import { toast } from "react-toastify";

import { connection, mail, errorInfo } from "./emailApi";
import ComposeWindow from "./ComposeWindow";
import EmailSettings from "./EmailSettings";
import FolderPane from "./FolderPane";
import MessageList from "./MessageList";
import MessageReader from "./MessageReader";

// ==========================================
// EMAIL CLIENT -- the Outlook-style mailbox, once the employee's Microsoft account is connected.
//
// Layout: folders | message list | reading pane on a wide screen; one pane at a time on a phone (list -> message, with a
// back button and a folder drawer). All data comes from the employee's OWN mailbox through /api/email/mail/* -- there is
// no user or mailbox id anywhere in this file.
// ==========================================

const EMPTY_FILTERS = { q: "", unread: false, flagged: false, hasAttachments: false, from: "", to: "", subject: "", after: "", before: "", sort: "newest" };
const REFRESH_MS = 60000;

function listParams(folderKey, filters, cursor) {
  if (cursor) return { cursor };
  const params = { folderId: folderKey, top: 25 };
  for (const [key, value] of Object.entries(filters)) {
    if (value === true) params[key] = "1";
    else if (value && value !== false && !(key === "sort" && value === "newest")) params[key] = value;
  }
  return params;
}

function EmailClient({ status, onProblem, onDisconnected }) {
  const [folders, setFolders] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [favorites, setFavorites] = useState([]);
  const [folderKey, setFolderKey] = useState("inbox");
  const [filters, setFilters] = useState(EMPTY_FILTERS);

  const [messages, setMessages] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [listError, setListError] = useState("");
  const [filteredLocally, setFilteredLocally] = useState(false);
  const [newMail, setNewMail] = useState(false);

  const [selected, setSelected] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [openMessage, setOpenMessage] = useState(null);
  const [readerLoading, setReaderLoading] = useState(false);
  const [readerError, setReaderError] = useState("");

  const [compose, setCompose] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [signature, setSignature] = useState("");
  const [categories, setCategories] = useState([]);
  const [mobileView, setMobileView] = useState("list"); // folders | list | reader

  const listRequest = useRef(0);
  const openRequest = useRef(0);
  const lastInboxMark = useRef(null);

  const currentFolder = useMemo(
    () => folders.find((f) => (f.wellKnown || f.id) === folderKey) || null,
    [folders, folderKey]
  );
  const folderName = currentFolder?.name || (folderKey === "inbox" ? "Inbox" : "Folder");

  const handleError = useCallback((error) => {
    const info = errorInfo(error);
    if (info.needsReconnect || info.notReady) onProblem && onProblem(info);
    return info;
  }, [onProblem]);

  // ---------- folders ----------
  const loadFolders = useCallback(async ({ silent = false } = {}) => {
    try {
      const result = await mail.folders();
      setFolders(result.folders || []);
      const inbox = (result.folders || []).find((f) => f.wellKnown === "inbox");
      if (inbox) {
        const mark = `${inbox.total}:${inbox.unread}`;
        if (silent && lastInboxMark.current && lastInboxMark.current !== mark) setNewMail(true);
        lastInboxMark.current = mark;
      }
    } catch (error) {
      if (!silent) toast.error(handleError(error).message);
      else handleError(error);
    } finally {
      setFoldersLoading(false);
    }
  }, [handleError]);

  useEffect(() => {
    loadFolders();
    mail.settings()
      .then((result) => {
        setFavorites(result.favoriteFolders || []);
        setSignature(result.signature?.enabled ? result.signature.html || "" : "");
      })
      .catch(() => { /* settings are optional for reading mail */ });
    mail.categories().then((result) => setCategories(result.categories || [])).catch(() => {});
  }, [loadFolders]);

  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) loadFolders({ silent: true }); }, REFRESH_MS);
    const onFocus = () => loadFolders({ silent: true });
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [loadFolders]);

  // ---------- message list ----------
  const loadMessages = useCallback(async ({ more = false, silent = false } = {}) => {
    const mine = ++listRequest.current;
    if (more) setLoadingMore(true);
    else if (silent) setRefreshing(true);
    else { setLoading(true); setListError(""); }
    try {
      const result = await mail.messages(listParams(folderKey, filters, more ? cursor : null));
      if (mine !== listRequest.current) return;
      setMessages((current) => (more ? [...current, ...result.messages.filter((m) => !current.some((c) => c.id === m.id))] : result.messages));
      setCursor(result.nextCursor || null);
      setFilteredLocally(Boolean(result.filteredLocally));
      setListError("");
      if (!more) setNewMail(false);
    } catch (error) {
      if (mine !== listRequest.current) return;
      setListError(handleError(error).message);
    } finally {
      if (mine === listRequest.current) { setLoading(false); setLoadingMore(false); setRefreshing(false); }
    }
  }, [folderKey, filters, cursor, handleError]);

  // Reload when the folder or the search / filters change (typing in filter boxes waits a moment).
  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    const timer = setTimeout(() => { setSelected([]); loadMessages(); }, 300);
    return () => clearTimeout(timer);
    // loadMessages changes with the cursor; only the folder and the filters should trigger a fresh first page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderKey, filterKey]);

  const patchMessage = useCallback((id, changes) => {
    setMessages((list) => list.map((m) => (m.id === id ? { ...m, ...changes } : m)));
    setOpenMessage((m) => (m && m.id === id ? { ...m, ...changes } : m));
  }, []);

  const dropMessages = useCallback((ids) => {
    const gone = new Set(ids);
    setMessages((list) => list.filter((m) => !gone.has(m.id)));
    setSelected((list) => list.filter((id) => !gone.has(id)));
    if (openId && gone.has(openId)) { setOpenId(null); setOpenMessage(null); setMobileView("list"); }
  }, [openId]);

  // ---------- folder actions ----------
  function selectFolder(folder) {
    setFolderKey(folder.wellKnown || folder.id);
    setFilters(EMPTY_FILTERS);
    setOpenId(null);
    setOpenMessage(null);
    setMobileView("list");
  }

  async function toggleFavorite(folder) {
    const next = favorites.includes(folder.id) ? favorites.filter((id) => id !== folder.id) : [...favorites, folder.id];
    setFavorites(next);
    try {
      await mail.saveSettings({ favoriteFolders: next });
    } catch (error) {
      setFavorites(favorites);
      toast.error(handleError(error).message);
    }
  }

  async function createFolder(name) {
    try {
      await mail.createFolder(name);
      await loadFolders();
      return true;
    } catch (error) {
      toast.error(handleError(error).message);
      return false;
    }
  }

  async function renameFolder(folder) {
    const name = window.prompt("Folder name", folder.name);
    if (!name || name.trim() === folder.name) return;
    try {
      await mail.renameFolder(folder.id, name.trim());
      await loadFolders();
    } catch (error) {
      toast.error(handleError(error).message);
    }
  }

  async function deleteFolder(folder) {
    if (!window.confirm(`Delete the folder "${folder.name}" and the messages in it? They are moved to Deleted Items.`)) return;
    try {
      await mail.deleteFolder(folder.id);
      if (folderKey === folder.id) selectFolder({ wellKnown: "inbox", id: "inbox" });
      await loadFolders();
    } catch (error) {
      toast.error(handleError(error).message);
    }
  }

  // ---------- reading ----------
  async function openSummary(summary) {
    const mine = ++openRequest.current;
    setOpenId(summary.id);
    setOpenMessage(null);
    setReaderLoading(true);
    setReaderError("");
    setMobileView("reader");
    try {
      const result = await mail.message(summary.id);
      if (mine !== openRequest.current) return;
      setOpenMessage(result.message);
      if (!summary.isRead && !result.message.isDraft) {
        patchMessage(summary.id, { isRead: true });
        setFolders((list) => list.map((f) => ((f.wellKnown || f.id) === folderKey && f.unread > 0 ? { ...f, unread: f.unread - 1 } : f)));
        mail.update(summary.id, { isRead: true }).catch((error) => { patchMessage(summary.id, { isRead: false }); handleError(error); });
      }
    } catch (error) {
      if (mine === openRequest.current) setReaderError(handleError(error).message);
    } finally {
      if (mine === openRequest.current) setReaderLoading(false);
    }
  }

  async function reloadOpen() {
    const summary = messages.find((m) => m.id === openId);
    if (summary) await openSummary({ ...summary, isRead: true });
  }

  async function changeMessage(id, changes, failure) {
    const before = messages.find((m) => m.id === id);
    patchMessage(id, changes);
    try {
      await mail.update(id, changes);
      if ("isRead" in changes) loadFolders({ silent: true });
    } catch (error) {
      if (before) patchMessage(id, { isRead: before.isRead, flag: before.flag, categories: before.categories });
      toast.error(failure || handleError(error).message);
    }
  }

  async function moveOne(action, id, success) {
    try {
      await action();
      dropMessages([id]);
      if (success) toast.success(success);
      loadFolders({ silent: true });
    } catch (error) {
      toast.error(handleError(error).message);
    }
  }

  const trashOpen = () => {
    if (!openId) return;
    if (folderKey === "deleteditems") {
      if (!window.confirm("Delete this message forever? This cannot be undone.")) return;
      moveOne(() => mail.remove(openId, true), openId, "Message deleted");
    } else {
      moveOne(() => mail.remove(openId), openId, "Moved to Deleted Items");
    }
  };

  // ---------- compose ----------
  const newMessage = () => setCompose({ initial: { title: "New message", to: [], cc: [], bcc: [], subject: "", bodyHtml: "" } });

  async function replyTo(mode) {
    if (!openId) return;
    try {
      const result = await mail.replyDraft(openId, mode);
      const draft = result.draft;
      setCompose({
        initial: {
          title: { reply: "Reply", replyAll: "Reply all", forward: "Forward" }[mode],
          draftId: draft.id,
          to: draft.to.map((p) => ({ ...p, valid: true })),
          cc: draft.cc.map((p) => ({ ...p, valid: true })),
          bcc: draft.bcc.map((p) => ({ ...p, valid: true })),
          subject: draft.subject,
          bodyHtml: draft.bodyHtml,
          attachments: draft.attachments,
          importance: draft.importance,
        },
      });
    } catch (error) {
      toast.error(handleError(error).message);
    }
  }

  async function editDraft() {
    if (!openId) return;
    try {
      const result = await mail.getDraft(openId);
      const draft = result.draft;
      setCompose({
        initial: {
          title: "Draft",
          draftId: draft.id,
          to: draft.to.map((p) => ({ ...p, valid: true })),
          cc: draft.cc.map((p) => ({ ...p, valid: true })),
          bcc: draft.bcc.map((p) => ({ ...p, valid: true })),
          subject: draft.subject,
          bodyHtml: draft.bodyHtml,
          attachments: draft.attachments,
          importance: draft.importance,
        },
      });
    } catch (error) {
      toast.error(handleError(error).message);
    }
  }

  function composeClosed() {
    setCompose(null);
    loadFolders({ silent: true });
    if (folderKey === "drafts" || folderKey === "sentitems") loadMessages({ silent: true });
  }

  // ---------- bulk ----------
  async function bulk(action) {
    if (selected.length === 0) return;
    if (action === "delete" && folderKey !== "deleteditems" && selected.length > 1 && !window.confirm(`Move ${selected.length} messages to Deleted Items?`)) return;
    try {
      const result = await mail.bulk(selected, action);
      const ok = new Set(result.results.filter((r) => r.ok).map((r) => r.id));
      if (["delete", "restore", "archive", "move"].includes(action)) dropMessages([...ok]);
      else {
        const change = { read: { isRead: true }, unread: { isRead: false }, flag: { flag: "flagged" }, unflag: { flag: "notFlagged" } }[action];
        ok.forEach((id) => patchMessage(id, change));
        setSelected([]);
      }
      if (result.failed > 0) toast.warn(`${result.failed} of ${result.results.length} messages could not be changed.`);
      else toast.success(`${result.succeeded} message${result.succeeded === 1 ? "" : "s"} updated`);
      loadFolders({ silent: true });
    } catch (error) {
      toast.error(handleError(error).message);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect your Microsoft account from ZioVenture? Your mail stays in Microsoft 365; you can reconnect any time.")) return;
    try {
      await connection.disconnect();
      onDisconnected && onDisconnected();
    } catch (error) {
      toast.error(errorInfo(error).message);
    }
  }

  const moveTargets = folders.filter((f) => (f.wellKnown || f.id) !== folderKey && f.wellKnown !== "drafts" && f.wellKnown !== "sentitems");

  return (
    <div className={`em-client em-view-${mobileView}`}>
      <header className="em-topbar">
        <button type="button" className="em-btn em-btn-small em-only-mobile" onClick={() => setMobileView("folders")}>Folders</button>
        <div className="em-topbar-title">
          <FaMicrosoft aria-hidden="true" />
          <span>{status?.mailbox?.address}</span>
        </div>
        <div className="em-topbar-actions">
          <button type="button" className="em-icon-btn" aria-label="Mail settings" title="Mail settings" onClick={() => setShowSettings(true)}><FaCog /></button>
          <button type="button" className="em-icon-btn" aria-label="Disconnect Microsoft account" title="Disconnect Microsoft account" onClick={disconnect}><FaUnlink /></button>
        </div>
      </header>

      {newMail && (
        <button type="button" className="em-newmail" onClick={() => { setNewMail(false); loadMessages({ silent: true }); }} aria-live="polite">
          Mailbox updated - click to refresh
        </button>
      )}

      <div className="em-panes">
        <FolderPane
          folders={folders}
          current={folderKey}
          favorites={favorites}
          loading={foldersLoading}
          onSelect={selectFolder}
          onToggleFavorite={toggleFavorite}
          onCreate={createFolder}
          onRename={renameFolder}
          onDelete={deleteFolder}
          onCompose={newMessage}
        />

        <MessageList
          folderName={folderName}
          folderKey={folderKey}
          messages={messages}
          loading={loading}
          error={listError}
          hasMore={Boolean(cursor)}
          loadingMore={loadingMore}
          refreshing={refreshing}
          filteredLocally={filteredLocally}
          openId={openId}
          selected={selected}
          onToggleSelect={(id) => setSelected((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]))}
          onSelectAll={() => setSelected(messages.map((m) => m.id))}
          onClearSelection={() => setSelected([])}
          onOpen={openSummary}
          filters={filters}
          onFiltersChange={(changes) => setFilters((f) => ({ ...f, ...changes }))}
          onSearch={(q) => setFilters((f) => ({ ...f, q }))}
          onRefresh={() => { loadFolders({ silent: true }); loadMessages({ silent: true }); }}
          onLoadMore={() => loadMessages({ more: true })}
          onBulk={bulk}
        />

        <MessageReader
          message={openMessage}
          loading={readerLoading}
          error={readerError}
          folderKey={folderKey}
          folders={moveTargets}
          categories={categories}
          onBack={() => setMobileView("list")}
          onReply={replyTo}
          onEditDraft={editDraft}
          onTrash={trashOpen}
          onRestore={() => moveOne(() => mail.restore(openId), openId, "Moved to Inbox")}
          onArchive={() => moveOne(() => mail.archive(openId), openId, "Archived")}
          onToggleRead={() => openMessage && changeMessage(openMessage.id, { isRead: !openMessage.isRead })}
          onToggleFlag={() => openMessage && changeMessage(openMessage.id, { flag: openMessage.flag === "flagged" ? "notFlagged" : "flagged" })}
          onMove={(folder) => moveOne(() => mail.move(openId, folder.wellKnown || folder.id), openId, `Moved to ${folder.name}`)}
          onSetCategories={(list) => openMessage && changeMessage(openMessage.id, { categories: list })}
          onReload={reloadOpen}
        />
      </div>

      {compose && (
        <ComposeWindow
          key={compose.initial.draftId || "new"}
          initial={compose.initial}
          signature={signature}
          onClose={composeClosed}
          onSent={composeClosed}
          onProblem={onProblem}
        />
      )}
      {showSettings && (
        <EmailSettings
          onClose={() => setShowSettings(false)}
          onProblem={onProblem}
          onSaved={() => mail.settings().then((r) => setSignature(r.signature?.enabled ? r.signature.html || "" : "")).catch(() => {})}
        />
      )}
    </div>
  );
}

export default EmailClient;
