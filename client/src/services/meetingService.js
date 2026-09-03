import api from "./api";

// ==========================================
// MEETING CRUD
// ==========================================

export const getMeetings = async () => {
    const { data } = await api.get("/meetings");
    return data;
};

export const getMeetingStats = async () => {
    const { data } = await api.get("/meetings/stats");
    return data;
};

export const getMeeting = async (id) => {
    const { data } = await api.get(`/meetings/${id}`);
    return data;
};

export const createMeeting = async (payload) => {
    const { data } = await api.post("/meetings", payload);
    return data;
};

export const updateMeeting = async (id, payload) => {
    const { data } = await api.put(`/meetings/${id}`, payload);
    return data;
};

export const startMeeting = async (id) => {
    const { data } = await api.post(`/meetings/${id}/start`);
    return data;
};

export const endMeeting = async (id) => {
    const { data } = await api.post(`/meetings/${id}/end`);
    return data;
};

export const resumeMeeting = async (id) => {
    const { data } = await api.post(`/meetings/${id}/resume`);
    return data;
};

export const cancelMeeting = async (id) => {
    const { data } = await api.post(`/meetings/${id}/cancel`);
    return data;
};

export const leaveMeeting = async (id) => {
    const { data } = await api.post(`/meetings/${id}/leave`);
    return data;
};

export const setMeetingLock = async (id, isLocked) => {
    const { data } = await api.put(`/meetings/${id}/lock`, { isLocked });
    return data;
};

// ==========================================
// JOIN MEETING (by code + optional password)
// ==========================================

export const joinMeeting = async (meetingCode, password) => {
    const { data } = await api.post("/meetings/join", { meetingCode, password });
    return data;
};

// ==========================================
// PARTICIPANTS
// ==========================================

export const getParticipants = async (id) => {
    const { data } = await api.get(`/meetings/${id}/participants`);
    return data;
};

export const admitParticipant = async (id, userId) => {
    const { data } = await api.put(`/meetings/${id}/participants/${userId}/admit`);
    return data;
};

export const rejectParticipant = async (id, userId) => {
    const { data } = await api.put(`/meetings/${id}/participants/${userId}/reject`);
    return data;
};

export const removeParticipant = async (id, userId) => {
    const { data } = await api.put(`/meetings/${id}/participants/${userId}/remove`);
    return data;
};

export const changeParticipantRole = async (id, userId, role) => {
    const { data } = await api.put(`/meetings/${id}/participants/${userId}/role`, { role });
    return data;
};

// ==========================================
// PARTICIPANT PICKER + AVAILABILITY
// ==========================================

export const searchMeetingParticipants = async (q) => {
    const { data } = await api.get("/meetings/participants/search", { params: { q } });
    return data;
};

export const getMeetingAvailability = async ({ userIds, date, startTime, endTime }) => {
    const { data } = await api.get("/meetings/availability", {
        params: { userIds: userIds.join(","), date, startTime, endTime },
    });
    return data;
};

// ==========================================
// MEETING CHAT
// ==========================================

export const getMeetingMessages = async (id) => {
    const { data } = await api.get(`/meetings/${id}/messages`);
    return data;
};

export const sendMeetingMessage = async (id, message) => {
    const { data } = await api.post(`/meetings/${id}/messages`, { message });
    return data;
};

export const sendMeetingAttachment = async (id, file) => {

    const formData = new FormData();
    formData.append("file", file);

    const { data } = await api.post(`/meetings/${id}/messages/attachment`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
    });

    return data;

};

// ==========================================
// MEETING LINK HELPERS
// ==========================================

export const buildMeetingLink = (meetingCode) =>
    `${window.location.origin}/meeting/${meetingCode}`;

// Accepts either a bare meeting code (WH-XXX-XXX-XXX)
// or a full pasted link and returns just the code.

export const extractMeetingCode = (value) => {

    if (!value) return "";

    const trimmed = value.trim();

    const linkMatch = trimmed.match(/\/meeting\/([A-Za-z0-9-]+)/);

    if (linkMatch) return linkMatch[1].toUpperCase();

    const codeMatch = trimmed.match(/WH-\d{3}-\d{3}-\d{3}/i);

    if (codeMatch) return codeMatch[0].toUpperCase();

    return trimmed.toUpperCase();

};
