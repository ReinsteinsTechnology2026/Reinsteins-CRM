import { useEffect, useState } from "react";
import "./TransferTaskModal.css";

import { toast } from "react-toastify";

import { getProjectTasks } from "../../services/projectService";
import { createWorkItemLink } from "../../services/workItemLinkService";

// ==========================================
// ADD RELATIONSHIP (Task <-> Task only, v1 scope)
//
// Reuses TransferTaskModal.css so this looks
// consistent with the other Task Workspace action
// modals (Assign/Transfer/Work Log) in this same
// folder. The target list is drawn from the current
// task's OWN project (getProjectTasks) -- the same
// data source the Backlog/Board tabs already use --
// with the current task filtered out client-side
// (server-side self-link rejection is the real
// boundary; this is just UX).
// ==========================================

function AddRelationshipModal({

    task,

    onClose,

    onCreated

}) {

    const [projectTasks, setProjectTasks] = useState([]);

    const [loading, setLoading] = useState(true);

    const [linkType, setLinkType] = useState("related");

    const [targetId, setTargetId] = useState("");

    const [saving, setSaving] = useState(false);

    useEffect(() => {

        loadTasks();

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function loadTasks() {

        try {

            setLoading(true);

            const response = await getProjectTasks(task.project_id);

            setProjectTasks(
                (response.tasks || []).filter(
                    (candidate) => Number(candidate.id) !== Number(task.id)
                )
            );

        } catch (error) {

            console.error(error);

            toast.error("Unable to load tasks for this project");

        } finally {

            setLoading(false);

        }

    }

    async function handleCreate() {

        if (!targetId) {
            toast.error("Please select a task");
            return;
        }

        try {

            setSaving(true);

            await createWorkItemLink({
                sourceType: "task",
                sourceId: task.id,
                targetType: "task",
                targetId,
                linkType,
            });

            toast.success("Relationship created successfully");

            onCreated();

        } catch (error) {

            console.error(error);

            toast.error(
                error.response?.data?.message || "Unable to create relationship"
            );

        } finally {

            setSaving(false);

        }

    }

    return (

        <div className="transfer-overlay">

            <div className="transfer-modal">

                <div className="transfer-header">

                    <h2>Add Relationship</h2>

                    <button
                        onClick={onClose}
                        className="close-btn"
                    >
                        ✕
                    </button>

                </div>

                <div className="transfer-body">

                    <div className="form-group">

                        <label>Relationship Type</label>

                        <select
                            value={linkType}
                            onChange={(event) => setLinkType(event.target.value)}
                        >
                            <option value="related">Related</option>
                            <option value="blocks">Blocks</option>
                        </select>

                    </div>

                    <div className="form-group">

                        <label>Task</label>

                        {loading ? (

                            <span>Loading tasks...</span>

                        ) : (

                            <select
                                value={targetId}
                                onChange={(event) => setTargetId(event.target.value)}
                            >

                                <option value="">Select Task</option>

                                {projectTasks.map((candidate) => (
                                    <option key={candidate.id} value={candidate.id}>
                                        T-{String(candidate.task_number || candidate.id).padStart(3, "0")} — {candidate.task_title}
                                    </option>
                                ))}

                            </select>

                        )}

                        {!loading && projectTasks.length === 0 && (
                            <span>No other tasks in this project.</span>
                        )}

                    </div>

                </div>

                <div className="transfer-footer">

                    <button
                        className="cancel-btn"
                        onClick={onClose}
                    >
                        Cancel
                    </button>

                    <button
                        className="transfer-btn"
                        onClick={handleCreate}
                        disabled={saving || loading}
                    >
                        {saving ? "Creating..." : "Create Relationship"}
                    </button>

                </div>

            </div>

        </div>

    );

}

export default AddRelationshipModal;
