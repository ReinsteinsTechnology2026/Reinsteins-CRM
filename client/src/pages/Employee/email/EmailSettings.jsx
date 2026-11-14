import { useEffect, useMemo, useRef, useState } from "react";
import { FaTimes } from "react-icons/fa";
import { toast } from "react-toastify";

import { mailFor, prefs, errorInfo } from "./emailApi";
import RichTextEditor from "./RichTextEditor";

// ==========================================
// MAIL SETTINGS
//   * Signature -- kept in ZioVenture and shared by all accounts (neither Gmail nor Outlook offers a signature API).
//   * Automatic replies / out of office -- stored at the PROVIDER for the chosen account: Outlook / Microsoft 365 (separate messages for
//     inside and outside your company) or Gmail's vacation responder (one message; limited to contacts or your domain on request).
// ==========================================

const plainFromHtml = (html) => {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(String(html).replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div)>/gi, "\n"), "text/html");
  return (doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
};
const htmlFromPlain = (text) =>
  String(text || "").split(/\n/).map((line) => `<div>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") || "<br>"}</div>`).join("");

// datetime-local wants "YYYY-MM-DDTHH:mm"; providers return longer forms.
const toLocalInput = (value) => (value ? String(value).slice(0, 16) : "");

function EmailSettings({ accounts, initialAccountId, onClose, onSaved, onProblem }) {
  const usable = accounts.filter((a) => a.status === "connected");
  const [accountId, setAccountId] = useState(initialAccountId && usable.some((a) => a.id === initialAccountId) ? initialAccountId : usable[0]?.id);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [signatureEnabled, setSignatureEnabled] = useState(false);
  const [signatureHtml, setSignatureHtml] = useState("");
  const [timeZone, setTimeZone] = useState("UTC");
  const [autoLoaded, setAutoLoaded] = useState(false);
  const [auto, setAuto] = useState({ status: "disabled", externalAudience: "none", internal: "", external: "", start: "", end: "", subject: "" });
  const editorRef = useRef(null);
  const account = usable.find((a) => a.id === accountId);
  const separate = account?.capabilities?.autoReplySeparateMessages !== false;
  const mailApi = useMemo(() => (accountId ? mailFor(accountId) : null), [accountId]);

  useEffect(() => {
    let cancelled = false;
    prefs.get()
      .then((result) => { if (!cancelled) { setSignatureEnabled(Boolean(result.signature?.enabled)); setSignatureHtml(result.signature?.html || ""); } })
      .catch((err) => !cancelled && setLoadError(errorInfo(err).message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!mailApi) return undefined;
    let cancelled = false;
    setAutoLoaded(false);
    mailApi.autoReply()
      .then((result) => {
        if (cancelled) return;
        setTimeZone(result.timeZone || "UTC");
        const r = result.automaticReplies || {};
        setAuto({
          status: r.status || "disabled",
          externalAudience: r.externalAudience || "none",
          internal: plainFromHtml(r.internalReplyMessage),
          external: plainFromHtml(r.externalReplyMessage),
          start: toLocalInput(r.scheduledStartDateTime),
          end: toLocalInput(r.scheduledEndDateTime),
          subject: r.subject || "",
        });
        setAutoLoaded(true);
      })
      .catch((err) => {
        const info = errorInfo(err);
        setAutoLoaded(false);
        setError(info.message);
        if (info.needsReconnect) onProblem && onProblem(info);
      });
    return () => { cancelled = true; };
  }, [mailApi, onProblem]);

  async function save(event) {
    event.preventDefault();
    setError("");
    if (auto.status === "scheduled" && (!auto.start || !auto.end)) return setError("Choose a start and an end time for scheduled replies.");
    if (auto.status === "scheduled" && auto.end <= auto.start) return setError("The end time must be after the start time.");
    setSaving(true);
    try {
      await prefs.save({ signature: { html: editorRef.current?.getHtml() ?? signatureHtml, enabled: signatureEnabled } });
      if (mailApi && autoLoaded) {
        await mailApi.saveAutoReply({
          status: auto.status,
          externalAudience: auto.externalAudience,
          internalReplyMessage: htmlFromPlain(auto.internal),
          externalReplyMessage: htmlFromPlain(separate ? auto.external : auto.internal),
          subject: auto.subject,
          timeZone,
          utcOffsetMinutes: new Date().getTimezoneOffset(),
          scheduledStartDateTime: auto.status === "scheduled" ? `${auto.start}:00` : undefined,
          scheduledEndDateTime: auto.status === "scheduled" ? `${auto.end}:00` : undefined,
        });
      }
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
              <legend>Signature (all accounts)</legend>
              <label className="em-check">
                <input type="checkbox" checked={signatureEnabled} onChange={(e) => setSignatureEnabled(e.target.checked)} /> Add my signature to new messages and replies
              </label>
              <RichTextEditor ref={editorRef} initialHtml={signatureHtml} label="Signature" placeholder="Your name, title and contact details" />
            </fieldset>

            <fieldset>
              <legend>Automatic replies (out of office)</legend>
              {usable.length > 1 && (
                <label className="em-field">
                  Account
                  <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
                    {usable.map((a) => <option key={a.id} value={a.id}>{a.address} ({a.kindLabel})</option>)}
                  </select>
                </label>
              )}
              {!account && <p className="em-muted">Connect an account to set automatic replies.</p>}
              {account && !autoLoaded && !error && <p className="em-muted">Loading this account&apos;s automatic replies...</p>}
              {account && autoLoaded && (
                <>
                  <p className="em-muted em-fineprint">Stored at {account.provider === "google" ? "Google" : "Microsoft"} for {account.address}, so they keep working when you are not signed in here.</p>
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
                      {!separate && (
                        <label className="em-field">Subject <input type="text" maxLength={200} value={auto.subject} onChange={(e) => setAuto((a) => ({ ...a, subject: e.target.value }))} placeholder="Out of office" /></label>
                      )}
                      <label className="em-field">
                        {separate ? "Reply to people inside my company" : "Reply message"}
                        <textarea rows={4} maxLength={5000} value={auto.internal} onChange={(e) => setAuto((a) => ({ ...a, internal: e.target.value }))} />
                      </label>
                      <label className="em-field">
                        {separate ? "Send replies outside my company" : "Who gets a reply"}
                        <select value={auto.externalAudience} onChange={(e) => setAuto((a) => ({ ...a, externalAudience: e.target.value }))}>
                          <option value="none">{separate ? "Do not reply to outside senders" : "Only people in my own domain"}</option>
                          <option value="contactsOnly">Only to my contacts</option>
                          <option value="all">{separate ? "To everyone" : "Everyone"}</option>
                        </select>
                      </label>
                      {separate && auto.externalAudience !== "none" && (
                        <label className="em-field">
                          Reply to people outside my company
                          <textarea rows={4} maxLength={5000} value={auto.external} onChange={(e) => setAuto((a) => ({ ...a, external: e.target.value }))} />
                        </label>
                      )}
                    </>
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
