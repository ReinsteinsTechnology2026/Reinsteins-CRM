import api from "./api";

// ==========================================
// GET ACTIVE SPRINTS ACROSS ALL MY PROJECTS
// (dashboard widget)
// ==========================================

export const getMyActiveSprints = async () => {

    const { data } = await api.get("/sprints/active");

    return data;

};

// ==========================================
// GET SPRINTS FOR A PROJECT
// ==========================================

export const getSprints = async (projectId) => {

    const { data } = await api.get(
        `/sprints/project/${projectId}`
    );

    return data;

};

// ==========================================
// GET ONE SPRINT (with its tasks)
// ==========================================

export const getSprint = async (id) => {

    const { data } = await api.get(`/sprints/${id}`);

    return data;

};

// ==========================================
// CREATE SPRINT
// ==========================================

export const createSprint = async (projectId, sprintData) => {

    const { data } = await api.post(
        `/sprints/project/${projectId}`,
        sprintData
    );

    return data;

};

// ==========================================
// UPDATE SPRINT
// ==========================================

export const updateSprint = async (id, sprintData) => {

    const { data } = await api.put(`/sprints/${id}`, sprintData);

    return data;

};

// ==========================================
// START SPRINT
// ==========================================

export const startSprint = async (id) => {

    const { data } = await api.patch(`/sprints/${id}/start`);

    return data;

};

// ==========================================
// COMPLETE SPRINT
// ==========================================

export const completeSprint = async (id) => {

    const { data } = await api.patch(`/sprints/${id}/complete`);

    return data;

};

// ==========================================
// DELETE SPRINT
// ==========================================

export const deleteSprint = async (id) => {

    const { data } = await api.delete(`/sprints/${id}`);

    return data;

};

// ==========================================
// GET SPRINT ANALYTICS (read-only)
// ==========================================

export const getSprintAnalytics = async (id) => {

    const { data } = await api.get(`/sprints/${id}/analytics`);

    return data;

};
