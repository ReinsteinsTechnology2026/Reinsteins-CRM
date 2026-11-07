// ==========================================
// ZIOVAULT -- copying a secret, and taking it back off the clipboard (best effort, and honest about it)
//
// After `seconds` the clipboard is cleared: if the browser lets the page read it, only when it STILL holds what we copied (so
// something the user copied meanwhile is left alone); if reading is not permitted, it is overwritten with an empty string, which is
// what password managers do. This cannot be guaranteed: another application, a clipboard-history tool or the operating system may
// have kept a copy, and a closed or frozen tab cannot clear anything. The interface says so.
// ==========================================

export function createClipboard({ clipboard = typeof navigator !== "undefined" ? navigator.clipboard : null, setTimer = setTimeout, clearTimer = clearTimeout, getSeconds = () => 30, onChange = () => {} } = {}) {
  let timer = null;
  let pending = null;

  const finishClear = async () => {
    const copied = pending;
    pending = null;
    timer = null;
    if (copied === null || !clipboard) return;
    try {
      let current = null;
      try {
        current = await clipboard.readText();
      } catch {
        current = null; // reading is not allowed: fall back to overwriting
      }
      if (current === null || current === copied) await clipboard.writeText("");
    } catch {
      // nothing more can be done
    }
    onChange({ pending: false });
  };

  return {
    get pending() {
      return pending !== null;
    },
    async copy(text) {
      if (!clipboard || typeof clipboard.writeText !== "function") throw new Error("Copying is not available in this browser.");
      await clipboard.writeText(text);
      if (timer) clearTimer(timer);
      pending = text;
      const seconds = getSeconds();
      if (seconds > 0) timer = setTimer(finishClear, seconds * 1000);
      onChange({ pending: true, seconds });
    },
    // Called when the vault locks: take back what we put there, now.
    async clearNow() {
      if (timer) clearTimer(timer);
      await finishClear();
    },
  };
}
