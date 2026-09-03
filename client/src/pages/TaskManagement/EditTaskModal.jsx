import { useEffect, useState } from "react";

import {
    getEmployees,
    updateTask
} from "../../services/taskManagementService";

import TagPicker from "../../components/TagPicker";

import "./EditTaskModal.css";

function EditTaskModal({

    task,

    onClose,

    onUpdated

}) {

    const [employees, setEmployees] = useState([]);

    const [loading, setLoading] = useState(false);

    const [formData, setFormData] = useState({

        title: "",

        description: "",

        assigned_to: "",

        priority: "Medium",

        status: "in_progress",

        due_date: "",

        estimated_hours: "",

        tags: ""

    });

    const [tagNames, setTagNames] = useState([]);

    useEffect(() => {

        loadEmployees(task?.project_id);

        if (task) {

            setFormData({

                title: task.task_title || "",

                description: task.task_description || "",

                assigned_to: task.assigned_to || "",

                priority: task.priority || "Medium",

                status: task.status || "in_progress",

                due_date: task.due_date
                    ? task.due_date.substring(0, 10)
                    : "",

                estimated_hours:
                    task.estimated_hours || "",

                tags: task.tags || ""

            });

            setTagNames((task.taskTags || []).map((tag) => tag.name));

        }

    }, [task]);

    async function loadEmployees(projectId) {

        try {

            const response =
                await getEmployees(projectId);

            setEmployees(
                response.employees
            );

        } catch (error) {

            console.error(error);

        }

    }

    function handleChange(event) {

        setFormData({

            ...formData,

            [event.target.name]:
                event.target.value

        });

    }

    async function handleUpdate(event) {

        event.preventDefault();

        try {

            setLoading(true);

            await updateTask(

                task.id,

                { ...formData, tagNames }

            );

            alert("Task Updated Successfully");

            onUpdated();

            onClose();

        } catch (error) {

            console.error(error);

            alert(error.response?.data?.message || "Unable to update task");

        } finally {

            setLoading(false);

        }

    }
        return (

        <div className="task-modal-overlay">

            <div className="task-modal">

                <div className="task-modal-header">

                    <div>

                        <h2>Edit Task</h2>

                        <p>

                            Update task information

                        </p>

                    </div>

                    <button

                        onClick={onClose}

                        className="task-close-button"

                    >

                        ✕

                    </button>

                </div>

                <form

                    onSubmit={handleUpdate}

                    className="task-form"

                >

                    <div className="task-form-group">

                        <label>Task Title</label>

                        <input

                            type="text"

                            name="title"

                            value={formData.title}

                            onChange={handleChange}

                            required

                        />

                    </div>

                    <div className="task-form-group">

                        <label>Description</label>

                        <textarea

                            rows="5"

                            name="description"

                            value={formData.description}

                            onChange={handleChange}

                        />

                    </div>

                    <div className="task-grid">

                        <div className="task-form-group">

                            <label>Assign To</label>

                            <select

                                name="assigned_to"

                                value={formData.assigned_to}

                                onChange={handleChange}

                            >

                                <option value="">

                                    Select Employee

                                </option>

                                {

                                    employees.map(employee => (

                                        <option

                                            key={employee.id}

                                            value={employee.id}

                                        >

                                            {employee.full_name}

                                        </option>

                                    ))

                                }

                            </select>

                        </div>

                        <div className="task-form-group">

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

                        <div className="task-form-group">

                            <label>Status</label>

                            <select

                                name="status"

                                value={formData.status}

                                onChange={handleChange}

                            >

                                <option value="in_progress">In Progress</option>

                                <option value="pending_review">Pending Review</option>

                                <option value="closed">Closed</option>

                            </select>

                        </div>

                        <div className="task-form-group">

                            <label>Due Date</label>

                            <input

                                type="date"

                                name="due_date"

                                value={formData.due_date}

                                onChange={handleChange}

                            />

                        </div>

                        <div className="task-form-group">

                            <label>Estimated Hours</label>

                            <input

                                type="number"

                                name="estimated_hours"

                                value={formData.estimated_hours}

                                onChange={handleChange}

                            />

                        </div>

                    </div>

                    <div className="task-form-group">

                        <label>Tags</label>

                        <TagPicker value={tagNames} onChange={setTagNames} />

                    </div>

                    <div className="task-modal-footer">

                        <button

                            type="button"

                            onClick={onClose}

                            className="cancel-button"

                        >

                            Cancel

                        </button>

                        <button

                            type="submit"

                            className="create-button"

                            disabled={loading}

                        >

                            {

                                loading

                                    ? "Updating..."

                                    : "Update Task"

                            }

                        </button>

                    </div>

                </form>

            </div>

        </div>

    );

}

export default EditTaskModal;