import api from "./api";

// ==========================================
// PROJECT MEMBERSHIP / SECURITY (Phase 1)
// ==========================================

export const getMyProjectPermissions = async (projectId) => {
    const { data } = await api.get(`/projects/${projectId}/my-permissions`);
    return data;
};

export const getProjectMembers = async (projectId) => {
    const { data } = await api.get(`/projects/${projectId}/members`);
    return data;
};

export const addProjectMembers = async (projectId, userIds, securityGroupId) => {
    const { data } = await api.post(`/projects/${projectId}/members`, { userIds, securityGroupId });
    return data;
};

export const changeProjectMemberGroup = async (projectId, userId, securityGroupId) => {
    const { data } = await api.patch(`/projects/${projectId}/members/${userId}/group`, { securityGroupId });
    return data;
};

export const removeProjectMember = async (projectId, userId) => {
    const { data } = await api.delete(`/projects/${projectId}/members/${userId}`);
    return data;
};

export const getProjectSecurityGroups = async (projectId) => {
    const { data } = await api.get(`/projects/${projectId}/groups`);
    return data;
};

export const getProjectPermissionMatrix = async (projectId) => {
    const { data } = await api.get(`/projects/${projectId}/permissions`);
    return data;
};

export const updateProjectPermission = async (projectId, securityGroupId, permissionKey, value) => {
    const { data } = await api.patch(`/projects/${projectId}/permissions`, { securityGroupId, permissionKey, value });
    return data;
};

export const getProjectActivityLog = async (projectId) => {
    const { data } = await api.get(`/projects/${projectId}/activity`);
    return data;
};
