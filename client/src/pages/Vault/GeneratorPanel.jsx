import { useState } from "react";

import {
  DEFAULT_PASSPHRASE_OPTIONS, DEFAULT_PASSWORD_OPTIONS, LENGTH_LIMITS, WORD_LIMITS,
  generatePassphrase, generatePassword, passphraseEntropyBits, passwordEntropyBits, strengthLabel,
} from "../../vault/generator";

// The generator runs entirely in this tab with the browser's CSPRNG (via libsodium). A generated value goes nowhere until the user
// puts it into an item and saves: then it travels encrypted like any other password.
export default function GeneratorPanel({ onUse, onClose }) {
  const [mode, setMode] = useState("password");
  const [pw, setPw] = useState({ ...DEFAULT_PASSWORD_OPTIONS });
  const [pp, setPp] = useState({ ...DEFAULT_PASSPHRASE_OPTIONS });
  const [value, setValue] = useState("");
  const [error, setError] = useState(null);

  let bits = 0;
  try {
    bits = mode === "password" ? passwordEntropyBits(pw) : passphraseEntropyBits(pp);
  } catch {
    bits = 0;
  }

  const generate = async () => {
    setError(null);
    try {
      setValue(mode === "password" ? await generatePassword(pw) : await generatePassphrase(pp));
    } catch (e) {
      setValue("");
      setError(e && e.message ? e.message : "Those options cannot produce a password.");
    }
  };

  const toggle = (key) => setPw((o) => ({ ...o, [key]: !o[key] }));

  return (
    <div className="zv-generator" data-testid="vault-generator">
      <div className="zv-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "password"} className={mode === "password" ? "on" : ""} onClick={() => { setMode("password"); setValue(""); }}>Password</button>
        <button type="button" role="tab" aria-selected={mode === "passphrase"} className={mode === "passphrase" ? "on" : ""} onClick={() => { setMode("passphrase"); setValue(""); }}>Passphrase</button>
      </div>

      {mode === "password" ? (
        <div className="zv-gen-options">
          <label>Length: {pw.length}
            <input type="range" data-testid="vault-gen-length" min={LENGTH_LIMITS.min} max={LENGTH_LIMITS.max} value={pw.length} onChange={(e) => setPw((o) => ({ ...o, length: Number(e.target.value) }))} />
          </label>
          <label className="zv-check"><input type="checkbox" checked={pw.upper} onChange={() => toggle("upper")} /> <span>Uppercase (A–Z)</span></label>
          <label className="zv-check"><input type="checkbox" checked={pw.lower} onChange={() => toggle("lower")} /> <span>Lowercase (a–z)</span></label>
          <label className="zv-check"><input type="checkbox" checked={pw.digits} onChange={() => toggle("digits")} /> <span>Numbers (0–9)</span></label>
          <label className="zv-check"><input type="checkbox" checked={pw.symbols} onChange={() => toggle("symbols")} /> <span>Symbols (!@#…)</span></label>
          <label className="zv-check"><input type="checkbox" checked={pw.excludeAmbiguous} onChange={() => toggle("excludeAmbiguous")} /> <span>Avoid look-alike characters</span></label>
          <label>Also exclude these characters
            <input type="text" data-testid="vault-gen-exclude" value={pw.exclude} maxLength={40} autoComplete="off" spellCheck="false" onChange={(e) => setPw((o) => ({ ...o, exclude: e.target.value }))} />
          </label>
        </div>
      ) : (
        <div className="zv-gen-options">
          <label>Words: {pp.words}
            <input type="range" data-testid="vault-gen-words" min={WORD_LIMITS.min} max={WORD_LIMITS.max} value={pp.words} onChange={(e) => setPp((o) => ({ ...o, words: Number(e.target.value) }))} />
          </label>
          <label>Separator
            <input type="text" value={pp.separator} maxLength={3} autoComplete="off" onChange={(e) => setPp((o) => ({ ...o, separator: e.target.value }))} />
          </label>
          <label className="zv-check"><input type="checkbox" checked={pp.capitalize} onChange={() => setPp((o) => ({ ...o, capitalize: !o.capitalize }))} /> <span>Capitalise words</span></label>
          <label className="zv-check"><input type="checkbox" checked={pp.includeNumber} onChange={() => setPp((o) => ({ ...o, includeNumber: !o.includeNumber }))} /> <span>Add a number</span></label>
        </div>
      )}

      <div className="zv-row">
        <button type="button" className="zv-btn" data-testid="vault-generate" onClick={generate}>Generate</button>
        <span className="zv-hint">Strength: {strengthLabel(bits)} · about {Math.round(bits)} bits</span>
      </div>
      {error && <p className="zv-error" role="alert">{error}</p>}
      {value && (
        <div className="zv-generated">
          <code data-testid="vault-generated-value">{value}</code>
          <button type="button" className="zv-btn zv-btn-primary" data-testid="vault-gen-use" onClick={() => { onUse(value); setValue(""); }}>Use this</button>
        </div>
      )}
      <p className="zv-hint">Generated here, in your browser. It is only saved if you save the item, and then it is encrypted first.</p>
      {onClose && <button type="button" className="zv-link" onClick={onClose}>Close generator</button>}
    </div>
  );
}
