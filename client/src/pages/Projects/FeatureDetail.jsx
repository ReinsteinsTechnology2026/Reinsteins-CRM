import { useEffect, useState } from "react";

import { useLocation, useNavigate, useParams } from "react-router-dom";

import { FaArrowLeft, FaPen } from "react-icons/fa";

import { getFeature } from "../../services/featureService";

import { getEpics } from "../../services/epicService";

import { getUserStories } from "../../services/userStoryService";

import { getMyProjectPermissions } from "../../services/projectMemberService";

import CreateFeatureModal from "./CreateFeatureModal";

import {
    STORY_STATUS_LABELS,
    STORY_STATUS_CLASS,
    PRIORITY_CLASS,
    formatDate,
    formatDateTime,
} from "../../utils/workItemStatus";

import { getPortalBasePath } from "../../utils/portalBasePath";

import "../../styles/workItems.css";
import "./Projects.css";

function FeatureDetail() {

    const { id } = useParams();

    const navigate = useNavigate();

    const location = useLocation();

    const basePath = getPortalBasePath(location.pathname);

    const [feature, setFeature] = useState(null);

    const [epics, setEpics] = useState([]);

    const [stories, setStories] = useState([]);

    const [canEdit, setCanEdit] = useState(false);

    const [loading, setLoading] = useState(true);

    const [notFound, setNotFound] = useState(false);

    const [loadError, setLoadError] = useState("");

    const [showEditModal, setShowEditModal] = useState(false);

    const loadData = async () => {

        try {

            setLoading(true);

            setNotFound(false);

            setLoadError("");

            const featureResponse = await getFeature(id);

            const current = featureResponse.feature;

            setFeature(current);

            const [epicsResult, storiesResult, permissionsResult] = await Promise.allSettled([
                getEpics(current.project_id),
                getUserStories(current.project_id),
                getMyProjectPermissions(current.project_id),
            ]);

            setEpics(epicsResult.status === "fulfilled" ? epicsResult.value.epics || [] : []);

            setStories(
                storiesResult.status === "fulfilled"
                    ? (storiesResult.value.userStories || []).filter(
                        (story) => String(story.feature_id) === String(current.id)
                    )
                    : []
            );

            if (epicsResult.status === "rejected" || storiesResult.status === "rejected") {
                setLoadError("Some related epics or user stories could not be loaded.");
            }

            setCanEdit(
                permissionsResult.status === "fulfilled" &&
                Boolean(permissionsResult.value.permissions?.FEATURE_EDIT)
            );

        } catch (error) {

            console.error(error);

            if (error.response?.status === 404) {
                setNotFound(true);
            } else {
                setLoadError(error.response?.data?.message || "Unable to load feature");
            }

        } finally {

            setLoading(false);

        }

    };

    useEffect(() => {

        loadData();

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    if (loading) {
        return <div className="wi-loading">Loading feature...</div>;
    }

    if (notFound || !feature) {
        return (
            <div className="wi-empty-state">
                <h3>Feature not found</h3>
                <p>{loadError || "This feature may have been deleted or you no longer have access to it."}</p>
                <button type="button" className="wi-secondary-button" onClick={() => navigate(-1)}>
                    <FaArrowLeft /> Go back
                </button>
            </div>
        );
    }

    return (

        <div className="wi-page">

            <div className="wi-breadcrumb">
                <button
                    type="button"
                    onClick={() => navigate(`${basePath}/projects/${feature.project_id}`)}
                >
                    <FaArrowLeft /> {feature.project_name}
                </button>
                {feature.epic_id && (
                    <button
                        type="button"
                        onClick={() => navigate(`${basePath}/epics/${feature.epic_id}`)}
                    >
                        {feature.epic_title}
                    </button>
                )}
                <span className="current">Feature</span>
            </div>

            {loadError && <div className="wi-empty-state"><p>{loadError}</p></div>}

            <div className="wi-project-header">

                <div className="wi-project-header-top">

                    <div>

                        {feature.feature_code && <span className="wi-code">{feature.feature_code}</span>}

                        <h1>{feature.title}</h1>

                    </div>

                    <div className="wi-project-header-actions">

                        <span className={STORY_STATUS_CLASS[feature.status] || "status-pill status-neutral"}>
                            {STORY_STATUS_LABELS[feature.status] || feature.status || "—"}
                        </span>

                        {canEdit && (
                            <button
                                type="button"
                                className="wi-secondary-button"
                                onClick={() => setShowEditModal(true)}
                            >
                                <FaPen /> Edit
                            </button>
                        )}

                    </div>

                </div>

                <p className="wi-project-description">
                    {feature.description || "No description provided."}
                </p>

                <div className="wi-project-header-meta">

                    <div>
                        <label>Epic</label>
                        <span>
                            {feature.epic_id ? (
                                <button
                                    type="button"
                                    className="wi-link-button"
                                    onClick={() => navigate(`${basePath}/epics/${feature.epic_id}`)}
                                >
                                    {feature.epic_title}
                                </button>
                            ) : (
                                "None"
                            )}
                        </span>
                    </div>

                    <div>
                        <label>Priority</label>
                        <span className={PRIORITY_CLASS[feature.priority] || "priority-pill priority-medium"}>
                            {feature.priority || "—"}
                        </span>
                    </div>

                    <div>
                        <label>Assigned To</label>
                        <span>{feature.assigned_to_name || "Unassigned"}</span>
                    </div>

                    <div>
                        <label>Assigned By</label>
                        <span>{feature.assigned_by_name || "—"}</span>
                    </div>

                    <div>
                        <label>Created By</label>
                        <span>{feature.created_by_name || "—"}</span>
                    </div>

                    <div>
                        <label>Owner</label>
                        <span>{feature.owner_name || "—"}</span>
                    </div>

                    <div>
                        <label>Start Date</label>
                        <span>{formatDate(feature.start_date)}</span>
                    </div>

                    <div>
                        <label>Due Date</label>
                        <span>{formatDate(feature.due_date)}</span>
                    </div>

                    <div>
                        <label>Created</label>
                        <span>{formatDateTime(feature.created_at)}</span>
                    </div>

                    <div>
                        <label>Last Updated</label>
                        <span>{formatDateTime(feature.updated_at)}</span>
                    </div>

                </div>

            </div>

            <div className="wi-section-header">
                <h2>User Stories ({stories.length})</h2>
            </div>

            {stories.length === 0 ? (
                <div className="wi-empty-state">
                    <p>No user stories in this feature yet.</p>
                </div>
            ) : (
                <div className="wi-table-wrapper">
                    <table className="wi-table">
                        <thead>
                            <tr>
                                <th>User Story</th>
                                <th>Status</th>
                                <th>Assigned To</th>
                                <th>Priority</th>
                            </tr>
                        </thead>
                        <tbody>
                            {stories.map((story) => (
                                <tr
                                    key={story.id}
                                    className="wi-clickable-row"
                                    onClick={() => navigate(`${basePath}/user-stories/${story.id}`)}
                                >
                                    <td>
                                        {story.story_code && <span className="wi-code">{story.story_code}</span>}{" "}
                                        {story.title}
                                    </td>
                                    <td>
                                        <span className={STORY_STATUS_CLASS[story.status] || "status-pill status-neutral"}>
                                            {STORY_STATUS_LABELS[story.status] || story.status}
                                        </span>
                                    </td>
                                    <td>{story.assigned_to_name || "Unassigned"}</td>
                                    <td>{story.priority || "—"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {showEditModal && (
                <CreateFeatureModal
                    projectId={feature.project_id}
                    epics={epics}
                    feature={feature}
                    onClose={() => setShowEditModal(false)}
                    onUpdated={() => {
                        setShowEditModal(false);
                        loadData();
                    }}
                />
            )}

        </div>

    );

}

export default FeatureDetail;
