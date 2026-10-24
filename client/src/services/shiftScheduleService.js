import api from "./api";

// ==========================================
// SHIFT SCHEDULE SERVICE (Phase 17b)
// Mirrors the plain named-export, `const { data } = await api.<verb>(...)`
// convention already used by taskActivityService.js.
// ==========================================

export const getShifts = async (startDate, endDate, extraParams = {}) => {
    const { data } = await api.get("/shifts", { params: { startDate, endDate, ...extraParams } });
    return data;
};

export const searchShiftEmployees = async (q, date) => {
    const { data } = await api.get("/shifts/search", { params: { q, date } });
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

// Excel report (Admin/Super Admin only; the server picks the dates).
// Resolves to { blob, filename }; the filename is the server's, with a
// matching fallback if the header is not readable.
export const exportShiftReport = async (period, employee = "all") => {
    const response = await api.get("/shifts/report/export", {
        params: { period, employee },
        responseType: "blob",
    });
    const disposition = response.headers?.["content-disposition"] || "";
    const match = /filename="?([^";]+)"?/i.exec(disposition);

    return { blob: response.data, filename: match ? match[1] : "Employee_Shift_Report.xlsx" };
};
