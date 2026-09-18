import api from "./api";

// ==========================================
// GET USER STORIES FOR A PROJECT
// ==========================================

export const getUserStories = async (projectId) => {

    const { data } = await api.get(
        `/user-stories/project/${projectId}`
    );

    return data;

};

// ==========================================
// GET ONE USER STORY (with its tasks)
// ==========================================

export const getUserStory = async (id) => {

    const { data } = await api.get(`/user-stories/${id}`);

    return data;

};

// ==========================================
// CREATE USER STORY
// ==========================================

export const createUserStory = async (projectId, storyData) => {

    const { data } = await api.post(
        `/user-stories/project/${projectId}`,
        storyData
    );

    return data;

};

// ==========================================
// UPDATE USER STORY
// ==========================================

export const updateUserStory = async (id, storyData) => {

    const { data } = await api.put(`/user-stories/${id}`, storyData);

    return data;

};

// ==========================================
// DELETE USER STORY
// ==========================================

export const deleteUserStory = async (id) => {

    const { data } = await api.delete(`/user-stories/${id}`);

    return data;

};

// ==========================================
// RESTORE / PERMANENTLY DELETE (Recycle Bin)
// ==========================================

export const restoreUserStory = async (id) => {

    const { data } = await api.patch(`/user-stories/${id}/restore`);

    return data;

};

export const permanentDeleteUserStory = async (id) => {

    const { data } = await api.delete(`/user-stories/${id}/permanent`);

    return data;

};

// ==========================================
// ASSIGN USER STORY TO SPRINT (or back to Backlog)
// sprintId === null clears the story back to the Backlog.
// ==========================================

export const assignUserStoryToSprint = async (id, sprintId) => {

    const { data } = await api.patch(`/user-stories/${id}/sprint`, {
        sprint_id: sprintId
    });

    return data;

};

// ==========================================
// CREATE TASK UNDER A USER STORY
// ==========================================

export const createTaskInStory = async (storyId, taskData) => {

    const { data } = await api.post(
        `/user-stories/${storyId}/tasks`,
        taskData
    );

    return data;

};
