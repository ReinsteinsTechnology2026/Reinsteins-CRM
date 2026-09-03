import { useState } from "react";

import { toast } from "react-toastify";

import {
    createSprint,
    updateSprint,
} from "../../services/sprintService";

import "./ProjectModal.css";

function CreateSprintModal({

    projectId,

    sprint,

    onClose,

    onCreated,

    onUpdated

}) {

    const isEditing = Boolean(sprint);

    const [loading, setLoading] = useState(false);

    const [formData, setFormData] = useState({

        name: sprint?.name || "",
        goal: sprint?.goal || "",
        start_date: sprint?.start_date
            ? String(sprint.start_date).substring(0, 10)
            : "",
        due_date: sprint?.end_date
            ? String(sprint.end_date).substring(0, 10)
            : "",

    });

    function handleChange(event) {

        setFormData({

            ...formData,

            [event.target.name]: event.target.value,

        });

    }

    async function handleSubmit(event) {

        event.preventDefault();

        if (!formData.name.trim()) {
            toast.error("Sprint name is required");
            return;
        }

        const payload = {
            name: formData.name,
            goal: formData.goal,
            start_date: formData.start_date,
            end_date: formData.due_date,
        };

        try {

            setLoading(true);

            if (isEditing) {

                await updateSprint(sprint.id, payload);

                toast.success("Sprint updated successfully");

                onUpdated();

            } else {

                await createSprint(projectId, payload);

                toast.success("Sprint created successfully");

                onCreated();

            }

        } catch (error) {

            console.error(error);

            toast.error(
                error.response?.data?.message ||
                (isEditing ? "Unable to update sprint" : "Unable to create sprint")
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
                        <h2>{isEditing ? "Edit Sprint" : "Create New Sprint"}</h2>
                        <p>Sprints group tasks into a fixed planning window.</p>
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
                        <label>Sprint Name *</label>
                        <input
                            type="text"
                            name="name"
                            placeholder="Example: Sprint 1"
                            value={formData.name}
                            onChange={handleChange}
                            required
                        />
                    </div>

                    <div className="wi-form-group">
                        <label>Goal</label>
                        <textarea
                            name="goal"
                            rows={3}
                            placeholder="What should this sprint accomplish?"
                            value={formData.goal}
                            onChange={handleChange}
                        />
                    </div>

                    <div className="wi-form-grid">

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
                            <label>End Date</label>
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
                                    : "Create Sprint"}
                        </button>

                    </div>

                </form>

            </div>

        </div>

    );

}

export default CreateSprintModal;
