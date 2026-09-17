import { useEffect, useMemo, useState } from "react";
import { FaBook, FaCloudUploadAlt, FaDownload, FaTrash, FaTimes, FaFileAlt } from "react-icons/fa";
import { toast } from "react-toastify";

import { getSops, uploadSop, deleteSop } from "../../services/sopService";
import { API_ORIGIN } from "../../config";

import "./SopLibrary.css";

// ==========================================
// SOP LIBRARY (Phase 17c)
//
// One shared component for both the Admin and Employee routes,
// following the same convention App.jsx already uses for Chat/
// Meetings/TaskWorkspace (the SAME Component reference registered in
// both ADMIN_ROUTES and EMPLOYEE_ROUTES) -- every authenticated
// tenant user sees the identical list; only the upload/delete
// controls are conditionally rendered based on the caller's own
// role/system_access. The backend independently re-enforces this on
// every mutating request regardless of what this component shows.
// ==========================================

function getCurrentUser() {
    try {
        return JSON.parse(sessionStorage.getItem("user"));
    } catch {
        return null;
    }
}

function isAdminTier(user) {
    return user?.role === "admin" || ["admin", "super_admin"].includes(user?.systemAccess);
}

function formatFileSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value) {
    if (!value) return "";
    return new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function SopLibrary() {
    const currentUser = useMemo(() => getCurrentUser(), []);
    const canManage = isAdminTier(currentUser);

    const [sops, setSops] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);

    const [showUploadForm, setShowUploadForm] = useState(false);
    const [title, setTitle] = useState("");
    const [selectedFile, setSelectedFile] = useState(null);

    const loadSops = async () => {
        try {
            setLoading(true);
            setError("");
            const data = await getSops();
            setSops(Array.isArray(data.sops) ? data.sops : []);
        } catch (err) {
            console.error("Load SOPs error:", err);
            setSops([]);
            setError(err.response?.data?.message || "Unable to load SOPs");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadSops();
    }, []);

    const handleFileChange = (event) => {
        setSelectedFile(event.target.files?.[0] || null);
    };

    const handleUploadSubmit = async (event) => {
        event.preventDefault();

        if (!title.trim()) {
            toast.error("SOP title is required");
            return;
        }

        if (!selectedFile) {
            toast.error("Please select a file to upload");
            return;
        }

        try {
            setSaving(true);
            await uploadSop(title.trim(), selectedFile);
            toast.success("SOP uploaded successfully");
            setShowUploadForm(false);
            setTitle("");
            setSelectedFile(null);
            await loadSops();
        } catch (err) {
            console.error("Upload SOP error:", err);
            toast.error(err.response?.data?.message || "Unable to upload SOP");
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (sop) => {
        if (!window.confirm(`Delete "${sop.title}"? This cannot be undone.`)) {
            return;
        }

        try {
            await deleteSop(sop.id);
            toast.success("SOP deleted successfully");
            await loadSops();
        } catch (err) {
            console.error("Delete SOP error:", err);
            toast.error(err.response?.data?.message || "Unable to delete SOP");
        }
    };

    return (
        <div className="sop-page-content">

            <section className="sop-header">
                <div>
                    <h2>SOP Library</h2>
                    <p>Standard Operating Procedures for your company</p>
                </div>
                {canManage && (
                    <button type="button" className="sop-upload-button" onClick={() => setShowUploadForm(true)}>
                        <FaCloudUploadAlt /> Upload SOP
                    </button>
                )}
            </section>

            <section className="sop-card">

                {loading ? (
                    <div className="sop-loading">Loading SOPs...</div>
                ) : error ? (
                    <div className="sop-error">{error}</div>
                ) : sops.length === 0 ? (
                    <div className="sop-empty">
                        <FaBook />
                        <h3>No SOPs uploaded yet</h3>
                        <p>{canManage ? "Upload your first SOP to get started." : "Check back later -- your company hasn't published any SOPs yet."}</p>
                    </div>
                ) : (
                    <div className="sop-table-wrapper">
                        <table className="sop-table">
                            <thead>
                                <tr>
                                    <th>Title</th>
                                    <th>File</th>
                                    <th>Size</th>
                                    <th>Uploaded By</th>
                                    <th>Date</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {sops.map((sop) => (
                                    <tr key={sop.id}>
                                        <td>
                                            <span className="sop-title-cell">
                                                <FaFileAlt /> {sop.title}
                                            </span>
                                        </td>
                                        <td className="sop-filename-cell">{sop.original_filename}</td>
                                        <td>{formatFileSize(sop.file_size)}</td>
                                        <td>{sop.uploaded_by_name || "—"}</td>
                                        <td>{formatDate(sop.created_at)}</td>
                                        <td>
                                            <div className="sop-row-actions">
                                                <a
                                                    className="sop-download-button"
                                                    href={`${API_ORIGIN}${sop.file_path}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    title="View / Download"
                                                >
                                                    <FaDownload />
                                                </a>
                                                {canManage && (
                                                    <button
                                                        type="button"
                                                        className="sop-delete-icon-button"
                                                        onClick={() => handleDelete(sop)}
                                                        title="Delete"
                                                    >
                                                        <FaTrash />
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

            </section>

            {showUploadForm && canManage && (
                <div className="employee-modal-overlay">
                    <div className="employee-modal">
                        <div className="employee-modal-header">
                            <div>
                                <h2>Upload SOP</h2>
                                <p>PDF, DOC, DOCX, JPG, JPEG, PNG or WEBP -- up to 20 MB.</p>
                            </div>
                            <button type="button" className="modal-close" onClick={() => setShowUploadForm(false)}>
                                <FaTimes />
                            </button>
                        </div>

                        <form onSubmit={handleUploadSubmit}>
                            <div className="employee-form-group">
                                <label>SOP Title</label>
                                <input
                                    type="text"
                                    value={title}
                                    onChange={(event) => setTitle(event.target.value)}
                                    placeholder="e.g. Employee Onboarding Checklist"
                                    required
                                />
                            </div>

                            <div className="employee-form-group">
                                <label>File</label>
                                <input
                                    type="file"
                                    accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp"
                                    onChange={handleFileChange}
                                    required
                                />
                            </div>

                            <div className="employee-modal-actions">
                                <span />
                                <div className="shift-form-actions-right">
                                    <button type="button" className="cancel-employee-button" onClick={() => setShowUploadForm(false)}>Cancel</button>
                                    <button type="submit" className="save-employee-button" disabled={saving}>
                                        {saving ? "Uploading..." : "Upload"}
                                    </button>
                                </div>
                            </div>
                        </form>
                    </div>
                </div>
            )}

        </div>
    );
}

export default SopLibrary;
