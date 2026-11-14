import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaCog, FaExclamationTriangle } from "react-icons/fa";
import { toast } from "react-toastify";

import { mailFor, unified, prefs, errorInfo } from "./emailApi";
import { subscribeEmailEvents } from "../../../services/emailEvents";
import { startConnect } from "./AddAccountPanel";
import ComposeWindow from "./ComposeWindow";
import EmailSettings from "./EmailSettings";
import FolderPane from "./FolderPane";
import ManageAccounts from "./ManageAccounts";
import MessageList from "./MessageList";
import MessageReader from "./MessageReader";

// ==========================================
// EMAIL CLIENT -- the Outlook-style mailbox over ALL of the employee's connected accounts (Gmail, Google Workspace, Outlook.com /
// Hotmail, Microsoft 365).
//
// Scope: "all" = the unified inbox (the Inbox of every account merged, newest first), or one account with its own folders / labels.
// Messages always carry the account they belong to, and every action goes to THAT account. All data comes from the employee's own
// accounts through /api/email/accounts/:id/... -- there is no user or company id anywhere in this file.
// ==========================================

const EMPTY_FILTERS = { q: "", unread: false, flagged: false, hasAttachments: false, from: "", to: "", subject: "", after: "", before: "", sort: "newest" };
const REFRESH_MS = 60000;

const keyOf = (m) => `${m.accountId}:${m.id}`;
const splitKey = (key) => {
  const i = key.indexOf(":");
  return { accountId: Number(key.slice(0, i)), id: key.slice(i + 1) };
};

function listParams(filters, cursor, folderKey) {
  if (cursor) return { cursor };
  const params = folderKey ? { folderId: folderKey, top: 25 } : { top: 25 };
  for (const [key, value] of Object.entries(filters)) {
    if (value === true) params[key] = "1";
    else if (value && value !== false && !(key === "sort" && value === "newest")) params[key] = value;
  }
  return params;
}

