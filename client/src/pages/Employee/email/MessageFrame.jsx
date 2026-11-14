import { useCallback, useEffect, useRef, useState } from "react";

import { buildMessageFrame } from "./emailUtils";

// ==========================================
// MESSAGE FRAME -- shows one message body safely.
//
// Two independent layers protect the CRM page from a hostile email:
//   1. the server already stripped everything outside an allow-list (utils/emailHtmlSanitizer.js);
//   2. the body is rendered in an <iframe sandbox> WITHOUT allow-scripts, so no script can run inside it even if
//      markup slipped through, and a Content-Security-Policy inside the document allows no network loads at all
//      (only inline data: images). "allow-same-origin" is present ONLY so this component can read the frame's height;
//      it is safe because the frame cannot run script. Links open in a new tab (allow-popups) and cannot reach the CRM
//      window (noopener is set by the server on every link).
// ==========================================

function MessageFrame({ html, title = "Message content" }) {
  const frameRef = useRef(null);
  const [height, setHeight] = useState(120);

  const resize = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc || !doc.body) return;
    setHeight(Math.min(Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight, 40), 20000));
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const onLoad = () => {
      resize();
      // Images (data:) can change the height after load.
      const doc = frame.contentDocument;
      doc?.querySelectorAll("img").forEach((img) => img.addEventListener("load", resize));
    };
    frame.addEventListener("load", onLoad);
    window.addEventListener("resize", resize);
    return () => {
      frame.removeEventListener("load", onLoad);
      window.removeEventListener("resize", resize);
    };
  }, [html, resize]);

  return (
    <iframe
      ref={frameRef}
      className="em-frame"
      title={title}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={buildMessageFrame(html || "")}
      style={{ height }}
    />
  );
}

export default MessageFrame;
