import { useEffect, useState } from "react";

import {
    FaTimes,
    FaUsers,
    FaMicrophone,
    FaMicrophoneSlash,
    FaVideo,
    FaVideoSlash,
    FaHandPaper,
    FaCrown,
    FaDesktop,
    FaEllipsisV,
    FaUserSlash,
    FaHourglassHalf,
} from "react-icons/fa";

const ROLE_LABELS = {
    co_host: "Co-Host",
    presenter: "Presenter",
};

// ==========================================
// PARTICIPANTS PANEL
//
// Presentational — MeetingRoom.jsx owns all
// state (live presence, waiting-room list) and
// wires every action here straight to the
// already-existing Phase 5 REST endpoints /
// meeting:* socket events. No new moderation
// logic lives in this file.
// ==========================================

function ParticipantsPanel({
    participantList,
    waitingParticipants,
    canModerate,
    selfId,
    onClose,
    onMute,
    onDisableCamera,
    onRemove,
    onChangeRole,
    onAdmitWaiting,
    onRejectWaiting,
}) {

    const [openMenuId, setOpenMenuId] = useState(null);

    useEffect(() => {

        if (openMenuId === null) return;

        function handleOutsideClick(event) {
            if (!event.target.closest(".meeting-participant-menu-wrap")) {
                setOpenMenuId(null);
            }
        }

        document.addEventListener("mousedown", handleOutsideClick);

        return () => document.removeEventListener("mousedown", handleOutsideClick);

    }, [openMenuId]);

    return (

        <div className="meeting-room-side-panel meeting-room-participants-panel">

            <div className="meeting-room-participants-header">
                <h3><FaUsers /> Participants ({participantList.length})</h3>
                <button
                    type="button"
                    className="meeting-panel-close-button"
                    onClick={onClose}
                    aria-label="Close participants panel"
                    title="Close participants"
                >
                    <FaTimes />
                </button>
            </div>

            <div className="meeting-room-participants-list">

                {canModerate && waitingParticipants.length > 0 && (

                    <div className="meeting-waiting-room-section">

                        <h4><FaHourglassHalf /> People waiting ({waitingParticipants.length})</h4>

                        {waitingParticipants.map((waiting) => (

                            <div key={waiting.user_id} className="meeting-waiting-room-row">

                                <span className="meeting-room-participant-avatar">
                                    {waiting.full_name?.charAt(0).toUpperCase() || "U"}
                                </span>

                                <span className="meeting-waiting-room-name">
                                    {waiting.full_name}
                                    <small>Waiting to join</small>
                                </span>

                                <div className="meeting-waiting-room-actions">

                                    <button
                                        type="button"
                                        className="meeting-waiting-admit"
                                        onClick={() => onAdmitWaiting(waiting.user_id)}
                                        title="Admit"
                                        aria-label={`Admit ${waiting.full_name}`}
                                    >
                                        Admit
                                    </button>

                                    <button
                                        type="button"
                                        className="meeting-waiting-reject"
                                        onClick={() => onRejectWaiting(waiting.user_id)}
                                        title="Reject"
                                        aria-label={`Reject ${waiting.full_name}`}
                                    >
                                        Reject
                                    </button>

                                </div>

                            </div>

                        ))}

                    </div>

                )}

                {canModerate && waitingParticipants.length > 0 && (
                    <div className="meeting-participants-divider" />
                )}

                {participantList.map((participant) => {

                    const isSelf = participant.userId === selfId;
                    const menuOpen = openMenuId === participant.userId;

                    return (

                        <div key={participant.userId} className="meeting-room-participant-row">

                            <span className="meeting-room-participant-avatar">
                                {participant.fullName?.charAt(0).toUpperCase() || "U"}
                            </span>

                            <span className="meeting-room-participant-name">

                                {participant.fullName}{isSelf ? " (You)" : ""}

                                {participant.isHost && <FaCrown title="Host" />}

                                {!participant.isHost && participant.roleLabel && (
                                    <span className="meeting-room-role-badge">{participant.roleLabel}</span>
                                )}

                                {participant.isPresenting && (
                                    <FaDesktop title="Presenting" className="meeting-presenting-icon" />
                                )}

                                {participant.handRaised && (
                                    <FaHandPaper title="Hand raised" className="meeting-hand-icon" />
                                )}

                            </span>

                            <span className="meeting-room-participant-icons">
                                {participant.micOn ? <FaMicrophone /> : <FaMicrophoneSlash className="off" />}
                                {participant.cameraOn ? <FaVideo /> : <FaVideoSlash className="off" />}
                            </span>

                            {canModerate && !isSelf && (

                                <div className="meeting-participant-menu-wrap">

                                    <button
                                        type="button"
                                        className="meeting-participant-menu-trigger"
                                        onClick={() => setOpenMenuId(menuOpen ? null : participant.userId)}
                                        aria-label={`Moderation actions for ${participant.fullName}`}
                                        title="Moderation actions"
                                    >
                                        <FaEllipsisV />
                                    </button>

                                    {menuOpen && (

                                        <div className="meeting-participant-menu">

                                            {participant.micOn && (
                                                <button type="button" onClick={() => { onMute(participant.userId); setOpenMenuId(null); }}>
                                                    Mute participant
                                                </button>
                                            )}

                                            {participant.cameraOn && (
                                                <button type="button" onClick={() => { onDisableCamera(participant.userId); setOpenMenuId(null); }}>
                                                    Turn off camera
                                                </button>
                                            )}

                                            {!participant.isHost && participant.role !== "co_host" && (
                                                <button type="button" onClick={() => { onChangeRole(participant.userId, "co_host"); setOpenMenuId(null); }}>
                                                    Make co-host
                                                </button>
                                            )}

                                            {!participant.isHost && participant.role === "co_host" && (
                                                <button type="button" onClick={() => { onChangeRole(participant.userId, "participant"); setOpenMenuId(null); }}>
                                                    Remove co-host
                                                </button>
                                            )}

                                            {!participant.isHost && participant.role !== "presenter" && (
                                                <button type="button" onClick={() => { onChangeRole(participant.userId, "presenter"); setOpenMenuId(null); }}>
                                                    Make presenter
                                                </button>
                                            )}

                                            {!participant.isHost && (
                                                <button
                                                    type="button"
                                                    className="danger"
                                                    onClick={() => { onRemove(participant.userId); setOpenMenuId(null); }}
                                                >
                                                    <FaUserSlash /> Remove from meeting
                                                </button>
                                            )}

                                        </div>

                                    )}

                                </div>

                            )}

                        </div>

                    );

                })}

            </div>

        </div>

    );

}

export default ParticipantsPanel;
