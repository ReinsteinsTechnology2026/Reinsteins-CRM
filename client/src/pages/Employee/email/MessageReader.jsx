import { useEffect, useMemo, useState } from "react";
import { FaReply, FaReplyAll, FaShare, FaTrashAlt, FaArchive, FaFlag, FaRegFlag, FaEnvelope, FaEnvelopeOpen, FaPaperclip, FaDownload, FaChevronLeft, FaUndoAlt, FaPen, FaFolder, FaExclamationTriangle } from "react-icons/fa";
import { toast } from "react-toastify";

import { errorInfo } from "./emailApi";
import { formatBytes, formatFullDate, initialsOf, recipientsLabel, senderLabel, threadSubject, saveBlob } from "./emailUtils";
import MessageFrame from "./MessageFrame";

// ==========================================
// MESSAGE READER -- one conversation: sender / recipients / time, safe body, attachments, thread, actions.
//
// The body arrives already sanitized by the server and is shown in a sandboxed frame (MessageFrame). Remote images are never
// loaded (they are tracking beacons); the notice below says so when a message had any.
// ==========================================

function Avatar({ person }) {
  return <span className="em-avatar" aria-hidden="true">{initialsOf(person)}</span>;
}

function Attachments({ mailApi, messageId, attachments }) {
  const [busy, setBusy] = useState(null);
  const files = attachments.filter((a) => !a.isInline);

  async function open(attachment, inline) {
    setBusy(attachment.id);
    try {
      const response = await mailApi.attachmentBlob(messageId, attachment.id, inline);
      const type = response.headers["content-type"] || "application/octet-stream";
      if (inline && type !== "application/octet-stream") {
        const url = URL.createObjectURL(response.data);
        window.open(url, "_blank", "noopener");
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } else {
        saveBlob(response.data, attachment.name);
      }
    } catch (err) {
      toast.error(errorInfo(err).message || "Could not download the attachment.");
    } finally {
      setBusy(null);
    }
  }

  if (files.length === 0) return null;
  return (
    <ul className="em-attachments" aria-label="Attachments">
      {files.map((a) => {
        const previewable = /^image\/(png|jpeg|gif|webp)$/i.test(a.contentType) || a.contentType === "application/pdf";
        return (
          <li key={a.id} className="em-attachment">
            <FaPaperclip aria-hidden="true" />
            <span className="em-attachment-name">{a.name}</span>
            <span className="em-muted">{formatBytes(a.size)}</span>
            {a.downloadable ? (
              <>
                {previewable && <button type="button" className="em-btn em-btn-small" disabled={busy === a.id} onClick={() => open(a, true)}>Preview</button>}
                <button type="button" className="em-btn em-btn-small" disabled={busy === a.id} onClick={() => open(a, false)}><FaDownload /> Download</button>
              </>
            ) : (
              <span className="em-muted">Not downloadable here</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function MessageCard({ mailApi, message, expanded, onToggle, detail, loading, failed, onReload }) {
  return (
    <article className={`em-card ${expanded ? "em-card-open" : ""}`}>
      <button type="button" className="em-card-head" aria-expanded={expanded} onClick={onToggle}>
        <Avatar person={message.from} />
        <span className="em-card-who">
          <strong>{senderLabel(message.from)}</strong>
          {!expanded && <span className="em-muted em-card-preview">{message.preview}</span>}
          {expanded && <span className="em-muted">to {recipientsLabel(message.to)}</span>}
        </span>
        <time className="em-muted" dateTime={message.receivedAt || message.sentAt || ""}>{formatFullDate(message.receivedAt || message.sentAt)}</time>
      </button>
      {expanded && (
        <div className="em-card-body">
          {loading && <p className="em-muted">Loading message...</p>}
          {failed && (
            <p role="alert" className="em-inline-error">
              <FaExclamationTriangle /> Could not load this message. <button type="button" className="em-link" onClick={onReload}>Try again</button>
            </p>
          )}
          {detail && (
            <>
              {(detail.cc.length > 0 || detail.bcc.length > 0) && (
                <p className="em-muted em-recips">
                  {detail.cc.length > 0 && <>Cc: {recipientsLabel(detail.cc)} </>}
                  {detail.bcc.length > 0 && <>Bcc: {recipientsLabel(detail.bcc)}</>}
                </p>
              )}
              {detail.body.blockedRemoteImages > 0 && (
                <p className="em-notice">Pictures from the internet were not loaded to protect your privacy.</p>
              )}
              <MessageFrame html={detail.body.html} title={`Message from ${senderLabel(detail.from)}`} />
              {detail.body.truncated && <p className="em-notice">This message is very large and was shortened.</p>}
              <Attachments mailApi={mailApi} messageId={detail.id} attachments={detail.attachments} />
            </>
          )}
        </div>
      )}
    </article>
  );
}

function MessageReader({ mailApi, capabilities = {}, accountLabel, message, loading, error, folderKey, folders, onBack, onReply, onTrash, onRestore, onArchive, onToggleRead, onToggleFlag, onMove, onEditDraft, onSetCategories, onReload, categories }) {
  const [thread, setThread] = useState([]);
  const [expanded, setExpanded] = useState(new Set());
  const [details, setDetails] = useState({});
  const [failed, setFailed] = useState(new Set());
  const [moving, setMoving] = useState(false);

  const isDraft = folderKey === "drafts" || message?.isDraft;
  const isDeleted = folderKey === "trash";
  const canDeleteForever = capabilities.permanentDelete !== false;
  const flagWord = capabilities.flag === "star" ? "Star" : "Flag";
  const flagDone = capabilities.flag === "star" ? "Starred" : "Flagged";
  const categoryWord = capabilities.categories === "labels" ? "label" : "category";

  // The open message's own detail is supplied by the parent; the rest of the conversation is fetched here.
  useEffect(() => {
    setThread([]);
    setExpanded(new Set(message ? [message.id] : []));
    setDetails(message ? { [message.id]: message } : {});
    setFailed(new Set());
    if (!message || !message.conversationId || isDraft) return undefined;
    let cancelled = false;
    mailApi.conversation(message.conversationId)
      .then((result) => { if (!cancelled) setThread(result.messages || []); })
      .catch(() => { /* a thread is an enhancement: the open message is still shown */ });
    return () => { cancelled = true; };
  }, [message?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const cards = useMemo(() => {
    if (!message) return [];
    const others = thread.filter((m) => m.id !== message.id);
    return [...others, { ...message }].sort((a, b) => String(a.receivedAt || a.sentAt).localeCompare(String(b.receivedAt || b.sentAt)));
  }, [thread, message]);

  async function toggle(card) {
    const next = new Set(expanded);
    if (next.has(card.id)) {
      next.delete(card.id);
      setExpanded(next);
      return;
    }
    next.add(card.id);
    setExpanded(next);
    if (!details[card.id]) await loadDetail(card.id);
  }

  async function loadDetail(id) {
    setFailed((set) => { const copy = new Set(set); copy.delete(id); return copy; });
    try {
      const result = await mailApi.message(id);
      setDetails((map) => ({ ...map, [id]: result.message }));
    } catch {
      setFailed((set) => new Set(set).add(id));
    }
  }

  if (!message && !loading && !error) {
    return (
      <section className="em-reader em-reader-empty" aria-label="Reading pane">
        <div className="em-state">
          <FaEnvelope aria-hidden="true" className="em-empty-icon" />
          <p><strong>Select a message to read</strong></p>
          <p className="em-muted">Nothing is selected.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="em-reader" aria-label="Reading pane">
      <div className="em-reader-bar">
        <button type="button" className="em-btn em-btn-small em-back" onClick={onBack}><FaChevronLeft /> Back</button>
        {message && (
          <div className="em-reader-actions" role="toolbar" aria-label="Message actions">
            {isDraft ? (
              <button type="button" className="em-btn em-btn-small em-btn-primary" onClick={onEditDraft}><FaPen /> Edit draft</button>
            ) : (
              <>
                <button type="button" className="em-btn em-btn-small" onClick={() => onReply("reply")}><FaReply /> Reply</button>
                <button type="button" className="em-btn em-btn-small" onClick={() => onReply("replyAll")}><FaReplyAll /> Reply all</button>
                <button type="button" className="em-btn em-btn-small" onClick={() => onReply("forward")}><FaShare /> Forward</button>
              </>
            )}
            <button type="button" className="em-btn em-btn-small" onClick={onToggleRead}>{message.isRead ? <><FaEnvelope /> Unread</> : <><FaEnvelopeOpen /> Read</>}</button>
            <button type="button" className="em-btn em-btn-small" aria-pressed={message.flag === "flagged"} onClick={onToggleFlag}>{message.flag === "flagged" ? <><FaFlag className="em-flag-on" /> {flagDone}</> : <><FaRegFlag /> {flagWord}</>}</button>
            {!isDraft && !isDeleted && <button type="button" className="em-btn em-btn-small" onClick={onArchive}><FaArchive /> Archive</button>}
            {isDeleted && <button type="button" className="em-btn em-btn-small" onClick={onRestore}><FaUndoAlt /> Restore</button>}
            {folders.length > 0 && <span className="em-move">
              <button type="button" className="em-btn em-btn-small" aria-haspopup="menu" aria-expanded={moving} onClick={() => setMoving((v) => !v)}><FaFolder /> Move</button>
              {moving && (
                <ul className="em-menu" role="menu">
                  {folders.map((f) => (
                    <li key={f.id} role="none">
                      <button type="button" role="menuitem" onClick={() => { setMoving(false); onMove(f); }}>{f.name}</button>
                    </li>
                  ))}
                </ul>
              )}
            </span>}
            {(!isDeleted || canDeleteForever) && <button type="button" className="em-btn em-btn-small em-btn-danger" onClick={onTrash}><FaTrashAlt /> {isDeleted ? "Delete forever" : "Delete"}</button>}
          </div>
        )}
      </div>

      {loading && <p className="em-muted em-pad">Loading message...</p>}
      {error && (
        <div className="em-state em-state-error" role="alert">
          <p>{error}</p>
          <button type="button" className="em-btn" onClick={onReload}>Try again</button>
        </div>
      )}

      {message && (
        <div className="em-reader-scroll">
          {accountLabel && <p className="em-account-line">{accountLabel}</p>}
          <h2 className="em-reader-subject">{threadSubject(message.subject)}</h2>
          {message.importance === "high" && <p className="em-notice em-important-note">Sent with high importance</p>}
          {categories && (
            <div className="em-reader-cats">
              {(message.categories || []).map((c) => <span key={c} className="em-cat">{c}</span>)}
              {categories.length > 0 && (
                <label className="em-sr-only" htmlFor="em-cat-select">Add category</label>
              )}
              {categories.length > 0 && (
                <select id="em-cat-select" className="em-cat-select" value="" onChange={(e) => e.target.value && onSetCategories([...new Set([...(message.categories || []), e.target.value])])}>
                  <option value="">Add {categoryWord}</option>
                  {categories.filter((c) => !(message.categories || []).includes(c.name)).map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              )}
              {(message.categories || []).length > 0 && (
                <button type="button" className="em-link" onClick={() => onSetCategories([])}>Clear {categoryWord}s</button>
              )}
            </div>
          )}
          {cards.length > 1 && <p className="em-muted em-thread-note">{cards.length} messages in this conversation</p>}
          {cards.map((card) => (
            <MessageCard
              key={card.id}
              mailApi={mailApi}
              message={card}
              expanded={expanded.has(card.id)}
              onToggle={() => toggle(card)}
              detail={card.id === message.id && message.body ? message : details[card.id] && details[card.id].body ? details[card.id] : null}
              loading={expanded.has(card.id) && !(details[card.id] && details[card.id].body) && !failed.has(card.id) && card.id !== message.id}
              failed={failed.has(card.id)}
              onReload={() => loadDetail(card.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default MessageReader;
