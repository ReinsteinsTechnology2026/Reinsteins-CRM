import api from "./api";

export const getMyHierarchy = async () => {

    const { data } = await api.get("/organization/my-hierarchy");

    return data;

};

export const getOrgChildren = async (employeeId) => {

    const { data } = await api.get(`/organization/chart/${employeeId}/children`);

    return data;

};

// Admin Hierarchy page only -- whole company in one call (see
// server/controllers/organizationController.js getOrgChartFullTree).

export const getOrgChartFullTree = async () => {

    const { data } = await api.get("/organization/chart/full-tree");

    return data;

};
