import api from "./api";

// ==========================================
// SHIFT SCHEDULE SERVICE (Phase 17b)
// Mirrors the plain named-export, `const { data } = await api.<verb>(...)`
// convention already used by taskActivityService.js.
// ==========================================

export const getShifts = async (startDate, endDate) => {
    const { data } = await api.get("/shifts", { params: { startDate, endDate } });
    return data;
};

export const createShift = async (shift) => {
    const { data } = await api.post("/shifts", shift);
    return data;
};

export const updateShift = async (id, changes) => {
    const { data } = await api.patch(`/shifts/${id}`, changes);
    return data;
};

export const deleteShift = async (id) => {
    const { data } = await api.delete(`/shifts/${id}`);
    return data;
};

export const bulkSaveShifts = async (shifts) => {
    const { data } = await api.post("/shifts/bulk", { shifts });
    return data;
};
