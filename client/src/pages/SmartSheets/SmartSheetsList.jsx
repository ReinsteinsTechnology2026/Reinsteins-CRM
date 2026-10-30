import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { FaArchive, FaEdit, FaFileUpload, FaLock, FaPlus, FaSearch, FaTable, FaTimes, FaTrash, FaUndo, FaUserPlus } from "react-icons/fa";
import { toast } from "react-toastify";

import ShareSheetModal from "../../components/SmartSheets/ShareSheetModal";
import {
  createSmartSheet,
  deleteSmartSheet,
  importSmartSheet,
  listSmartSheets,
  readServiceError,
  updateSmartSheet,
} from "../../services/smartSheetService";

import "./SmartSheetsList.css";

// ==========================================
// SMART SHEETS -- LIST PAGE (one component for the admin AND the employee portal)
//
// What is offered comes from the server's answer (canManage), never from the URL or from what the
// browser thinks the user's role is. Admin tier: every spreadsheet, create / upload / share / rename /
// archive / delete. Everyone else: only the spreadsheets explicitly assigned to them.
// The server enforces all of this independently on every request.
// ==========================================

const MAX_UPLOAD_MB = 10;

const formatWhen = (value) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

function Modal({ title, subtitle, onClose, children, wide = false, labelledBy }) {
  return (
    <div className="employee-modal-overlay" role="presentation">
      <div className={`employee-modal ${wide ? "smart-sheets-wide-modal" : ""}`} role="dialog" aria-modal="true" aria-label={labelledBy || title}>
        <div className="employee-modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <FaTimes />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function SmartSheetsList() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Keeps a company prefix (/:companySlug/admin or /employee) intact.
  const basePath = pathname.replace(/\/smart-sheets\/?.*$/i, "");

  const [sheets, setSheets] = useState([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadName, setUploadName] = useState("");
  const [importResult, setImportResult] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [sharing, setSharing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const fileInput = useRef(null);

  const load = useCallback(async () => {
    try {
      const data = await listSmartSheets();
      setSheets(data.sheets || []);
      setCanManage(Boolean(data.canManage));
      setError("");
    } catch (err) {
      setError(await readServiceError(err, "Could not load spreadsheets"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const open = (id) => navigate(`${basePath}/smart-sheets/${id}`);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return sheets.filter((sheet) => (showArchived || sheet.status !== "archived") && (!needle || sheet.name.toLowerCase().includes(needle)));
  }, [sheets, search, showArchived]);

  const archivedCount = sheets.filter((sheet) => sheet.status === "archived").length;

  // ---- create ----
  const submitCreate = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const created = await createSmartSheet(newName);
      setCreating(false);
      setNewName("");
      toast.success("Spreadsheet created");
      open(created.id);
    } catch (err) {
      toast.error(await readServiceError(err, "Could not create the spreadsheet"));
    } finally {
      setBusy(false);
    }
  };

  // ---- upload (.xlsx) ----
  const chooseFile = (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) {
      toast.error("Only .xlsx files can be uploaded. Save the workbook as “Excel Workbook (.xlsx)” first.");
      return;
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      toast.error(`That file is larger than ${MAX_UPLOAD_MB} MB.`);
      return;
    }
    setUploadFile(file);
    setUploadName(file.name.replace(/\.xlsx$/i, ""));
  };

  const submitUpload = async (event) => {
    event.preventDefault();
    if (busy || !uploadFile) return;
    setBusy(true);
    try {
      const result = await importSmartSheet(uploadFile, uploadName.trim());
      setUploadFile(null);
      setImportResult(result);
      load();
    } catch (err) {
      toast.error(await readServiceError(err, "Could not import the workbook"));
    } finally {
      setBusy(false);
    }
  };

  // ---- rename / archive / delete ----
  const submitRename = async (event) => {
    event.preventDefault();
    if (busy || !renaming) return;
    setBusy(true);
    try {
      await updateSmartSheet(renaming.id, { name: renameValue });
      setRenaming(null);
      toast.success("Renamed");
      load();
    } catch (err) {
      toast.error(await readServiceError(err, "Could not rename the spreadsheet"));
    } finally {
      setBusy(false);
    }
  };

  const runConfirmed = async () => {
    if (!confirm || busy) return;
    setBusy(true);
    try {
      if (confirm.kind === "delete") {
        await deleteSmartSheet(confirm.sheet.id);
        toast.success("Spreadsheet deleted");
      } else {
        await updateSmartSheet(confirm.sheet.id, { status: confirm.kind === "archive" ? "archived" : "active" });
        toast.success(confirm.kind === "archive" ? "Spreadsheet archived" : "Spreadsheet restored");
      }
      setConfirm(null);
      load();
    } catch (err) {
      toast.error(await readServiceError(err, "That action could not be completed"));
    } finally {
      setBusy(false);
    }
  };

  const confirmText = {
    archive: (name) => ({
      title: "Archive spreadsheet?",
      body: `“${name}” will disappear for employees and become read-only. Anyone editing it right now is disconnected. You can restore it later; nothing is lost.`,
      action: "Archive",
    }),
    restore: (name) => ({ title: "Restore spreadsheet?", body: `“${name}” becomes available again to the people it is shared with.`, action: "Restore" }),
    delete: (name) => ({
      title: "Delete spreadsheet?",
      body: `“${name}” will be removed for everyone, including you, and anyone editing it right now is disconnected. This cannot be undone from here.`,
      action: "Delete",
    }),
  };

  return (
    <div className="smart-sheets-page">
      <div className="smart-sheets-header">
        <div className="smart-sheets-title">
          <h2>
            <FaTable /> Smart Sheets
          </h2>
          <p>{canManage ? "Create spreadsheets, upload Excel files and choose who can edit them together." : "Spreadsheets your team has shared with you."}</p>
        </div>

        {canManage && (
          <div className="smart-sheets-actions">
            <button type="button" className="smart-sheets-secondary" onClick={() => fileInput.current && fileInput.current.click()}>
              <FaFileUpload /> Upload .xlsx
            </button>
            <button type="button" className="save-employee-button smart-sheets-primary" onClick={() => setCreating(true)}>
              <FaPlus /> New spreadsheet
            </button>
            <input ref={fileInput} type="file" hidden accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={chooseFile} data-testid="smart-sheets-file-input" />
          </div>
        )}
      </div>

      <div className="smart-sheets-toolbar">
        <div className="smart-sheets-search">
          <FaSearch />
          <input type="search" placeholder="Search spreadsheets" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search spreadsheets" />
        </div>
        {canManage && archivedCount > 0 && (
          <label className="smart-sheets-toggle">
            <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived ({archivedCount})
          </label>
        )}
      </div>

      {loading && <p className="smart-sheets-state">Loading spreadsheets…</p>}
      {!loading && error && (
        <p className="smart-sheets-state smart-sheets-state-error" role="alert">
          {error} <button type="button" onClick={load}>Try again</button>
        </p>
      )}
      {!loading && !error && visible.length === 0 && (
        <div className="smart-sheets-empty">
          <FaTable />
          <h3>{sheets.length === 0 ? (canManage ? "No spreadsheets yet" : "Nothing has been shared with you yet") : "No spreadsheets match your search"}</h3>
          <p>{sheets.length === 0 ? (canManage ? "Create a blank spreadsheet or upload an Excel file to get started." : "When an administrator shares a spreadsheet with you, it will appear here.") : "Try a different search."}</p>
        </div>
      )}

      <ul className="smart-sheets-grid">
        {visible.map((sheet) => (
          <li key={sheet.id} className={`smart-sheets-card ${sheet.status === "archived" ? "is-archived" : ""}`}>
            <button type="button" className="smart-sheets-open" onClick={() => open(sheet.id)}>
              <span className="smart-sheets-card-icon"><FaTable /></span>
              <span className="smart-sheets-card-body">
                <strong>{sheet.name}</strong>
                <small>Updated {formatWhen(sheet.updated_at) || "—"}</small>
                <small>
                  {canManage
                    ? `${sheet.created_by_name ? `By ${sheet.created_by_name} · ` : ""}${sheet.assigned_count || 0} ${sheet.assigned_count === 1 ? "person" : "people"} assigned`
                    : sheet.permission === "view"
                      ? "View only"
                      : "You can edit"}
                </small>
              </span>
              {sheet.status === "archived" && <span className="smart-sheets-chip">Archived</span>}
              {!canManage && sheet.permission === "view" && <span className="smart-sheets-chip"><FaLock /> View only</span>}
            </button>

            {canManage && (
              <div className="smart-sheets-card-actions">
                <button type="button" className="smart-sheets-icon-button" onClick={() => setSharing(sheet)} aria-label={`Share ${sheet.name}`} title="Share">
                  <FaUserPlus />
                </button>
                <button type="button" className="smart-sheets-icon-button" onClick={() => { setRenaming(sheet); setRenameValue(sheet.name); }} aria-label={`Rename ${sheet.name}`} title="Rename">
                  <FaEdit />
                </button>
                <button
                  type="button"
                  className="smart-sheets-icon-button"
                  onClick={() => setConfirm({ kind: sheet.status === "archived" ? "restore" : "archive", sheet })}
                  aria-label={`${sheet.status === "archived" ? "Restore" : "Archive"} ${sheet.name}`}
                  title={sheet.status === "archived" ? "Restore" : "Archive"}
                >
                  {sheet.status === "archived" ? <FaUndo /> : <FaArchive />}
                </button>
                <button type="button" className="smart-sheets-icon-button smart-sheets-danger" onClick={() => setConfirm({ kind: "delete", sheet })} aria-label={`Delete ${sheet.name}`} title="Delete">
                  <FaTrash />
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {creating && (
        <Modal title="New spreadsheet" subtitle="Start with a blank spreadsheet. You can share it after it is created." onClose={() => setCreating(false)}>
          <form onSubmit={submitCreate}>
            <div className="employee-form-group">
              <label htmlFor="smart-sheet-new-name">Name</label>
              <input id="smart-sheet-new-name" value={newName} maxLength={150} onChange={(event) => setNewName(event.target.value)} placeholder="e.g. Q3 budget" autoFocus required />
            </div>
            <div className="employee-modal-actions">
              <span />
              <div className="shift-form-actions-right">
                <button type="button" className="cancel-employee-button" onClick={() => setCreating(false)}>Cancel</button>
                <button type="submit" className="save-employee-button" disabled={busy || !newName.trim()}>{busy ? "Creating…" : "Create"}</button>
              </div>
            </div>
          </form>
        </Modal>
      )}

      {uploadFile && (
        <Modal title="Upload Excel file" subtitle={`${uploadFile.name} · ${(uploadFile.size / 1024).toFixed(0)} KB`} onClose={() => !busy && setUploadFile(null)}>
          <form onSubmit={submitUpload}>
            <div className="employee-form-group">
              <label htmlFor="smart-sheet-upload-name">Spreadsheet name</label>
              <input id="smart-sheet-upload-name" value={uploadName} maxLength={150} onChange={(event) => setUploadName(event.target.value)} required />
            </div>
            <p className="smart-sheets-muted">
              Worksheets, values, formulas, number formats, basic formatting, column widths and row heights are imported. Merged cells, images, charts, pivot tables, comments and conditional formatting are not; you will be told what was left out.
            </p>
            <div className="employee-modal-actions">
              <span />
              <div className="shift-form-actions-right">
                <button type="button" className="cancel-employee-button" onClick={() => setUploadFile(null)} disabled={busy}>Cancel</button>
                <button type="submit" className="save-employee-button" disabled={busy || !uploadName.trim()}>{busy ? "Importing…" : "Import"}</button>
              </div>
            </div>
          </form>
        </Modal>
      )}

      {importResult && (
        <Modal title="Spreadsheet imported" subtitle={`“${importResult.name}” · ${importResult.worksheetCount} worksheet${importResult.worksheetCount === 1 ? "" : "s"}`} onClose={() => setImportResult(null)}>
          {importResult.warnings && importResult.warnings.length > 0 ? (
            <div className="smart-sheets-warnings" role="status">
              <strong>Some Excel features could not be kept:</strong>
              <ul>
                {importResult.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="smart-sheets-muted">Everything in the file was imported.</p>
          )}
          <div className="employee-modal-actions">
            <span />
            <div className="shift-form-actions-right">
              <button type="button" className="cancel-employee-button" onClick={() => setImportResult(null)}>Close</button>
              <button type="button" className="save-employee-button" onClick={() => open(importResult.id)}>Open spreadsheet</button>
            </div>
          </div>
        </Modal>
      )}

      {renaming && (
        <Modal title="Rename spreadsheet" onClose={() => setRenaming(null)}>
          <form onSubmit={submitRename}>
            <div className="employee-form-group">
              <label htmlFor="smart-sheet-rename">Name</label>
              <input id="smart-sheet-rename" value={renameValue} maxLength={150} onChange={(event) => setRenameValue(event.target.value)} autoFocus required />
            </div>
            <div className="employee-modal-actions">
              <span />
              <div className="shift-form-actions-right">
                <button type="button" className="cancel-employee-button" onClick={() => setRenaming(null)}>Cancel</button>
                <button type="submit" className="save-employee-button" disabled={busy || !renameValue.trim()}>{busy ? "Saving…" : "Save"}</button>
              </div>
            </div>
          </form>
        </Modal>
      )}

      {confirm && (
        <Modal title={confirmText[confirm.kind](confirm.sheet.name).title} onClose={() => !busy && setConfirm(null)}>
          <p className="smart-sheets-muted">{confirmText[confirm.kind](confirm.sheet.name).body}</p>
          <div className="employee-modal-actions">
            <span />
            <div className="shift-form-actions-right">
              <button type="button" className="cancel-employee-button" onClick={() => setConfirm(null)} disabled={busy}>Cancel</button>
              <button type="button" className={confirm.kind === "delete" ? "shift-delete-button" : "save-employee-button"} onClick={runConfirmed} disabled={busy}>
                {busy ? "Working…" : confirmText[confirm.kind](confirm.sheet.name).action}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {sharing && <ShareSheetModal sheet={sharing} onClose={() => setSharing(null)} onChanged={load} />}
    </div>
  );
}

export default SmartSheetsList;
