import { useCallback, useEffect, useRef, useState } from "react";
import { FaPaperPlane, FaPaperclip, FaTimes, FaTrashAlt, FaExclamationTriangle } from "react-icons/fa";
import { toast } from "react-toastify";

import { mail, errorInfo } from "./emailApi";
import { formatBytes } from "./emailUtils";
import RecipientField from "./RecipientField";
import RichTextEditor from "./RichTextEditor";

// ==========================================
// COMPOSE WINDOW -- new message, reply, reply all, forward and "edit draft".
//
// Everything is stored in the employee's OWN Microsoft mailbox as a draft the moment it is first saved (or an attachment is
// added): "Save draft" and "Send" both go through that draft, so what is sent is exactly what is in the Drafts folder.
// The server sanitizes the body and validates every recipient, subject and attachment again; the checks here only save a
// round trip and explain problems early.
// ==========================================

const MAX_FILE_BYTES = 25 * 1024 * 1024;
// A short client-side list; the server holds the full list (the same one Outlook blocks) and is the real gate.
const BLOCKED = new Set(["exe", "bat", "cmd", "com", "scr", "js", "jse", "vbs", "vbe", "ps1", "msi", "jar", "lnk", "hta", "dll", "reg", "wsf", "cpl", "pif"]);

const toPayloadList = (list) => list.map((p) => ({ address: p.address, name: p.name || "" }));
const blockedExtension = (name) => String(name).toLowerCase().split(".").slice(1).find((ext) => BLOCKED.has(ext));

