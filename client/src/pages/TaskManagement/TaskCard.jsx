import "./TaskCard.css";

function TaskCard({ task }) {

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

    return (

        <div className="task-card">

            <div className="task-card-header">

                <span className="task-id">

                    Task #{task.task_number}

                </span>

                <span
                    className={`priority ${task.priority?.toLowerCase()}`}
                >
                    {task.priority}
                </span>

            </div>

            <h3>

                {task.task_title}

            </h3>

            <p>

                {task.task_description}

            </p>

            <div className="task-info">

                <div>

                    <label>Assigned To</label>

                    <span>

                        {task.assigned_to_name || "Unassigned"}

                    </span>

                </div>

                <div>

                    <label>Assigned By</label>

                    <span>

                        {task.assigned_by_name || "-"}

                    </span>

                </div>

            </div>

            <div className="task-info">

                <div>

                    <label>Status</label>

                    <span>

                        {task.status}

                    </span>

                </div>

                <div>

                    <label>Due Date</label>

                    <span>

                        {formatDate(task.due_date)}

                    </span>

                </div>

            </div>

            <div className="task-progress">

                <div
                    className="task-progress-bar"
                    style={{
                        width: `${task.progress || 0}%`
                    }}
                />

            </div>

            <small>

                {task.progress || 0}% Complete

            </small>

        </div>

    );

}

export default TaskCard;