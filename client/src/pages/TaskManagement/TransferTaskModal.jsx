import { useEffect, useState } from "react";
import "./TransferTaskModal.css";

import {
    getTransferTargets,
    transferTask
} from "../../services/taskManagementService";

import { toast } from "react-toastify";

function TransferTaskModal({

    task,

    onClose,

    onTransferred

}) {

    const [employees, setEmployees] = useState([]);

    const [assignedTo, setAssignedTo] = useState("");

    const [remarks, setRemarks] = useState("");

    const [loading, setLoading] = useState(false);

    useEffect(() => {

        loadEmployees();

    }, []);

    async function loadEmployees() {

        try {

            const response = await getTransferTargets();

            setEmployees(response.employees);

        } catch (error) {

            console.error(error);

        }

    }

    async function handleTransfer() {

        if (!assignedTo) {

            toast.error("Please select an employee");

            return;

        }

        try {

            setLoading(true);

            await transferTask(

                task.id,

                {

                    assigned_to: assignedTo,

                    remarks

                }

            );

            toast.success("Task transferred successfully");

            onTransferred();

        } catch (error) {

            console.error(error);

            toast.error(
                error.response?.data?.message || "Unable to transfer task"
            );

        } finally {

            setLoading(false);

        }

    }

    return (

        <div className="transfer-overlay">

            <div className="transfer-modal">

                <div className="transfer-header">

                    <h2>

                        Transfer Task #{task.task_number}

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

                        <label>

                            Transfer To

                        </label>

                        <select

                            value={assignedTo}

                            onChange={(e)=>setAssignedTo(e.target.value)}

                        >

                            <option value="">

                                Select Employee

                            </option>

                            {

                                employees

                                    .filter(

                                        emp => emp.id !== task.assigned_to

                                    )

                                    .map(employee => (

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

                    <div className="form-group">

                        <label>

                            Remarks

                        </label>

                        <textarea

                            rows="6"

                            placeholder="Example: Backend completed. Continue frontend..."

                            value={remarks}

                            onChange={(e)=>setRemarks(e.target.value)}

                        />

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

                        onClick={handleTransfer}

                        disabled={loading}

                    >

                        {

                            loading

                                ?

                                "Transferring..."

                                :

                                "Transfer Task"

                        }

                    </button>

                </div>

            </div>

        </div>

    );

}

export default TransferTaskModal;