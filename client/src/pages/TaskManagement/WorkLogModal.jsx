import { useState } from "react";

import "./WorkLogModal.css";

import {

    stopWork

} from "../../services/taskWorkService";

import { toast } from "react-toastify";

function WorkLogModal({

    task,

    onClose,

    onSaved

}) {

    const [workDescription, setWorkDescription] = useState("");

    const [progress, setProgress] = useState(task.progress || 0);

    // Deliberately a literal, not task.status -- tasks.status and
    // task_work_logs.status are separate ENUM vocabularies (see
    // taskWorkService.js's WORK_LOG_TO_TASK_STATUS comment), so
    // task.status is never a valid seed value here.
    const [status, setStatus] = useState("In Progress");

    const [loading, setLoading] = useState(false);

    async function handleSave() {

        if (!workDescription.trim()) {

            toast.error("Enter work description");

            return;

        }

        try {

            setLoading(true);

            await stopWork(

                task.id,

                {

                    work_description: workDescription,

                    progress,

                    status

                }

            );

            toast.success("Work log saved successfully");

            onSaved();

        }

        catch (error) {

            console.error(error);

            toast.error("Unable to save work log");

        }

        finally {

            setLoading(false);

        }

    }

    return (

        <div className="worklog-overlay">

            <div className="worklog-modal">

                <div className="worklog-header">

                    <h2>

                        Stop Work

                    </h2>

                    <button onClick={onClose}>

                        ✕

                    </button>

                </div>

                <div className="worklog-body">

                    <div className="form-group">

                        <label>

                            Work Description

                        </label>

                        <textarea

                            rows={6}

                            value={workDescription}

                            onChange={(e)=>setWorkDescription(e.target.value)}

                        />

                    </div>

                    <div className="form-group">

                        <label>

                            Progress %

                        </label>

                        <input

                            type="number"

                            min="0"

                            max="100"

                            value={progress}

                            onChange={(e)=>setProgress(e.target.value)}

                        />

                    </div>

                    <div className="form-group">

                        <label>

                            Status

                        </label>

                        <select

                            value={status}

                            onChange={(e)=>setStatus(e.target.value)}

                        >

                            <option>Assigned</option>

                            <option>In Progress</option>

                            <option>On Hold</option>

                            <option>Review</option>

                        </select>

                        {/* "Completed"/"Closed" are deliberately not
                            offered here -- Stop Work must never let an
                            employee self-close a task. Closing only
                            happens through Submit for Review -> Admin
                            Approve & Close. */}

                    </div>

                </div>

                <div className="worklog-footer">

                    <button

                        onClick={onClose}

                    >

                        Cancel

                    </button>

                    <button

                        onClick={handleSave}

                        disabled={loading}

                    >

                        {

                            loading

                            ?

                            "Saving..."

                            :

                            "Save Work"

                        }

                    </button>

                </div>

            </div>

        </div>

    );

}

export default WorkLogModal;