import api from "./api";

// ==========================================
// GET FEATURES FOR A PROJECT
// ==========================================

export const getFeatures = async (projectId) => {

    const { data } = await api.get(
        `/features/project/${projectId}`
    );

    return data;

};

// ==========================================
// GET ONE FEATURE
// ==========================================

export const getFeature = async (id) => {

    const { data } = await api.get(`/features/${id}`);

    return data;

};

// ==========================================
// CREATE FEATURE
// ==========================================

export const createFeature = async (projectId, featureData) => {

    const { data } = await api.post(
        `/features/project/${projectId}`,
        featureData
    );

    return data;

};

// ==========================================
// UPDATE FEATURE
// ==========================================

export const updateFeature = async (id, featureData) => {

    const { data } = await api.put(`/features/${id}`, featureData);

    return data;

};

// ==========================================
// DELETE FEATURE
// ==========================================

export const deleteFeature = async (id) => {

    const { data } = await api.delete(`/features/${id}`);

    return data;

};
