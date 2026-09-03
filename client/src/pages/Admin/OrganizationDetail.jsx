import { useEffect, useState } from "react";

import { useNavigate, useParams } from "react-router-dom";

import { FaArrowLeft, FaUsers, FaProjectDiagram, FaPlus, FaTrash, FaArrowRight } from "react-icons/fa";

import { toast } from "react-toastify";

import {
    getOrganization,
    getOrganizationMembers,
    removeOrganizationMember,
    getOrganizationProjects,
} from "../../services/organizationsService";

import AddOrganizationMemberModal from "./AddOrganizationMemberModal";

import CreateProjectModal from "../Projects/CreateProjectModal";

import {
    ORGANIZATION_STATUS_LABELS, ORGANIZATION_STATUS_CLASS,
    PROJECT_STATUS_LABELS, PROJECT_STATUS_CLASS,
    formatDate,
} from "../../utils/workItemStatus";

import "../../styles/workItems.css";
import "./Organizations.css";

// ==========================================
// ORGANIZATION DETAIL (Phase 2A + 2B + 2C)
//
// Phase 2A: name/description/status header.
// Phase 2B: real Members management (view/add/
// remove).
// Phase 2C: real Projects section (view/create),
// organization-scoped via GET/POST
// /organizations/:id/projects -- organization_id is
// always the route's :id, resolved server-side, never
// trusted from the client. Opening a project reuses
// the existing ProjectWorkspace route/component
// unchanged.
// ==========================================

