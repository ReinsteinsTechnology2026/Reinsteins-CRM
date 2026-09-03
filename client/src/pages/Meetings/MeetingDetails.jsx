import { useEffect, useState } from "react";

import { useNavigate, useParams } from "react-router-dom";

import {
    FaArrowLeft,
    FaVideo,
    FaCopy,
    FaPen,
    FaUsers,
    FaLock,
} from "react-icons/fa";

import { toast } from "react-toastify";

import {
    getMeeting,
    getParticipants,
    cancelMeeting,
    resumeMeeting,
    buildMeetingLink,
} from "../../services/meetingService";

import CreateMeetingModal from "./CreateMeetingModal";

import {
    MEETING_STATUS_LABELS,
    MEETING_STATUS_CLASS,
    formatDate,
    formatDateTime,
} from "../../utils/workItemStatus";

import "../../styles/workItems.css";
import "./Meetings.css";

function getCurrentUser() {

    try {
        return JSON.parse(sessionStorage.getItem("user"));
    } catch (error) {
        return null;
    }

}

const PARTICIPANT_ROLE_LABELS = {
    host: "Host",
    co_host: "Co-Host",
    presenter: "Presenter",
    participant: "Participant",
};

const PARTICIPANT_STATUS_LABELS = {
    waiting: "Waiting Room",
    admitted: "Admitted",
    joined: "Joined",
    left: "Left",
    removed: "Removed",
    rejected: "Rejected",
};

