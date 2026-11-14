import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaPaperPlane, FaPaperclip, FaTimes, FaTrashAlt, FaExclamationTriangle } from "react-icons/fa";
import { toast } from "react-toastify";

import { mailFor, errorInfo } from "./emailApi";
import { formatBytes } from "./emailUtils";
import RecipientField from "./RecipientField";
import RichTextEditor from "./RichTextEditor";

// ==========================================
// COMPOSE WINDOW -- new message, reply, reply all, forward and "edit draft", from ANY of the employee's connected accounts.
//
// A message is stored in the chosen account's own Drafts at the provider (Gmail / Outlook) the moment it is first saved, so what is
// sent is exactly what the Drafts folder holds. Saving and sending are ONE request carrying the message and any NEW files; files the
// draft already holds are listed and kept by id. The server sanitizes the body and validates recipients, subject and attachments
// again; the checks here only save a round trip and explain problems early.
// ==========================================

const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 15;
// A short client-side list; the server holds the full list (the same one Outlook blocks) and is the real gate.
const BLOCKED = new Set(["exe", "bat", "cmd", "com", "scr", "js", "jse", "vbs", "vbe", "ps1", "msi", "jar", "lnk", "hta", "dll", "reg", "wsf", "cpl", "pif"]);

const toPayloadList = (list) => list.map((p) => ({ address: p.address, name: p.name || "" }));
const blockedExtension = (name) => String(name).toLowerCase().split(".").slice(1).find((ext) => BLOCKED.has(ext));

