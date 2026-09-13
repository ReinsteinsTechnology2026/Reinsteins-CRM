import { useState } from "react";

import platformApi from "../../services/platformApi";

// ==========================================
// DELETE COMPANY MODAL
//
// The one genuinely destructive action in the Platform Owner surface
// -- permanently drops the company's tenant database and removes its
// companies row. High-friction by design: the Delete button stays
// disabled until the Platform Owner types the company's exact slug,
// mirroring the standard "type to confirm" pattern for irreversible
// actions. The backend independently re-verifies this same slug
// server-side (never trusts this client-side gate alone) and
// unconditionally refuses to delete Reinsteins regardless of what is
// typed here -- see platformCompanyController.js's deleteCompany.
// ==========================================

function DeleteCompanyModal({ company, onClose, onDeleted }) {
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const canDelete = confirmText.trim().toLowerCase() === company.companySlug;

  const handleDelete = async () => {
    if (!canDelete) return;
    setError(null);
    try {
      setSubmitting(true);
      await platformApi.delete(`/companies/${company.id}`, {
        data: { confirmSlug: confirmText.trim().toLowerCase() },
      });
      onDeleted();
    } catch (err) {
      setError(err.response?.data?.message || "Failed to delete company.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="platform-modal-backdrop" onClick={onClose}>
      <div className="platform-modal" onClick={(event) => event.stopPropagation()}>

        <div className="platform-modal-header">
          <div>
            <h2>Delete Company</h2>
            <p>This cannot be undone.</p>
          </div>
          <button className="platform-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="platform-modal-body">

          {error && <div className="platform-alert platform-alert-danger">{error}</div>}

          <div className="platform-alert platform-alert-danger">
            Deleting <strong>{company.companyName}</strong> permanently removes its tenant database and all data
            in it -- employees, tasks, chat, files, everything. There is no recovery.
          </div>

          <div className="platform-form-group">
            <label htmlFor="confirm-slug">
              Type <strong>{company.companySlug}</strong> to confirm
            </label>
            <input
              id="confirm-slug"
              type="text"
              placeholder={company.companySlug}
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              autoComplete="off"
            />
          </div>

        </div>

        <div className="platform-modal-footer">
          <button className="platform-btn platform-btn-outline" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            className="platform-btn platform-btn-danger"
            onClick={handleDelete}
            disabled={!canDelete || submitting}
          >
            {submitting ? "Deleting..." : "Delete Company"}
          </button>
        </div>

      </div>
    </div>
  );
}

export default DeleteCompanyModal;
