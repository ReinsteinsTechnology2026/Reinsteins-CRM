// ==========================================
// SMART SHEETS -- SYNCHRONISATION CONTROLLER (pure; no React, no Univer, no socket imports)
//
// ONE function, synchronise(), brings the editor in line with the server's latest SAVED state. It is used for the first
// load and for EVERY reconnect, so the two can never drift apart again. The editor only supplies the side-effects.
//
// What it guarantees:
//
//   1. NOTHING IS MISSED. It joins the live room first, then loads the saved state, then replays every live change
//      that arrived in between (those with a revision newer than the loaded state, in order).
//
//   2. LOCAL EDITS ARE NEVER DISCARDED. Before the workbook is replaced, the unsaved edit queue is flushed to the
//      server (with a timeout). If it cannot be flushed, the workbook is NOT replaced -- the user keeps what they typed,
//      the view is marked out of date, and synchronisation is retried.
//
//   3. NO EDITING WHILE OUT OF STEP. setEditing(false) is called as soon as synchronisation starts and setEditing(true)
//      only after the new state is mounted and the buffered changes are replayed, so an edit can never be typed into a
//      workbook that is about to be replaced.
//
//   4. IT KEEPS TRYING. A failed attempt (network down, server restarting, a slow queue) is retried with growing
//      delays until it succeeds or access is gone -- never silently abandoned. While waiting, the phase is 'stale' so
//      the UI can show an "out of date" indicator.
//
// Phases reported through onStatus: 'syncing' (working) | 'live' (in step) | 'stale' (out of date, retrying) |
// 'revoked' (access removed).
// ==========================================

export const SYNC_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
export const DRAIN_TIMEOUT_MS = 15000;
const MAX_BUFFERED_MESSAGES = 5000;

const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createSyncController({
  join, // () => Promise   joins the live room; rejects (error.code === "NOT_FOUND" when access is gone)
  fetchState, // () => Promise<state>   the latest SAVED state ({ revision, ... })
  mount, // (state) => void   replaces the workbook with that state
  applyOp, // (op) => void   applies one live change from another user
  queue, // the save queue (setConnected / whenDrained)
  setEditing = () => {}, // (open: boolean) => void   true only while in step
  onStatus = () => {}, // ({ phase, attempt, error }) => void
  onRevoked = () => {},
  backoffMs = SYNC_BACKOFF_MS,
  drainTimeoutMs = DRAIN_TIMEOUT_MS,
  wait = defaultWait,
  isCancelled = () => false,
}) {
  let phase = "syncing";
  let buffering = true; // live changes are held back until the state they apply to is on screen
  let buffered = [];
  let running = null;
  let rerun = false;
  let wake = null; // resolves the current backoff wait early (retryNow)

  const setPhase = (next, extra = {}) => {
    phase = next;
    onStatus({ phase: next, attempt: 0, error: null, ...extra });
  };

  const interruptibleWait = (ms) =>
    new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        wake = null;
        resolve();
      };
      wake = done;
      wait(ms).then(done, done);
    });

  async function attemptLoop(reason) {
    let attempt = 0;

    for (;;) {
      if (isCancelled()) return;

      buffering = true;
      buffered = [];
      setEditing(false);
      setPhase(attempt === 0 ? "syncing" : "stale", { attempt, reason });

      try {
        await join(); // from here on, nothing live is missed (it is buffered)
        queue.setConnected(true);

        // Our own unsaved edits go FIRST. If they cannot be saved in time, keep the workbook as it is.
        const drained = await queue.whenDrained({ timeoutMs: drainTimeoutMs });
        if (!drained) {
          const error = new Error("Your latest changes have not been saved yet.");
          error.code = "UNSAVED_CHANGES";
          throw error;
        }

        const state = await fetchState();
        if (isCancelled()) return;

        mount(state);

        const missed = buffered
          .filter((message) => Number(message.revision) > Number(state.revision))
          .sort((a, b) => Number(a.revision) - Number(b.revision));
        buffered = [];
        buffering = false;
        missed.forEach((message) => applyOp(message.op));

        setEditing(true);
        setPhase("live", { reason });
        return;
      } catch (error) {
        if (isCancelled()) return;
        if (error && error.code === "NOT_FOUND") {
          setPhase("revoked", { error });
          onRevoked(error);
          return;
        }
        attempt += 1;
        setPhase("stale", { attempt, error, reason });
        await interruptibleWait(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]);
      }
    }
  }

  return {
    // The editor forwards every live change here. While out of step it is held back.
    receive(message) {
      if (buffering) {
        buffered.push(message);
        if (buffered.length > MAX_BUFFERED_MESSAGES) buffered = buffered.slice(-MAX_BUFFERED_MESSAGES);
        return;
      }
      applyOp(message.op);
    },

    // Safe to call at any time and as often as needed (a reconnect while a sync is running just schedules one more).
    synchronise(reason = "manual") {
      if (running) {
        rerun = true;
        return running;
      }
      running = (async () => {
        try {
          do {
            rerun = false;
            await attemptLoop(reason);
          } while (rerun && !isCancelled());
        } finally {
          running = null;
        }
      })();
      return running;
    },

    // "Retry now": cut the current backoff wait short.
    retryNow() {
      if (wake) wake();
      else this.synchronise("manual");
    },

    get phase() {
      return phase;
    },
    get isRunning() {
      return running !== null;
    },
  };
}