function ComposeWindow({ accounts, initial, signature, onClose, onSent, onSaved, onProblem }) {
  const usable = accounts.filter((a) => a.status === "connected");
  const [fromId, setFromId] = useState(initial.accountId && usable.some((a) => a.id === initial.accountId) ? initial.accountId : usable[0]?.id);
  const [to, setTo] = useState(initial.to || []);
  const [cc, setCc] = useState(initial.cc || []);
  const [bcc, setBcc] = useState(initial.bcc || []);
  const [subject, setSubject] = useState(initial.subject || "");
  const [importance, setImportance] = useState(initial.importance || "normal");
  const [existing, setExisting] = useState(initial.attachments || []);
  const [newFiles, setNewFiles] = useState([]);
  const [showCc, setShowCc] = useState((initial.cc || []).length > 0);
  const [showBcc, setShowBcc] = useState((initial.bcc || []).length > 0);
  const [status, setStatus] = useState("idle"); // idle | saving | saved | error
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [hasDraft, setHasDraft] = useState(Boolean(initial.draftId));

  const editorRef = useRef(null);
  const draftIdRef = useRef(initial.draftId || null);
  const dirtyRef = useRef(false);
  const busyRef = useRef(false);
  const fileInputRef = useRef(null);
  const mailApi = useMemo(() => mailFor(fromId), [fromId]);
  const fromAccount = usable.find((a) => a.id === fromId);

  // The signature is written into the editor ONCE, below the quoted text of a reply or at the end of a new message.
  const initialHtml = (() => {
    const body = initial.bodyHtml || "";
    if (!signature || initial.draftId) return body;
    return `<p><br></p><div class="zv-signature">${signature}</div>${body}`;
  })();

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setStatus((current) => (current === "saving" ? current : "idle"));
  }, []);

  const buildPayload = () => ({
    draftId: draftIdRef.current || undefined,
    to: toPayloadList(to),
    cc: toPayloadList(cc),
    bcc: toPayloadList(bcc),
    subject,
    body: editorRef.current?.getHtml() || "",
    importance,
    keepAttachmentIds: existing.map((a) => a.id),
  });

  // Saves the draft (creating it on first use). Only the files in the snapshot are cleared afterwards, so a file added while the
  // request was running is still there for the next save.
  const saveNow = useCallback(async () => {
    while (busyRef.current) await new Promise((resolve) => setTimeout(resolve, 60));
    busyRef.current = true;
    try {
      const sent = newFiles;
      const result = await mailApi.saveDraft(buildPayload(), sent.map((f) => f.file), setProgress);
      draftIdRef.current = result.draft.id;
      setHasDraft(true);
      setExisting(result.draft.attachments || []);
      setNewFiles((list) => list.filter((f) => !sent.includes(f)));
      dirtyRef.current = false;
      return result.draft.id;
    } finally {
      busyRef.current = false;
      setProgress(null);
    }
    // buildPayload reads the latest state through closures; the effect that autosaves re-binds when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, bcc, subject, importance, existing, newFiles, mailApi]);

  const saveDraft = useCallback(async ({ silent = false } = {}) => {
    setStatus("saving");
    setError("");
    try {
      await saveNow();
      setStatus("saved");
      onSaved && onSaved();
      if (!silent) toast.success("Draft saved");
      return true;
    } catch (err) {
      const info = errorInfo(err);
      setStatus("error");
      setError(info.message);
      if (info.needsReconnect) onProblem && onProblem(info);
      return false;
    }
  }, [saveNow, onSaved, onProblem]);

  // Autosave every 15 seconds while there are unsaved changes (only once there is something worth keeping).
  useEffect(() => {
    const timer = setInterval(() => {
      const hasContent = to.length || cc.length || bcc.length || subject.trim() || newFiles.length || (editorRef.current?.getText() || "").trim();
      if (dirtyRef.current && hasContent && !sending && !busyRef.current) saveDraft({ silent: true });
    }, 15000);
    return () => clearInterval(timer);
  }, [to, cc, bcc, subject, newFiles, sending, saveDraft]);

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setError("");
    let total = existing.reduce((n, a) => n + (a.size || 0), 0) + newFiles.reduce((n, f) => n + f.file.size, 0);
    let count = existing.length + newFiles.length;
    const accepted = [];
    for (const file of files) {
      const ext = blockedExtension(file.name);
      if (ext) { setError(`".${ext}" files cannot be attached (blocked for safety, the same as Outlook).`); continue; }
      if (file.size === 0) { setError(`"${file.name}" is empty.`); continue; }
      if (file.size > MAX_TOTAL_BYTES) { setError(`"${file.name}" is larger than 25 MB.`); continue; }
      if (total + file.size > MAX_TOTAL_BYTES) { setError("Attachments together are larger than 25 MB."); continue; }
      if (count >= MAX_FILES) { setError("Too many attachments."); continue; }
      total += file.size;
      count += 1;
      accepted.push({ key: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`, file });
    }
    if (accepted.length) {
      setNewFiles((list) => [...list, ...accepted]);
      markDirty();
    }
  }

  async function handleSend() {
    setError("");
    const everyone = [...to, ...cc, ...bcc];
    if (everyone.length === 0) return setError("Add at least one recipient.");
    const invalid = everyone.find((p) => p.valid === false);
    if (invalid) return setError(`"${invalid.address}" is not a valid email address.`);
    if (!subject.trim() && !window.confirm("Send this message without a subject?")) return;
    setSending(true);
    try {
      await mailApi.send(buildPayload(), newFiles.map((f) => f.file), setProgress);
      toast.success("Message sent");
      draftIdRef.current = null;
      dirtyRef.current = false;
      onSent && onSent();
    } catch (err) {
      const info = errorInfo(err);
      setError(info.message);
      setStatus("error");
      if (info.needsReconnect) onProblem && onProblem(info);
    } finally {
      setSending(false);
      setProgress(null);
    }
  }

  async function handleDiscard() {
    const hasWork = draftIdRef.current || dirtyRef.current;
    if (hasWork && !window.confirm("Discard this message?")) return;
    try {
      if (draftIdRef.current) await mailApi.discardDraft(draftIdRef.current);
    } catch (err) {
      const info = errorInfo(err);
      if (info.status !== 404) {
        setError(info.message);
        return;
      }
    }
    draftIdRef.current = null;
    dirtyRef.current = false;
    onClose && onClose({ discarded: true });
  }

  async function handleClose() {
    const hasContent = to.length || cc.length || bcc.length || subject.trim() || (editorRef.current?.getText() || "").trim() || existing.length || newFiles.length;
    if ((dirtyRef.current || draftIdRef.current) && hasContent) {
      const ok = await saveDraft({ silent: true });
      if (ok) toast.info("Saved to Drafts");
      else if (!window.confirm("Your changes could not be saved. Close anyway?")) return;
    }
    onClose && onClose({ discarded: false });
  }

  // Escape closes the window (saving it as a draft), like pressing the X. Ctrl/Cmd+Enter sends.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape" && !sending) handleClose();
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") handleSend();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  return (
    <div className="em-compose-backdrop" role="presentation">
      <div
        className={`em-compose ${dragging ? "em-compose-drop" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={initial.title || "New message"}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}
      >
        <header className="em-compose-header">
          <h2>{initial.title || "New message"}</h2>
          <span className="em-compose-status" aria-live="polite">
            {status === "saving" && "Saving..."}
            {status === "saved" && "Draft saved"}
            {status === "error" && "Not saved"}
          </span>
          <button type="button" className="em-icon-btn" aria-label="Close and save as draft" onClick={handleClose}><FaTimes /></button>
        </header>

        <div className="em-compose-fields">
          <div className="em-recipient-row">
            <label className="em-recipient-label" htmlFor="em-from">From</label>
            <select
              id="em-from"
              className="em-from"
              value={fromId}
              disabled={hasDraft || usable.length <= 1}
              title={hasDraft ? "This message is already saved in this account's Drafts. Start a new message to send from another account." : undefined}
              onChange={(event) => setFromId(Number(event.target.value))}
            >
              {usable.map((a) => <option key={a.id} value={a.id}>{a.displayName ? `${a.displayName} <${a.address}>` : a.address} ({a.kindLabel})</option>)}
            </select>
          </div>
          <RecipientField mailApi={mailApi} label="To" value={to} onChange={(v) => { setTo(v); markDirty(); }} autoFocus={!initial.draftId && to.length === 0} />
          {showCc && <RecipientField mailApi={mailApi} label="Cc" value={cc} onChange={(v) => { setCc(v); markDirty(); }} />}
          {showBcc && <RecipientField mailApi={mailApi} label="Bcc" value={bcc} onChange={(v) => { setBcc(v); markDirty(); }} />}
          {(!showCc || !showBcc) && (
            <div className="em-compose-toggles">
              {!showCc && <button type="button" onClick={() => setShowCc(true)}>Cc</button>}
              {!showBcc && <button type="button" onClick={() => setShowBcc(true)}>Bcc</button>}
            </div>
          )}
          <div className="em-recipient-row">
            <label className="em-recipient-label" htmlFor="em-subject">Subject</label>
            <input id="em-subject" className="em-subject" type="text" maxLength={255} value={subject} onChange={(event) => { setSubject(event.target.value); markDirty(); }} placeholder="Add a subject" />
          </div>
        </div>

        <RichTextEditor ref={editorRef} initialHtml={initialHtml} onChange={markDirty} />

        {(existing.length > 0 || newFiles.length > 0) && (
          <ul className="em-attachments" aria-label="Attachments">
            {existing.map((a) => (
              <li key={a.id} className="em-attachment">
                <FaPaperclip /> <span className="em-attachment-name">{a.name}</span> <span className="em-muted">{formatBytes(a.size)}</span>
                <button type="button" className="em-icon-btn" aria-label={`Remove ${a.name}`} onClick={() => { setExisting((list) => list.filter((x) => x.id !== a.id)); markDirty(); }}><FaTimes /></button>
              </li>
            ))}
            {newFiles.map((f) => (
              <li key={f.key} className="em-attachment em-attachment-new">
                <FaPaperclip /> <span className="em-attachment-name">{f.file.name}</span> <span className="em-muted">{formatBytes(f.file.size)}</span>
                <button type="button" className="em-icon-btn" aria-label={`Remove ${f.file.name}`} onClick={() => { setNewFiles((list) => list.filter((x) => x !== f)); markDirty(); }}><FaTimes /></button>
              </li>
            ))}
          </ul>
        )}
        {progress !== null && (
          <p className="em-compose-progress" role="status"><progress max="100" value={progress} aria-label="Uploading" /> Uploading {progress}%</p>
        )}

        {error && <p className="em-compose-error" role="alert"><FaExclamationTriangle /> {error}</p>}

        <footer className="em-compose-footer">
          <button type="button" className="em-btn em-btn-primary" onClick={handleSend} disabled={sending || !fromAccount}>
            <FaPaperPlane /> {sending ? "Sending..." : "Send"}
          </button>
          <button type="button" className="em-btn" onClick={() => fileInputRef.current?.click()}><FaPaperclip /> Attach</button>
          <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
          <label className="em-compose-importance">
            <span className="em-sr-only">Importance</span>
            <select value={importance} onChange={(event) => { setImportance(event.target.value); markDirty(); }} aria-label="Importance">
              <option value="normal">Normal importance</option>
              <option value="high">High importance</option>
              <option value="low">Low importance</option>
            </select>
          </label>
          <button type="button" className="em-btn" onClick={() => saveDraft()} disabled={sending}>Save draft</button>
          <button type="button" className="em-btn em-btn-danger" onClick={handleDiscard} disabled={sending}><FaTrashAlt /> Discard</button>
        </footer>
      </div>
    </div>
  );
}

export default ComposeWindow;
