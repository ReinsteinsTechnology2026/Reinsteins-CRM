import api from "./api";

// ==========================================
// START WORK
// ==========================================

export const startWork = async (taskId) => {

    const { data } = await api.put(

        `/task-work/start/${taskId}`

    );

    return data;

};

// ==========================================
// STOP WORK
// ==========================================

export const stopWork = async (

    taskId,

    workData

) => {

    const { data } = await api.put(

        `/task-work/stop/${taskId}`,

        workData

    );

    return data;

};