import { useEffect, useState } from "react";

import { toast } from "react-toastify";

import { getEmployees } from "../../services/taskManagementService";

import {
    createUserStory,
    updateUserStory,
} from "../../services/userStoryService";

import { createUserStoryInSprint } from "../../services/sprintService";

import "./ProjectModal.css";

// sprintId (optional): when set, the story is created directly inside
// that Sprint (Sprint -> "Create User Story") instead of the plain
// Project-level create -- Sprint is auto-selected, never chosen by the
// user. Editing an existing story never passes this.
//
// Assigned To replaces the old Owner selector -- see
// CreateEpicModal.jsx's header comment for the full reasoning
// (owner_id kept in DB/backend untouched, just no longer surfaced
// here). Same edit-mode-doubles-as-reassignment-form pattern
// (USER_STORY_EDIT gates it).
function getCurrentUser() {
    try {
        return JSON.parse(sessionStorage.getItem("user"));
    } catch {
        return null;
    }
}

function CreateUserStoryModal({

    projectId,

    features,

    story,

    defaultFeatureId,

    sprintId,

    onClose,

    onCreated,

    onUpdated

}) {

    const isEditing = Boolean(story);

    const currentUser = getCurrentUser();

    const [employees, setEmployees] = useState([]);

    const [loading, setLoading] = useState(false);

    const [formData, setFormData] = useState({

        title: story?.title || "",
        description: story?.description || "",
        assigned_to: story?.assigned_to || "",
        status: story?.status || "new",
        priority: story?.priority || "Medium",
        start_date: story?.start_date
            ? String(story.start_date).substring(0, 10)
            : "",
        due_date: story?.due_date
            ? String(story.due_date).substring(0, 10)
            : "",
        tags: story?.tags || "",
        // Optional -- a Story may exist directly under the Project
        // with no Feature, exactly as before this field existed.
        feature_id: story?.feature_id || defaultFeatureId || "",

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
            toast.error("User story title is required");
            return;
        }

        try {

            setLoading(true);

            if (isEditing) {

                await updateUserStory(story.id, formData);

                toast.success("User story updated successfully");

                onUpdated();

            } else if (sprintId) {

                await createUserStoryInSprint(sprintId, formData);

                toast.success("User story created successfully");

                onCreated();

            } else {

                await createUserStory(projectId, formData);

                toast.success("User story created successfully");

                onCreated();

            }

        } catch (error) {

            console.error(error);

            toast.error(
                isEditing
                    ? "Unable to update user story"
                    : "Unable to create user story"
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
                        <h2>{isEditing ? "Edit User Story" : "Create New User Story"}</h2>
                        <p>
                            {sprintId
                                ? "This user story will be created directly in the current sprint."
                                : "Describe the feature or requirement this story covers."}
                        </p>
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
                            placeholder="Example: Employee Dashboard"
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
                            placeholder="Explain the requirement in detail..."
                            value={formData.description}
                            onChange={handleChange}
                        />
                    </div>

                    {features && (
                        <div className="wi-form-group">
                            <label>Feature</label>
                            <select
                                name="feature_id"
                                value={formData.feature_id}
                                onChange={handleChange}
                            >
                                <option value="">No Feature (directly under project)</option>
                                {features.map((featureOption) => (
                                    <option key={featureOption.id} value={featureOption.id}>
                                        {featureOption.title}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}

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

                        <div className="wi-form-group">
                            <label>Tags</label>
                            <input
                                type="text"
                                name="tags"
                                placeholder="frontend, ui, api..."
                                value={formData.tags}
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
                                    : "Create User Story"}
                        </button>

                    </div>

                </form>

            </div>

        </div>

    );

}

export default CreateUserStoryModal;
