import { useEffect, useRef } from "react";

// A small accessible dialog: labelled, closes with Escape or the backdrop, keeps keyboard focus inside while open, and gives focus back.
export default function Modal({ title, onClose, children, wide = false, labelId = "zv-modal-title" }) {
  const box = useRef(null);
  const opener = useRef(typeof document !== "undefined" ? document.activeElement : null);

  useEffect(() => {
    const previous = opener.current;
    const first = box.current && box.current.querySelector("input:not([disabled]), select:not([disabled]), textarea, button:not([disabled])");
    if (first) first.focus();
    return () => {
      if (previous && typeof previous.focus === "function") previous.focus();
    };
  }, []);

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !box.current) return;
    const focusable = [...box.current.querySelectorAll("input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href]")];
    if (focusable.length === 0) return;
    const [firstEl, lastEl] = [focusable[0], focusable[focusable.length - 1]];
    if (event.shiftKey && document.activeElement === firstEl) {
      event.preventDefault();
      lastEl.focus();
    } else if (!event.shiftKey && document.activeElement === lastEl) {
      event.preventDefault();
      firstEl.focus();
    }
  };

  return (
    <div className="zv-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-testid="vault-modal">
      <div className={`zv-modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={labelId} ref={box} onKeyDown={onKeyDown}>
        <header>
          <h2 id={labelId}>{title}</h2>
          <button type="button" className="zv-link" onClick={onClose} aria-label="Close dialog">Close</button>
        </header>
        {children}
      </div>
    </div>
  );
}
