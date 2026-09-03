import api from "./api";

// ==========================================
// GET ALL PROJECTS
// ==========================================

export const getProjects = async () => {

    const { data } = await api.get("/projects");

    return data;

};

// ==========================================
// GET ONE PROJECT
// ==========================================

export const getProject = async (id) => {

    const { data } = await api.get(`/projects/${id}`);

    return data;

};

// ==========================================
// GET ALL TASKS FOR A PROJECT (Kanban)
// ==========================================

export const getProjectTasks = async (id) => {

    const { data } = await api.get(`/projects/${id}/tasks`);

    return data;

};

// ==========================================
// CREATE PROJECT
// ==========================================

export const createProject = async (projectData) => {

    const { data } = await api.post("/projects", projectData);

    return data;

};

// ==========================================
// UPDATE PROJECT
// ==========================================

export const updateProject = async (id, projectData) => {

    const { data } = await api.put(`/projects/${id}`, projectData);

    return data;

};

// ==========================================
// DELETE PROJECT
// ==========================================

export const deleteProject = async (id) => {

    const { data } = await api.delete(`/projects/${id}`);

    return data;

};
