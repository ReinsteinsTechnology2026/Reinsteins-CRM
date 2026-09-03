import React, { useEffect, useState } from "react";
import "./TaskDashboard.css";

import TaskFilters from "./TaskFilters";
import TaskCard from "./TaskCard";
import CreateTaskModal from "./CreateTaskModal";
import TaskDetailsModal from "./TaskDetailsModal";
import EmployeeTasks from "../Employee/EmployeeTasks";
import {
    getTasks
} from "../../services/taskManagementService";

function TaskDashboard() {
    console.log("TaskDashboard component loaded");

    const [showCreateModal, setShowCreateModal] = useState(false);

    const [selectedTask, setSelectedTask] = useState(null);

    const [tasks, setTasks] = useState([]);

    const [role, setRole] = useState("");

    const [userId, setUserId] = useState(0);
    const [activeTab, setActiveTab] = useState("management");

    // ==========================================
    // FILTER TASKS
    // ==========================================

    const assignedTasks = tasks.filter(

        task => Number(task.assigned_to) === Number(userId)

    );

    const createdTasks = tasks.filter(

        task => Number(task.assigned_by) === Number(userId)

    );

    // ==========================================
    // LOAD TASKS
    // ==========================================

    async function loadTasks() {

        try {

            const response = await getTasks();

            setTasks(response.tasks);

            setRole(response.role);

            setUserId(response.userId);

        } catch (error) {

            console.error(error);

        }

    }

    useEffect(() => {

        loadTasks();

    }, []);

    return (

        <div className="task-dashboard">

            <div className="task-dashboard-header">

                <div>

                    <h1 style={{ color: "#1E293B" }}>
  Task Management
</h1>

                 <p style={{ color: "#64748B" }}>
  Reinsteins WorkHub Task Management
</p>
                </div>

                <button

                    className="task-create-button"

                    onClick={() => setShowCreateModal(true)}

                >

                    + New Task

                </button>

            </div>

            {

                role === "admin"

                    ?

                    <h3>

                        All Company Tasks

                    </h3>

                    :

                    <h3>

                        My Task Management

                    </h3>

            }

           <div className="task-filter-buttons">

<button
    className={activeTab === "management" ? "active" : ""}
    onClick={() => setActiveTab("management")}
>
    Task Management
</button>

    {role !== "admin" && (
        <button
            className={activeTab === "my" ? "active" : ""}
            onClick={() => setActiveTab("my")}
        >
            My Tasks
        </button>
    )}

</div>

         {
    role === "admin" ? (

        <div className="task-list">

            {tasks.length === 0 ? (

                <div className="task-empty">
                    <h2>No Tasks Found</h2>
                    <p>
                        Click <b>+ New Task</b> to create your first task.
                    </p>
                </div>

            ) : (

                tasks.map(task => (

                    <div
                        key={task.id}
                        onClick={() => setSelectedTask(task)}
                        style={{ cursor: "pointer" }}
                    >
                        <TaskCard task={task} />
                    </div>

                ))

            )}

        </div>

    ) : (

  activeTab === "management" ? (

    <>

        <h2 className="task-section-title">
            📥 Assigned To Me
        </h2>

        <div className="task-list">

            {assignedTasks.length === 0 ? (

                <div className="task-empty">
                    <h2>No Assigned Tasks</h2>
                </div>

            ) : (

                assignedTasks.map(task => (

                    <div
                        key={task.id}
                        onClick={() => setSelectedTask(task)}
                        style={{ cursor: "pointer" }}
                    >
                        <TaskCard task={task} />
                    </div>

                ))

            )}

        </div>

        <h2 className="task-section-title">
            📤 Created By Me
        </h2>

        <div className="task-list">

            {createdTasks.length === 0 ? (

                <div className="task-empty">
                    <h2>No Created Tasks</h2>
                </div>

            ) : (

                createdTasks.map(task => (

                    <div
                        key={task.id}
                        onClick={() => setSelectedTask(task)}
                        style={{ cursor: "pointer" }}
                    >
                        <TaskCard task={task} />
                    </div>

                ))

            )}

        </div>

    </>

) : (

    <EmployeeTasks
        tasks={assignedTasks}
        onTaskUpdated={loadTasks}
    />

)
    )
}

            {

                showCreateModal &&

                <CreateTaskModal

                    onClose={() => {

                        setShowCreateModal(false);

                        loadTasks();

                    }}

                />

            }

            {

                selectedTask &&

                <TaskDetailsModal

                    task={selectedTask}

                    onClose={() => setSelectedTask(null)}

                    onUpdated={async () => {

                        await loadTasks();

                        const response = await getTasks();

                        const updatedTask = response.tasks.find(

                            t => t.id === selectedTask.id

                        );

                        setSelectedTask(updatedTask);

                    }}

                />

            }

        </div>

    );

}

export default TaskDashboard;