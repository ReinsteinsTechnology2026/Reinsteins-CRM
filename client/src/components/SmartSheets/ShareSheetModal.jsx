import { useCallback, useEffect, useRef, useState } from "react";
import { FaSearch, FaTimes, FaTrash, FaUserPlus } from "react-icons/fa";
import { toast } from "react-toastify";

import {
  assignSmartSheet,
  listSmartSheetAccess,
  readServiceError,
  searchAssignableEmployees,
  unassignSmartSheet,
} from "../../services/smartSheetService";

// ==========================================
// SHARE DIALOG (admin tier only -- the server enforces it on every call)
// Pick employees, choose "can edit" or "view only", assign. Removing someone takes effect
// immediately, including for a tab they already have open.
// ==========================================

const PERMISSION_LABELS = { edit: "Can edit", view: "View only" };

function ShareSheetModal({ sheet, onClose, onChanged }) {
  const [access, setAccess] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [permission, setPermission] = useState("edit");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(null);
  const searchSeq = useRef(0);

  const loadAccess = useCallback(async () => {
    try {
      const data = await listSmartSheetAccess(sheet.id);
      setAccess(data.access || []);
    } catch (error) {
      toast.error(await readServiceError(error, "Could not load who has access"));
    } finally {
      setLoading(false);
    }
  }, [sheet.id]);

  useEffect(() => {
    loadAccess();
  }, [loadAccess]);

  // Debounced employee search. A late response for an old query is ignored.
  useEffect(() => {
    const sequence = ++searchSeq.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const data = await searchAssignableEmployees(query.trim());
        if (sequence === searchSeq.current) setResults(data.employees || []);
      } catch (error) {
        if (sequence === searchSeq.current) toast.error(await readServiceError(error, "Could not search employees"));
      } finally {
        if (sequence === searchSeq.current) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const assignedIds = new Set(access.map((entry) => entry.user_id));

  const toggle = (id) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const assign = async (userIds, permissionValue) => {
    setSaving(true);
    try {
      const result = await assignSmartSheet(sheet.id, userIds, permissionValue);
      if (result.skipped && result.skipped.length > 0) {
        toast.warn(`${result.skipped.length} selected account(s) could not be assigned (not an active employee).`);
      }
      setSelected(new Set());
      await loadAccess();
      onChanged();
      return true;
    } catch (error) {
      toast.error(await readServiceError(error, "Could not assign the spreadsheet"));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleAssign = async () => {
    if (selected.size === 0) return;
    if (await assign([...selected], permission)) toast.success("Access updated");
  };

  const handleRemove = async (entry) => {
    setRemoving(entry.user_id);
    try {
      await unassignSmartSheet(sheet.id, entry.user_id);
      toast.success(`${entry.full_name} no longer has access`);
      await loadAccess();
      onChanged();
    } catch (error) {
      toast.error(await readServiceError(error, "Could not remove access"));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="employee-modal-overlay" role="presentation">
      <div className="employee-modal smart-sheets-share-modal" role="dialog" aria-modal="true" aria-label={`Share ${sheet.name}`}>
        <div className="employee-modal-header">
          <div>
            <h2>Share “{sheet.name}”</h2>
            <p>Only the people listed here (and administrators) can open this spreadsheet.</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <FaTimes />
          </button>
        </div>

        <div className="smart-sheets-share-section">
          <h3>Add people</h3>
          <div className="smart-sheets-search">
            <FaSearch />
            <input
              type="search"
              value={query}
              placeholder="Search employees by name, ID or email"
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search employees"
            />
          </div>

          <div className="smart-sheets-pick-list" role="listbox" aria-label="Employees" aria-multiselectable="true">
            {searching && results.length === 0 && <p className="smart-sheets-muted">Searching…</p>}
            {!searching && results.length === 0 && <p className="smart-sheets-muted">No employees found.</p>}
            {results.map((employee) => {
              const already = assignedIds.has(employee.id);
              return (
                <label key={employee.id} className={`smart-sheets-pick-row ${already ? "is-assigned" : ""}`}>
                  <input
                    type="checkbox"
                    checked={selected.has(employee.id)}
                    disabled={already || saving}
                    onChange={() => toggle(employee.id)}
                  />
                  <span className="smart-sheets-pick-name">
                    {employee.full_name}
                    <small>{[employee.employee_id, employee.designation].filter(Boolean).join(" · ")}</small>
                  </span>
                  {already && <span className="smart-sheets-chip">Has access</span>}
                </label>
              );
            })}
          </div>

          <div className="smart-sheets-assign-row">
            <select value={permission} onChange={(event) => setPermission(event.target.value)} aria-label="Permission for selected employees" disabled={saving}>
              <option value="edit">Can edit</option>
              <option value="view">View only</option>
            </select>
            <button type="button" className="save-employee-button" onClick={handleAssign} disabled={saving || selected.size === 0}>
              <FaUserPlus /> {saving ? "Saving…" : `Assign${selected.size ? ` (${selected.size})` : ""}`}
            </button>
          </div>
        </div>

        <div className="smart-sheets-share-section">
          <h3>People with access {access.length > 0 && <span className="smart-sheets-count">{access.length}</span>}</h3>
          {loading && <p className="smart-sheets-muted">Loading…</p>}
          {!loading && access.length === 0 && <p className="smart-sheets-muted">Nobody has been given access yet.</p>}
          <ul className="smart-sheets-access-list">
            {access.map((entry) => (
              <li key={entry.user_id}>
                <span className="smart-sheets-pick-name">
                  {entry.full_name}
                  <small>{[entry.employee_id, entry.designation].filter(Boolean).join(" · ")}</small>
                </span>
                <select
                  value={entry.permission}
                  onChange={(event) => assign([entry.user_id], event.target.value)}
                  disabled={saving || removing === entry.user_id}
                  aria-label={`Permission for ${entry.full_name}`}
                >
                  {Object.entries(PERMISSION_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="smart-sheets-icon-button smart-sheets-danger"
                  onClick={() => handleRemove(entry)}
                  disabled={removing === entry.user_id}
                  aria-label={`Remove ${entry.full_name}`}
                  title="Remove access"
                >
                  <FaTrash />
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="employee-modal-actions">
          <span />
          <div className="shift-form-actions-right">
            <button type="button" className="cancel-employee-button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ShareSheetModal;
