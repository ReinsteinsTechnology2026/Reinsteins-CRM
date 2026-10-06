import api from "./api";

export const getMyHierarchy = async () => {

    const { data } = await api.get("/organization/my-hierarchy");

    return data;

};

export const getOrgChildren = async (employeeId) => {

    const { data } = await api.get(`/organization/chart/${employeeId}/children`);

    return data;

};
