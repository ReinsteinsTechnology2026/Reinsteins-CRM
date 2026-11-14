import { useEffect, useId, useRef, useState } from "react";
import { FaTimes } from "react-icons/fa";

import { isValidAddress, parseAddressText } from "./emailUtils";

// ==========================================
// RECIPIENT FIELD -- chips for To / Cc / Bcc with contact suggestions.
//
// Suggestions come from the employee's OWN Microsoft contacts / frequent correspondents (People.Read, /me/people) through
// the CRM server; nothing is looked up for anyone else. An address that is not valid is shown in red and blocks sending
// (the server validates again).
// ==========================================

function RecipientField({ mailApi, label, value, onChange, autoFocus = false, placeholder = "" }) {
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [active, setActive] = useState(-1);
  const inputRef = useRef(null);
  const listId = useId();
  const requestId = useRef(0);

  useEffect(() => {
    const query = text.trim();
    if (query.length < 2 || (query.includes("@") && isValidAddress(query))) {
      setSuggestions([]);
      return undefined;
    }
    const mine = ++requestId.current;
    const timer = setTimeout(async () => {
      try {
        const result = await mailApi.contacts(query);
        if (mine === requestId.current) {
          const have = new Set(value.map((r) => r.address.toLowerCase()));
          setSuggestions((result.contacts || []).filter((c) => !have.has(c.address.toLowerCase())));
          setActive(-1);
        }
      } catch {
        if (mine === requestId.current) setSuggestions([]); // suggestions are a convenience; typing an address always works
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [text, value, mailApi]);

  function addRecipients(parsed) {
    if (parsed.length === 0) return;
    const have = new Set(value.map((r) => r.address.toLowerCase()));
    const next = [...value];
    for (const person of parsed) {
      if (!have.has(person.address.toLowerCase())) {
        have.add(person.address.toLowerCase());
        next.push({ address: person.address, name: person.name || "", valid: person.valid !== false && isValidAddress(person.address) });
      }
    }
    onChange(next);
    setText("");
    setSuggestions([]);
  }

  function commitText() {
    addRecipients(parseAddressText(text));
  }

  function handleKeyDown(event) {
    if (event.key === "ArrowDown" && suggestions.length) {
      event.preventDefault();
      setActive((index) => (index + 1) % suggestions.length);
    } else if (event.key === "ArrowUp" && suggestions.length) {
      event.preventDefault();
      setActive((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
    } else if (event.key === "Enter" || event.key === "," || event.key === ";" || event.key === "Tab") {
      if (event.key === "Tab" && !text.trim()) return;
      if (active >= 0 && suggestions[active]) {
        event.preventDefault();
        addRecipients([{ ...suggestions[active], valid: true }]);
      } else if (text.trim()) {
        event.preventDefault();
        commitText();
      }
    } else if (event.key === "Backspace" && !text && value.length) {
      onChange(value.slice(0, -1));
    } else if (event.key === "Escape") {
      setSuggestions([]);
    }
  }

  function handlePaste(event) {
    const pasted = event.clipboardData?.getData("text") || "";
    if (/[;,\n]/.test(pasted)) {
      event.preventDefault();
      addRecipients(parseAddressText(pasted.replace(/\n/g, ",")));
    }
  }

  return (
    <div className="em-recipient-row">
      <label className="em-recipient-label" htmlFor={`${listId}-input`}>{label}</label>
      <div className="em-recipient-box" onClick={() => inputRef.current?.focus()}>
        {value.map((person) => (
          <span key={person.address} className={`em-chip ${person.valid === false ? "em-chip-invalid" : ""}`} title={person.valid === false ? "Not a valid email address" : person.address}>
            {person.name || person.address}
            <button
              type="button"
              aria-label={`Remove ${person.name || person.address}`}
              onClick={(event) => {
                event.stopPropagation();
                onChange(value.filter((r) => r.address !== person.address));
              }}
            >
              <FaTimes />
            </button>
          </span>
        ))}
        <input
          id={`${listId}-input`}
          ref={inputRef}
          className="em-recipient-input"
          type="text"
          value={text}
          autoFocus={autoFocus}
          autoComplete="off"
          placeholder={value.length === 0 ? placeholder : ""}
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => setTimeout(commitText, 120)}
          onPaste={handlePaste}
        />
        {suggestions.length > 0 && (
          <ul className="em-suggest" id={listId} role="listbox">
            {suggestions.map((person, index) => (
              <li
                key={person.address}
                role="option"
                aria-selected={index === active}
                className={index === active ? "em-suggest-active" : ""}
                onMouseDown={(event) => {
                  event.preventDefault();
                  addRecipients([{ ...person, valid: true }]);
                }}
              >
                <strong>{person.name || person.address}</strong>
                {person.name && <span>{person.address}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default RecipientField;