function OrganizationDetail() {

    const { id } = useParams();
    const navigate = useNavigate();

    const [organization, setOrganization] = useState(null);
    const [members, setMembers] = useState([]);
    const [projects, setProjects] = useState([]);
    const [loading, setLoading] = useState(true);
    const [membersLoading, setMembersLoading] = useState(true);
    const [projectsLoading, setProjectsLoading] = useState(true);
    const [accessDenied, setAccessDenied] = useState(false);
    const [showAddModal, setShowAddModal] = useState(false);
    const [showCreateProjectModal, setShowCreateProjectModal] = useState(false);

    useEffect(() => {

        loadOrganization();
        loadMembers();
        loadProjects();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    async function loadOrganization() {

        try {

            setLoading(true);

            const response = await getOrganization(id);

            setOrganization(response.organization);

        } catch (error) {

            console.error(error);

            const status = error.response?.status;

            if (status === 403 || status === 401 || status === 404) {
                setAccessDenied(true);
            } else {
                toast.error(error.response?.data?.message || "Unable to load this organization");
            }

        } finally {

            setLoading(false);

        }

    }

    async function loadMembers() {

        try {

            setMembersLoading(true);

            const response = await getOrganizationMembers(id);

            setMembers(response.members || []);

        } catch (error) {

            console.error(error);

        } finally {

            setMembersLoading(false);

        }

    }

    async function loadProjects() {

        try {

            setProjectsLoading(true);

            const response = await getOrganizationProjects(id);

            setProjects(response.projects || []);

        } catch (error) {

            console.error(error);

        } finally {

            setProjectsLoading(false);

        }

    }

    async function refreshAll() {
        await Promise.all([loadOrganization(), loadMembers(), loadProjects()]);
    }

    async function handleRemoveMember(userId, name) {

        const confirmed = window.confirm(
            `Remove ${name} from this organization? Their project memberships in this organization's projects will also be removed. This cannot be undone.`
        );

        if (!confirmed) return;

        try {

            await removeOrganizationMember(id, userId);

            toast.success("Member removed from the organization");

            await refreshAll();

        } catch (error) {

            console.error(error);

            toast.error(error.response?.data?.message || "Unable to remove member");

        }

    }

    if (loading) {
        return <div className="wi-page"><div className="org-loading">Loading organization...</div></div>;
    }

    if (accessDenied || !organization) {
        return (
            <div className="wi-page">
                <div className="wi-empty-state">
                    <h3>Organization not found</h3>
                    <p>It may not exist, or you may not have access to it.</p>
                </div>
            </div>
        );
    }

    return (

        <div className="wi-page">

            <div className="wi-breadcrumb">
                <button type="button" onClick={() => navigate("/admin/organizations")}>
                    <FaArrowLeft /> Organizations
                </button>
            </div>

            <div className="org-detail-header">

                <div className="org-detail-header-top">

                    <h1>{organization.name}</h1>

                    <span
                        className={
                            ORGANIZATION_STATUS_CLASS[organization.status] ||
                            "status-pill status-neutral"
                        }
                    >
                        {ORGANIZATION_STATUS_LABELS[organization.status] || organization.status}
                    </span>

                </div>

                <p className="org-detail-description">
                    {organization.description || "No description provided."}
                </p>

                <div className="org-detail-meta">

                    <div>
                        <label>Created By</label>
                        <span>{organization.created_by_name || "--"}</span>
                    </div>

                    <div>
                        <label>Created</label>
                        <span>{formatDate(organization.created_at)}</span>
                    </div>

                </div>

            </div>

            <div className="org-section-card">

                <div className="org-section-header">
                    <h2><FaUsers /> Members ({organization.member_count})</h2>
                    <button type="button" className="org-primary-button" onClick={() => setShowAddModal(true)}>
                        <FaPlus /> Add Member
                    </button>
                </div>

                {membersLoading ? (
                    <div className="org-empty-cell">Loading members...</div>
                ) : members.length === 0 ? (
                    <div className="org-empty-cell">No members yet. Click <b>+ Add Member</b> to add the first one.</div>
                ) : (
                    <div className="org-table-wrap">
                        <table className="org-table">
                            <thead>
                                <tr>
                                    <th>Name</th>
                                    <th>Email</th>
                                    <th>Department</th>
                                    <th>Designation</th>
                                    <th>Status</th>
                                    <th>Added Date</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {members.map((member) => (
                                    <tr key={member.id}>
                                        <td className="org-table-name">{member.full_name}</td>
                                        <td className="org-table-muted">{member.email || "--"}</td>
                                        <td className="org-table-muted">{member.department_name || "--"}</td>
                                        <td className="org-table-muted">{member.designation || "--"}</td>
                                        <td>
                                            <span className={member.employment_status === "active" ? "status-pill status-in-progress" : "status-pill status-neutral"}>
                                                {member.employment_status === "active" ? "Active" : member.employment_status}
                                            </span>
                                        </td>
                                        <td className="org-table-muted">{formatDate(member.created_at)}</td>
                                        <td>
                                            <button
                                                type="button"
                                                className="org-icon-button org-danger"
                                                title="Remove"
                                                onClick={() => handleRemoveMember(member.user_id, member.full_name)}
                                            >
                                                <FaTrash />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

            </div>

            <div className="org-section-card">

                <div className="org-section-header">
                    <h2><FaProjectDiagram /> Projects ({organization.project_count})</h2>
                    <button type="button" className="org-primary-button" onClick={() => setShowCreateProjectModal(true)}>
                        <FaPlus /> Create Project
                    </button>
                </div>

                {projectsLoading ? (
                    <div className="org-empty-cell">Loading projects...</div>
                ) : projects.length === 0 ? (
                    <div className="org-empty-cell">No projects yet. Click <b>+ Create Project</b> to add the first one.</div>
                ) : (
                    <div className="org-grid">

                        {projects.map((proj) => (

                            <div
                                key={proj.id}
                                className="org-card"
                                onClick={() => navigate(`/admin/projects/${proj.id}`)}
                            >

                                <div className="org-card-top">
                                    <span className="org-code">PR-{String(proj.id).padStart(3, "0")}</span>
                                    <span
                                        className={
                                            PROJECT_STATUS_CLASS[proj.status] ||
                                            "status-pill status-neutral"
                                        }
                                    >
                                        {PROJECT_STATUS_LABELS[proj.status] || proj.status}
                                    </span>
                                </div>

                                <h3>{proj.name}</h3>

                                <p className="org-description">
                                    {proj.description || "No description provided."}
                                </p>

                                <div className="org-card-footer">
                                    <span>{proj.member_count} {proj.member_count === 1 ? "Member" : "Members"}</span>
                                    <span>Created {formatDate(proj.created_at)}</span>
                                </div>

                                <button
                                    type="button"
                                    className="org-secondary-button org-open-button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        navigate(`/admin/projects/${proj.id}`);
                                    }}
                                >
                                    Open Project <FaArrowRight />
                                </button>

                            </div>

                        ))}

                    </div>
                )}

            </div>

            {showAddModal && (
                <AddOrganizationMemberModal
                    organizationId={id}
                    onClose={() => setShowAddModal(false)}
                    onAdded={() => {
                        setShowAddModal(false);
                        refreshAll();
                    }}
                />
            )}

            {showCreateProjectModal && (
                <CreateProjectModal
                    organizationId={id}
                    onClose={() => setShowCreateProjectModal(false)}
                    onCreated={() => {
                        setShowCreateProjectModal(false);
                        refreshAll();
                    }}
                />
            )}

        </div>

    );

}

export default OrganizationDetail;
