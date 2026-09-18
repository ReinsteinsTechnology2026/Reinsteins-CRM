import api from "./api";

// ==========================================
// GET EPICS FOR A PROJECT
// ==========================================

export const getEpics = async (projectId) => {

    const { data } = await api.get(
        `/epics/project/${projectId}`
    );

    return data;

};

// ==========================================
// GET ONE EPIC
// ==========================================

export const getEpic = async (id) => {

    const { data } = await api.get(`/epics/${id}`);

    return data;

};

// ==========================================
// CREATE EPIC
// ==========================================

export const createEpic = async (projectId, epicData) => {

    const { data } = await api.post(
        `/epics/project/${projectId}`,
        epicData
    );

    return data;

};

// ==========================================
// UPDATE EPIC
// ==========================================

export const updateEpic = async (id, epicData) => {

    const { data } = await api.put(`/epics/${id}`, epicData);

    return data;

};

// ==========================================
// DELETE EPIC
// ==========================================

export const deleteEpic = async (id) => {

    const { data } = await api.delete(`/epics/${id}`);

    return data;

};

// ==========================================
// RESTORE / PERMANENTLY DELETE (Recycle Bin)
// ==========================================

export const restoreEpic = async (id) => {

    const { data } = await api.patch(`/epics/${id}/restore`);

    return data;

};

export const permanentDeleteEpic = async (id) => {

    const { data } = await api.delete(`/epics/${id}/permanent`);

    return data;

};
