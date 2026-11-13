import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { FaBold, FaItalic, FaUnderline, FaListUl, FaListOl, FaLink, FaQuoteRight, FaEraser, FaUndo, FaRedo, FaStrikethrough } from "react-icons/fa";

// ==========================================
// RICH TEXT EDITOR -- a small contentEditable editor for the composer (no extra dependency).
//
// What it produces is only a DRAFT of HTML: the server sanitizes everything again before it is saved to Microsoft or sent,
// so nothing the editor (or a pasted fragment) contains can bypass the allow-list. Pasting inserts plain text, which keeps
// foreign styles, scripts and tracking markup out of a message in the first place.
// ==========================================

const COMMANDS = [
  { id: "bold", icon: FaBold, label: "Bold", run: () => document.execCommand("bold") },
  { id: "italic", icon: FaItalic, label: "Italic", run: () => document.execCommand("italic") },
  { id: "underline", icon: FaUnderline, label: "Underline", run: () => document.execCommand("underline") },
  { id: "strike", icon: FaStrikethrough, label: "Strikethrough", run: () => document.execCommand("strikeThrough") },
  { id: "ul", icon: FaListUl, label: "Bulleted list", run: () => document.execCommand("insertUnorderedList") },
  { id: "ol", icon: FaListOl, label: "Numbered list", run: () => document.execCommand("insertOrderedList") },
  { id: "quote", icon: FaQuoteRight, label: "Quote", run: () => document.execCommand("formatBlock", false, "blockquote") },
  {
    id: "link",
    icon: FaLink,
    label: "Insert link",
    run: () => {
      const value = window.prompt("Link address (https://...)");
      if (!value) return;
      const url = value.trim();
      // Only web and mail links; the server enforces this again.
      if (!/^(https?:\/\/|mailto:)/i.test(url)) {
        window.alert("Enter a link that starts with https://, http:// or mailto:");
        return;
      }
      document.execCommand("createLink", false, url);
    },
  },
  { id: "clear", icon: FaEraser, label: "Clear formatting", run: () => document.execCommand("removeFormat") },
  { id: "undo", icon: FaUndo, label: "Undo", run: () => document.execCommand("undo") },
  { id: "redo", icon: FaRedo, label: "Redo", run: () => document.execCommand("redo") },
];

const RichTextEditor = forwardRef(function RichTextEditor({ initialHtml = "", onChange, placeholder = "Write your message", label = "Message body" }, ref) {
  const editorRef = useRef(null);

  useImperativeHandle(ref, () => ({
    getHtml: () => editorRef.current?.innerHTML || "",
    getText: () => editorRef.current?.innerText || "",
    setHtml: (html) => {
      if (editorRef.current) editorRef.current.innerHTML = html || "";
    },
    focus: () => editorRef.current?.focus(),
  }));

  // The initial content is written once; the editor owns its content afterwards (so the caret never jumps).
  useEffect(() => {
    if (editorRef.current) editorRef.current.innerHTML = initialHtml || "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handlePaste(event) {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") || "";
    document.execCommand("insertText", false, text);
  }

  return (
    <div className="em-editor">
      <div className="em-editor-toolbar" role="toolbar" aria-label="Formatting">
        {COMMANDS.map(({ id, icon: Icon, label: commandLabel, run }) => (
          <button
            key={id}
            type="button"
            className="em-icon-btn"
            title={commandLabel}
            aria-label={commandLabel}
            // mouseDown keeps the selection in the editor while a button is pressed.
            onMouseDown={(event) => {
              event.preventDefault();
              editorRef.current?.focus();
              run();
              onChange && onChange();
            }}
          >
            <Icon />
          </button>
        ))}
      </div>
      <div
        ref={editorRef}
        className="em-editor-body"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        data-placeholder={placeholder}
        onInput={() => onChange && onChange()}
        onPaste={handlePaste}
      />
    </div>
  );
});

export default RichTextEditor;
