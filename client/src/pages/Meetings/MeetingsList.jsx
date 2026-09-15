import { useEffect, useMemo, useState } from "react";

import { useNavigate, useParams } from "react-router-dom";

import {
    FaVideo,
    FaPlus,
    FaSignInAlt,
    FaCopy,
    FaLock,
    FaUsers,
    FaCalendarAlt,
    FaCheckCircle,
    FaBroadcastTower,
    FaClock,
    FaUserAlt,
    FaEye,
} from "react-icons/fa";

import { toast } from "react-toastify";

import {
    getMeetings,
    getMeetingStats,
    cancelMeeting,
    resumeMeeting,
    buildMeetingLink,
} from "../../services/meetingService";

import CreateMeetingModal from "./CreateMeetingModal";

import JoinMeetingModal from "./JoinMeetingModal";

import MeetingsCalendar from "./MeetingsCalendar";

import {
    MEETING_STATUS_LABELS,
    MEETING_STATUS_CLASS,
    formatDate,
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

function formatTimeRange(meeting) {

    if (!meeting.start_time) return null;

    const start = String(meeting.start_time).substring(0, 5);

    if (!meeting.end_time) return start;

    const end = String(meeting.end_time).substring(0, 5);

    return `${start} - ${end}`;

}

function MeetingsList() {

    const navigate = useNavigate();

    const { companySlug } = useParams();

    const currentUser = getCurrentUser();

    const isAdmin = currentUser?.role === "admin";

    const [meetings, setMeetings] = useState([]);

    const [stats, setStats] = useState(null);

    const [loading, setLoading] = useState(true);

    const [showCreateModal, setShowCreateModal] = useState(false);

    const [showJoinModal, setShowJoinModal] = useState(false);

    const [editingMeeting, setEditingMeeting] = useState(null);

    const [actionLoadingId, setActionLoadingId] = useState(null);

    const [viewMode, setViewMode] = useState("list");

    const loadData = async () => {

        try {

            setLoading(true);

            const requests = [getMeetings()];

            if (isAdmin) requests.push(getMeetingStats());

            const [meetingsResponse, statsResponse] = await Promise.all(requests);

            setMeetings(meetingsResponse.meetings || []);

            if (statsResponse) setStats(statsResponse.stats);

        } catch (error) {

            console.error(error);

            toast.error("Unable to load meetings");

        } finally {

            setLoading(false);

        }

    };

    useEffect(() => {

        loadData();

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const { liveMeetings, upcomingMeetings, pastMeetings } = useMemo(() => {

        const live = [];
        const upcoming = [];
        const past = [];

        meetings.forEach((meeting) => {

            if (meeting.status === "live") live.push(meeting);
            else if (meeting.status === "scheduled") upcoming.push(meeting);
            else past.push(meeting);

        });

        return { liveMeetings: live, upcomingMeetings: upcoming, pastMeetings: past };

    }, [meetings]);

    // Company-aware tenant users are rendered under
    // "/:companySlug/admin"/"/:companySlug/employee" -- navigating to
    // the unprefixed path would take them off that route tree.
    // Reinsteins (no companySlug) keeps the existing unprefixed path.
    const basePath = companySlug
        ? `/${companySlug}/${isAdmin ? "admin" : "employee"}`
        : isAdmin ? "/admin" : "/employee";

    function isHost(meeting) {
        return Number(meeting.host_id) === Number(currentUser?.id);
    }

    function canManage(meeting) {
        return isAdmin || isHost(meeting);
    }

    async function handleCopyLink(meeting) {

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

    function handleOpenLobby(meeting) {

        navigate(`${basePath}/meetings/${meeting.id}/room`, {
            state: { meeting },
        });

    }

    async function handleCancel(meeting) {

        const confirmed = window.confirm(`Cancel "${meeting.title}"?`);

        if (!confirmed) return;

        try {

            setActionLoadingId(meeting.id);

            await cancelMeeting(meeting.id);

            toast.success("Meeting cancelled");

            await loadData();

        } catch (error) {

            console.error(error);

            toast.error(error.response?.data?.message || "Unable to cancel meeting");

        } finally {

            setActionLoadingId(null);

        }

    }

    // Reuses the existing lobby flow exactly like an instant meeting
    // does after creation — resume the meeting on the backend first
    // (host/admin-only, backend-verified), then open the lobby with
    // the now-live meeting so the normal "Join Now" preview/device
    // flow takes over. No new lobby logic, no duplicate join code.

    async function handleContinueMeeting(meeting) {

        try {

            setActionLoadingId(meeting.id);

            const response = await resumeMeeting(meeting.id);

            handleOpenLobby(response.meeting);

        } catch (error) {

            console.error(error);

            toast.error(error.response?.data?.message || "Unable to resume meeting");

        } finally {

            setActionLoadingId(null);

        }

    }

    function renderMeetingCard(meeting) {

        const managed = canManage(meeting);

        return (

            <div key={meeting.id} className="meeting-card">

                <div className="meeting-card-top">

                    <span
                        className={
                            MEETING_STATUS_CLASS[meeting.status] ||
                            "status-pill status-neutral"
                        }
                    >
                        {MEETING_STATUS_LABELS[meeting.status] || meeting.status}
                    </span>

                    {meeting.has_password && (
                        <span className="meeting-locked-badge" title="Password protected">
                            <FaLock />
                        </span>
                    )}

                </div>

                <h3>{meeting.title}</h3>

                {meeting.description && (
                    <p className="meeting-card-description">{meeting.description}</p>
                )}

                <div className="meeting-card-meta">

                    <div>
                        <label><FaUserAlt /> Host</label>
                        <span>{meeting.host_name}</span>
                    </div>

                    <div>
                        <label><FaCalendarAlt /> Date</label>
                        <span>
                            {meeting.meeting_type === "instant"
                                ? "Instant"
                                : formatDate(meeting.scheduled_date)}
                        </span>
                    </div>

                    {formatTimeRange(meeting) && (
                        <div>
                            <label><FaClock /> Time</label>
                            <span>{formatTimeRange(meeting)}</span>
                        </div>
                    )}

                </div>

                <div className="meeting-card-footer">

                    <span className="meeting-code-chip">{meeting.meeting_code}</span>

                    <span className="meeting-participant-count">
                        <FaUsers /> {meeting.participant_count}
                    </span>

                </div>

                <div className="meeting-card-actions">

                    {meeting.status === "live" && (
                        <button
                            type="button"
                            className="wi-primary-button"
                            onClick={() => handleOpenLobby(meeting)}
                        >
                            <FaVideo /> Join
                        </button>
                    )}

                    {meeting.status === "scheduled" && managed && (
                        <button
                            type="button"
                            className="wi-primary-button"
                            onClick={() => handleOpenLobby(meeting)}
                        >
                            <FaVideo /> Start
                        </button>
                    )}

                    {meeting.status === "ended" && managed && (
                        <button
                            type="button"
                            className="wi-primary-button"
                            onClick={() => handleContinueMeeting(meeting)}
                            disabled={actionLoadingId === meeting.id}
                            title="Continue this meeting"
                        >
                            <FaVideo /> {actionLoadingId === meeting.id ? "Starting…" : "Continue Meeting"}
                        </button>
                    )}

                    <button
                        type="button"
                        className="wi-secondary-button"
                        onClick={() => navigate(`${basePath}/meetings/${meeting.id}`)}
                    >
                        View Details
                    </button>

                    <button
                        type="button"
                        className="wi-secondary-button"
                        onClick={() => handleCopyLink(meeting)}
                        title="Copy meeting link"
                        aria-label="Copy meeting link"
                    >
                        <FaCopy />
                    </button>

                    {meeting.status === "scheduled" && managed && (

                        <>
                            <button
                                type="button"
                                className="wi-secondary-button"
                                onClick={() => setEditingMeeting(meeting)}
                            >
                                Edit
                            </button>

                            <button
                                type="button"
                                className="wi-secondary-button meeting-cancel-button"
                                disabled={actionLoadingId === meeting.id}
                                onClick={() => handleCancel(meeting)}
                            >
                                Cancel
                            </button>
                        </>

                    )}

                </div>

            </div>

        );

    }

    // Compact section-level empty state — deliberately not the
    // large dashed .wi-empty-state box used for the page-level
    // "no meetings at all" case below.

    function renderCompactEmpty({ icon, title, description, showCreateAction }) {

        return (

            <div className="meeting-empty-compact">

                <div className="meeting-empty-compact-icon">{icon}</div>

                <h3>{title}</h3>

                <p>{description}</p>

                {showCreateAction && (
                    <button
                        type="button"
                        className="wi-primary-button"
                        onClick={() => setShowCreateModal(true)}
                    >
                        <FaPlus /> New Meeting
                    </button>
                )}

            </div>

        );

    }

    // Past meetings: a compact scannable table on desktop, the
    // same meeting cards used elsewhere on mobile (pure CSS
    // toggle between the two — see Meetings.css). Both render
    // the exact same data through the exact same handlers as
    // every other meeting card/action in this file.

    function renderPastMeetingsTable() {

        return (

            <>

                <div className="wi-table-wrapper meeting-past-table-wrap">

                    <table className="wi-table meeting-past-table">

                        <thead>
                            <tr>
                                <th>Meeting</th>
                                <th>Host</th>
                                <th>Date</th>
                                <th>Participants</th>
                                <th>Status</th>
                                <th aria-label="Actions" />
                            </tr>
                        </thead>

                        <tbody>

                            {pastMeetings.map((meeting) => (

                                <tr key={meeting.id}>

                                    <td>
                                        <div className="meeting-table-title-cell">
                                            <strong>{meeting.title}</strong>
                                            <span>{meeting.meeting_code}</span>
                                        </div>
                                    </td>

                                    <td>{meeting.host_name}</td>

                                    <td>
                                        {meeting.meeting_type === "instant"
                                            ? "Instant"
                                            : formatDate(meeting.scheduled_date)}
                                    </td>

                                    <td>
                                        <span className="meeting-participant-count">
                                            <FaUsers /> {meeting.participant_count}
                                        </span>
                                    </td>

                                    <td>
                                        <span
                                            className={
                                                MEETING_STATUS_CLASS[meeting.status] ||
                                                "status-pill status-neutral"
                                            }
                                        >
                                            {MEETING_STATUS_LABELS[meeting.status] || meeting.status}
                                        </span>
                                    </td>

                                    <td>
                                        <div className="meeting-table-actions">

                                            {meeting.status === "ended" && canManage(meeting) && (
                                                <button
                                                    type="button"
                                                    className="meeting-continue-button"
                                                    onClick={() => handleContinueMeeting(meeting)}
                                                    disabled={actionLoadingId === meeting.id}
                                                    title="Continue this meeting"
                                                    aria-label={`Continue ${meeting.title}`}
                                                >
                                                    <FaVideo /> {actionLoadingId === meeting.id ? "Starting…" : "Continue"}
                                                </button>
                                            )}

                                            <button
                                                type="button"
                                                className="meeting-icon-button"
                                                onClick={() => navigate(`${basePath}/meetings/${meeting.id}`)}
                                                title="View details"
                                                aria-label={`View details for ${meeting.title}`}
                                            >
                                                <FaEye />
                                            </button>

                                            <button
                                                type="button"
                                                className="meeting-icon-button"
                                                onClick={() => handleCopyLink(meeting)}
                                                title="Copy meeting link"
                                                aria-label={`Copy link for ${meeting.title}`}
                                            >
                                                <FaCopy />
                                            </button>

                                        </div>
                                    </td>

                                </tr>

                            ))}

                        </tbody>

                    </table>

                </div>

                <div className="meeting-past-cards-wrap meeting-grid">
                    {pastMeetings.map(renderMeetingCard)}
                </div>

            </>

        );

    }

    return (

        <div className="wi-page meetings-dashboard">

            <div className="wi-page-header">

                <div>
                    <h1>Meetings</h1>
                    <p>Create, join, and manage meetings with your team.</p>
                </div>

                <div className="meeting-header-actions">

                    <div className="meeting-view-toggle">
                        <button
                            type="button"
                            className={viewMode === "list" ? "active" : ""}
                            onClick={() => setViewMode("list")}
                        >
                            List View
                        </button>
                        <button
                            type="button"
                            className={viewMode === "calendar" ? "active" : ""}
                            onClick={() => setViewMode("calendar")}
                        >
                            <FaCalendarAlt /> Calendar View
                        </button>
                    </div>

                    <button
                        type="button"
                        className="wi-secondary-button"
                        onClick={() => setShowJoinModal(true)}
                    >
                        <FaSignInAlt /> Join Meeting
                    </button>

                    <button
                        type="button"
                        className="wi-primary-button"
                        onClick={() => setShowCreateModal(true)}
                    >
                        <FaPlus /> New Meeting
                    </button>

                </div>

            </div>

            {isAdmin && stats && (

                <div className="meeting-stats-grid">

                    <div className="meeting-stat-card">
                        <div className="meeting-stat-icon"><FaVideo /></div>
                        <div className="meeting-stat-body">
                            <span className="meeting-stat-value">{stats.total || 0}</span>
                            <span className="meeting-stat-label">Total Meetings</span>
                            <span className="meeting-stat-sub">All time</span>
                        </div>
                    </div>

                    <div className="meeting-stat-card meeting-stat-live">
                        <div className="meeting-stat-icon"><FaBroadcastTower /></div>
                        <div className="meeting-stat-body">
                            <span className="meeting-stat-value">{stats.live || 0}</span>
                            <span className="meeting-stat-label">Live Now</span>
                            <span className="meeting-stat-sub"><span className="meeting-live-dot" />Live</span>
                        </div>
                    </div>

                    <div className="meeting-stat-card">
                        <div className="meeting-stat-icon"><FaCalendarAlt /></div>
                        <div className="meeting-stat-body">
                            <span className="meeting-stat-value">{stats.upcoming || 0}</span>
                            <span className="meeting-stat-label">Upcoming</span>
                            <span className="meeting-stat-sub">Scheduled</span>
                        </div>
                    </div>

                    <div className="meeting-stat-card">
                        <div className="meeting-stat-icon"><FaCheckCircle /></div>
                        <div className="meeting-stat-body">
                            <span className="meeting-stat-value">{stats.completed || 0}</span>
                            <span className="meeting-stat-label">Completed</span>
                            <span className="meeting-stat-sub">Finished</span>
                        </div>
                    </div>

                </div>

            )}

            {loading ? (

                <div className="wi-loading">Loading meetings...</div>

            ) : viewMode === "calendar" ? (

                <MeetingsCalendar
                    meetings={meetings}
                    onSelectMeeting={(meeting) => navigate(`${basePath}/meetings/${meeting.id}`)}
                    onCreateMeeting={() => setShowCreateModal(true)}
                />

            ) : meetings.length === 0 ? (

                <div className="wi-empty-state">
                    <FaVideo />
                    <h3>No meetings yet</h3>
                    <p>Click <b>+ New Meeting</b> to schedule your first meeting, or join one with an ID or link.</p>
                </div>

            ) : (

                <>

                    <div className="meeting-section meeting-live-section">

                        <h2 className="meeting-section-title">
                            Live Now <span className="meeting-section-count live">{liveMeetings.length}</span>
                        </h2>

                        {liveMeetings.length === 0 ? (

                            renderCompactEmpty({
                                icon: <FaBroadcastTower />,
                                title: "No live meetings",
                                description: "Meetings currently in progress will appear here.",
                            })

                        ) : (

                            <div className="meeting-grid">
                                {liveMeetings.map(renderMeetingCard)}
                            </div>

                        )}

                    </div>

                    <div className="meeting-section">

                        <h2 className="meeting-section-title">
                            Upcoming Meetings <span className="meeting-section-count">{upcomingMeetings.length}</span>
                        </h2>

                        {upcomingMeetings.length === 0 ? (

                            renderCompactEmpty({
                                icon: <FaCalendarAlt />,
                                title: "No upcoming meetings",
                                description: "Your scheduled meetings will appear here.",
                                showCreateAction: true,
                            })

                        ) : (

                            <div className="meeting-grid">
                                {upcomingMeetings.map(renderMeetingCard)}
                            </div>

                        )}

                    </div>

                    <div className="meeting-section">

                        <h2 className="meeting-section-title">
                            Past Meetings <span className="meeting-section-count">{pastMeetings.length}</span>
                        </h2>

                        {pastMeetings.length === 0 ? (

                            renderCompactEmpty({
                                icon: <FaCheckCircle />,
                                title: "No past meetings yet",
                                description: "Meetings that have ended will appear here.",
                            })

                        ) : (

                            renderPastMeetingsTable()

                        )}

                    </div>

                </>

            )}

            {showCreateModal && (

                <CreateMeetingModal
                    onClose={() => setShowCreateModal(false)}
                    onCreated={(meeting) => {
                        setShowCreateModal(false);
                        loadData();
                        if (meeting.meeting_type === "instant") {
                            handleOpenLobby(meeting);
                        }
                    }}
                />

            )}

            {showJoinModal && (
                <JoinMeetingModal onClose={() => setShowJoinModal(false)} />
            )}

            {editingMeeting && (

                <CreateMeetingModal
                    meeting={editingMeeting}
                    onClose={() => setEditingMeeting(null)}
                    onUpdated={() => {
                        setEditingMeeting(null);
                        loadData();
                    }}
                />

            )}

        </div>

    );

}

export default MeetingsList;
