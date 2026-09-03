import api from "./api";

// ==========================================
// GET ALL ORGANIZATIONS
// ==========================================

export const getOrganizations = async () => {

    const { data } = await api.get("/organizations");

    return data;

};

// ==========================================
// GET ONE ORGANIZATION
// ==========================================

export const getOrganization = async (id) => {

    const { data } = await api.get(`/organizations/${id}`);

    return data;

};

// ==========================================
// CREATE ORGANIZATION
// ==========================================

export const createOrganization = async (organizationData) => {

    const { data } = await api.post("/organizations", organizationData);

    return data;

};

// ==========================================
// ORGANIZATION MEMBERS (Phase 2B)
// ==========================================

export const getOrganizationMembers = async (organizationId) => {

    const { data } = await api.get(`/organizations/${organizationId}/members`);

    return data;

};

export const getEligibleEmployees = async (organizationId) => {

    const { data } = await api.get(`/organizations/${organizationId}/eligible-employees`);

    return data;

};

export const addOrganizationMember = async (organizationId, userId) => {

    const { data } = await api.post(`/organizations/${organizationId}/members`, { userId });

    return data;

};

export const removeOrganizationMember = async (organizationId, userId) => {

    const { data } = await api.delete(`/organizations/${organizationId}/members/${userId}`);

    return data;

};

// ==========================================
// ORGANIZATION PROJECTS (Phase 2C)
// ==========================================

export const getOrganizationProjects = async (organizationId) => {

    const { data } = await api.get(`/organizations/${organizationId}/projects`);

    return data;

};

export const createOrganizationProject = async (organizationId, projectData) => {

    const { data } = await api.post(`/organizations/${organizationId}/projects`, projectData);

    return data;

};