function ComposeWindow({ initial, signature, onClose, onSent, onSaved, onProblem }) {
  const [to, setTo] = useState(initial.to || []);
  const [cc, setCc] = useState(initial.cc || []);
  const [bcc, setBcc] = useState(initial.bcc || []);
  const [subject, setSubject] = useState(initial.subject || "");
  const [importance, setImportance] = useState(initial.importance || "normal");
  const [attachments, setAttachments] = useState(initial.attachments || []);
  const [showCc, setShowCc] = useState((initial.cc || []).length > 0);
  const [showBcc, setShowBcc] = useState((initial.bcc || []).length > 0);
  const [status, setStatus] = useState("idle"); // idle | saving | saved | error
  const [sending, setSending] = useState(false);
  const [uploads, setUploads] = useState([]);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  const editorRef = useRef(null);
  const draftIdRef = useRef(initial.draftId || null);
  const dirtyRef = useRef(false);
  const busyRef = useRef(false);
  const fileInputRef = useRef(null);

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
    to: toPayloadList(to),
    cc: toPayloadList(cc),
    bcc: toPayloadList(bcc),
    subject,
    body: editorRef.current?.getHtml() || "",
    importance,
    appendSignature: false, // the signature is already in the editor
  });

  // Creates the draft on first use, otherwise updates it. Never runs twice at once.
  const ensureDraft = useCallback(async () => {
    while (busyRef.current) await new Promise((resolve) => setTimeout(resolve, 60));
    busyRef.current = true;
    try {
      const payload = buildPayload();
      if (draftIdRef.current) {
        await mail.updateDraft(draftIdRef.current, payload);
      } else {
        const created = await mail.createDraft(payload);
        draftIdRef.current = created.draft.id;
      }
      dirtyRef.current = false;
      return draftIdRef.current;
    } finally {
      busyRef.current = false;
    }
    // buildPayload reads the latest state through closures below; the effect that autosaves re-binds when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, bcc, subject, importance]);

  const saveDraft = useCallback(async ({ silent = false } = {}) => {
    setStatus("saving");
    setError("");
    try {
      await ensureDraft();
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
  }, [ensureDraft, onSaved, onProblem]);

  // Autosave every 15 seconds while there are unsaved changes (only once there is something worth keeping).
  useEffect(() => {
    const timer = setInterval(() => {
      const hasContent = to.length || cc.length || bcc.length || subject.trim() || (editorRef.current?.getText() || "").trim();
      if (dirtyRef.current && hasContent && !sending && !busyRef.current) saveDraft({ silent: true });
    }, 15000);
    return () => clearInterval(timer);
  }, [to, cc, bcc, subject, sending, saveDraft]);

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setError("");
    for (const file of files) {
      const ext = blockedExtension(file.name);
      if (ext) {
        setError(`".${ext}" files cannot be attached (blocked for safety, the same as Outlook).`);
        continue;
      }
      if (file.size === 0) { setError(`"${file.name}" is empty.`); continue; }
      if (file.size > MAX_FILE_BYTES) { setError(`"${file.name}" is larger than 25 MB.`); continue; }
      const total = attachments.reduce((sum, a) => sum + (a.size || 0), 0) + file.size;
      if (total > MAX_FILE_BYTES) { setError("Attachments together are larger than 25 MB."); continue; }
      const token = `${file.name}-${Date.now()}-${Math.random()}`;
      setUploads((list) => [...list, { token, name: file.name, progress: 0 }]);
      try {
        const draftId = await ensureDraft();
        const result = await mail.addAttachment(draftId, file, (progress) =>
          setUploads((list) => list.map((u) => (u.token === token ? { ...u, progress } : u)))
        );
        setAttachments((list) => [...list, result.attachment]);
        markDirty();
      } catch (err) {
        const info = errorInfo(err);
        setError(info.message);
        if (info.needsReconnect) onProblem && onProblem(info);
      } finally {
        setUploads((list) => list.filter((u) => u.token !== token));
      }
    }
  }

  async function removeAttachment(attachment) {
    try {
      await mail.removeAttachment(draftIdRef.current, attachment.id);
      setAttachments((list) => list.filter((a) => a.id !== attachment.id));
    } catch (err) {
      setError(errorInfo(err).message);
    }
  }

  async function handleSend() {
    setError("");
    const everyone = [...to, ...cc, ...bcc];
    if (everyone.length === 0) return setError("Add at least one recipient.");
    const invalid = everyone.find((p) => p.valid === false);
    if (invalid) return setError(`"${invalid.address}" is not a valid email address.`);
    if (uploads.length > 0) return setError("Wait for the attachments to finish uploading.");
    if (!subject.trim() && !window.confirm("Send this message without a subject?")) return;
    setSending(true);
    try {
      const draftId = await ensureDraft();
      await mail.sendDraft(draftId);
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
    }
  }

  async function handleDiscard() {
    const hasWork = draftIdRef.current || dirtyRef.current;
    if (hasWork && !window.confirm("Discard this message?")) return;
    try {
      if (draftIdRef.current) await mail.discardDraft(draftIdRef.current);
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
    const hasContent = to.length || cc.length || bcc.length || subject.trim() || (editorRef.current?.getText() || "").trim() || attachments.length;
    if ((dirtyRef.current || draftIdRef.current) && hasContent) {
      const ok = await saveDraft({ silent: true });
      if (ok) toast.info("Saved to Drafts");
      else if (!window.confirm("Your changes could not be saved. Close anyway?")) return;
    }
    onClose && onClose({ discarded: false });
  }

  // Escape closes the window (saving it as a draft), like pressing the X.
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
          <RecipientField label="To" value={to} onChange={(v) => { setTo(v); markDirty(); }} autoFocus={!initial.draftId && to.length === 0} />
          {showCc && <RecipientField label="Cc" value={cc} onChange={(v) => { setCc(v); markDirty(); }} />}
          {showBcc && <RecipientField label="Bcc" value={bcc} onChange={(v) => { setBcc(v); markDirty(); }} />}
          {(!showCc || !showBcc) && (
            <div className="em-compose-toggles">
              {!showCc && <button type="button" onClick={() => setShowCc(true)}>Cc</button>}
              {!showBcc && <button type="button" onClick={() => setShowBcc(true)}>Bcc</button>}
            </div>
          )}
          <div className="em-recipient-row">
            <label className="em-recipient-label" htmlFor="em-subject">Subject</label>
            <input
              id="em-subject"
              className="em-subject"
              type="text"
              maxLength={255}
              value={subject}
              onChange={(event) => { setSubject(event.target.value); markDirty(); }}
              placeholder="Add a subject"
            />
          </div>
        </div>

        <RichTextEditor ref={editorRef} initialHtml={initialHtml} onChange={markDirty} />

        {(attachments.length > 0 || uploads.length > 0) && (
          <ul className="em-attachments" aria-label="Attachments">
            {attachments.map((a) => (
              <li key={a.id} className="em-attachment">
                <FaPaperclip /> <span className="em-attachment-name">{a.name}</span> <span className="em-muted">{formatBytes(a.size)}</span>
                <button type="button" className="em-icon-btn" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(a)}><FaTimes /></button>
              </li>
            ))}
            {uploads.map((u) => (
              <li key={u.token} className="em-attachment em-attachment-uploading">
                <FaPaperclip /> <span className="em-attachment-name">{u.name}</span>
                <progress max="100" value={u.progress} aria-label={`Uploading ${u.name}`} />
              </li>
            ))}
          </ul>
        )}

        {error && (
          <p className="em-compose-error" role="alert"><FaExclamationTriangle /> {error}</p>
        )}

        <footer className="em-compose-footer">
          <button type="button" className="em-btn em-btn-primary" onClick={handleSend} disabled={sending || uploads.length > 0}>
            <FaPaperPlane /> {sending ? "Sending..." : "Send"}
          </button>
          <button type="button" className="em-btn" onClick={() => fileInputRef.current?.click()}>
            <FaPaperclip /> Attach
          </button>
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
