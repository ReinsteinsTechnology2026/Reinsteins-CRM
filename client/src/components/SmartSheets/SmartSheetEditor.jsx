import { useCallback, useEffect, useRef, useState } from "react";
import { FaArrowLeft, FaDownload, FaExclamationTriangle, FaLock, FaSyncAlt } from "react-icons/fa";
import { toast } from "react-toastify";
import { createUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import sheetsCoreEnUS from "@univerjs/preset-sheets-core/locales/en-US";
import "@univerjs/preset-sheets-core/lib/index.css";

import socket, { connectSocket } from "../../services/socket";
import {
  exportSmartSheet,
  getSmartSheetWorkbook,
  readServiceError,
  updateSmartSheet,
} from "../../services/smartSheetService";
import {
  BLOCKED_MESSAGE,
  READ_ONLY_MESSAGE,
  SAVE_STATUS_LABELS,
  SHARED_DATA_MUTATIONS,
  collaboratorColor,
  collaboratorInitials,
  createSaveQueue,
  isBlockedCommand,
  mutationsFromRemoteOp,
  normalizeCell,
  numfmtMutationsForWorkbook,
  opsFromMutation,
} from "../../utils/smartSheetSync";

import "./SmartSheetEditor.css";

// ==========================================
// SMART SHEET EDITOR (Univer Community Edition, Apache-2.0)
//
// This is the ONLY file that imports Univer, and it is loaded lazily (see App.jsx), so the editor's
// large bundle is not part of the CRM's initial download.
//
// Collaboration uses only Univer's PUBLIC API:
//   * univerAPI.onCommandExecuted      -- every local mutation is turned into a small operation
//                                         (utils/smartSheetSync.js) and queued for the server.
//   * univerAPI.syncExecuteCommand(..., { onlyLocal: true, fromCollab: true })
//                                      -- applies other people's saved changes without echoing them.
//   * univerAPI.onBeforeCommandExecute -- refuses the few structural edits that are not synchronised
//                                         yet, instead of letting screens silently diverge.
//
// Data flow for one edit:  type -> Univer mutation -> operation -> Socket.IO -> server checks access
// and VALIDATES -> server SAVES to PostgreSQL -> server broadcasts -> other clients apply.
// "Saved" is shown only after the server acknowledged the save.
// ==========================================

const ACK_TIMEOUT_MS = 15000;

function SmartSheetEditor({ sheetId, backPath, onBack }) {
  const containerRef = useRef(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState({ name: "", permission: "view", canManage: false, status: "active" });
  const [titleDraft, setTitleDraft] = useState("");
  const [saveStatus, setSaveStatus] = useState({ state: "connecting", pendingOperations: 0, error: null });
  const [collaborators, setCollaborators] = useState([]);
  const [revoked, setRevoked] = useState(null);
  const [rejected, setRejected] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // Everything the Univer callbacks need lives in a ref, so effects never capture stale state.
  const runtime = useRef({ queue: null, univerAPI: null });

  const me = (() => {
    try {
      return JSON.parse(sessionStorage.getItem("user")) || {};
    } catch {
      return {};
    }
  })();

  const reload = useCallback(() => {
    setRejected(null);
    setLoadError("");
    setReloadToken((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const disposers = [];
    let univer = null;
    let applyingRemote = false;
    let firstSync = true;
    let buffering = true; // remote operations that arrive while the saved state is still loading
    let bufferedOps = [];
    let loadedRevision = 0;
    let workbookRef = null;
    let canEdit = false; // mirrors the server-confirmed permission; flipped by access-changed

    setLoading(true);
    setLoadError("");
    setRevoked(null);

    const on = (event, handler) => {
      socket.on(event, handler);
      disposers.push(() => socket.off(event, handler));
    };

    const emitWithAck = (event, payload) =>
      new Promise((resolve, reject) => {
        if (!socket.connected) return reject(new Error("offline"));
        socket.timeout(ACK_TIMEOUT_MS).emit(event, payload, (error, answer) => (error ? reject(error) : resolve(answer)));
      });

    const queue = createSaveQueue({
      send: (op) => emitWithAck("smartsheet:op", { sheetId, op }),
      onStatus: (state, details) => !cancelled && setSaveStatus({ state, ...details }),
      onRejected: (op, error) => !cancelled && setRejected(error),
      onNeedsRejoin: () => join().then(() => queue.resume()).catch(() => {}),
    });
    runtime.current.queue = queue;

    // ---- access to Univer's model through its public facade ----
    const getWorkbook = () => workbookRef;
    const readCell = (worksheetKey, row, column) => {
      const workbook = getWorkbook();
      const sheet = workbook && workbook.getSheetBySheetId(worksheetKey);
      if (!sheet) return null;
      // The RAW cell, never range.getCellData(): that one runs through Univer's display interceptors, and
      // the number-format plugin replaces a number such as 0.256 with its display text "25.6%". Saving
      // that would corrupt the data. Style (stored by id) is resolved from the core style table.
      const raw = sheet.getSheet().getCellRaw(row, column);
      const style = raw ? workbook.getWorkbook().getStyles().getStyleByCell(raw) : null;
      return normalizeCell(raw, style, sheet.getRange(row, column).getNumberFormat());
    };

    const applyRemoteOp = (op) => {
      const workbook = getWorkbook();
      const api = runtime.current.univerAPI;
      if (!workbook || !api) return;

      const mutations = mutationsFromRemoteOp(op, {
        unitId: workbook.getId(),
        readCell,
        hasWorksheet: (key) => Boolean(workbook.getSheetBySheetId(key)),
        worksheetCount: () => workbook.getSheets().length,
        getWorksheetName: (key) => {
          const sheet = workbook.getSheetBySheetId(key);
          return sheet ? sheet.getSheetName() : null;
        },
        isPending: (key, row, column) => queue.isPending(key, row, column),
      });

      applyingRemote = true;
      try {
        for (const mutation of mutations) {
          api.syncExecuteCommand(mutation.id, mutation.params, { onlyLocal: true, fromCollab: true });
        }
      } catch (error) {
        console.error("Smart Sheets: could not apply a change from another user", error);
      } finally {
        applyingRemote = false;
      }
    };

    // ---- (re)build the workbook from the server's latest saved state ----
    const mountWorkbook = (state) => {
      const api = runtime.current.univerAPI;
      if (workbookRef) {
        api.disposeUnit(workbookRef.getId());
        workbookRef = null;
      }
      workbookRef = api.createWorkbook(state.workbook);
      loadedRevision = state.revision;

      // Number formats live in their own Univer model: hand the saved ones over (local only, never echoed).
      applyingRemote = true;
      try {
        for (const mutation of numfmtMutationsForWorkbook(state.workbook, workbookRef.getId())) {
          api.syncExecuteCommand(mutation.id, mutation.params, { onlyLocal: true, fromCollab: true });
        }
      } catch (error) {
        console.error("Smart Sheets: could not apply the saved number formats", error);
      } finally {
        applyingRemote = false;
      }

      canEdit = state.permission === "edit";
      workbookRef.setEditable(canEdit);
      setMeta({
        name: state.sheet.name,
        permission: state.permission,
        canManage: state.canManage,
        status: state.sheet.status,
      });
      setTitleDraft(state.sheet.name);
    };

    async function join() {
      const answer = await emitWithAck("smartsheet:join", { sheetId });
      if (!answer || !answer.ok) {
        const error = new Error((answer && answer.message) || "Could not open this spreadsheet.");
        error.code = answer && answer.code;
        throw error;
      }
      if (!cancelled) setCollaborators(answer.users || []);
      return answer;
    }

    // Join the room (so nothing is missed), THEN fetch the saved state, THEN replay whatever arrived meanwhile.
    async function synchronise() {
      buffering = true;
      bufferedOps = [];
      await join();
      const state = await getSmartSheetWorkbook(sheetId);
      if (cancelled) return;
      mountWorkbook(state);
      buffering = false;
      const missed = bufferedOps.filter((message) => message.revision > loadedRevision);
      bufferedOps = [];
      missed.forEach((message) => applyRemoteOp(message.op));
    }

    // ---- socket events ----
    on("smartsheet:op", (message) => {
      if (!message || Number(message.sheetId) !== Number(sheetId)) return;
      if (buffering) {
        bufferedOps.push(message);
        return;
      }
      applyRemoteOp(message.op);
    });

    on("smartsheet:presence", (message) => {
      if (message && Number(message.sheetId) === Number(sheetId)) setCollaborators(message.users || []);
    });

    on("smartsheet:access-revoked", (message) => {
      if (!message || Number(message.sheetId) !== Number(sheetId)) return;
      setRevoked(message.reason || "unassigned");
      queue.setConnected(false);
    });

    on("smartsheet:access-changed", (message) => {
      if (!message || Number(message.sheetId) !== Number(sheetId)) return;
      const editable = message.permission === "edit";
      canEdit = editable;
      if (workbookRef) workbookRef.setEditable(editable);
      setMeta((current) => ({ ...current, permission: message.permission }));
      toast.info(editable ? "You can now edit this spreadsheet." : "Your access was changed to view only.");
    });

    on("disconnect", () => queue.setConnected(false));

    on("connect", async () => {
      if (cancelled) return;
      try {
        if (firstSync) return; // the initial join is done by start() below
        await join();
        queue.setConnected(true);
        await queue.whenDrained(); // our unsaved edits go first...
        buffering = true;
        const state = await getSmartSheetWorkbook(sheetId); // ...then pick up everything we missed while offline
        if (cancelled) return;
        mountWorkbook(state);
        buffering = false;
      } catch (error) {
        buffering = false;
        if (!cancelled) setRevoked(error.code === "NOT_FOUND" ? "unassigned" : null);
        if (!cancelled && error.code !== "NOT_FOUND") toast.error("Could not reconnect to the spreadsheet. Retrying…");
      }
    });

    const beforeUnload = (event) => {
      if (queue.size > 0) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    disposers.push(() => window.removeEventListener("beforeunload", beforeUnload));

    // ---- boot ----
    async function start() {
      try {
        const created = createUniver({
          locale: LocaleType.EN_US,
          locales: { [LocaleType.EN_US]: mergeLocales(sheetsCoreEnUS) },
          presets: [UniverSheetsCorePreset({ container: containerRef.current })],
        });
        univer = created.univer;
        const api = created.univerAPI;
        runtime.current.univerAPI = api;

        // Univer's documented way to veto a command: set event.cancel before it runs.
        const beforeListener = api.addEvent(api.Event.BeforeCommandExecute, (event) => {
          if (applyingRemote) return;
          if (isBlockedCommand(event.id)) {
            event.cancel = true;
            toast.info(BLOCKED_MESSAGE, { toastId: "smart-sheet-blocked" });
          } else if (!canEdit && SHARED_DATA_MUTATIONS.has(event.id)) {
            // Univer's own read-only switch does not stop typing into a cell, so veto the change itself.
            event.cancel = true;
            toast.info(READ_ONLY_MESSAGE, { toastId: "smart-sheet-read-only" });
          }
        });
        disposers.push(() => beforeListener.dispose());

        const executedListener = api.addEvent(api.Event.CommandExecuted, (event) => {
          const options = event.options;
          if (applyingRemote || (options && (options.fromCollab || options.onlyLocal))) return;
          const ops = opsFromMutation(event.id, event.params, { readCell });
          ops.forEach((op) => queue.enqueue(op));
        });
        disposers.push(() => executedListener.dispose());

        connectSocket();
        if (!socket.connected) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Could not connect to the server.")), 15000);
            socket.once("connect", () => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
        if (cancelled) return;
        queue.setConnected(true);
        await synchronise();
        firstSync = false;
        if (!cancelled) setLoading(false);
      } catch (error) {
        if (cancelled) return;
        const message =
          error.code === "NOT_FOUND"
            ? "This spreadsheet doesn't exist, or it hasn't been shared with you."
            : error.response
              ? await readServiceError(error, "Could not open this spreadsheet.")
              : error.message || "Could not open this spreadsheet.";
        setLoadError(message);
        setLoading(false);
      }
    }

    start();

    return () => {
      cancelled = true;
      try {
        if (socket.connected) socket.emit("smartsheet:leave", { sheetId });
      } catch {
        // leaving is best effort
      }
      disposers.forEach((dispose) => {
        try {
          dispose();
        } catch {
          // already disposed
        }
      });
      // Univer unmounts its own React root when disposed; doing that inside React's effect cleanup raises
      // "Attempted to synchronously unmount a root while React was already rendering". Defer it one tick.
      // (Each run renders into its own container element -- see the key below -- so this can never touch
      // an editor that was created afterwards.)
      const disposing = univer;
      if (disposing) {
        setTimeout(() => {
          try {
            disposing.dispose();
          } catch {
            // already disposed
          }
        }, 0);
      }
      runtime.current = { queue: null, univerAPI: null };
    };
  }, [sheetId, reloadToken]);

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const queue = runtime.current.queue;
      if (queue && queue.size > 0) {
        toast.info("Saving your latest changes first…");
        await Promise.race([queue.whenDrained(), new Promise((resolve) => setTimeout(resolve, 10000))]);
      }
      const { blob, filename } = await exportSmartSheet(sheetId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(await readServiceError(error, "Could not export the spreadsheet"));
    } finally {
      setExporting(false);
    }
  };

  const commitTitle = async () => {
    const name = titleDraft.trim().replace(/\s+/g, " ");
    if (!meta.canManage || !name || name === meta.name) {
      setTitleDraft(meta.name);
      return;
    }
    try {
      await updateSmartSheet(sheetId, { name });
      setMeta((current) => ({ ...current, name }));
      toast.success("Renamed");
    } catch (error) {
      setTitleDraft(meta.name);
      toast.error(await readServiceError(error, "Could not rename the spreadsheet"));
    }
  };

  const status = saveStatus.state;
  const readOnly = meta.permission !== "edit";
  const archived = meta.status === "archived";
  const others = collaborators.filter((person) => String(person.id) !== String(me.id));

  return (
    <div className="smart-sheet-editor">
      <div className="smart-sheet-editor-bar">
        <button type="button" className="smart-sheet-back" onClick={onBack} aria-label="Back to spreadsheets" title="Back to spreadsheets" data-back-path={backPath}>
          <FaArrowLeft />
        </button>

        {meta.canManage && !archived ? (
          <input
            className="smart-sheet-title-input"
            value={titleDraft}
            maxLength={150}
            aria-label="Spreadsheet name"
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setTitleDraft(meta.name);
            }}
          />
        ) : (
          <h2 className="smart-sheet-title">{meta.name || "Spreadsheet"}</h2>
        )}

        {!loading && readOnly && (
          <span className="smart-sheet-badge" title={archived ? "This spreadsheet is archived" : "You have view-only access"}>
            <FaLock /> {archived ? "Archived · read-only" : "View only"}
          </span>
        )}

        <span className={`smart-sheet-status smart-sheet-status-${status}`} role="status" aria-live="polite" data-testid="smart-sheet-save-status">
          {status === "saving" || status === "connecting" ? <FaSyncAlt className="smart-sheet-spin" /> : null}
          {SAVE_STATUS_LABELS[status]}
        </span>

        <div className="smart-sheet-collaborators" aria-label="People viewing this spreadsheet" data-testid="smart-sheet-collaborators">
          {others.length === 0 ? (
            <span className="smart-sheet-alone">Only you</span>
          ) : (
            others.slice(0, 6).map((person) => (
              <span
                key={person.id}
                className="smart-sheet-avatar"
                style={{ background: collaboratorColor(person.id) }}
                title={`${person.name} is here`}
              >
                {collaboratorInitials(person.name)}
              </span>
            ))
          )}
          {others.length > 6 && <span className="smart-sheet-avatar smart-sheet-avatar-more">+{others.length - 6}</span>}
        </div>

        <button type="button" className="smart-sheet-export" onClick={handleExport} disabled={exporting || loading || Boolean(loadError)}>
          <FaDownload /> {exporting ? "Preparing…" : "Export .xlsx"}
        </button>
      </div>

      {rejected && !revoked && (
        <div className="smart-sheet-banner smart-sheet-banner-error" role="alert">
          <FaExclamationTriangle />
          <span>
            A change could not be saved: {rejected.message} What you see may now differ from the saved spreadsheet.
          </span>
          <button type="button" onClick={reload}>
            Reload saved version
          </button>
        </div>
      )}

      {status === "offline" && !revoked && (
        <div className="smart-sheet-banner smart-sheet-banner-warn" role="status">
          You're offline. Your changes are kept on this page and will be saved when the connection returns. Don't close this tab until then.
        </div>
      )}

      <div className="smart-sheet-stage">
        <div key={`${sheetId}-${reloadToken}`} ref={containerRef} className="smart-sheet-univer" data-testid="smart-sheet-univer" />

        {loading && !loadError && <div className="smart-sheet-overlay">Opening spreadsheet…</div>}

        {loadError && (
          <div className="smart-sheet-overlay smart-sheet-overlay-error" role="alert">
            <p>{loadError}</p>
            <button type="button" onClick={onBack}>
              Back to spreadsheets
            </button>
          </div>
        )}

        {revoked && (
          <div className="smart-sheet-overlay smart-sheet-overlay-error" role="alert" data-testid="smart-sheet-revoked">
            <p>
              {revoked === "unassigned" || revoked === "no_access"
                ? "Your access to this spreadsheet was removed."
                : revoked === "archived"
                  ? "This spreadsheet was archived by an administrator."
                  : "This spreadsheet is no longer available."}
            </p>
            <button type="button" onClick={onBack}>
              Back to spreadsheets
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default SmartSheetEditor;
