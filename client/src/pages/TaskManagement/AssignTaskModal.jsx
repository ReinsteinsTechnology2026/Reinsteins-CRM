import { useEffect, useState } from "react";
import "./TransferTaskModal.css";

import { getProjectMembers } from "../../services/projectMemberService";
import { assignTask } from "../../services/taskManagementService";

import { toast } from "react-toastify";

// ==========================================
// ASSIGN / REASSIGN TASK (project-linked tasks
// only) — deliberately separate from
// TransferTaskModal.jsx. Eligible users are drawn
// from project membership (getProjectMembers),
// NEVER the org-wide active-employee pool
// TransferTaskModal uses, matching the backend's
// own TASK_ASSIGN rule (assignTask in
// taskManagementController.js). Reuses
// TransferTaskModal.css so the two modals look
// consistent with each other and the rest of the
// portal, without duplicating styles.
// ==========================================

function AssignTaskModal({

    task,

    onClose,

    onAssigned

}) {

    const [members, setMembers] = useState([]);

    const [search, setSearch] = useState("");

    const [assignedTo, setAssignedTo] = useState("");

    const [loading, setLoading] = useState(true);

    const [saving, setSaving] = useState(false);

    useEffect(() => {

        loadMembers();

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function loadMembers() {

        try {

            setLoading(true);

            const response = await getProjectMembers(task.project_id);

            setMembers(response.members || []);

        } catch (error) {

            console.error(error);

            toast.error(
                error.response?.data?.message || "Unable to load project members"
            );

        } finally {

            setLoading(false);

        }

    }

    const eligibleMembers = members
        .filter((member) => member.employment_status === "active")
        .filter((member) => Number(member.user_id) !== Number(task.assigned_to))
        .filter((member) =>
            member.full_name.toLowerCase().includes(search.trim().toLowerCase())
        );

    const isReassign = Boolean(task.assigned_to);

    async function handleAssign() {

        if (!assignedTo) {
            toast.error("Please select a project member");
            return;
        }

        try {

            setSaving(true);

            await assignTask(task.id, { assigned_to: assignedTo });

            toast.success(
                isReassign
                    ? "Task reassigned successfully"
                    : "Task assigned successfully"
            );

            onAssigned();

        } catch (error) {

            console.error(error);

            toast.error(
                error.response?.data?.message ||
                `Unable to ${isReassign ? "reassign" : "assign"} task`
            );

        } finally {

            setSaving(false);

        }

    }

    return (

        <div className="transfer-overlay">

            <div className="transfer-modal">

                <div className="transfer-header">

                    <h2>
                        {isReassign ? "Reassign" : "Assign"} Task #{task.task_number}
                    </h2>

                    <button
                        onClick={onClose}
                        className="close-btn"
                    >
                        ✕
                    </button>

                </div>

                <div className="transfer-body">

                    <div className="form-group">
                        <label>Currently Assigned To</label>
                        <span>{task.assigned_to_name || "Unassigned"}</span>
                    </div>

                    <div className="form-group">

                        <label>Search Project Members</label>

                        <input
                            type="text"
                            placeholder="Search by name..."
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                        />

                    </div>

                    <div className="form-group">

                        <label>{isReassign ? "Reassign To" : "Assign To"}</label>

                        {loading ? (

                            <span>Loading project members...</span>

                        ) : (

                            <select
                                value={assignedTo}
                                onChange={(event) => setAssignedTo(event.target.value)}
                            >

                                <option value="">Select Project Member</option>

                                {eligibleMembers.map((member) => (
                                    <option key={member.user_id} value={member.user_id}>
                                        {member.full_name} ({member.group_name})
                                    </option>
                                ))}

                            </select>

                        )}

                        {!loading && eligibleMembers.length === 0 && (
                            <span>No other eligible project members found.</span>
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
                        onClick={handleAssign}
                        disabled={saving || loading}
                    >
                        {saving
                            ? (isReassign ? "Reassigning..." : "Assigning...")
                            : (isReassign ? "Reassign Task" : "Assign Task")}
                    </button>

                </div>

            </div>

        </div>

    );

}

export default AssignTaskModal;
