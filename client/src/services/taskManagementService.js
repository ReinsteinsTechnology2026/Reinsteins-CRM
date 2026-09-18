import api from "./api";

// ==========================================
// GET EMPLOYEES
// ==========================================

export const getEmployees = async (projectId) => {

    const { data } = await api.get(
        projectId
            ? `/task-management/employees?project_id=${projectId}`
            : "/task-management/employees"
    );

    return data;

};

// ==========================================
// GET TASKS
// ==========================================

export const getTasks = async () => {

    const { data } = await api.get(
        "/task-management/tasks"
    );

    return data;

};

// ==========================================
// GET ONE TASK
// ==========================================

export const getTaskById = async (id) => {

    const { data } = await api.get(
        `/task-management/task/${id}`
    );

    return data;

};

// ==========================================
// CREATE TASK
// ==========================================

export const createTask = async (taskData) => {

    const { data } = await api.post(
        "/task-management/create",
        taskData
    );

    return data;

};

// ==========================================
// UPDATE TASK
// ==========================================

export const updateTask = async (id, taskData) => {

    const { data } = await api.put(
        `/task-management/update/${id}`,
        taskData
    );

    return data;

};

// ==========================================
// UPDATE TASK STATUS ONLY (Kanban move)
// ==========================================

export const changeTaskStatus = async (id, status) => {

    const { data } = await api.patch(
        `/task-management/${id}/status`,
        { status }
    );

    return data;

};

// ==========================================
// ASSIGN TASK TO SPRINT (or back to Backlog)
// ==========================================

export const assignTaskToSprint = async (id, sprintId) => {

    const { data } = await api.patch(
        `/task-management/${id}/sprint`,
        { sprint_id: sprintId }
    );

    return data;

};

// ==========================================
// DELETE TASK
// ==========================================
// ==========================================
// TRANSFER TASK
// ==========================================

export const transferTask = async (

    id,

    data

) => {

    const { data: response } = await api.put(

        `/task-management/transfer/${id}`,

        data

    );

    return response;

};

// ==========================================
// ASSIGN / REASSIGN TASK (project-linked tasks only —
// separate from transferTask above)
// ==========================================

export const assignTask = async (id, data) => {

    const { data: response } = await api.put(
        `/task-management/assign/${id}`,
        data
    );

    return response;

};
export const deleteTask = async (id) => {

    const { data } = await api.delete(
        `/task-management/delete/${id}`
    );

    return data;

};

// ==========================================
// RESTORE / PERMANENTLY DELETE (Recycle Bin --
// project-linked tasks only)
// ==========================================

export const restoreTask = async (id) => {

    const { data } = await api.patch(
        `/task-management/${id}/restore`
    );

    return data;

};

export const permanentDeleteTask = async (id) => {

    const { data } = await api.delete(
        `/task-management/${id}/permanent`
    );

    return data;

};

// ==========================================
// CREATE TASK DIRECTLY UNDER A PROJECT
// User Story is optional -- a task doesn't have to go through a
// User Story.
// ==========================================

export const createProjectTask = async (projectId, taskData) => {

    const { data } = await api.post(
        `/projects/${projectId}/tasks`,
        taskData
    );

    return data;

};

// ==========================================
// TRANSFER TARGETS
// Every active Employee/Intern, unscoped — used
// only by the Transfer modal. Task CREATION
// assignment keeps using getEmployees() above,
// which stays scope-limited, unchanged.
// ==========================================

export const getTransferTargets = async () => {

    const { data } = await api.get(
        "/task-management/transfer-targets"
    );

    return data;

};

// ==========================================
// APPROVE & CLOSE TASK
// ==========================================

export const approveAndCloseTask = async (id) => {

    const { data } = await api.put(
        `/task-management/approve/${id}`
    );

    return data;

};

// ==========================================
// SEND TASK BACK
// ==========================================

export const sendBackTask = async (id) => {

    const { data } = await api.put(
        `/task-management/send-back/${id}`
    );

    return data;

};