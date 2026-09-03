import { useEffect, useState } from "react";

import { toast } from "react-toastify";

import { getEmployees } from "../../services/taskManagementService";

import {
    createProject,
    updateProject,
} from "../../services/projectService";

import { createOrganizationProject } from "../../services/organizationsService";

import "./ProjectModal.css";

function CreateProjectModal({

    project,

    // Phase 2C: when set, the project is created INSIDE this
    // organization (via POST /organizations/:id/projects, which
    // forces organization_id server-side from the route) instead of
    // the standalone POST /projects. Omitted entirely by the
    // standalone Projects page's "New Project" flow -- that usage is
    // completely unaffected.
    organizationId,

    onClose,

    onCreated,

    onUpdated

}) {

    const isEditing = Boolean(project);

    const [employees, setEmployees] = useState([]);

    const [loading, setLoading] = useState(false);

    const [formData, setFormData] = useState({

        name: project?.name || "",
        description: project?.description || "",
        owner_id: project?.owner_id || "",
        status: project?.status || "planning",
        priority: project?.priority || "Medium",
        start_date: project?.start_date
            ? String(project.start_date).substring(0, 10)
            : "",
        due_date: project?.due_date
            ? String(project.due_date).substring(0, 10)
            : "",

    });

    useEffect(() => {

        loadEmployees();

    }, []);

    async function loadEmployees() {

        try {

            const response = await getEmployees();

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

        if (!formData.name.trim()) {
            toast.error("Project name is required");
            return;
        }

        try {

            setLoading(true);

            if (isEditing) {

                await updateProject(project.id, formData);

                toast.success("Project updated successfully");

                onUpdated();

            } else if (organizationId) {

                await createOrganizationProject(organizationId, formData);

                toast.success("Project created successfully");

                onCreated();

            } else {

                await createProject(formData);

                toast.success("Project created successfully");

                onCreated();

            }

        } catch (error) {

            console.error(error);

            toast.error(
                isEditing
                    ? "Unable to update project"
                    : "Unable to create project"
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
                        <h2>{isEditing ? "Edit Project" : "Create New Project"}</h2>
                        <p>Projects are the top-level container for user stories and tasks.</p>
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
                        <label>Project Name *</label>
                        <input
                            type="text"
                            name="name"
                            placeholder="Example: RS Management Portal"
                            value={formData.name}
                            onChange={handleChange}
                            required
                        />
                    </div>

                    <div className="wi-form-group">
                        <label>Description</label>
                        <textarea
                            name="description"
                            rows={4}
                            placeholder="What is this project about?"
                            value={formData.description}
                            onChange={handleChange}
                        />
                    </div>

                    <div className="wi-form-grid">

                        <div className="wi-form-group">
                            <label>Owner</label>
                            <select
                                name="owner_id"
                                value={formData.owner_id}
                                onChange={handleChange}
                            >
                                <option value="">Select Owner</option>
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
                                <option value="planning">Planning</option>
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
                                    : "Create Project"}
                        </button>

                    </div>

                </form>

            </div>

        </div>

    );

}

export default CreateProjectModal;
