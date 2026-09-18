import api from "./api";

// ==========================================
// GET PROJECT RECYCLE BIN
// { epics, features, userStories, tasks, sprints } -- every
// soft-deleted item within this project.
// ==========================================

export const getRecycleBin = async (projectId) => {

    const { data } = await api.get(
        `/projects/${projectId}/recycle-bin`
    );

    return data;

};

// ==========================================
// RESTORE ALL (a cascade-deleted group)
// Restores every Epic/Feature/User Story/Task that shares the given
// batchId -- exactly the set that was moved to the Recycle Bin
// together by one cascading soft delete. Never touches an item
// deleted independently, even if it shares the same parent.
// ==========================================

export const restoreRecycleBinBatch = async (projectId, batchId) => {

    const { data } = await api.post(
        `/projects/${projectId}/recycle-bin/restore-batch`,
        { batchId }
    );

    return data;

};
