import { useEffect, useRef, useState } from "react";
import { FaTimes } from "react-icons/fa";
import { toast } from "react-toastify";

import { mail, errorInfo } from "./emailApi";
import RichTextEditor from "./RichTextEditor";

// ==========================================
// MAIL SETTINGS -- signature (kept in ZioVenture: Outlook offers no signature API) and automatic replies / out of office
// (stored in the employee's own Microsoft mailbox through Graph mailboxSettings).
// ==========================================

const plainFromHtml = (html) => {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div)>/gi, "\n"), "text/html");
  return (doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
};
const htmlFromPlain = (text) =>
  String(text || "")
    .split(/\n/)
    .map((line) => `<div>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") || "<br>"}</div>`)
    .join("");

// datetime-local wants "YYYY-MM-DDTHH:mm"; Graph returns "YYYY-MM-DDTHH:mm:ss.fffffff".
const toLocalInput = (value) => (value ? String(value).slice(0, 16) : "");

function EmailSettings({ onClose, onSaved, onProblem }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [signatureEnabled, setSignatureEnabled] = useState(false);
  const [signatureHtml, setSignatureHtml] = useState("");
  const [timeZone, setTimeZone] = useState("UTC");
  const [auto, setAuto] = useState({ status: "disabled", externalAudience: "none", internal: "", external: "", start: "", end: "" });
  const editorRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    mail.settings()
      .then((result) => {
        if (cancelled) return;
        setSignatureEnabled(Boolean(result.signature?.enabled));
        setSignatureHtml(result.signature?.html || "");
        setTimeZone(result.timeZone || "UTC");
        const replies = result.automaticReplies || {};
        setAuto({
          status: replies.status || "disabled",
          externalAudience: replies.externalAudience || "none",
          internal: plainFromHtml(replies.internalReplyMessage),
          external: plainFromHtml(replies.externalReplyMessage),
          start: toLocalInput(replies.scheduledStartDateTime),
          end: toLocalInput(replies.scheduledEndDateTime),
        });
      })
      .catch((err) => {
        const info = errorInfo(err);
        setLoadError(info.message);
        if (info.needsReconnect) onProblem && onProblem(info);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [onProblem]);

  async function save(event) {
    event.preventDefault();
    setError("");
    if (auto.status === "scheduled" && (!auto.start || !auto.end)) return setError("Choose a start and an end time for scheduled replies.");
    if (auto.status === "scheduled" && auto.end <= auto.start) return setError("The end time must be after the start time.");
    setSaving(true);
    try {
      await mail.saveSettings({
        signature: { html: editorRef.current?.getHtml() ?? signatureHtml, enabled: signatureEnabled },
        automaticReplies: {
          status: auto.status,
          externalAudience: auto.externalAudience,
          internalReplyMessage: htmlFromPlain(auto.internal),
          externalReplyMessage: htmlFromPlain(auto.external),
          timeZone,
          scheduledStartDateTime: auto.status === "scheduled" ? `${auto.start}:00` : undefined,
          scheduledEndDateTime: auto.status === "scheduled" ? `${auto.end}:00` : undefined,
        },
      });
      toast.success("Mail settings saved");
      onSaved && onSaved();
      onClose();
    } catch (err) {
      const info = errorInfo(err);
      setError(info.message);
      if (info.needsReconnect) onProblem && onProblem(info);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="em-compose-backdrop" role="presentation">
      <form className="em-settings" role="dialog" aria-modal="true" aria-label="Mail settings" onSubmit={save}>
        <header className="em-compose-header">
          <h2>Mail settings</h2>
          <button type="button" className="em-icon-btn" aria-label="Close" onClick={onClose}><FaTimes /></button>
        </header>

        {loading && <p className="em-muted em-pad">Loading settings...</p>}
        {loadError && <p className="em-compose-error" role="alert">{loadError}</p>}

        {!loading && !loadError && (
          <div className="em-settings-body">
            <fieldset>
              <legend>Signature</legend>
              <label className="em-check">
                <input type="checkbox" checked={signatureEnabled} onChange={(e) => setSignatureEnabled(e.target.checked)} /> Add my signature to new messages and replies
              </label>
              <RichTextEditor ref={editorRef} initialHtml={signatureHtml} label="Signature" placeholder="Your name, title and contact details" />
            </fieldset>

            <fieldset>
              <legend>Automatic replies (out of office)</legend>
              <label className="em-field">
                Status
                <select value={auto.status} onChange={(e) => setAuto((a) => ({ ...a, status: e.target.value }))}>
                  <option value="disabled">Off</option>
                  <option value="alwaysEnabled">On</option>
                  <option value="scheduled">Only during a time period</option>
                </select>
              </label>
              {auto.status === "scheduled" && (
                <div className="em-row">
                  <label className="em-field">Starts <input type="datetime-local" value={auto.start} onChange={(e) => setAuto((a) => ({ ...a, start: e.target.value }))} /></label>
                  <label className="em-field">Ends <input type="datetime-local" value={auto.end} onChange={(e) => setAuto((a) => ({ ...a, end: e.target.value }))} /></label>
                </div>
              )}
              {auto.status !== "disabled" && (
                <>
                  <label className="em-field">
                    Reply to people inside my company
                    <textarea rows={4} maxLength={5000} value={auto.internal} onChange={(e) => setAuto((a) => ({ ...a, internal: e.target.value }))} />
                  </label>
                  <label className="em-field">
                    Send replies outside my company
                    <select value={auto.externalAudience} onChange={(e) => setAuto((a) => ({ ...a, externalAudience: e.target.value }))}>
                      <option value="none">Do not reply to outside senders</option>
                      <option value="contactsOnly">Only to my contacts</option>
                      <option value="all">To everyone</option>
                    </select>
                  </label>
                  {auto.externalAudience !== "none" && (
                    <label className="em-field">
                      Reply to people outside my company
                      <textarea rows={4} maxLength={5000} value={auto.external} onChange={(e) => setAuto((a) => ({ ...a, external: e.target.value }))} />
                    </label>
                  )}
                </>
              )}
            </fieldset>
          </div>
        )}

        {error && <p className="em-compose-error" role="alert">{error}</p>}
        <footer className="em-compose-footer">
          <button type="submit" className="em-btn em-btn-primary" disabled={saving || loading || Boolean(loadError)}>{saving ? "Saving..." : "Save"}</button>
          <button type="button" className="em-btn" onClick={onClose}>Cancel</button>
        </footer>
      </form>
    </div>
  );
}

export default EmailSettings;
