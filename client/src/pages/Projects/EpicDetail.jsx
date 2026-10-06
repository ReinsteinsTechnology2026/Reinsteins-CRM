import { useEffect, useState } from "react";

import { useLocation, useNavigate, useParams } from "react-router-dom";
import { getPortalBasePath } from "../../utils/portalBasePath";

import { FaArrowLeft, FaPen } from "react-icons/fa";

import { getEpic } from "../../services/epicService";

import { getFeatures } from "../../services/featureService";

import { getUserStories } from "../../services/userStoryService";

import { getMyProjectPermissions } from "../../services/projectMemberService";

import CreateEpicModal from "./CreateEpicModal";

import {
    STORY_STATUS_LABELS,
    STORY_STATUS_CLASS,
    PRIORITY_CLASS,
    formatDate,
    formatDateTime,
} from "../../utils/workItemStatus";

import "../../styles/workItems.css";
import "./Projects.css";

function EpicDetail() {

    const { id } = useParams();

    const navigate = useNavigate();

    const location = useLocation();

    const basePath = getPortalBasePath(location.pathname);

    const [epic, setEpic] = useState(null);

    const [features, setFeatures] = useState([]);

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

            const epicResponse = await getEpic(id);

            const current = epicResponse.epic;

            setEpic(current);

            const [featuresResult, storiesResult, permissionsResult] = await Promise.allSettled([
                getFeatures(current.project_id),
                getUserStories(current.project_id),
                getMyProjectPermissions(current.project_id),
            ]);

            const allFeatures = featuresResult.status === "fulfilled"
                ? featuresResult.value.features || []
                : [];

            setFeatures(allFeatures.filter((feature) => String(feature.epic_id) === String(current.id)));

            setStories(storiesResult.status === "fulfilled" ? storiesResult.value.userStories || [] : []);

            if (featuresResult.status === "rejected" || storiesResult.status === "rejected") {
                setLoadError("Some related features or user stories could not be loaded.");
            }

            setCanEdit(
                permissionsResult.status === "fulfilled" &&
                Boolean(permissionsResult.value.permissions?.EPIC_EDIT)
            );

        } catch (error) {

            console.error(error);

            if (error.response?.status === 404) {
                setNotFound(true);
            } else {
                setLoadError(error.response?.data?.message || "Unable to load epic");
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
        return <div className="wi-loading">Loading epic...</div>;
    }

    if (notFound || !epic) {
        return (
            <div className="wi-empty-state">
                <h3>Epic not found</h3>
                <p>{loadError || "This epic may have been deleted or you no longer have access to it."}</p>
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
                    onClick={() => navigate(`${basePath}/projects/${epic.project_id}`)}
                >
                    <FaArrowLeft /> {epic.project_name}
                </button>
                <span className="current">Epic</span>
            </div>

            {loadError && <div className="wi-empty-state"><p>{loadError}</p></div>}

            <div className="wi-project-header">

                <div className="wi-project-header-top">

                    <div>

                        {epic.epic_code && <span className="wi-code">{epic.epic_code}</span>}

                        <h1>{epic.title}</h1>

                    </div>

                    <div className="wi-project-header-actions">

                        <span className={STORY_STATUS_CLASS[epic.status] || "status-pill status-neutral"}>
                            {STORY_STATUS_LABELS[epic.status] || epic.status}
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
                    {epic.description || "No description provided."}
                </p>

                <div className="wi-project-header-meta">

                    <div>
                        <label>Priority</label>
                        <span className={PRIORITY_CLASS[epic.priority] || "priority-pill priority-medium"}>
                            {epic.priority || "—"}
                        </span>
                    </div>

                    <div>
                        <label>Assigned To</label>
                        <span>{epic.assigned_to_name || "Unassigned"}</span>
                    </div>

                    <div>
                        <label>Assigned By</label>
                        <span>{epic.assigned_by_name || "—"}</span>
                    </div>

                    <div>
                        <label>Created By</label>
                        <span>{epic.created_by_name || "—"}</span>
                    </div>

                    <div>
                        <label>Start Date</label>
                        <span>{formatDate(epic.start_date)}</span>
                    </div>

                    <div>
                        <label>Due Date</label>
                        <span>{formatDate(epic.due_date)}</span>
                    </div>

                    <div>
                        <label>Created</label>
                        <span>{formatDateTime(epic.created_at)}</span>
                    </div>

                    <div>
                        <label>Last Updated</label>
                        <span>{formatDateTime(epic.updated_at)}</span>
                    </div>

                </div>

            </div>

            <div className="wi-section-header">
                <h2>Features ({features.length})</h2>
            </div>

            {features.length === 0 ? (
                <div className="wi-empty-state">
                    <p>No features in this epic yet.</p>
                </div>
            ) : (
                <div className="wi-table-wrapper">
                    <table className="wi-table">
                        <thead>
                            <tr>
                                <th>Feature</th>
                                <th>Status</th>
                                <th>Assigned To</th>
                                <th>User Stories</th>
                            </tr>
                        </thead>
                        <tbody>
                            {features.map((feature) => {
                                const featureStories = stories.filter(
                                    (story) => String(story.feature_id) === String(feature.id)
                                );

                                return (
                                    <FeatureRows
                                        key={feature.id}
                                        feature={feature}
                                        featureStories={featureStories}
                                        basePath={basePath}
                                        navigate={navigate}
                                    />
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {showEditModal && (
                <CreateEpicModal
                    projectId={epic.project_id}
                    epic={epic}
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

function FeatureRows({ feature, featureStories, basePath, navigate }) {

    return (
        <>
            <tr>
                <td>
                    {feature.feature_code && <span className="wi-code">{feature.feature_code}</span>}{" "}
                    <button
                        type="button"
                        className="wi-link-button"
                        onClick={() => navigate(`${basePath}/features/${feature.id}`)}
                    >
                        {feature.title}
                    </button>
                </td>
                <td>
                    <span className={STORY_STATUS_CLASS[feature.status] || "status-pill status-neutral"}>
                        {STORY_STATUS_LABELS[feature.status] || feature.status || "—"}
                    </span>
                </td>
                <td>{feature.assigned_to_name || "Unassigned"}</td>
                <td>{featureStories.length}</td>
            </tr>

            {featureStories.map((story) => (
                <tr
                    key={story.id}
                    className="wi-clickable-row"
                    onClick={() => navigate(`${basePath}/user-stories/${story.id}`)}
                >
                    <td>
                        <span style={{ paddingLeft: 24 }}>
                            {story.story_code && <span className="wi-code">{story.story_code}</span>}{" "}
                            {story.title}
                        </span>
                    </td>
                    <td>
                        <span className={STORY_STATUS_CLASS[story.status] || "status-pill status-neutral"}>
                            {STORY_STATUS_LABELS[story.status] || story.status}
                        </span>
                    </td>
                    <td>{story.assigned_to_name || "Unassigned"}</td>
                    <td>User Story</td>
                </tr>
            ))}
        </>
    );

}

export default EpicDetail;
