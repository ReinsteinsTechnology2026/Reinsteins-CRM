import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";

import { accounts } from "../pages/Employee/email/emailApi";
import { subscribeEmailEvents } from "../services/emailEvents";

// ==========================================
// EMAIL UNREAD BADGE
//
// Total unread mail across ALL of the employee's connected accounts, for the sidebar badge, plus how many accounts need attention
// (a provider asked to reconnect). The server keeps the counts in step with Gmail / Outlook; the Gmail / Outlook apps' own
// notifications are untouched -- this only mirrors the numbers inside the CRM.
//
// Live: the server pushes "email:new" over Socket.IO (instant, with a toast); polling every minute while the tab is visible is the
// safe fallback when the socket is down. Nothing is requested unless `enabled` (the tenant has the Email module and a user is signed in).
// ==========================================

const POLL_MS = 60000;

export default function useEmailUnread({ enabled }) {
  const [state, setState] = useState({ unreadTotal: 0, needsAttention: 0, accounts: 0 });
  const lastToast = useRef(0);

  const load = useCallback(async () => {
    try {
      const result = await accounts.summary(false);
      setState({ unreadTotal: result.unreadTotal || 0, needsAttention: result.needsAttention || 0, accounts: (result.accounts || []).length });
    } catch {
      /* a failing badge must never disturb the page: it keeps its last value */
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    const unsubscribe = subscribeEmailEvents((name, payload) => {
      if (name === "email:new") {
        if (typeof payload.unreadTotal === "number") setState((s) => ({ ...s, unreadTotal: payload.unreadTotal }));
        // One toast per burst: a flood of mail must not become a flood of pop-ups.
        if (Date.now() - lastToast.current > 4000) {
          lastToast.current = Date.now();
          const who = payload.latest && payload.latest.from ? payload.latest.from.name || payload.latest.from.address : "someone";
          const subject = payload.latest && payload.latest.subject ? ` - ${String(payload.latest.subject).slice(0, 60)}` : "";
          toast.info(payload.count > 1 ? `${payload.count} new emails` : `New email from ${who}${subject}`, { toastId: `email-new-${payload.accountId}-${Math.floor(Date.now() / 4000)}` });
        }
      } else {
        load();
      }
    });
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      unsubscribe();
    };
  }, [enabled, load]);

  return state;
}
