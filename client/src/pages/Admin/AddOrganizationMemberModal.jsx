import { useEffect, useState } from "react";

import { FaSearch } from "react-icons/fa";

import { toast } from "react-toastify";

import { getEligibleEmployees, addOrganizationMember } from "../../services/organizationsService";

import "./Organizations.css";

// ==========================================
// ADD ORGANIZATION MEMBER MODAL (Phase 2B)
// Mirrors the search + checkbox multi-select pattern
// already established in ProjectSettings.jsx's
// AddMemberModal -- the backend endpoint adds one
// user at a time (organization membership is 1:1), so
// a multi-select submit just loops that single call,
// same as how this exact interaction already works
// elsewhere in the app.
// ==========================================

function AddOrganizationMemberModal({

    organizationId,

    onClose,

    onAdded

}) {

    const [candidates, setCandidates] = useState([]);

    const [search, setSearch] = useState("");

    const [selectedIds, setSelectedIds] = useState([]);

    const [saving, setSaving] = useState(false);

    useEffect(() => {

        getEligibleEmployees(organizationId)
            .then((res) => setCandidates(res.employees || []))
            .catch(() => {});

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [organizationId]);

    const filtered = candidates.filter(
        (user) =>
            user.full_name.toLowerCase().includes(search.trim().toLowerCase()) ||
            user.employee_id.toLowerCase().includes(search.trim().toLowerCase())
    );

    const toggleSelect = (userId) => {
        setSelectedIds((prev) =>
            prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
        );
    };

    const handleSubmit = async () => {

        if (selectedIds.length === 0) {
            toast.error("Select at least one employee");
            return;
        }

        try {

            setSaving(true);

            let addedCount = 0;

            for (const userId of selectedIds) {

                try {
                    await addOrganizationMember(organizationId, userId);
                    addedCount += 1;
                } catch (error) {
                    toast.error(error.response?.data?.message || "Unable to add one of the selected employees");
                }

            }

            if (addedCount > 0) {
                toast.success(`Added ${addedCount} member(s)`);
            }

            onAdded();

        } finally {

            setSaving(false);

        }

    };

    return (

        <div className="org-modal-overlay">

            <div className="org-modal">

                <div className="org-modal-header">

                    <div>
                        <h2>Add Member</h2>
                        <p>Only active employees who don't already belong to another organization can be added.</p>
                    </div>

                    <button type="button" className="org-modal-close" onClick={onClose}>&times;</button>

                </div>

                <div className="org-modal-form">

                    <div className="org-search-box">
                        <FaSearch />
                        <input
                            type="text"
                            placeholder="Search eligible employees..."
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                        />
                    </div>

                    <div className="org-candidate-list">
                        {filtered.length === 0 ? (
                            <div className="org-empty-cell">No eligible employees found.</div>
                        ) : filtered.map((user) => (
                            <label className="org-candidate-row" key={user.id}>
                                <input
                                    type="checkbox"
                                    checked={selectedIds.includes(user.id)}
                                    onChange={() => toggleSelect(user.id)}
                                />
                                <span>{user.full_name} ({user.employee_id})</span>
                            </label>
                        ))}
                    </div>

                    <div className="org-modal-footer">

                        <button type="button" className="org-secondary-button" onClick={onClose}>Cancel</button>

                        <button type="button" className="org-primary-button" disabled={saving} onClick={handleSubmit}>
                            {saving ? "Adding..." : `Add ${selectedIds.length || ""} Member${selectedIds.length === 1 ? "" : "s"}`}
                        </button>

                    </div>

                </div>

            </div>

        </div>

    );

}

export default AddOrganizationMemberModal;
