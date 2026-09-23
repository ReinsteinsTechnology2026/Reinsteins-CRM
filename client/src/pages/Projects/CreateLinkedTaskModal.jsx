import { useEffect, useState } from "react";

import { toast } from "react-toastify";

import { getEmployees, createProjectTask } from "../../services/taskManagementService";

import { createTaskInSprint } from "../../services/sprintService";

import TagPicker from "../../components/TagPicker";

import "./ProjectModal.css";

// ==========================================
// CREATE LINKED TASK MODAL
//
// Powers the two NEW Task-creation entry points that don't require
// going through a User Story first:
//   - Project Backlog -> "Add Task" (mode="project")
//   - Sprint -> "Create Task" (mode="sprint", sprint pre-selected)
//
// User Story is OPTIONAL here (unlike CreateStoryTaskModal, which
// stays untouched for its own existing entry point) -- the dropdown
// below is restricted to User Stories already belonging to THIS
// project (userStories prop), and the backend independently
// re-validates it belongs to the same project regardless
// (taskService.assertUserStoryBelongsToProject).
// ==========================================

function getCurrentUser() {
    try {
        return JSON.parse(sessionStorage.getItem("user"));
    } catch {
        return null;
    }
}

function CreateLinkedTaskModal({

    mode, // "project" | "sprint"
    projectId,
    sprintId,
    userStories,
    userStoriesLoadFailed,
    onClose,
    onCreated

}) {

    const currentUser = getCurrentUser();

    const [employees, setEmployees] = useState([]);

    const [loading, setLoading] = useState(false);

    const [formData, setFormData] = useState({

        title: "",
        description: "",
        assigned_to: "",
        priority: "Medium",
        due_date: "",
        estimated_hours: "",
        user_story_id: "",

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

        const payload = {
            ...formData,
            user_story_id: formData.user_story_id || null,
            tagNames,
        };

        try {

            setLoading(true);

            if (mode === "sprint") {
                await createTaskInSprint(sprintId, payload);
            } else {
                await createProjectTask(projectId, payload);
            }

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
                        <p>
                            {mode === "sprint"
                                ? "This task will be created directly in the current sprint."
                                : "This task will belong to the current project. Optionally link it to a User Story."}
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

                    {/* Always rendered in "project" mode, even when userStories
                        is empty -- previously this block was also gated on
                        userStories?.length > 0, which hid the selector
                        entirely whenever the project had no stories yet (or
                        the story list failed to load), making it look like
                        standalone-task creation had lost this field. "No
                        User Story" is always a valid, selectable option. */}
                    {mode === "project" && (
                        <div className="wi-form-group">
                            <label>User Story (optional)</label>
                            <select
                                name="user_story_id"
                                value={formData.user_story_id}
                                onChange={handleChange}
                            >
                                <option value="">No User Story</option>
                                {(userStories || []).map((story) => (
                                    <option key={story.id} value={story.id}>
                                        {story.story_code ? `${story.story_code} — ` : ""}{story.title}
                                    </option>
                                ))}
                            </select>
                            {userStoriesLoadFailed && (
                                <small style={{ display: "block", marginTop: 4, color: "#b45309" }}>
                                    User Stories could not be loaded right now — you can still create a standalone task ("No User Story").
                                </small>
                            )}
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

export default CreateLinkedTaskModal;
