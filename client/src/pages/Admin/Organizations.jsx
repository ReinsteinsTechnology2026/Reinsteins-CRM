import { useEffect, useState } from "react";

import { useNavigate } from "react-router-dom";

import { FaBuilding, FaPlus, FaArrowRight } from "react-icons/fa";

import { toast } from "react-toastify";

import { getOrganizations } from "../../services/organizationsService";

import CreateOrganizationModal from "./CreateOrganizationModal";

import { ORGANIZATION_STATUS_LABELS, ORGANIZATION_STATUS_CLASS } from "../../utils/workItemStatus";

import "../../styles/workItems.css";
import "./Organizations.css";

// ==========================================
// ORGANIZATIONS (Phase 2A)
//
// The organization-level list, one tier above
// Projects in the approved TechOps -> Organizations
// -> Projects hierarchy. Built on the exact same
// design system as ProjectsList.jsx (same shared
// classes, same card/modal/empty-state pattern) --
// deliberately its own self-contained CSS file rather
// than importing Projects.css directly, since this is
// a standalone top-level admin area, not nested under
// Projects. Member management and project creation
// inside an organization are explicitly out of scope
// for this phase -- see OrganizationDetail.jsx.
// ==========================================

function Organizations() {

    const navigate = useNavigate();

    const [organizations, setOrganizations] = useState([]);

    const [loading, setLoading] = useState(true);

    const [showCreateModal, setShowCreateModal] = useState(false);

    const loadOrganizations = async () => {

        try {

            setLoading(true);

            const response = await getOrganizations();

            setOrganizations(response.organizations || []);

        } catch (error) {

            console.error(error);

            toast.error("Unable to load organizations");

        } finally {

            setLoading(false);

        }

    };

    useEffect(() => {

        loadOrganizations();

    }, []);

    return (

        <div className="wi-page">

            <div className="org-page-header">

                <div>

                    <h1>Organizations</h1>

                    <p>
                        Every organization on WorkHub &mdash; each has its
                        own members and projects, kept completely separate
                        from every other organization.
                    </p>

                </div>

                <button
                    type="button"
                    className="org-primary-button"
                    onClick={() => setShowCreateModal(true)}
                >
                    <FaPlus /> New Organization
                </button>

            </div>

            {loading ? (

                <div className="org-loading">Loading organizations...</div>

            ) : organizations.length === 0 ? (

                <div className="wi-empty-state">
                    <FaBuilding />
                    <h3>No organizations yet</h3>
                    <p>Click <b>+ New Organization</b> to create the first one.</p>
                </div>

            ) : (

                <div className="org-grid">

                    {organizations.map((organization) => (

                        <div
                            key={organization.id}
                            className="org-card"
                            onClick={() => navigate(`/admin/organizations/${organization.id}`)}
                        >

                            <div className="org-card-top">

                                <span
                                    className={
                                        ORGANIZATION_STATUS_CLASS[organization.status] ||
                                        "status-pill status-neutral"
                                    }
                                >
                                    {ORGANIZATION_STATUS_LABELS[organization.status] || organization.status}
                                </span>

                            </div>

                            <h3>{organization.name}</h3>

                            <p className="org-description">
                                {organization.description || "No description provided."}
                            </p>

                            <div className="org-card-footer">

                                <span>{organization.member_count} {organization.member_count === 1 ? "Member" : "Members"}</span>

                                <span>{organization.project_count} {organization.project_count === 1 ? "Project" : "Projects"}</span>

                            </div>

                            <button
                                type="button"
                                className="org-secondary-button org-open-button"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    navigate(`/admin/organizations/${organization.id}`);
                                }}
                            >
                                Open Organization <FaArrowRight />
                            </button>

                        </div>

                    ))}

                </div>

            )}

            {showCreateModal && (

                <CreateOrganizationModal
                    onClose={() => setShowCreateModal(false)}
                    onCreated={() => {
                        setShowCreateModal(false);
                        loadOrganizations();
                    }}
                />

            )}

        </div>

    );

}

export default Organizations;
