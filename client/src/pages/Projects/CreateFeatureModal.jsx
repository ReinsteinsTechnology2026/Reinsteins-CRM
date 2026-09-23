import { useEffect, useState } from "react";

import { toast } from "react-toastify";

import { getEmployees } from "../../services/taskManagementService";

import {
    createFeature,
    updateFeature,
} from "../../services/featureService";

import "./ProjectModal.css";

// ==========================================
// CREATE / EDIT FEATURE
// May be created under an Epic (defaultEpicId, or
// picked from the "Epic" dropdown below) or directly
// under the Project (Epic left as "No Epic"). No
// tags field (Features don't support tags in this
// version, per the approved scope).
//
// Assigned To replaces the old Owner selector -- see
// CreateEpicModal.jsx's header comment for the full
// reasoning (owner_id kept in DB/backend untouched,
// just no longer surfaced here). Same edit-mode-doubles-
// as-reassignment-form pattern (FEATURE_EDIT gates it).
// ==========================================

function getCurrentUser() {
    try {
        return JSON.parse(sessionStorage.getItem("user"));
    } catch {
        return null;
    }
}

function CreateFeatureModal({

    projectId,

    epics,

    feature,

    defaultEpicId,

    onClose,

    onCreated,

    onUpdated

}) {

    const isEditing = Boolean(feature);

    const currentUser = getCurrentUser();

    const [employees, setEmployees] = useState([]);

    const [loading, setLoading] = useState(false);

    const [formData, setFormData] = useState({

        title: feature?.title || "",
        description: feature?.description || "",
        assigned_to: feature?.assigned_to || "",
        status: feature?.status || "new",
        priority: feature?.priority || "Medium",
        start_date: feature?.start_date
            ? String(feature.start_date).substring(0, 10)
            : "",
        due_date: feature?.due_date
            ? String(feature.due_date).substring(0, 10)
            : "",
        epic_id: feature?.epic_id || defaultEpicId || "",

    });

    useEffect(() => {

        loadEmployees();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId]);

    async function loadEmployees() {

        try {

            const response = await getEmployees(projectId);

            setEmployees(response.employees || []);

        } catch (error) {

            console.error(error);

        }

    }

    function handleChange(event) {

        setFormData({

            ...formData,

            [event.target.name]: event.target.value,

        });

    }

    async function handleSubmit(event) {

        event.preventDefault();

        if (!formData.title.trim()) {
            toast.error("Feature title is required");
            return;
        }

        try {

            setLoading(true);

            if (isEditing) {

                await updateFeature(feature.id, formData);

                toast.success("Feature updated successfully");

                onUpdated();

            } else {

                await createFeature(projectId, formData);

                toast.success("Feature created successfully");

                onCreated();

            }

        } catch (error) {

            console.error(error);

            toast.error(
                error.response?.data?.message ||
                (isEditing
                    ? "Unable to update feature"
                    : "Unable to create feature")
            );

        } finally {

            setLoading(false);

        }

    }

    return (

        <div className="wi-modal-overlay">

            <div className="wi-modal">

                <div className="wi-modal-header">

                    <div>
                        <h2>{isEditing ? "Edit Feature" : "Create New Feature"}</h2>
                        <p>A deliverable slice of an Epic — broken down into User Stories.</p>
                    </div>

                    <button
                        type="button"
                        className="wi-modal-close"
                        onClick={onClose}
                    >
                        &times;
                    </button>

                </div>

                <form onSubmit={handleSubmit} className="wi-modal-form">

                    <div className="wi-form-group">
                        <label>Title *</label>
                        <input
                            type="text"
                            name="title"
                            placeholder="Example: Self-Service Password Reset"
                            value={formData.title}
                            onChange={handleChange}
                            required
                        />
                    </div>

                    <div className="wi-form-group">
                        <label>Description</label>
                        <textarea
                            name="description"
                            rows={4}
                            placeholder="Describe this deliverable in detail..."
                            value={formData.description}
                            onChange={handleChange}
                        />
                    </div>

                    <div className="wi-form-group">
                        <label>Epic</label>
                        <select
                            name="epic_id"
                            value={formData.epic_id}
                            onChange={handleChange}
                        >
                            <option value="">No Epic (directly under project)</option>
                            {(epics || []).map((epicOption) => (
                                <option key={epicOption.id} value={epicOption.id}>
                                    {epicOption.title}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="wi-form-grid">

                        <div className="wi-form-group">
                            <label>Assigned By</label>
                            <input
                                type="text"
                                value={currentUser?.name || currentUser?.fullName || ""}
                                disabled
                                readOnly
                            />
                        </div>

                        <div className="wi-form-group">
                            <label>Assigned To</label>
                            <select
                                name="assigned_to"
                                value={formData.assigned_to}
                                onChange={handleChange}
                            >
                                <option value="">Unassigned</option>
                                {employees.map((employee) => (
                                    <option key={employee.id} value={employee.id}>
                                        {employee.full_name}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div className="wi-form-group">
                            <label>Priority</label>
                            <select
                                name="priority"
                                value={formData.priority}
                                onChange={handleChange}
                            >
                                <option>Low</option>
                                <option>Medium</option>
                                <option>High</option>
                                <option>Critical</option>
                            </select>
                        </div>

                        <div className="wi-form-group">
                            <label>Status</label>
                            <select
                                name="status"
                                value={formData.status}
                                onChange={handleChange}
                            >
                                <option value="new">New</option>
                                <option value="active">Active</option>
                                <option value="on_hold">On Hold</option>
                                <option value="completed">Completed</option>
                                <option value="cancelled">Cancelled</option>
                            </select>
                        </div>

                        <div className="wi-form-group">
                            <label>Start Date</label>
                            <input
                                type="date"
                                name="start_date"
                                value={formData.start_date}
                                onChange={handleChange}
                            />
                        </div>

                        <div className="wi-form-group">
                            <label>Due Date</label>
                            <input
                                type="date"
                                name="due_date"
                                value={formData.due_date}
                                onChange={handleChange}
                            />
                        </div>

                    </div>

                    <div className="wi-modal-footer">

                        <button
                            type="button"
                            className="wi-secondary-button"
                            onClick={onClose}
                        >
                            Cancel
                        </button>

                        <button
                            type="submit"
                            className="wi-primary-button"
                            disabled={loading}
                        >
                            {loading
                                ? "Saving..."
                                : isEditing
                                    ? "Save Changes"
                                    : "Create Feature"}
                        </button>

                    </div>

                </form>

            </div>

        </div>

    );

}

export default CreateFeatureModal;