function MeetingDetails() {

    const { id } = useParams();

    const navigate = useNavigate();

    const currentUser = getCurrentUser();

    const isAdmin = currentUser?.role === "admin";

    const basePath = isAdmin ? "/admin" : "/employee";

    const [meeting, setMeeting] = useState(null);

    const [participants, setParticipants] = useState([]);

    const [loading, setLoading] = useState(true);

    const [showEditModal, setShowEditModal] = useState(false);

    const [actionLoading, setActionLoading] = useState(false);

    const loadData = async () => {

        try {

            setLoading(true);

            const [meetingResponse, participantsResponse] = await Promise.all([
                getMeeting(id),
                getParticipants(id),
            ]);

            setMeeting(meetingResponse.meeting);

            setParticipants(participantsResponse.participants || []);

        } catch (error) {

            console.error(error);

            toast.error(
                error.response?.data?.message || "Unable to load meeting"
            );

        } finally {

            setLoading(false);

        }

    };

    useEffect(() => {

        loadData();

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    if (loading) {
        return <div className="wi-loading">Loading meeting...</div>;
    }

    if (!meeting) {
        return (
            <div className="wi-page">
                <div className="wi-empty-state">
                    <h3>Meeting not found</h3>
                </div>
            </div>
        );
    }

    const isHost = Number(meeting.host_id) === Number(currentUser?.id);

    const canManage = isAdmin || isHost;

    async function handleCopyLink() {

        try {
            await navigator.clipboard.writeText(buildMeetingLink(meeting.meeting_code));
            toast.success("Meeting link copied");
        } catch (error) {
            console.error(error);
            toast.error("Unable to copy link");
        }

    }

    // Navigates into the Meeting Lobby with the meeting we've
    // already loaded. The actual join/start API call now
    // happens from the lobby's "Join Now"/"Start Meeting"
    // button, after the device preview — not before it.

    function handleOpenLobby() {

        navigate(`${basePath}/meetings/${meeting.id}/room`, {
            state: { meeting },
        });

    }

    // Same resume service call and lobby hand-off as the Meetings
    // list's Continue Meeting action — no separate logic here.

    async function handleContinueMeeting() {

        try {

            setActionLoading(true);

            const response = await resumeMeeting(meeting.id);

            navigate(`${basePath}/meetings/${meeting.id}/room`, {
                state: { meeting: response.meeting },
            });

        } catch (error) {

            console.error(error);

            toast.error(error.response?.data?.message || "Unable to resume meeting");

            setActionLoading(false);

        }

    }

    async function handleCancel() {

        const confirmed = window.confirm(`Cancel "${meeting.title}"?`);

        if (!confirmed) return;

        try {

            setActionLoading(true);

            await cancelMeeting(meeting.id);

            toast.success("Meeting cancelled");

            await loadData();

        } catch (error) {

            console.error(error);

            toast.error(error.response?.data?.message || "Unable to cancel meeting");

        } finally {

            setActionLoading(false);

        }

    }

    return (

        <div className="wi-page">

            <div className="wi-breadcrumb">
                <button type="button" onClick={() => navigate(`${basePath}/meetings`)}>
                    <FaArrowLeft /> Meetings
                </button>
                <span>/</span>
                <span className="current">{meeting.title}</span>
            </div>

            <div className="wi-project-header">

                <div className="wi-project-header-top">

                    <div>
                        <span className="wi-code">{meeting.meeting_code}</span>
                        <h1>{meeting.title}</h1>
                    </div>

                    <div className="wi-project-header-actions">

                        <span
                            className={
                                MEETING_STATUS_CLASS[meeting.status] ||
                                "status-pill status-neutral"
                            }
                        >
                            {MEETING_STATUS_LABELS[meeting.status] || meeting.status}
                        </span>

                        {canManage && meeting.status === "scheduled" && (

                            <>
                                <button
                                    type="button"
                                    className="wi-secondary-button"
                                    onClick={() => setShowEditModal(true)}
                                >
                                    <FaPen /> Edit
                                </button>

                                <button
                                    type="button"
                                    className="wi-secondary-button meeting-cancel-button"
                                    disabled={actionLoading}
                                    onClick={handleCancel}
                                >
                                    Cancel
                                </button>
                            </>

                        )}

                    </div>

                </div>

                <p className="wi-project-description">
                    {meeting.description || "No description provided."}
                </p>

                <div className="wi-project-header-meta">

                    <div>
                        <label>Host</label>
                        <span>{meeting.host_name}</span>
                    </div>

                    <div>
                        <label>Type</label>
                        <span>{meeting.meeting_type === "instant" ? "Instant" : "Scheduled"}</span>
                    </div>

                    {meeting.meeting_type === "scheduled" && (
                        <div>
                            <label>Date</label>
                            <span>{formatDate(meeting.scheduled_date)}</span>
                        </div>
                    )}

                    {meeting.start_time && (
                        <div>
                            <label>Start Time</label>
                            <span>{String(meeting.start_time).substring(0, 5)}</span>
                        </div>
                    )}

                    {meeting.end_time && (
                        <div>
                            <label>End Time</label>
                            <span>{String(meeting.end_time).substring(0, 5)}</span>
                        </div>
                    )}

                    <div>
                        <label>Participants</label>
                        <span><FaUsers /> {meeting.participant_count}</span>
                    </div>

                    {meeting.has_password && (
                        <div>
                            <label>Security</label>
                            <span><FaLock /> Password protected</span>
                        </div>
                    )}

                </div>

                <div className="meeting-link-row">

                    <span>{buildMeetingLink(meeting.meeting_code)}</span>

                    <button
                        type="button"
                        className="wi-secondary-button"
                        onClick={handleCopyLink}
                    >
                        <FaCopy /> Copy Link
                    </button>

                </div>

                {["scheduled", "live", "ended"].includes(meeting.status) && (

                    <div className="meeting-join-panel">

                        {meeting.status === "live" ? (
                            <button
                                type="button"
                                className="wi-primary-button"
                                onClick={handleOpenLobby}
                            >
                                <FaVideo /> Join Meeting
                            </button>
                        ) : meeting.status === "ended" ? (
                            canManage ? (
                                <button
                                    type="button"
                                    className="wi-primary-button"
                                    onClick={handleContinueMeeting}
                                    disabled={actionLoading}
                                    title="Continue this meeting"
                                >
                                    <FaVideo /> {actionLoading ? "Starting…" : "Continue Meeting"}
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    className="wi-secondary-button"
                                    disabled
                                    title="This meeting has ended"
                                >
                                    Meeting Ended
                                </button>
                            )
                        ) : canManage ? (
                            <button
                                type="button"
                                className="wi-primary-button"
                                onClick={handleOpenLobby}
                            >
                                <FaVideo /> Start Meeting
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="wi-secondary-button"
                                disabled
                                title="The host hasn't started this meeting yet"
                            >
                                Not Started Yet
                            </button>
                        )}

                    </div>

                )}

            </div>

            <div className="meeting-panel">

                <h2>Participants</h2>

                {participants.length === 0 ? (

                    <div className="wi-empty-state">
                        <p>No participants yet.</p>
                    </div>

                ) : (

                    <div className="wi-table-wrapper">

                        <table className="wi-table">

                            <thead>
                                <tr>
                                    <th>Name</th>
                                    <th>Role</th>
                                    <th>Status</th>
                                    <th>Joined</th>
                                </tr>
                            </thead>

                            <tbody>

                                {participants.map((participant) => (

                                    <tr key={participant.id}>

                                        <td>{participant.full_name}</td>

                                        <td>{PARTICIPANT_ROLE_LABELS[participant.role] || participant.role}</td>

                                        <td>{PARTICIPANT_STATUS_LABELS[participant.status] || participant.status}</td>

                                        <td>{formatDateTime(participant.joined_at)}</td>

                                    </tr>

                                ))}

                            </tbody>

                        </table>

                    </div>

                )}

            </div>

            {showEditModal && (

                <CreateMeetingModal
                    meeting={meeting}
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

export default MeetingDetails;
