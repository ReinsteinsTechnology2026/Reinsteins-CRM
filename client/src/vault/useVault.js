import { useEffect, useSyncExternalStore } from "react";

// The vault session's state as React state. The snapshot never contains a key or a secret: only decrypted DETAILS of items (title,
// username, ...), folder names, flags and messages.
export function useVaultState(session) {
  return useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
}

// Every real interaction counts as activity and pushes the inactivity lock out. (Touching only moves a deadline; it is cheap.)
export function useActivityTouch(session, active) {
  useEffect(() => {
    if (!active) return undefined;
    let last = 0;
    const onActivity = () => {
      const stamp = Date.now();
      if (stamp - last < 1000) return;
      last = stamp;
      session.touch();
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"];
    events.forEach((name) => window.addEventListener(name, onActivity, { passive: true }));
    return () => events.forEach((name) => window.removeEventListener(name, onActivity));
  }, [session, active]);
}
