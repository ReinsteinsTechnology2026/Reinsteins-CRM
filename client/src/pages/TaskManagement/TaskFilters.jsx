import "./TaskFilters.css";

function TaskFilters() {

    return (

        <div className="task-filters">

            <button className="active">
                All Tasks
            </button>

            <button>
                My Tasks
            </button>

            <button>
                Assigned By Me
            </button>

            <button>
                Completed
            </button>

            <button>
                Overdue
            </button>

            <input
                type="text"
                placeholder="Search task..."
            />

        </div>

    );

}

export default TaskFilters;