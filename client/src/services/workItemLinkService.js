import api from "./api";

// ==========================================
// GET RELATIONSHIPS FOR ONE WORK ITEM
// Returns { blocks, blockedBy, related }
// ==========================================

export const getWorkItemLinks = async (sourceType, sourceId) => {

    const { data } = await api.get(
        `/work-item-links/${sourceType}/${sourceId}`
    );

    return data;

};

// ==========================================
// CREATE RELATIONSHIP
// ==========================================

export const createWorkItemLink = async (linkData) => {

    const { data } = await api.post(
        "/work-item-links",
        linkData
    );

    return data;

};

// ==========================================
// DELETE RELATIONSHIP
// ==========================================

export const deleteWorkItemLink = async (id) => {

    const { data } = await api.delete(
        `/work-item-links/${id}`
    );

    return data;

};