function EmailClient({ accounts, providers, portal, onAccountsChanged, onProblem }) {
  const connected = useMemo(() => accounts.filter((a) => a.status === "connected"), [accounts]);
  const accountsById = useMemo(() => Object.fromEntries(accounts.map((a) => [a.id, a])), [accounts]);
  const [scope, setScope] = useState(() => (accounts.filter((a) => a.status === "connected").length > 1 ? "all" : accounts[0].id));
  const scopeAccount = scope === "all" ? null : accountsById[scope] || null;

  const [folders, setFolders] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [favorites, setFavorites] = useState([]); // "<accountId>:<folderId>"
  const [folderKey, setFolderKey] = useState("inbox");
  const [filters, setFilters] = useState(EMPTY_FILTERS);

  const [messages, setMessages] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [listError, setListError] = useState("");
  const [accountErrors, setAccountErrors] = useState([]);
  const [filteredLocally, setFilteredLocally] = useState(false);
  const [newMail, setNewMail] = useState(0);

  const [selected, setSelected] = useState([]);
  const [openKey, setOpenKey] = useState(null);
  const [openMessage, setOpenMessage] = useState(null);
  const [readerLoading, setReaderLoading] = useState(false);
  const [readerError, setReaderError] = useState("");

  const [compose, setCompose] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [signature, setSignature] = useState("");
  const [categories, setCategories] = useState({});
  const [mobileView, setMobileView] = useState("list");

  const listRequest = useRef(0);
  const openRequest = useRef(0);
  const refreshTimer = useRef(null);
  const latest = useRef({});

  const openAccountId = openKey ? splitKey(openKey).accountId : null;
  const openApi = useMemo(() => (openAccountId ? mailFor(openAccountId) : null), [openAccountId]);
  const scopeApi = useMemo(() => (scope === "all" ? null : mailFor(scope)), [scope]);
  const capabilities = (scopeAccount && scopeAccount.capabilities) || {};
  const openCapabilities = (openAccountId && accountsById[openAccountId] && accountsById[openAccountId].capabilities) || {};
  const effectiveFolder = scope === "all" ? "inbox" : folderKey;
  const totalUnread = connected.reduce((n, a) => n + (a.unread || 0), 0);
  const needAttention = accounts.filter((a) => a.status !== "connected");

  const handleError = useCallback((error) => {
    const info = errorInfo(error);
    if (info.needsReconnect || info.notAvailable) onProblem && onProblem(info);
    return info;
  }, [onProblem]);

  // If the selected account disappears (disconnected elsewhere), fall back to a valid view instead of showing an empty pane.
  useEffect(() => {
    if (scope !== "all" && !accountsById[scope]) setScope(connected.length > 1 ? "all" : (accounts[0] && accounts[0].id) || "all");
  }, [scope, accountsById, connected.length, accounts]);

  // ---------- preferences ----------
  useEffect(() => {
    prefs.get()
      .then((r) => { setFavorites(r.favoriteFolders || []); setSignature(r.signature?.enabled ? r.signature.html || "" : ""); })
      .catch(() => { /* preferences are optional for reading mail */ });
  }, []);

  // ---------- folders (one account at a time) ----------
  const loadFolders = useCallback(async ({ silent = false } = {}) => {
    if (!scopeApi || !scopeAccount || scopeAccount.status !== "connected") { setFolders([]); return; }
    if (!silent) setFoldersLoading(true);
    try {
      const result = await scopeApi.folders();
      setFolders(result.folders || []);
    } catch (error) {
      const info = handleError(error);
      if (!silent) toast.error(info.message);
    } finally {
      setFoldersLoading(false);
    }
  }, [scopeApi, scopeAccount, handleError]);

  useEffect(() => { setFolders([]); loadFolders(); }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) { loadFolders({ silent: true }); onAccountsChanged && onAccountsChanged(); } }, REFRESH_MS);
    const onFocus = () => { loadFolders({ silent: true }); onAccountsChanged && onAccountsChanged(); };
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [loadFolders, onAccountsChanged]);

  // ---------- message list (unified or one account) ----------
  const loadMessages = useCallback(async ({ more = false, silent = false } = {}) => {
    const mine = ++listRequest.current;
    if (more) setLoadingMore(true);
    else if (silent) setRefreshing(true);
    else { setLoading(true); setListError(""); }
    try {
      let result;
      if (scope === "all") {
        result = await unified.messages(listParams(filters, more ? cursor : null, null));
      } else if (scopeAccount && scopeAccount.status === "connected") {
        result = await scopeApi.messages(listParams(filters, more ? cursor : null, folderKey));
        result.messages = (result.messages || []).map((m) => ({ ...m, accountId: scope }));
      } else {
        result = { messages: [], nextCursor: null };
      }
      if (mine !== listRequest.current) return;
      const incoming = result.messages || [];
      setMessages((current) => (more ? [...current, ...incoming.filter((m) => !current.some((c) => keyOf(c) === keyOf(m)))] : incoming));
      setCursor(result.nextCursor || null);
      setFilteredLocally(Boolean(result.filteredLocally));
      setAccountErrors(result.accountErrors || []);
      setListError("");
      if (!more) setNewMail(0);
    } catch (error) {
      if (mine !== listRequest.current) return;
      setListError(handleError(error).message);
    } finally {
      if (mine === listRequest.current) { setLoading(false); setLoadingMore(false); setRefreshing(false); }
    }
  }, [scope, scopeAccount, scopeApi, folderKey, filters, cursor, handleError]);

  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    const timer = setTimeout(() => { setSelected([]); loadMessages(); }, 300);
    return () => clearTimeout(timer);
    // loadMessages changes with the cursor; only the scope, folder, filters and the account's state trigger a fresh first page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, folderKey, filterKey, scopeAccount && scopeAccount.status]);

  // ---------- live events from the server ----------
  useEffect(() => subscribeEmailEvents((name, payload) => {
    if (name === "email:new") {
      const relevant = scope === "all" || scope === payload.accountId;
      if (relevant && effectiveFolder === "inbox" && !filters.q) setNewMail((n) => n + (payload.count || 1));
      onAccountsChanged && onAccountsChanged();
      if (scope === payload.accountId) loadFolders({ silent: true });
    } else if (name === "email:reauth" || name === "email:accounts" || name === "email:sync-error") {
      onAccountsChanged && onAccountsChanged();
    }
  }), [scope, effectiveFolder, filters.q, onAccountsChanged, loadFolders]);

  const patchMessage = useCallback((accountId, id, changes) => {
    setMessages((list) => list.map((m) => (m.accountId === accountId && m.id === id ? { ...m, ...changes } : m)));
    setOpenMessage((m) => (m && m.accountId === accountId && m.id === id ? { ...m, ...changes } : m));
  }, []);

  const dropMessages = useCallback((keys) => {
    const gone = new Set(keys);
    setMessages((list) => list.filter((m) => !gone.has(keyOf(m))));
    setSelected((list) => list.filter((k) => !gone.has(k)));
    if (openKey && gone.has(openKey)) { setOpenKey(null); setOpenMessage(null); setMobileView("list"); }
  }, [openKey]);

  // The timer must call the LATEST callbacks: by the time it fires the employee may have switched account, and a stale closure would
  // refresh (or clear) the wrong account's folders.
  latest.current = { loadFolders, onAccountsChanged };
  const refreshSoon = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      if (latest.current.onAccountsChanged) latest.current.onAccountsChanged();
      latest.current.loadFolders({ silent: true });
    }, 800);
  }, []);

  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  // ---------- scope and folders ----------
  function selectScope(next) {
    setScope(next);
    setFolderKey("inbox");
    setFilters(EMPTY_FILTERS);
    setOpenKey(null);
    setOpenMessage(null);
    setSelected([]);
    setMobileView("list");
  }

  function selectFolder(folder) {
    setFolderKey(folder.wellKnown || folder.id);
    setFilters(EMPTY_FILTERS);
    setOpenKey(null);
    setOpenMessage(null);
    setMobileView("list");
  }

  const favoriteIds = useMemo(() => favorites.filter((f) => f.startsWith(`${scope}:`)).map((f) => f.slice(String(scope).length + 1)), [favorites, scope]);

  async function toggleFavorite(folder) {
    const entry = `${scope}:${folder.id}`;
    const next = favorites.includes(entry) ? favorites.filter((f) => f !== entry) : [...favorites, entry];
    setFavorites(next);
    try {
      await prefs.save({ favoriteFolders: next });
    } catch (error) {
      setFavorites(favorites);
      toast.error(handleError(error).message);
    }
  }

  async function createFolder(name) {
    try {
      await scopeApi.createFolder(name);
      await loadFolders();
      return true;
    } catch (error) {
      toast.error(handleError(error).message);
      return false;
    }
  }

  async function renameFolder(folder) {
    const name = window.prompt("Name", folder.name);
    if (!name || name.trim() === folder.name) return;
    try {
      await scopeApi.renameFolder(folder.id, name.trim());
      await loadFolders();
    } catch (error) {
      toast.error(handleError(error).message);
    }
  }

  async function deleteFolder(folder) {
    const text = capabilities.folderDeleteRemovesMessages === false
      ? `Delete the label "${folder.name}"? The messages stay in Gmail; only the label is removed.`
      : `Delete the folder "${folder.name}" and the messages in it? They are moved to Deleted Items.`;
    if (!window.confirm(text)) return;
    try {
      await scopeApi.deleteFolder(folder.id);
      if (folderKey === folder.id) setFolderKey("inbox");
      await loadFolders();
    } catch (error) {
      toast.error(handleError(error).message);
    }
  }

  // ---------- reading ----------
  async function openSummary(summary) {
    const mine = ++openRequest.current;
    const api = mailFor(summary.accountId);
    setOpenKey(keyOf(summary));
    setOpenMessage(null);
    setReaderLoading(true);
    setReaderError("");
    setMobileView("reader");
    try {
      const result = await api.message(summary.id);
      if (mine !== openRequest.current) return;
      setOpenMessage({ ...result.message, accountId: summary.accountId });
      if (!categories[summary.accountId]) api.categories().then((r) => setCategories((c) => ({ ...c, [summary.accountId]: r.categories || [] }))).catch(() => {});
      if (!summary.isRead && !result.message.isDraft) {
        patchMessage(summary.accountId, summary.id, { isRead: true });
        api.update(summary.id, { isRead: true }).then(refreshSoon).catch((error) => { patchMessage(summary.accountId, summary.id, { isRead: false }); handleError(error); });
      }
    } catch (error) {
      if (mine === openRequest.current) setReaderError(handleError(error).message);
    } finally {
      if (mine === openRequest.current) setReaderLoading(false);
    }
  }

  async function reloadOpen() {
    const summary = messages.find((m) => keyOf(m) === openKey);
    if (summary) await openSummary({ ...summary, isRead: true });
  }

  async function changeMessage(accountId, id, changes) {
    const before = messages.find((m) => m.accountId === accountId && m.id === id);
    patchMessage(accountId, id, changes);
    try {
      await mailFor(accountId).update(id, changes);
      if ("isRead" in changes) refreshSoon();
    } catch (error) {
      if (before) patchMessage(accountId, id, { isRead: before.isRead, flag: before.flag, categories: before.categories });
      toast.error(handleError(error).message);
    }
  }

  async function moveOne(action, success) {
    const key = openKey;
    try {
      await action();
      dropMessages([key]);
      if (success) toast.success(success);
      refreshSoon();
    } catch (error) {
      toast.error(handleError(error).message);
    }
  }

  const folderOfOpen = scope === "all" ? "inbox" : folderKey;
  const trashOpen = () => {
    if (!openKey) return;
    const { id } = splitKey(openKey);
    if (folderOfOpen === "trash") {
      if (!window.confirm("Delete this message forever? This cannot be undone.")) return;
      moveOne(() => openApi.remove(id, true), "Message deleted");
    } else {
      moveOne(() => openApi.remove(id), `Moved to ${openCapabilities.provider === "google" ? "Trash" : "Deleted Items"}`);
    }
  };

  // ---------- compose ----------
  const startAccountId = () => (scope !== "all" && scopeAccount && scopeAccount.status === "connected" ? scope : connected[0] && connected[0].id);
  const newMessage = () => setCompose({ initial: { accountId: startAccountId(), title: "New message", to: [], cc: [], bcc: [], subject: "", bodyHtml: "" } });

  const draftInitial = (accountId, title, draft) => ({
    accountId, title, draftId: draft.id,
    to: draft.to.map((p) => ({ ...p, valid: true })), cc: draft.cc.map((p) => ({ ...p, valid: true })), bcc: draft.bcc.map((p) => ({ ...p, valid: true })),
    subject: draft.subject, bodyHtml: draft.bodyHtml, attachments: draft.attachments, importance: draft.importance,
  });

  async function replyTo(mode) {
    if (!openKey) return;
    try {
      const { id, accountId } = splitKey(openKey);
      const result = await mailFor(accountId).replyDraft(id, mode);
      setCompose({ initial: draftInitial(accountId, { reply: "Reply", replyAll: "Reply all", forward: "Forward" }[mode], result.draft) });
    } catch (error) {
      toast.error(handleError(error).message);
    }
  }

  async function editDraft() {
    if (!openKey) return;
    try {
      const { id, accountId } = splitKey(openKey);
      const result = await mailFor(accountId).getDraft(id);
      setCompose({ initial: draftInitial(accountId, "Draft", result.draft) });
    } catch (error) {
      toast.error(handleError(error).message);
    }
  }

  function composeClosed() {
    setCompose(null);
    refreshSoon();
    if (["drafts", "sent"].includes(effectiveFolder)) loadMessages({ silent: true });
  }

  // ---------- bulk (a selection can span accounts in the unified inbox: one call per account) ----------
  async function bulk(action) {
    if (selected.length === 0) return;
    if (action === "delete" && folderOfOpen !== "trash" && selected.length > 1 && !window.confirm(`Move ${selected.length} messages to the bin?`)) return;
    const byAccount = new Map();
    for (const key of selected) {
      const { accountId, id } = splitKey(key);
      if (!byAccount.has(accountId)) byAccount.set(accountId, []);
      byAccount.get(accountId).push(id);
    }
    let failed = 0;
    let succeeded = 0;
    const okKeys = [];
    for (const [accountId, ids] of byAccount) {
      try {
        const result = await mailFor(accountId).bulk(ids, action);
        failed += result.failed;
        succeeded += result.succeeded;
        for (const r of result.results) if (r.ok) okKeys.push(`${accountId}:${r.id}`);
      } catch (error) {
        failed += ids.length;
        toast.error(handleError(error).message);
      }
    }
    if (["delete", "restore", "archive", "move"].includes(action)) dropMessages(okKeys);
    else {
      const change = { read: { isRead: true }, unread: { isRead: false }, flag: { flag: "flagged" }, unflag: { flag: "notFlagged" } }[action];
      okKeys.forEach((k) => { const { accountId, id } = splitKey(k); patchMessage(accountId, id, change); });
      setSelected([]);
    }
    if (failed > 0) toast.warn(`${failed} of ${failed + succeeded} messages could not be changed.`);
    else toast.success(`${succeeded} message${succeeded === 1 ? "" : "s"} updated`);
    refreshSoon();
  }

  // ---------- rendering ----------
  const moveTargets = folders.filter((f) => (f.wellKnown || f.id) !== folderKey && !["drafts", "sent", "starred"].includes(f.wellKnown));
  const folderName = scope === "all" ? "Unified inbox" : (folders.find((f) => (f.wellKnown || f.id) === folderKey) || {}).name || (folderKey === "inbox" ? "Inbox" : "Folder");
  const scopeNeedsReconnect = scopeAccount && scopeAccount.status !== "connected";

  return (
    <div className={`em-client em-view-${mobileView}`}>
      <header className="em-topbar">
        <button type="button" className="em-btn em-btn-small em-only-mobile" onClick={() => setMobileView("folders")}>Accounts</button>
        <div className="em-topbar-title">
          <span>{scope === "all" ? `All accounts (${connected.length})` : scopeAccount && scopeAccount.address}</span>
        </div>
        <div className="em-topbar-actions">
          <button type="button" className="em-icon-btn" aria-label="Mail settings" title="Mail settings" onClick={() => setShowSettings(true)}><FaCog /></button>
        </div>
      </header>

      {needAttention.length > 0 && (
        <button type="button" className="em-attention" onClick={() => setShowManage(true)}>
          <FaExclamationTriangle aria-hidden="true" /> {needAttention.length === 1 ? `${needAttention[0].address} needs to be reconnected` : `${needAttention.length} accounts need to be reconnected`} - click to fix
        </button>
      )}

      {newMail > 0 && (
        <button type="button" className="em-newmail" onClick={() => { setNewMail(0); loadMessages({ silent: true }); }} aria-live="polite">
          {newMail === 1 ? "1 new message" : `${newMail} new messages`} - click to refresh
        </button>
      )}

      <div className="em-panes">
        <FolderPane
          accounts={accounts}
          scope={scope}
          onScope={selectScope}
          totalUnread={totalUnread}
          onAddAccount={() => setShowManage(true)}
          onManageAccounts={() => setShowManage(true)}
          folders={folders}
          current={folderKey}
          favorites={favoriteIds}
          loading={foldersLoading}
          onSelect={selectFolder}
          onToggleFavorite={toggleFavorite}
          onCreate={createFolder}
          onRename={renameFolder}
          onDelete={deleteFolder}
          onCompose={newMessage}
          capabilities={capabilities}
        />

        {scopeNeedsReconnect ? (
          <section className="em-list em-list-reconnect" aria-label="Reconnect this account">
            <div className="em-state">
              <FaExclamationTriangle className="em-empty-icon" aria-hidden="true" />
              <p><strong>Reconnect {scopeAccount.address}</strong></p>
              <p className="em-muted">Your {scopeAccount.provider === "google" ? "Google" : "Microsoft"} sign-in expired or was revoked, so this account is paused. Your mail is safe at the provider.</p>
              <button type="button" className="em-btn em-btn-primary" onClick={() => startConnect({ provider: scopeAccount.provider, portal, accountId: scopeAccount.id }).catch((e) => toast.error(errorInfo(e).message))}>Reconnect</button>
            </div>
          </section>
        ) : (
          <MessageList
            folderName={folderName}
            folderKey={effectiveFolder}
            messages={messages}
            loading={loading}
            error={listError}
            hasMore={Boolean(cursor)}
            loadingMore={loadingMore}
            refreshing={refreshing}
            filteredLocally={filteredLocally}
            openId={openKey}
            selected={selected}
            onToggleSelect={(key) => setSelected((list) => (list.includes(key) ? list.filter((x) => x !== key) : [...list, key]))}
            onSelectAll={() => setSelected(messages.map(keyOf))}
            onClearSelection={() => setSelected([])}
            onOpen={openSummary}
            filters={filters}
            onFiltersChange={(changes) => setFilters((f) => ({ ...f, ...changes }))}
            onSearch={(q) => setFilters((f) => ({ ...f, q }))}
            onRefresh={() => { onAccountsChanged && onAccountsChanged(); loadFolders({ silent: true }); loadMessages({ silent: true }); }}
            onLoadMore={() => loadMessages({ more: true })}
            onBulk={bulk}
            showAccount={scope === "all" || accounts.length > 1}
            accountsById={accountsById}
            capabilities={capabilities}
            accountErrors={accountErrors}
          />
        )}

        <MessageReader
          mailApi={openApi}
          capabilities={openCapabilities}
          accountLabel={accounts.length > 1 && openAccountId && accountsById[openAccountId] ? accountsById[openAccountId].address : null}
          message={openMessage}
          loading={readerLoading}
          error={readerError}
          folderKey={folderOfOpen}
          folders={scope === "all" ? [] : moveTargets}
          categories={openAccountId ? categories[openAccountId] || [] : []}
          onBack={() => setMobileView("list")}
          onReply={replyTo}
          onEditDraft={editDraft}
          onTrash={trashOpen}
          onRestore={() => moveOne(() => openApi.restore(splitKey(openKey).id), "Moved to Inbox")}
          onArchive={() => moveOne(() => openApi.archive(splitKey(openKey).id), "Archived")}
          onToggleRead={() => openMessage && changeMessage(openMessage.accountId, openMessage.id, { isRead: !openMessage.isRead })}
          onToggleFlag={() => openMessage && changeMessage(openMessage.accountId, openMessage.id, { flag: openMessage.flag === "flagged" ? "notFlagged" : "flagged" })}
          onMove={(folder) => moveOne(() => openApi.move(splitKey(openKey).id, folder.wellKnown || folder.id), `Moved to ${folder.name}`)}
          onSetCategories={(list) => openMessage && changeMessage(openMessage.accountId, openMessage.id, { categories: list })}
          onReload={reloadOpen}
        />
      </div>

      {compose && (
        <ComposeWindow
          key={compose.initial.draftId || "new"}
          accounts={accounts}
          initial={compose.initial}
          signature={signature}
          onClose={composeClosed}
          onSent={composeClosed}
          onProblem={onProblem}
        />
      )}
      {showSettings && (
        <EmailSettings
          accounts={accounts}
          initialAccountId={scope === "all" ? undefined : scope}
          onClose={() => setShowSettings(false)}
          onProblem={onProblem}
          onSaved={() => prefs.get().then((r) => setSignature(r.signature?.enabled ? r.signature.html || "" : "")).catch(() => {})}
        />
      )}
      {showManage && (
        <ManageAccounts
          accounts={accounts}
          providers={providers}
          portal={portal}
          onClose={() => setShowManage(false)}
          onChanged={() => { onAccountsChanged && onAccountsChanged(); }}
        />
      )}
    </div>
  );
}

export default EmailClient;
