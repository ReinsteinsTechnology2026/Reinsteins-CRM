import { useEffect, useRef, useState } from "react";

import { ITEM_KINDS, LIMITS, emptyDraft, validateDraft } from "../../vault/itemModel";
import GeneratorPanel from "./GeneratorPanel";
import { StrengthMeter } from "./VaultGate";

// Add / edit one item. The draft lives in this component's state only; if the vault locks while it is open, the session seals it
// (encrypted) so the work can be offered again after unlocking.
export default function ItemEditor({ session, state, initial, uid, version, onSaved, onCancel }) {
  const [draft, setDraft] = useState(() => ({ ...emptyDraft(), ...initial }));
  const [showPassword, setShowPassword] = useState(false);
  const [showGen, setShowGen] = useState(false);
  const [errors, setErrors] = useState({});
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    session.setDraftProvider(() => ({ ...draftRef.current, uid: uid || null, version: version ?? null }));
    return () => session.setDraftProvider(null);
  }, [session, uid, version]);

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const isNote = draft.kind === "secure_note";

  const setField = (index, patch) => setDraft((d) => ({ ...d, fields: d.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)) }));
  const addField = () => setDraft((d) => (d.fields.length >= LIMITS.FIELDS ? d : { ...d, fields: [...d.fields, { label: "", value: "", hidden: false }] }));
  const removeField = (index) => setDraft((d) => ({ ...d, fields: d.fields.filter((_, i) => i !== index) }));

  const save = async (event) => {
    event.preventDefault();
    setSaveError(null);
    const { ok, errors: found } = validateDraft(draft);
    setErrors(found);
    if (!ok) return;
    setSaving(true);
    try {
      if (uid) await session.updateItem(uid, draft, version);
      else await session.createItem(draft);
      session.discardDraft();
      onSaved(uid);
    } catch (error) {
      setSaveError(session.describe(error));
    } finally {
      setSaving(false);
    }
  };

  const err = (key) => (errors[key] ? <span className="zv-error" role="alert">{errors[key]}</span> : null);

  return (
    <form className="zv-editor" onSubmit={save} data-testid="vault-editor" autoComplete="off" noValidate>
      <h2>{uid ? "Edit item" : "New item"}</h2>

      <label className="zv-field">Type
        <select data-testid="vault-field-kind" value={draft.kind} onChange={(e) => set({ kind: e.target.value })}>
          {ITEM_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
      </label>

      <label className="zv-field">Name
        <input data-testid="vault-field-title" value={draft.title} maxLength={LIMITS.TITLE} onChange={(e) => set({ title: e.target.value })} autoFocus />
        {err("title")}
      </label>

      {!isNote && (
        <>
          <label className="zv-field">Website address
            <input data-testid="vault-field-url" value={draft.url} maxLength={LIMITS.URL} placeholder="https://" onChange={(e) => set({ url: e.target.value })} />
            {err("url")}
          </label>
          <label className="zv-field">Username
            <input data-testid="vault-field-username" value={draft.username} maxLength={LIMITS.USERNAME} autoComplete="off" onChange={(e) => set({ username: e.target.value })} />
          </label>
          <label className="zv-field">{draft.kind === "api_key" ? "Key or token" : "Password"}
            <div className="zv-inline">
              <input data-testid="vault-field-password" type={showPassword ? "text" : "password"} value={draft.password} maxLength={LIMITS.PASSWORD} autoComplete="new-password" spellCheck="false" onChange={(e) => set({ password: e.target.value })} />
              <button type="button" className="zv-btn" onClick={() => setShowPassword((v) => !v)} aria-pressed={showPassword} data-testid="vault-field-toggle">{showPassword ? "Hide" : "Show"}</button>
              <button type="button" className="zv-btn" onClick={() => setShowGen((v) => !v)} data-testid="vault-open-generator">Generate</button>
            </div>
            {err("password")}
          </label>
          {draft.kind === "login" && <StrengthMeter password={draft.password} label="Password strength" />}
          {showGen && <GeneratorPanel onUse={(value) => { set({ password: value }); setShowGen(false); setShowPassword(true); }} onClose={() => setShowGen(false)} />}
        </>
      )}

      <label className="zv-field">{isNote ? "Note" : "Notes"}
        <textarea data-testid="vault-field-notes" rows={isNote ? 10 : 4} value={draft.notes} maxLength={LIMITS.NOTES} onChange={(e) => set({ notes: e.target.value })} />
        {err("notes")}
      </label>

      <label className="zv-field">Folder
        <select data-testid="vault-field-folder" value={draft.folderUid || ""} onChange={(e) => set({ folderUid: e.target.value || null })}>
          <option value="">No folder</option>
          {state.folders.map((f) => <option key={f.uid} value={f.uid}>{f.name}</option>)}
        </select>
      </label>

      <fieldset className="zv-fields">
        <legend>Custom fields</legend>
        {draft.fields.map((field, index) => (
          <div className="zv-custom" key={index}>
            <input aria-label="Field label" placeholder="Label" value={field.label} maxLength={LIMITS.FIELD_LABEL} data-testid={`vault-custom-label-${index}`} onChange={(e) => setField(index, { label: e.target.value })} />
            <input aria-label="Field value" placeholder="Value" type={field.hidden ? "password" : "text"} value={field.value} maxLength={LIMITS.FIELD_VALUE} data-testid={`vault-custom-value-${index}`} autoComplete="off" onChange={(e) => setField(index, { value: e.target.value })} />
            <label className="zv-check"><input type="checkbox" checked={field.hidden} onChange={(e) => setField(index, { hidden: e.target.checked })} /> <span>Hidden</span></label>
            <button type="button" className="zv-link" onClick={() => removeField(index)}>Remove</button>
          </div>
        ))}
        {err("fields")}
        <button type="button" className="zv-btn" data-testid="vault-add-field" onClick={addField} disabled={draft.fields.length >= LIMITS.FIELDS}>Add field</button>
        <p className="zv-hint">Hidden fields are encrypted with the password and are only shown on request. Other fields appear with the item's details and can be searched.</p>
      </fieldset>

      <label className="zv-check"><input type="checkbox" data-testid="vault-field-favorite" checked={draft.favorite} onChange={(e) => set({ favorite: e.target.checked })} /> <span>Favorite</span></label>

      {saveError && <p className="zv-error" role="alert" data-testid="vault-error">{saveError}</p>}
      <div className="zv-row">
        <button type="submit" className="zv-btn zv-btn-primary" data-testid="vault-save" disabled={saving}>{saving ? "Encrypting and saving…" : "Save"}</button>
        <button type="button" className="zv-btn" data-testid="vault-cancel" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </form>
  );
}
