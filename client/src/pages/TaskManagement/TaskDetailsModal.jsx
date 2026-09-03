import { useState } from "react";

import "./TaskDetailsModal.css";

import EditTaskModal from "./EditTaskModal";
import TransferTaskModal from "./TransferTaskModal";
import WorkLogModal from "./WorkLogModal";

import {
    deleteTask,
    approveAndCloseTask,
    sendBackTask
} from "../../services/taskManagementService";

import {
    startWork
} from "../../services/taskWorkService";

import { toast } from "react-toastify";

const STATUS_LABELS = {
    in_progress: "In Progress",
    pending_review: "Pending Review",
    closed: "Closed"
};

function TaskDetailsModal({

    task,

    onClose,

    onUpdated

}) {

    const [showEditModal, setShowEditModal] = useState(false);

    const [showTransferModal, setShowTransferModal] = useState(false);

    const [showWorkLogModal, setShowWorkLogModal] = useState(false);

    const [loading, setLoading] = useState(false);

    const [reviewLoading, setReviewLoading] = useState(false);

    const [working, setWorking] = useState(

        Number(task.current_working) === 1

    );

    const isAdmin = JSON.parse(

        sessionStorage.getItem("user")

    )?.role === "admin";

    const formatDate = (date) => {

        if (!date) return "No Due Date";

        return new Date(date).toLocaleDateString(

            "en-IN",

            {

                day: "2-digit",

                month: "short",

                year: "numeric"

            }

        );

    };

    async function handleDelete() {

        const confirmDelete = window.confirm(

            `Delete Task #${task.task_number}?`

        );

        if (!confirmDelete) return;

        try {

            setLoading(true);

            await deleteTask(task.id);

            toast.success("Task deleted successfully");

            onClose();

            onUpdated();

        }

        catch (error) {

            console.error(error);

            toast.error("Unable to delete task");

        }

        finally {

            setLoading(false);

        }

    }

    async function handleStartWork() {

        try {

            setLoading(true);

            await startWork(task.id);

            toast.success("Work started");

            setWorking(true);

            onUpdated();

        }

        catch (error) {

            console.error(error);

            toast.error("Unable to start work");

        }

        finally {

            setLoading(false);

        }

    }

    function handleStopWork() {

        setShowWorkLogModal(true);

    }

    async function handleApproveAndClose() {

        try {

            setReviewLoading(true);

            await approveAndCloseTask(task.id);

            toast.success("Task approved and closed");

            onUpdated();

        }

        catch (error) {

            console.error(error);

            toast.error("Unable to approve task");

        }

        finally {

            setReviewLoading(false);

        }

    }

    async function handleSendBack() {

        try {

            setReviewLoading(true);

            await sendBackTask(task.id);

            toast.success("Task sent back to employee");

            onUpdated();

        }

        catch (error) {

            console.error(error);

            toast.error("Unable to send back task");

        }

        finally {

            setReviewLoading(false);

        }

    }

    return (
    <>
    <div className="task-details-overlay">

        <div className="task-details-modal">

            <div className="task-details-header">

                <div>

                    <h2>

                        Task #{task.task_number}

                    </h2>

                    <span>

                        {task.priority}

                    </span>

                </div>

                <button

                    className="task-close-button"

                    onClick={onClose}

                >

                    ✕

                </button>

            </div>

            <div className="task-details-body">

                <div className="task-row">

                    <label>

                        Title

                    </label>

                    <p>

                        {task.task_title}

                    </p>

                </div>

                <div className="task-row">

                    <label>

                        Description

                    </label>

                    <p>

                        {task.task_description}

                    </p>

                </div>

                <div className="task-grid">

                    <div>

                        <label>

                            Assigned To

                        </label>

                        <p>

                            {task.assigned_to_name || "Unassigned"}

                        </p>

                    </div>

                    <div>

                        <label>

                            Created By

                        </label>

                        <p>

                            {task.assigned_by_name || "-"}

                        </p>

                    </div>

                    <div>

                        <label>

                            Status

                        </label>

                        <p>

                            {STATUS_LABELS[task.status] || task.status}

                        </p>

                    </div>

                    <div>

                        <label>

                            Priority

                        </label>

                        <p>

                            {task.priority}

                        </p>

                    </div>

                    <div>

                        <label>

                            Due Date

                        </label>

                        <p>

                            {formatDate(task.due_date)}

                        </p>

                    </div>

                    <div>

                        <label>

                            Estimated Hours

                        </label>

                        <p>

                            {task.estimated_hours || "-"}

                        </p>

                    </div>

                </div>

                <div className="task-progress-section">

                    <label>

                        Progress

                    </label>

                    <div className="progress-bar">

                        <div

                            className="progress-fill"

                            style={{

                                width: `${task.progress || 0}%`

                            }}

                        />

                    </div>

                    <span>

                        {task.progress || 0}% Complete

                    </span>

                </div>

                <div className="task-row">

                    <label>

                        Tags

                    </label>

                    <p>

                        {task.tags || "-"}

                    </p>

                </div>

            </div>

            <div className="task-footer">

                <button

                    className="edit-button"

                    onClick={() => setShowEditModal(true)}

                >

                    ✏ Edit

                </button>

                {

                    working

                    ?

                    <button

                        className="edit-button"

                        onClick={handleStopWork}

                    >

                        ⏹ Stop Work

                    </button>

                    :

                    <button

                        className="edit-button"

                        onClick={handleStartWork}

                        disabled={loading}

                    >

                        {

                            loading

                            ?

                            "Starting..."

                            :

                            "▶ Start Work"

                        }

                    </button>

                }

                <button

                    className="edit-button"

                    onClick={() => setShowTransferModal(true)}

                >

                    🔄 Transfer

                </button>

                {

                    JSON.parse(

                        sessionStorage.getItem("user")

                    )?.role === "admin"

                    &&

                    <button

                        className="delete-button"

                        onClick={handleDelete}

                        disabled={loading}

                    >

                        {

                            loading

                            ?

                            "Deleting..."

                            :

                            "🗑 Delete"

                        }

                    </button>

                }

                {

                    isAdmin && task.status === "pending_review"

                    &&

                    <>

                        <button

                            className="edit-button"

                            onClick={handleApproveAndClose}

                            disabled={reviewLoading}

                        >

                            {

                                reviewLoading

                                ?
                                "Approving..."
                                :
                                "✅ Approve & Close"

                            }

                        </button>

                        <button

                            className="edit-button"

                            onClick={handleSendBack}

                            disabled={reviewLoading}

                        >

                            {

                                reviewLoading

                                ?
                                "Sending Back..."
                                :
                                "↩ Send Back"

                            }

                        </button>

                    </>

                }

            </div>

        </div>

    </div>
                {

                showEditModal &&

                <EditTaskModal

                    task={task}

                    onClose={() => setShowEditModal(false)}

                    onUpdated={() => {

                        setShowEditModal(false);

                        onClose();

                        onUpdated();

                    }}

                />

            }

            {

                showTransferModal &&

                <TransferTaskModal

                    task={task}

                    onClose={() => setShowTransferModal(false)}

                    onTransferred={() => {

                        setShowTransferModal(false);

                        onClose();

                        onUpdated();

                    }}

                />

            }

            {

                showWorkLogModal &&

                <WorkLogModal

                    task={task}

                    onClose={() => setShowWorkLogModal(false)}

                    onSaved={() => {

                        setShowWorkLogModal(false);

                        setWorking(false);

                        onClose();

                        onUpdated();

                    }}

                />

            }

        </>

    );

}

export default TaskDetailsModal;