import { useEffect, useState } from "react";
import "./CreateTaskModal.css";

import {
    getEmployees,
    createTask as createTaskAPI
} from "../../services/taskManagementService";

function CreateTaskModal({ onClose }) {

    const [employees, setEmployees] = useState([]);

    const [task, setTask] = useState({

        title: "",

        description: "",

        assigned_to: "",

        priority: "Medium",

        status: "New",

        due_date: "",

        estimated_hours: "",

        tags: ""

    });

    useEffect(() => {

        loadEmployees();

    }, []);

    async function loadEmployees() {

        try {

            const response = await getEmployees();

            setEmployees(response.employees);

        } catch (error) {

            console.error(error);

        }

    }

    function handleChange(event) {

        setTask({

            ...task,

            [event.target.name]: event.target.value

        });

    }

    async function createTask(event) {

        event.preventDefault();

        try {

            await createTaskAPI(task);

            alert("Task Created Successfully");

            onClose();

        } catch (error) {

            console.error(error);

            alert("Unable to create task");

        }

    }

    return (

        <div className="task-modal-overlay">

            <div className="task-modal">

                <div className="task-modal-header">

                    <div>

                        <h2>Create New Task</h2>

                        <p>

                            Assign work just like Azure DevOps

                        </p>

                    </div>

                    <button

                        type="button"

                        onClick={onClose}

                        className="task-close-button"

                    >

                        ✕

                    </button>

                </div>

                <form

                    onSubmit={createTask}

                    className="task-form"

                >

                    <div className="task-form-group">

                        <label>

                            Task Title *

                        </label>

                        <input

                            type="text"

                            name="title"

                            value={task.title}

                            onChange={handleChange}

                            required

                        />

                    </div>

                    <div className="task-form-group">

                        <label>

                            Description

                        </label>

                        <textarea

                            name="description"

                            value={task.description}

                            onChange={handleChange}

                            rows="5"

                        />

                    </div>

                    <div className="task-grid">

                        <div className="task-form-group">

                            <label>

                                Assign To

                            </label>

                            <select

                                name="assigned_to"

                                value={task.assigned_to}

                                onChange={handleChange}

                                required

                            >

                                <option value="">

                                    Select Employee

                                </option>

                                {employees.map((employee) => (

                                    <option

                                        key={employee.id}

                                        value={employee.id}

                                    >

                                        {employee.full_name} ({employee.employee_id})

                                    </option>

                                ))}

                            </select>

                        </div>

                        <div className="task-form-group">

                            <label>

                                Priority

                            </label>

                            <select

                                name="priority"

                                value={task.priority}

                                onChange={handleChange}

                            >

                                <option>Low</option>

                                <option>Medium</option>

                                <option>High</option>

                                <option>Critical</option>

                            </select>

                        </div>

                        <div className="task-form-group">

                            <label>

                                Status

                            </label>

                            <select

                                name="status"

                                value={task.status}

                                onChange={handleChange}

                            >

                                <option>New</option>

                                <option>Active</option>

                                <option>In Progress</option>

                                <option>On Hold</option>

                                <option>Completed</option>

                                <option>Closed</option>

                            </select>

                        </div>

                        <div className="task-form-group">

                            <label>

                                Due Date

                            </label>

                            <input

                                type="date"

                                name="due_date"

                                value={task.due_date}

                                onChange={handleChange}

                            />

                        </div>

                        <div className="task-form-group">

                            <label>

                                Estimated Hours

                            </label>

                            <input

                                type="number"

                                name="estimated_hours"

                                value={task.estimated_hours}

                                onChange={handleChange}

                            />

                        </div>

                        <div className="task-form-group">

                            <label>

                                Tags

                            </label>

                            <input

                                type="text"

                                name="tags"

                                value={task.tags}

                                onChange={handleChange}

                                placeholder="UI, Login, API..."

                            />

                        </div>

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
                        >
                            Create Task
                        </button>

                    </div>

                </form>

            </div>

        </div>

    );

}

export default CreateTaskModal;