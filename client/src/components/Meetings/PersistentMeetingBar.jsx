import { useEffect, useRef } from "react";

import { useLocation, useNavigate } from "react-router-dom";

import {
    FaMicrophone,
    FaMicrophoneSlash,
    FaVideo,
    FaVideoSlash,
    FaDesktop,
    FaUsers,
    FaExpandAlt,
    FaSignOutAlt,
} from "react-icons/fa";

import { toast } from "react-toastify";

import useMeetingSession from "../../hooks/useMeetingSession";

import * as meetingSessionManager from "../../services/meetingSessionManager";

import "./PersistentMeetingBar.css";

function getCurrentUser() {
    try {
        return JSON.parse(sessionStorage.getItem("user"));
    } catch (error) {
        return null;
    }
}

// ==========================================
// PERSISTENT MEETING BAR
//
// Mounted once in App.jsx as a sibling of
// <Routes> (the same "survives every route
// change" pattern already used by
// ChatNotificationListener) so an active
// meeting stays visible -- and controllable --
// no matter which WorkHub page the user is on.
//
// Reads meetingSessionManager's live snapshot;
// every control here calls the singleton's
// actions directly, the same ones the in-room
// MeetingRoom UI itself uses, so there is only
// ever one source of truth for mic/camera/
// screen-share state.
// ==========================================

function PersistentMeetingBar() {

    const session = useMeetingSession();

    const navigate = useNavigate();

    const location = useLocation();

    const terminalAcknowledgedRef = useRef(false);

    const currentUser = getCurrentUser();

    const basePath = currentUser?.role === "admin" ? "/admin" : "/employee";

    const roomPath = session.meetingId ? `${basePath}/meetings/${session.meetingId}/room` : null;

    const onRoomRoute = Boolean(roomPath) && location.pathname === roomPath;

    // One-time toast when the meeting legitimately ends (host ended
    // it, or this user was removed) while this bar -- not the room
    // itself -- is the only visible meeting UI. The session's local
    // resources are already stopped by this point (see
    // tearDownForTerminalState in meetingSessionManager.js);
    // acknowledgeTerminal() just clears the session record so the
    // bar disappears.
    //
    // Guarded by onRoomRoute: this component stays mounted (its hooks
    // still run) even while its own render returns null on the room
    // route, so without this guard it would race MeetingRoom's own
    // terminal screen -- clearing the session out from under it
    // before the user ever sees "Meeting Ended"/"You Were Removed" or
    // gets to click its own "Return to Meetings" button.

    useEffect(() => {

        if (!session.terminalState || terminalAcknowledgedRef.current || onRoomRoute) return;

        terminalAcknowledgedRef.current = true;

        if (session.terminalState === "removed") {
            toast("You were removed from the meeting", { icon: "🚫" });
        } else {
            toast(`"${session.meeting?.title || "The meeting"}" has ended`, { icon: "📴" });
        }

        meetingSessionManager.acknowledgeTerminal();

    }, [session.terminalState, session.meeting, onRoomRoute]);

    useEffect(() => {
        if (session.active) terminalAcknowledgedRef.current = false;
    }, [session.active]);

    if (!session.active || onRoomRoute) return null;

    const participantCount = Object.keys(session.participants).length;

    function handleReturnToMeeting() {
        navigate(roomPath);
    }

    async function handleLeaveMeeting() {
        await meetingSessionManager.leaveSession();
        navigate(`${basePath}/meetings`);
    }

    return (

        <div className="persistent-meeting-bar">

            <div className="pmb-status">
                <span className="pmb-live-dot" />
                <div className="pmb-status-text">
                    <strong>Meeting Active</strong>
                    <span>{session.meeting?.title}</span>
                </div>
            </div>

            <span className={session.connectionLost ? "pmb-connection reconnecting" : "pmb-connection"}>
                {session.connectionLost ? "Reconnecting…" : "Connected"}
            </span>

            <div className="pmb-controls">

                <button
                    type="button"
                    className={session.micOn ? "pmb-icon-button on" : "pmb-icon-button"}
                    onClick={() => meetingSessionManager.toggleMic()}
                    aria-label={session.micOn ? "Turn microphone off" : "Turn microphone on"}
                    title={session.micOn ? "Mute" : "Unmute"}
                >
                    {session.micOn ? <FaMicrophone /> : <FaMicrophoneSlash />}
                </button>

                <button
                    type="button"
                    className={session.cameraOn ? "pmb-icon-button on" : "pmb-icon-button"}
                    onClick={() => meetingSessionManager.toggleCamera()}
                    aria-label={session.cameraOn ? "Turn camera off" : "Turn camera on"}
                    title={session.cameraOn ? "Stop video" : "Start video"}
                >
                    {session.cameraOn ? <FaVideo /> : <FaVideoSlash />}
                </button>

                <button
                    type="button"
                    className={session.isSharingScreen ? "pmb-icon-button on" : "pmb-icon-button"}
                    onClick={() => (
                        session.isSharingScreen
                            ? meetingSessionManager.stopScreenShare()
                            : meetingSessionManager.startScreenShare()
                    )}
                    aria-label={session.isSharingScreen ? "Stop sharing your screen" : "Share your screen"}
                    title={session.isSharingScreen ? "Sharing — click to stop" : "Share screen"}
                >
                    <FaDesktop />
                </button>

                <span className="pmb-participants" title="Participants">
                    <FaUsers /> {participantCount}
                </span>

            </div>

            <div className="pmb-actions">

                <button type="button" className="pmb-return-button" onClick={handleReturnToMeeting}>
                    <FaExpandAlt /> Return to Meeting
                </button>

                <button type="button" className="pmb-leave-button" onClick={handleLeaveMeeting}>
                    <FaSignOutAlt /> Leave
                </button>

            </div>

        </div>

    );

}

export default PersistentMeetingBar;
