import api from "./api";

// ==========================================
// SOP SERVICE (Phase 17c)
// Mirrors the plain named-export, `const { data } = await api.<verb>(...)`
// convention already used by taskActivityService.js/shiftScheduleService.js.
// ==========================================

export const getSops = async () => {
    const { data } = await api.get("/sops");
    return data;
};

export const uploadSop = async (title, file) => {
    const formData = new FormData();
    formData.append("title", title);
    formData.append("sopFile", file);

    // Explicit multipart override required for the shared `api`
    // instance's default "Content-Type: application/json" header --
    // same fix/convention already applied to every other FormData
    // upload in this codebase (EmployeeProfile.jsx, Chat.jsx,
    // meetingService.js, taskActivityService.js).
    const { data } = await api.post("/sops", formData, {
        headers: { "Content-Type": "multipart/form-data" },
    });
    return data;
};

export const deleteSop = async (id) => {
    const { data } = await api.delete(`/sops/${id}`);
    return data;
};
