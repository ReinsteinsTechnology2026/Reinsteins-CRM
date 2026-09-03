import { useEffect, useState } from "react";

import { toast } from "react-toastify";

import { getEmployees } from "../../services/taskManagementService";

import { createTaskInStory } from "../../services/userStoryService";

import TagPicker from "../../components/TagPicker";

import "./ProjectModal.css";

function CreateStoryTaskModal({

    storyId,

    projectId,

    onClose,

    onCreated

}) {

    const [employees, setEmployees] = useState([]);

    const [loading, setLoading] = useState(false);

    const [formData, setFormData] = useState({

        title: "",
        description: "",
        assigned_to: "",
        priority: "Medium",
        due_date: "",
        estimated_hours: "",

    });

    const [tagNames, setTagNames] = useState([]);

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
            toast.error("Task title is required");
            return;
        }

        if (!formData.description.trim()) {
            toast.error("Task description is required");
            return;
        }

        if (!formData.assigned_to) {
            toast.error("Please assign this task to an employee");
            return;
        }

        try {

            setLoading(true);

            await createTaskInStory(storyId, { ...formData, tagNames });

            toast.success("Task created and assigned successfully");

            onCreated();

        } catch (error) {

            console.error(error);

            toast.error(error.response?.data?.message || "Unable to create task");

        } finally {

            setLoading(false);

        }

    }

    return (

        <div className="wi-modal-overlay">

            <div className="wi-modal">

                <div className="wi-modal-header">

                    <div>
                        <h2>Create Task</h2>
                        <p>This task will belong to the current user story.</p>
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
                        <label>Task Title *</label>
                        <input
                            type="text"
                            name="title"
                            placeholder="Example: Create Attendance Widget"
                            value={formData.title}
                            onChange={handleChange}
                            required
                        />
                    </div>

                    <div className="wi-form-group">
                        <label>Description *</label>
                        <textarea
                            name="description"
                            rows={4}
                            placeholder="Explain the task in detail..."
                            value={formData.description}
                            onChange={handleChange}
                            required
                        />
                    </div>

                    <div className="wi-form-grid">

                        <div className="wi-form-group">
                            <label>Assign To *</label>
                            <select
                                name="assigned_to"
                                value={formData.assigned_to}
                                onChange={handleChange}
                                required
                            >
                                <option value="">Select Employee</option>
                                {employees.map((employee) => (
                                    <option key={employee.id} value={employee.id}>
                                        {employee.full_name} ({employee.employee_id})
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
                            <label>Due Date</label>
                            <input
                                type="date"
                                name="due_date"
                                value={formData.due_date}
                                onChange={handleChange}
                            />
                        </div>

                        <div className="wi-form-group">
                            <label>Estimated Hours</label>
                            <input
                                type="number"
                                name="estimated_hours"
                                value={formData.estimated_hours}
                                onChange={handleChange}
                            />
                        </div>

                    </div>

                    <div className="wi-form-group">
                        <label>Tags</label>
                        <TagPicker value={tagNames} onChange={setTagNames} />
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
                            {loading ? "Creating..." : "Create Task"}
                        </button>

                    </div>

                </form>

            </div>

        </div>

    );

}

export default CreateStoryTaskModal;
