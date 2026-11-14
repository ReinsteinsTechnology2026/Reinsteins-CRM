import { useState } from "react";
import { FaPaperclip, FaFlag, FaSearch, FaSyncAlt, FaTimes, FaTrashAlt, FaArchive, FaEnvelopeOpen, FaEnvelope, FaUndoAlt, FaSortAmountDown, FaSortAmountUp } from "react-icons/fa";

import { formatListDate, senderLabel, recipientsLabel } from "./emailUtils";

// ==========================================
// MESSAGE LIST -- search, filters, sort, bulk actions, selection and paging.
//
// Selection model: clicking a row OPENS the message; the checkbox on a row (or "Select all") builds the selection that the
// bulk toolbar acts on. Search matches sender, recipient, subject and keywords; unread / flagged / attachments / dates are
// filters. (When a text search is used Microsoft cannot also filter server-side, so those filters apply to the loaded
// results -- the list says so.)
// ==========================================

function MessageList({
  folderName, folderKey, messages, loading, error, hasMore, loadingMore, filteredLocally,
  openId, selected, onToggleSelect, onSelectAll, onClearSelection, onOpen,
  filters, onFiltersChange, onSearch, onRefresh, onLoadMore, onBulk, refreshing,
  showAccount = false, accountsById = {}, capabilities = {}, accountErrors = [],
}) {
  const keyOf = (m) => (m.accountId ? `${m.accountId}:${m.id}` : m.id);
  const sortOldestOk = capabilities.sortOldest !== false && !showAccount;
  const flagWord = capabilities.flag === "star" ? "Star" : "Flag";
  const [showFilters, setShowFilters] = useState(false);
  const [draftQuery, setDraftQuery] = useState(filters.q || "");

  const isDrafts = folderKey === "drafts";
  const isDeleted = folderKey === "trash";
  const isSent = folderKey === "sent" || isDrafts;
  const anySelected = selected.length > 0;
  const allSelected = messages.length > 0 && selected.length === messages.length;
  const activeFilters = [filters.unread, filters.flagged, filters.hasAttachments, filters.from, filters.to, filters.subject, filters.after, filters.before].filter(Boolean).length;

  function submitSearch(event) {
    event.preventDefault();
    onSearch(draftQuery.trim());
  }

  return (
    <section className="em-list" aria-label={`${folderName} messages`}>
      <header className="em-list-header">
        <h2>{folderName}</h2>
        <button type="button" className="em-icon-btn" aria-label="Refresh" title="Refresh" onClick={onRefresh} disabled={refreshing}>
          <FaSyncAlt className={refreshing ? "em-spin" : ""} />
        </button>
      </header>

      <form className="em-search" role="search" onSubmit={submitSearch}>
        <FaSearch aria-hidden="true" />
        <input
          type="search"
          value={draftQuery}
          onChange={(event) => setDraftQuery(event.target.value)}
          placeholder={`Search ${folderName}`}
          aria-label="Search mail"
        />
        {(draftQuery || filters.q) && (
          <button type="button" className="em-icon-btn" aria-label="Clear search" onClick={() => { setDraftQuery(""); onSearch(""); }}><FaTimes /></button>
        )}
        <button type="button" className={`em-btn em-btn-small ${activeFilters ? "em-btn-on" : ""}`} aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)}>
          Filter{activeFilters ? ` (${activeFilters})` : ""}
        </button>
      </form>

      {showFilters && (
        <div className="em-filters">
          <label className="em-check"><input type="checkbox" checked={Boolean(filters.unread)} onChange={(e) => onFiltersChange({ unread: e.target.checked })} /> Unread</label>
          <label className="em-check"><input type="checkbox" checked={Boolean(filters.flagged)} onChange={(e) => onFiltersChange({ flagged: e.target.checked })} /> Flagged</label>
          <label className="em-check"><input type="checkbox" checked={Boolean(filters.hasAttachments)} onChange={(e) => onFiltersChange({ hasAttachments: e.target.checked })} /> Has attachments</label>
          <label className="em-field">From <input type="text" value={filters.from || ""} onChange={(e) => onFiltersChange({ from: e.target.value })} placeholder="name or address" /></label>
          <label className="em-field">To <input type="text" value={filters.to || ""} onChange={(e) => onFiltersChange({ to: e.target.value })} placeholder="name or address" /></label>
          <label className="em-field">Subject <input type="text" value={filters.subject || ""} onChange={(e) => onFiltersChange({ subject: e.target.value })} /></label>
          <label className="em-field">After <input type="date" value={filters.after || ""} onChange={(e) => onFiltersChange({ after: e.target.value })} /></label>
          <label className="em-field">Before <input type="date" value={filters.before || ""} onChange={(e) => onFiltersChange({ before: e.target.value })} /></label>
          <div className="em-filter-actions">
            <button type="button" className="em-btn em-btn-small" onClick={() => onFiltersChange({ unread: false, flagged: false, hasAttachments: false, from: "", to: "", subject: "", after: "", before: "" })}>Clear filters</button>
          </div>
        </div>
      )}

      <div className="em-list-tools">
        <label className="em-check">
          <input type="checkbox" checked={allSelected} onChange={(e) => (e.target.checked ? onSelectAll() : onClearSelection())} aria-label="Select all messages" />
          {anySelected ? `${selected.length} selected` : "Select all"}
        </label>
        <button
          type="button"
          className="em-btn em-btn-small"
          onClick={() => onFiltersChange({ sort: filters.sort === "oldest" ? "newest" : "oldest" })}
          title={sortOldestOk ? "Change sort order" : "This account can only list newest mail first"}
          disabled={!sortOldestOk || Boolean(filters.q || filters.to || filters.subject)}
        >
          {filters.sort === "oldest" ? <FaSortAmountUp /> : <FaSortAmountDown />} {filters.sort === "oldest" ? "Oldest first" : "Newest first"}
        </button>
      </div>

      {anySelected && (
        <div className="em-bulk" role="toolbar" aria-label="Actions for selected messages">
          <button type="button" className="em-btn em-btn-small" onClick={() => onBulk("read")}><FaEnvelopeOpen /> Mark read</button>
          <button type="button" className="em-btn em-btn-small" onClick={() => onBulk("unread")}><FaEnvelope /> Mark unread</button>
          <button type="button" className="em-btn em-btn-small" onClick={() => onBulk("flag")}><FaFlag /> {flagWord}</button>
          <button type="button" className="em-btn em-btn-small" onClick={() => onBulk("unflag")}>Clear flag</button>
          {!isDeleted && !isDrafts && <button type="button" className="em-btn em-btn-small" onClick={() => onBulk("archive")}><FaArchive /> Archive</button>}
          {isDeleted ? (
            <button type="button" className="em-btn em-btn-small" onClick={() => onBulk("restore")}><FaUndoAlt /> Restore</button>
          ) : (
            <button type="button" className="em-btn em-btn-small em-btn-danger" onClick={() => onBulk("delete")}><FaTrashAlt /> Delete</button>
          )}
        </div>
      )}

      {accountErrors.length > 0 && (
        <p className="em-note em-note-warn" role="alert">
          {accountErrors.length === 1 ? "One account" : `${accountErrors.length} accounts`} could not be loaded ({accountErrors.map((e) => (accountsById[e.accountId] ? accountsById[e.accountId].address : "account")).join(", ")}). Other accounts are shown.
        </p>
      )}

      {filteredLocally && (filters.unread || filters.flagged || filters.hasAttachments) && (
        <p className="em-muted em-note">Filters are applied to the results loaded so far because a text search is active.</p>
      )}

      {error && (
        <div className="em-state em-state-error" role="alert">
          <p>{error}</p>
          <button type="button" className="em-btn" onClick={onRefresh}>Try again</button>
        </div>
      )}

      {loading && messages.length === 0 && !error && (
        <ul className="em-skeleton-list" aria-label="Loading messages">{[0, 1, 2, 3, 4, 5].map((i) => <li key={i}><span /><span /></li>)}</ul>
      )}

      {!loading && !error && messages.length === 0 && (
        <div className="em-state">
          <p><strong>{filters.q || activeFilters ? "No messages match your search." : `${folderName} is empty.`}</strong></p>
          <p className="em-muted">{filters.q || activeFilters ? "Try different words or clear the filters." : "New messages will appear here."}</p>
        </div>
      )}

      <ul className="em-messages" role="listbox" aria-label="Messages" aria-multiselectable="true">
        {messages.map((message) => {
          const checked = selected.includes(keyOf(message));
          const account = showAccount ? accountsById[message.accountId] : null;
          const person = isSent ? { name: recipientsLabel(message.to) } : message.from;
          return (
            <li
              key={message.id}
              role="option"
              aria-selected={openId === keyOf(message)}
              className={`em-message ${message.isRead ? "" : "em-unread"} ${openId === keyOf(message) ? "em-open" : ""}`}
            >
              <input
                type="checkbox"
                className="em-message-check"
                checked={checked}
                aria-label={`Select message from ${senderLabel(message.from)}: ${message.subject || "no subject"}`}
                onChange={() => onToggleSelect(keyOf(message))}
              />
              <button type="button" className="em-message-main" onClick={() => onOpen(message)}>
                <span className="em-message-top">
                  <span className="em-message-sender">{isSent ? person.name : senderLabel(person)}</span>
                  {account && <span className="em-acct-chip" style={{ "--acct": account.color }} title={account.address}>{account.displayName || account.address}</span>}
                  <span className="em-message-date">{formatListDate(message.receivedAt || message.sentAt)}</span>
                </span>
                <span className="em-message-subject">
                  {!message.isRead && <span className="em-sr-only">Unread. </span>}
                  {message.subject || "(no subject)"}
                </span>
                <span className="em-message-preview">
                  {message.preview}
                  <span className="em-message-icons">
                    {message.hasAttachments && <FaPaperclip aria-label="Has attachment" />}
                    {message.flag === "flagged" && <FaFlag className="em-flag-on" aria-label="Flagged" />}
                    {message.importance === "high" && <strong className="em-important" aria-label="High importance">!</strong>}
                  </span>
                </span>
                {message.categories.length > 0 && (
                  <span className="em-message-cats">{message.categories.slice(0, 3).map((c) => <span key={c} className="em-cat">{c}</span>)}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {hasMore && (
        <div className="em-more">
          <button type="button" className="em-btn" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? "Loading..." : "Load more"}</button>
        </div>
      )}
    </section>
  );
}

export default MessageList;
