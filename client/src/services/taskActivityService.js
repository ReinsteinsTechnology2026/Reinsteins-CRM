import api from "./api";

// ==========================================
// GET ACTIVITY FEED FOR A TASK
// ==========================================

export const getTaskActivity = async (taskId) => {

    const { data } = await api.get(`/task-activity/${taskId}`);

    return data;

};

// ==========================================
// POST NEW ACTIVITY ENTRY
// (comment / work update, with optional
// attachments + @mentions)
// ==========================================

export const postTaskActivity = async (taskId, activityData) => {

    const files = activityData.files || [];

    // ==========================================
    // NO ATTACHMENTS -> plain JSON request.
    // The backend already accepts this: multer
    // passes non-multipart requests straight
    // through, and express.json() has already
    // parsed req.body by that point.
    // ==========================================

    if (files.length === 0) {

        const { data } = await api.post(
            `/task-activity/${taskId}`,
            {
                activityType: activityData.activityType || "comment",
                body: activityData.body || undefined,
                progress: activityData.progress,
                mentionedUserIds: activityData.mentionedUserIds || [],
            }
        );

        return data;

    }

    // ==========================================
    // HAS ATTACHMENTS -> multipart/form-data.
    //
    // This axios instance sets a default
    // "Content-Type: application/json" header
    // (see services/api.js). With a plain
    // api.post(url, formData) call, that default
    // wins and the FormData body gets sent as
    // JSON instead of multipart (the File
    // objects serialize to "{}"), so multer
    // never sees any files. Explicitly
    // overriding Content-Type per-request fixes
    // this — the browser still fills in the
    // correct multipart boundary itself, it just
    // needs Content-Type to not already say
    // "application/json". This mirrors the same
    // working pattern already used for chat image
    // uploads (Chat.jsx's uploadImage).
    // ==========================================

    const formData = new FormData();

    formData.append("activityType", activityData.activityType || "comment");

    if (activityData.body) {
        formData.append("body", activityData.body);
    }

    if (activityData.progress !== undefined && activityData.progress !== null) {
        formData.append("progress", activityData.progress);
    }

    if (activityData.mentionedUserIds?.length) {
        formData.append(
            "mentionedUserIds",
            JSON.stringify(activityData.mentionedUserIds)
        );
    }

    files.forEach((file) => {
        formData.append("attachments", file);
    });

    const { data } = await api.post(
        `/task-activity/${taskId}`,
        formData,
        {
            headers: {
                "Content-Type": "multipart/form-data",
            },
        }
    );

    return data;

};

// ==========================================
// EDIT ACTIVITY ENTRY (author only)
// ==========================================

export const editTaskActivity = async (activityId, body) => {

    const { data } = await api.put(
        `/task-activity/activity/${activityId}`,
        { body }
    );

    return data;

};

// ==========================================
// DELETE ACTIVITY ENTRY (author or admin)
// ==========================================

export const deleteTaskActivity = async (activityId) => {

    const { data } = await api.delete(
        `/task-activity/activity/${activityId}`
    );

    return data;

};

// ==========================================
// GET MENTIONABLE USERS
// Reuses the existing chat users endpoint
// (all active users except the current one).
// ==========================================

export const getMentionableUsers = async () => {

    const { data } = await api.get("/chat/users");

    return data;

};
