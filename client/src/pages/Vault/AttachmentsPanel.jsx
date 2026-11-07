import { useCallback, useEffect, useRef, useState } from "react";
import { FaPaperclip, FaTrash, FaDownload } from "react-icons/fa";

import { MAX_ATTACHMENT_BYTES, formatSize } from "../../vault/attachmentModel";
import { formatDate } from "./access";
import { saveBytes } from "./download";

// The files attached to one item. Each is encrypted in this browser before it is sent; the server holds only ciphertext. Whoever may reveal
// the item may open its files, whoever may edit it may add or remove them; people who can only see the item's details learn that files exist
// (size and date) but not their names and cannot open them.
export default function AttachmentsPanel({ session, item, locked = false }) {
  const rights = item.rights || { reveal: true, edit: true };
  const [files, setFiles] = useState(null);
  const [named, setNamed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const input = useRef(null);

  const load = useCallback(async (withNames) => {
    try {
      setFiles(await session.listAttachments(item.uid, { withNames }));
      setNamed(withNames);
    } catch (e) {
      setError(session.describe(e));
      setFiles([]);
    }
  }, [session, item.uid]);

  useEffect(() => {
    setFiles(null);
    setNamed(false);
    setError(null);
    setNotice(null);
    load(false);
  }, [load]);

  const run = async (work, done) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      if (done) setNotice(done);
      return true;
    } catch (e) {
      setError(session.describe(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const upload = async (event) => {
    const file = event.target.files && event.target.files[0];
    if (input.current) input.current.value = "";
    if (!file) return;
    await run(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const saved = await session.uploadAttachment(item.uid, { name: file.name, type: file.type, bytes });
      await load(named);
      setNotice(`${saved.name} was encrypted and saved.`);
    });
  };

  const download = async (file) => {
    await run(async () => {
      const opened = await session.downloadAttachment(item.uid, file.uid);
      saveBytes(opened.name, opened.bytes);
    }, "Decrypted here and saved to your device. The file is not kept in the page.");
  };

  const remove = async (file) => {
    const ok = await run(async () => {
      await session.deleteAttachment(item.uid, file.uid);
      await load(named);
    }, "File deleted.");
    if (ok) setConfirm(null);
  };

  const count = files ? files.length : 0;
  return (
    <section className="zv-attach" data-testid="vault-attachments" aria-label="Attachments">
      <h3><FaPaperclip aria-hidden="true" /> Attachments {files ? <span className="zv-count">{count}</span> : null}</h3>
      {error && <p className="zv-error" role="alert" data-testid="vault-attach-error">{error}</p>}
      {notice && <p className="zv-notice" role="status" data-testid="vault-attach-notice">{notice}</p>}
      {files === null ? <p className="zv-hint">Loading…</p> : count === 0 ? (
        <p className="zv-hint" data-testid="vault-attach-empty">No files attached.</p>
      ) : (
        <ul className="zv-files">
          {files.map((f) => (
            <li key={f.uid} data-testid={`vault-attachment-${f.uid}`}>
              <span className="zv-file-name">{f.damaged ? "Damaged name" : f.name || (rights.reveal ? "Encrypted file" : "Encrypted file (name hidden)")}</span>
              <small>{formatSize(f.size)} · {formatDate(f.createdAt)}</small>
              <span className="zv-row">
                {rights.reveal && !locked && <button type="button" className="zv-btn" data-testid={`vault-attachment-download-${f.uid}`} disabled={busy} onClick={() => download(f)}><FaDownload /> Download</button>}
                {rights.edit && !locked && confirm !== f.uid && <button type="button" className="zv-btn zv-btn-danger" data-testid={`vault-attachment-delete-${f.uid}`} onClick={() => setConfirm(f.uid)} aria-label="Delete file"><FaTrash /></button>}
                {confirm === f.uid && <span className="zv-confirm">Delete this file? <button type="button" className="zv-btn zv-btn-danger" data-testid="vault-attachment-delete-confirm" disabled={busy} onClick={() => remove(f)}>Yes, delete</button> <button type="button" className="zv-link" onClick={() => setConfirm(null)}>No</button></span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="zv-row">
        {rights.reveal && count > 0 && !named && <button type="button" className="zv-btn" data-testid="vault-attach-names" disabled={busy} onClick={() => run(() => load(true))}>Show file names</button>}
        {rights.edit && !locked && (
          <label className="zv-btn zv-upload">
            {busy ? "Working…" : "Add a file"}
            <input ref={input} type="file" data-testid="vault-attach-input" onChange={upload} disabled={busy} />
          </label>
        )}
      </div>
      {!rights.reveal && count > 0 && <p className="zv-hint" data-testid="vault-attach-nopermission">You can see that this item has files, but you do not have permission to open them.</p>}
      <p className="zv-hint">Files are encrypted in your browser before they are uploaded (up to {formatSize(MAX_ATTACHMENT_BYTES)} each). Showing names or downloading opens the item's keys and is recorded in its activity log. Programs and scripts cannot be attached.</p>
    </section>
  );
}
