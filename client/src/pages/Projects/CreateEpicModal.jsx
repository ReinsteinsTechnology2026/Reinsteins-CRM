import { useEffect, useState } from "react";

import { toast } from "react-toastify";

import { getEmployees } from "../../services/taskManagementService";

import {
    createEpic,
    updateEpic,
} from "../../services/epicService";

import "./ProjectModal.css";

// ==========================================
// CREATE / EDIT EPIC
// Top of the Epic -> Feature -> User Story -> Task
// hierarchy. Deliberately the same simple form
// pattern as CreateUserStoryModal.jsx -- no new UX
// invented. No tags field (Epics don't support tags
// in this version, per the approved scope).
//
// Assigned To replaces the old Owner selector as the
// operational assignment field (owner_id is kept in
// the DB/backend untouched for backward compatibility
// but is no longer surfaced here). Assigned By is
// always read-only and server-derived -- this form
// only ever displays who it WILL become (the current
// user), it never submits a value for it.
//
// This same modal, in edit mode (epic prop present),
// is also how an Epic's Assigned To is changed --
// there is no separate reassignment modal, per the
// approved design (EPIC_EDIT already gates access to
// this form).
// ==========================================

function getCurrentUser() {
    try {
        return JSON.parse(sessionStorage.getItem("user"));
    } catch {
        return null;
    }
}

function CreateEpicModal({

    projectId,

    epic,

    onClose,

    onCreated,

    onUpdated

}) {

    const isEditing = Boolean(epic);

    const currentUser = getCurrentUser();

    const [employees, setEmployees] = useState([]);

    const [loading, setLoading] = useState(false);

    const [formData, setFormData] = useState({

        title: epic?.title || "",
        description: epic?.description || "",
        assigned_to: epic?.assigned_to || "",
        status: epic?.status || "new",
        priority: epic?.priority || "Medium",
        start_date: epic?.start_date
            ? String(epic.start_date).substring(0, 10)
            : "",
        due_date: epic?.due_date
            ? String(epic.due_date).substring(0, 10)
            : "",

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
            toast.error("Epic title is required");
            return;
        }

        try {

            setLoading(true);

            if (isEditing) {

                await updateEpic(epic.id, formData);

                toast.success("Epic updated successfully");

                onUpdated();

            } else {

                await createEpic(projectId, formData);

                toast.success("Epic created successfully");

                onCreated();

            }

        } catch (error) {

            console.error(error);

            toast.error(
                error.response?.data?.message ||
                (isEditing
                    ? "Unable to update epic"
                    : "Unable to create epic")
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
                        <h2>{isEditing ? "Edit Epic" : "Create New Epic"}</h2>
                        <p>The largest unit of work — a broad initiative broken down into Features.</p>
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
                            placeholder="Example: Customer Onboarding Overhaul"
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
                            placeholder="Describe the initiative in detail..."
                            value={formData.description}
                            onChange={handleChange}
                        />
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
                                    : "Create Epic"}
                        </button>

                    </div>

                </form>

            </div>

        </div>

    );

}

export default CreateEpicModal;
