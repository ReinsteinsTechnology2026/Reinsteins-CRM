import { useState } from "react";

import platformApi from "../../services/platformApi";

// ==========================================
// CREATE FIRST ADMIN MODAL (Phase 4)
//
// Reuses the existing POST /api/platform/companies/:companyId/admin
// endpoint (Phase 2E) as-is -- no backend changes. That endpoint only
// ever accepts { name, email, password, phone }: role, system_access,
// and the tenant database are always server-controlled and are never
// fields on this form.
//
// NOTE on Employee ID: the existing backend does NOT accept a
// client-supplied employee ID -- it generates one itself
// (tenantUserService.generateNextAdminIdentifier), the same
// collision-safe pattern used for every tenant user. Adding a
// client-controlled employee ID field would mean either silently
// ignoring it (misleading) or changing an already-secure, deliberate
// backend behavior for this phase's UI alone -- so this form has no
// Employee ID input. The server-generated ID is shown in the result
// below once the admin is created.
// ==========================================

function CreateAdminModal({ companyId, companyName, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [createdAdmin, setCreatedAdmin] = useState(null);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);

    if (!name.trim() || !email.trim() || !password) {
      setError("Name, email, and password are required.");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    try {
      setSubmitting(true);

      const response = await platformApi.post(`/companies/${companyId}/admin`, {
        name: name.trim(),
        email: email.trim(),
        password,
        phone: phone.trim() || undefined,
      });

      setCreatedAdmin(response.data.admin);
      onCreated?.(response.data.admin);

    } catch (err) {
      setError(err.response?.data?.message || "Failed to create administrator.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="platform-modal-backdrop" onClick={onClose}>
      <div className="platform-modal" onClick={(event) => event.stopPropagation()}>

        <div className="platform-modal-header">
          <div>
            <h2>Create First Admin</h2>
            <p>For {companyName}</p>
          </div>
          <button className="platform-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="platform-modal-body">

          {error && <div className="platform-alert platform-alert-danger">{error}</div>}

          {createdAdmin ? (
            <>
              <div className="platform-alert platform-alert-success">
                Administrator created successfully.
              </div>
              <div className="platform-result-box">
                <div className="platform-result-row"><span>Employee ID</span><span>{createdAdmin.employeeId}</span></div>
                <div className="platform-result-row"><span>Name</span><span>{createdAdmin.fullName}</span></div>
                <div className="platform-result-row"><span>Email</span><span>{createdAdmin.email}</span></div>
                <div className="platform-result-row"><span>Role</span><span>{createdAdmin.role}</span></div>
                <div className="platform-result-row"><span>Status</span><span>{createdAdmin.status}</span></div>
              </div>
              <p className="platform-form-hint">
                Share the Employee ID and password with the company directly — the password is not shown again and is never returned by the server after creation.
              </p>
            </>
          ) : (
            <form onSubmit={handleSubmit}>

              <div className="platform-form-group">
                <label htmlFor="admin-name">Admin Name</label>
                <input
                  id="admin-name"
                  type="text"
                  placeholder="Jane Doe"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>

              <div className="platform-form-group">
                <label htmlFor="admin-email">Email</label>
                <input
                  id="admin-email"
                  type="email"
                  placeholder="jane@company.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>

              <div className="platform-form-group">
                <label htmlFor="admin-phone">Phone (optional)</label>
                <input
                  id="admin-phone"
                  type="text"
                  placeholder="+1 555 0100"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                />
              </div>

              <div className="platform-form-group">
                <label htmlFor="admin-password">Password</label>
                <input
                  id="admin-password"
                  type="password"
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </div>

            </form>
          )}

        </div>

        <div className="platform-modal-footer">
          {createdAdmin ? (
            <button className="platform-btn platform-btn-primary" onClick={onClose}>Done</button>
          ) : (
            <>
              <button className="platform-btn platform-btn-outline" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button className="platform-btn platform-btn-primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? "Creating..." : "Create Admin"}
              </button>
            </>
          )}
        </div>

      </div>
    </div>
  );
}

export default CreateAdminModal;
