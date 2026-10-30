import api from "./api";

// ==========================================
// SMART SHEETS SERVICE (REST)
// Plain named exports returning response.data, like shiftScheduleService.js. Live cell edits do NOT
// use REST: they travel over the shared Socket.IO connection (see utils/smartSheetSync.js).
// ==========================================

export const listSmartSheets = async () => {
    const { data } = await api.get("/smart-sheets");
    return data;
};

export const createSmartSheet = async (name) => {
    const { data } = await api.post("/smart-sheets", { name });
    return data;
};

export const importSmartSheet = async (file, name) => {
    const form = new FormData();
    if (name) form.append("name", name);
    form.append("file", file);
    const { data } = await api.post("/smart-sheets/import", form, {
        headers: { "Content-Type": "multipart/form-data" },
    });
    return data;
};

export const getSmartSheet = async (id) => {
    const { data } = await api.get(`/smart-sheets/${id}`);
    return data;
};

// The latest SAVED state of a spreadsheet (what a refresh or a reconnect shows).
export const getSmartSheetWorkbook = async (id) => {
    const { data } = await api.get(`/smart-sheets/${id}/workbook`);
    return data;
};

export const updateSmartSheet = async (id, changes) => {
    const { data } = await api.patch(`/smart-sheets/${id}`, changes);
    return data;
};

export const deleteSmartSheet = async (id) => {
    const { data } = await api.delete(`/smart-sheets/${id}`);
    return data;
};

export const searchAssignableEmployees = async (q) => {
    const { data } = await api.get("/smart-sheets/assignable-employees", { params: { q } });
    return data;
};

export const listSmartSheetAccess = async (id) => {
    const { data } = await api.get(`/smart-sheets/${id}/access`);
    return data;
};

export const assignSmartSheet = async (id, userIds, permission) => {
    const { data } = await api.put(`/smart-sheets/${id}/access`, { userIds, permission });
    return data;
};

export const unassignSmartSheet = async (id, userId) => {
    const { data } = await api.delete(`/smart-sheets/${id}/access/${userId}`);
    return data;
};

// -> { blob, filename }
export const exportSmartSheet = async (id) => {
    const response = await api.get(`/smart-sheets/${id}/export`, { responseType: "blob" });
    const disposition = response.headers["content-disposition"] || "";
    const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition) || /filename="([^"]+)"/i.exec(disposition);
    const filename = match ? decodeURIComponent(match[1]) : "spreadsheet.xlsx";
    return { blob: response.data, filename };
};

// With responseType "blob" an error body arrives as a Blob; unwrap the server's message.
export async function readServiceError(error, fallback = "Something went wrong") {
    try {
        const data = error?.response?.data;
        if (data instanceof Blob) {
            return JSON.parse(await data.text()).message || fallback;
        }
        return data?.message || fallback;
    } catch {
        return fallback;
    }
}
