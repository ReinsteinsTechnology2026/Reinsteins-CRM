import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { FaTimes } from "react-icons/fa";

import "./Modal.css";

// Shared Modal (Batch 1) -- standalone, not yet used by any existing
// page. Mirrors the structural pattern already established by
// platform-modal-backdrop/platform-modal in platformComponents.css
// (header/body/footer, close button, backdrop-click dismiss), but
// adds real accessibility behaviour none of this app's existing
// modals (TaskDetailsModal, WorkLogModal, TransferTaskModal, etc.)
// currently have: a focus trap, Escape-to-close, and focus restored
// to whatever triggered the modal on close. Escape-to-close and the
// scroll lock follow the same pattern already used by
// hooks/useMobileNav.js for the mobile nav drawer.

function Modal({

  open,

  onClose,

  title,

  description,

  footer,

  children,

  className = ""

}) {

  const dialogRef = useRef(null);
  const previouslyFocused = useRef(null);

  // Escape closes the modal.
  useEffect(() => {

    if (!open) {
      return;
    }

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        onClose?.();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => document.removeEventListener("keydown", handleKeyDown);

  }, [open, onClose]);

  // Lock background scroll while open; restored on close/unmount.
  useEffect(() => {

    if (!open) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };

  }, [open]);

  // Move focus into the dialog on open, trap Tab/Shift+Tab inside it
  // while open, and restore focus to whatever triggered it on close.
  useEffect(() => {

    if (!open) {
      return;
    }

    previouslyFocused.current = document.activeElement;

    const dialogNode = dialogRef.current;

    const focusableSelector =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const focusables = dialogNode
      ? Array.from(dialogNode.querySelectorAll(focusableSelector))
      : [];

    (focusables[0] || dialogNode)?.focus();

    const handleKeyDown = (event) => {

      if (event.key !== "Tab" || focusables.length === 0) {
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }

    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused.current?.focus?.();
    };

  }, [open]);

  if (!open) {
    return null;
  }

  return createPortal(

    <div className="ui-modal-backdrop" onClick={onClose}>

      <div

        className={["ui-modal", className].filter(Boolean).join(" ")}

        role="dialog"

        aria-modal="true"

        aria-labelledby={title ? "ui-modal-title" : undefined}

        ref={dialogRef}

        tabIndex={-1}

        onClick={(event) => event.stopPropagation()}

      >

        {(title || description) && (

          <div className="ui-modal-header">

            <div>
              {title && <h2 id="ui-modal-title">{title}</h2>}
              {description && <p>{description}</p>}
            </div>

            <button

              type="button"

              className="ui-modal-close"

              onClick={onClose}

              aria-label="Close"

            >
              <FaTimes />
            </button>

          </div>

        )}

        <div className="ui-modal-body">
          {children}
        </div>

        {footer && (
          <div className="ui-modal-footer">
            {footer}
          </div>
        )}

      </div>

    </div>,

    document.body

  );

}

export default Modal;
