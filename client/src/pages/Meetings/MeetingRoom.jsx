import { useEffect, useRef, useState } from "react";

import {
    FaMicrophone,
    FaMicrophoneSlash,
    FaVideo,
    FaVideoSlash,
    FaDesktop,
    FaHandPaper,
    FaSmile,
    FaUsers,
    FaComments,
    FaEllipsisH,
    FaSignOutAlt,
    FaPhoneSlash,
    FaLock,
    FaLockOpen,
    FaCrown,
    FaExpand,
    FaCompress,
    FaInfoCircle,
    FaSlidersH,
    FaThLarge,
    FaWifi,
    FaCheck,
    FaTimes as FaTimesIcon,
} from "react-icons/fa";

import { toast } from "react-toastify";

import * as meetingSessionManager from "../../services/meetingSessionManager";

import useMeetingSession from "../../hooks/useMeetingSession";

import ParticipantVideo from "./ParticipantVideo";
import ParticipantsPanel from "./ParticipantsPanel";
import MeetingChatPanel from "./MeetingChatPanel";
import MeetingInfoPanel from "./MeetingInfoPanel";
import { ReactionPicker, FloatingReactions } from "./Reactions";

import "./MeetingModal.css";
import "./MeetingRoom.css";

function formatDuration(seconds) {

    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const pad = (n) => String(n).padStart(2, "0");

    return hrs > 0 ? `${pad(hrs)}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;

}

// ==========================================
// MEETING ROOM
//
// Rendered from inside MeetingLobby.jsx once
// the user has actually joined — deliberately
// NOT a separate route, since the local
// MediaStream created in the lobby cannot
// survive a React Router navigation and must
// be reused here as-is.
//
// Phase 9 extends the Phase 8 WebRTC layer
// (mesh peer connections via
// meetingSignalingService) with the full
// collaboration layer: screen sharing, chat,
// reactions, raise hand, host moderation,
// waiting room, lock, meeting info, layouts,
// and a request/approval-only "control"
// workflow. Every persistent action (chat,
// admit/reject/remove/role/lock) calls the
// existing Phase 5 REST endpoints; every
// transient one (reactions, raise hand,
// screen-share state, media state, control
// request/approval) rides Socket.IO only and
// is never written to MySQL.
// ==========================================

function MeetingRoom({
    meeting,
    currentUser,
    isHost,
    localStream: localStreamProp,
    onLeave,
    onEnded,
    devices,
    selectedCameraId,
    selectedMicId,
    selectedSpeakerId,
    speakerSelectionSupported,
    onCameraChange,
    onMicChange,
    onSpeakerChange,
}) {

    const session = useMeetingSession();

    // Domain state (participants, remoteStreams, chat, screen-share,
    // etc.) now lives in meetingSessionManager -- a module-level
    // singleton that survives this component unmounting when the
    // user navigates to another WorkHub page. See PersistentMeetingBar
    // for the compact view shown on other pages, and
    // meetingSessionManager.leaveSession() for the only place real
    // teardown happens (explicit Leave/End, never route navigation).
    //
    // localStreamProp is only a first-paint fallback for the instant
    // after this component mounts but before the join effect below
    // has run -- session.localStream is authoritative once set.

    const localStream = session.localStream || localStreamProp;
    const micOn = session.micOn;
    const cameraOn = session.cameraOn;

    const selfId = Number(currentUser?.id);

    const roomRef = useRef(null);

    const [showParticipants, setShowParticipants] = useState(false);

    const [showChat, setShowChat] = useState(false);

    const [showMoreMenu, setShowMoreMenu] = useState(false);

    const [showReactionPicker, setShowReactionPicker] = useState(false);

    const [showInfoPanel, setShowInfoPanel] = useState(false);

    const [showHostMenu, setShowHostMenu] = useState(false);

    const [showDeviceSettings, setShowDeviceSettings] = useState(false);

    const [isFullscreen, setIsFullscreen] = useState(false);

    const [ending, setEnding] = useState(false);

    const [layoutMode, setLayoutMode] = useState("gallery"); // gallery | speaker

    const [activeSpeakerId, setActiveSpeakerId] = useState(null);

    const [myHandRaised, setMyHandRaised] = useState(false);

    const [chatSending, setChatSending] = useState(false);

    const [uploadingAttachment, setUploadingAttachment] = useState(false);

    const [floatingReactions, setFloatingReactions] = useState([]);

    const [durationSeconds, setDurationSeconds] = useState(0);

    const participants = session.participants;
    const remoteStreams = session.remoteStreams;
    const connectionLost = session.connectionLost;
    const terminalState = session.terminalState;
    const isSharingScreen = session.isSharingScreen;
    const presentingUserId = session.presentingUserId;
    const presentingName = session.presentingName;
    const myRole = session.myRole;
    const waitingParticipants = session.waitingParticipants;
    const isLocked = session.isLocked;
    const messages = session.messages;
    const unreadChat = session.unreadChat;
    const controlState = session.controlState;

    const canModerate = isHost || myRole === "co_host";

    // Keeps the singleton informed of chat-panel visibility so its
    // unread-count suppression logic matches today's exact behavior.
    useEffect(() => {
        meetingSessionManager.setChatPanelOpen(showChat);
    }, [showChat]);

    // ==========================================
    // FLOATING REACTIONS (shared by outgoing
    // clicks and incoming broadcasts)
    // ==========================================

    function addFloatingReaction(emoji) {

        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const offset = 10 + Math.random() * 78;

        setFloatingReactions((prev) => [...prev, { id, emoji, offset }]);

        setTimeout(() => {
            setFloatingReactions((prev) => prev.filter((r) => r.id !== id));
        }, 3000);

    }

    // Incoming reaction broadcasts arrive via the singleton's
    // separate ephemeral event bus (not the durable snapshot -- a
    // reaction sent while this view wasn't mounted should not replay
    // when it remounts).
    useEffect(() => {

        return meetingSessionManager.subscribeToEvents((event) => {
            if (event.type === "reaction") addFloatingReaction(event.emoji);
        });

    }, []);

    // ==========================================
    // JOIN SESSION (idempotent -- a no-op if a
    // session for this meeting is already active,
    // e.g. this is a "Return to Meeting" remount)
    // ==========================================

    useEffect(() => {

        meetingSessionManager.joinSession({
            meetingId: meeting.id,
            meeting,
            currentUser,
            isHost,
            localStream: localStreamProp,
        });

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [meeting.id]);

    // ==========================================
    // MEETING DURATION TIMER (client-side only —
    // no per-second database writes)
    // ==========================================

    useEffect(() => {

        const anchor = meeting.actual_start_time ? new Date(meeting.actual_start_time).getTime() : Date.now();

        const tick = () => setDurationSeconds(Math.max(0, Math.floor((Date.now() - anchor) / 1000)));

        tick();

        const interval = setInterval(tick, 1000);

        return () => clearInterval(interval);

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ==========================================
    // FULLSCREEN (best-effort)
    // ==========================================

    useEffect(() => {

        function handleFullscreenChange() {
            setIsFullscreen(Boolean(document.fullscreenElement));
        }

        document.addEventListener("fullscreenchange", handleFullscreenChange);

        return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);

    }, []);

    // ==========================================
    // CLOSE POPOVERS ON OUTSIDE CLICK
    // ==========================================

    useEffect(() => {

        function handleOutsideClick(event) {

            if (!event.target.closest(".meeting-room-popover-wrap")) {
                setShowMoreMenu(false);
                setShowReactionPicker(false);
                setShowHostMenu(false);
            }

        }

        document.addEventListener("mousedown", handleOutsideClick);

        return () => document.removeEventListener("mousedown", handleOutsideClick);

    }, []);

    function toggleFullscreen() {

        if (!document.fullscreenEnabled) {
            toast.error("Fullscreen isn't supported in this browser");
            return;
        }

        if (!document.fullscreenElement) {
            roomRef.current?.requestFullscreen?.().catch((error) => {
                console.error(error);
                toast.error("Unable to enter fullscreen");
            });
        } else {
            document.exitFullscreen?.();
        }

    }

    // ==========================================
    // MIC / CAMERA / SCREEN SHARE / RAISE HAND /
    // REACTIONS -- all now thin calls into
    // meetingSessionManager, which owns the
    // underlying media/socket state so it
    // survives this component unmounting.
    // ==========================================

    function handleToggleMic() {
        meetingSessionManager.toggleMic();
    }

    function handleToggleCamera() {
        meetingSessionManager.toggleCamera();
    }

    function handleToggleScreenShare() {
        if (isSharingScreen) meetingSessionManager.stopScreenShare();
        else meetingSessionManager.startScreenShare();
    }

    function handleToggleRaiseHand() {
        const next = meetingSessionManager.toggleRaiseHand(myHandRaised);
        setMyHandRaised(next);
    }

    function handleSendReaction(emoji) {
        addFloatingReaction(emoji);
        meetingSessionManager.sendReaction(emoji);
    }

    // ==========================================
    // PRESENTATION CONTROL REQUEST / APPROVAL
    // Collaboration protocol only — see the
    // note rendered in the UI and the final
    // Phase 9 report for why this intentionally
    // never touches real mouse/keyboard input.
    // ==========================================

    function requestControl() {
        meetingSessionManager.requestControl();
    }

    function respondToControlRequest(approved) {
        meetingSessionManager.respondToControlRequest(approved);
    }

    function revokeControl() {
        meetingSessionManager.revokeControl();
    }

    // ==========================================
    // CHAT
    // ==========================================

    async function handleSendChat(text) {

        try {
            setChatSending(true);
            await meetingSessionManager.sendChatMessage(text);
            // meeting:chat-message (already reaching everyone in the
            // room, including the sender) is what actually appends
            // it to the list — nothing appended optimistically here.
        } catch (error) {
            console.error(error);
            toast.error(error.response?.data?.message || "Unable to send message");
        } finally {
            setChatSending(false);
        }

    }

    // Same non-optimistic pattern as handleSendChat above — the
    // resulting attachment message reaches everyone, sender
    // included, via the existing meeting:chat-message broadcast.
    //
    // Unlike handleSendChat, this deliberately does NOT swallow the
    // error — MeetingChatPanel.jsx now stages attachments and only
    // calls this once, per file, when Send is clicked, and needs to
    // know whether a given upload actually succeeded so it can keep
    // a failed attachment staged (for retry) without re-uploading
    // the ones that already succeeded. The panel owns the per-file
    // error toast, since it has the filename to make that specific.

    async function handleSendChatAttachment(file) {

        setUploadingAttachment(true);

        try {
            await meetingSessionManager.sendChatAttachment(file);
        } catch (error) {
            console.error(error);
            throw error;
        } finally {
            setUploadingAttachment(false);
        }

    }

    function handleOpenChat() {
        setShowChat(true);
        setShowParticipants(false);
    }

    function handleOpenParticipants() {
        setShowParticipants(true);
        setShowChat(false);
    }

    // ==========================================
    // HOST MODERATION
    // ==========================================

    async function handleMuteParticipant(userId) {
        meetingSessionManager.muteParticipant(userId);
    }

    async function handleDisableParticipantCamera(userId) {
        meetingSessionManager.disableParticipantCamera(userId);
    }

    async function handleRemoveParticipant(userId) {

        const confirmed = window.confirm("Remove this participant from the meeting?");
        if (!confirmed) return;

        try {
            await meetingSessionManager.removeParticipantFromMeeting(userId);
        } catch (error) {
            console.error(error);
            toast.error(error.response?.data?.message || "Unable to remove participant");
        }

    }

    async function handleChangeRole(userId, role) {

        try {
            await meetingSessionManager.changeParticipantRoleInMeeting(userId, role);
        } catch (error) {
            console.error(error);
            toast.error(error.response?.data?.message || "Unable to update role");
        }

    }

    async function handleAdmitWaiting(userId) {

        try {
            await meetingSessionManager.admitWaiting(userId);
        } catch (error) {
            console.error(error);
            toast.error(error.response?.data?.message || "Unable to admit participant");
        }

    }

    async function handleRejectWaiting(userId) {

        try {
            await meetingSessionManager.rejectWaiting(userId);
        } catch (error) {
            console.error(error);
            toast.error(error.response?.data?.message || "Unable to reject participant");
        }

    }

    function handleMuteAll() {

        const mutedCount = meetingSessionManager.muteAllParticipants();

        if (mutedCount === 0) {
            toast("Everyone is already muted", { icon: "🔇" });
        } else {
            toast.success("Asked all participants to mute");
        }

        setShowHostMenu(false);

    }

    async function handleToggleLock() {

        try {
            await meetingSessionManager.toggleLock();
        } catch (error) {
            console.error(error);
            toast.error("Unable to update meeting lock");
        }

    }

    // ==========================================
    // LEAVE / END
    // ==========================================

    async function handleLeaveClick() {
        await meetingSessionManager.leaveSession();
        onLeave();
    }

    async function handleEndMeetingClick() {

        if (!isHost) return;

        const confirmed = window.confirm("End this meeting for everyone?");
        if (!confirmed) return;

        try {
            setEnding(true);
            await meetingSessionManager.endMeetingForAll();
        } catch (error) {
            console.error(error);
            toast.error(error.response?.data?.message || "Unable to end meeting");
            setEnding(false);
        }

    }

    // ==========================================
    // TERMINAL STATES
    // ==========================================

    if (terminalState) {

        return (

            <div className="meeting-room-ended">

                <FaPhoneSlash />

                <h2>{terminalState === "removed" ? "You Were Removed" : "Meeting Ended"}</h2>

                <p>
                    {terminalState === "removed"
                        ? "The host removed you from this meeting."
                        : isHost ? "You ended this meeting." : "The host ended this meeting."}
                </p>

                <button type="button" className="wi-primary-button" onClick={onEnded}>
                    Return to Meetings
                </button>

            </div>

        );

    }

    // ==========================================
    // DERIVED RENDER STATE
    // ==========================================

    const participantList = Object.values(participants)
        .map((p) => ({
            ...(p.userId === selfId ? { ...p, micOn, cameraOn, handRaised: myHandRaised } : p),
            isPresenting: p.userId === presentingUserId,
        }))
        .sort((a, b) => (a.userId === selfId ? -1 : b.userId === selfId ? 1 : 0));

    const count = participantList.length;

    const gridClass =
        count <= 1 ? "count-1" :
            count === 2 ? "count-2" :
                count === 3 ? "count-3" :
                    count === 4 ? "count-4" :
                        count <= 6 ? "count-5-6" :
                            "count-7-8";

    const isPresenting = Boolean(presentingUserId);
    const iAmPresenting = presentingUserId === selfId;

    const mainStageStream = iAmPresenting ? session.screenStream : remoteStreams[presentingUserId];

    const thumbnailList = isPresenting
        ? participantList.filter((p) => p.userId !== presentingUserId || p.userId === selfId)
        : participantList;

    const speakerMain = participantList.find((p) => p.userId === activeSpeakerId) || participantList[0];
    const speakerThumbnails = participantList.filter((p) => p.userId !== speakerMain?.userId);

    const networkStatus = connectionLost
        ? "reconnecting"
        : participantList.some((p) => p.connectionState === "reconnecting")
            ? "poor"
            : "connected";

    const raisedHandCount = participantList.filter((p) => p.handRaised).length;

    function handleSpeakingChange(userId, speaking) {
        if (speaking) setActiveSpeakerId(userId);
        else setActiveSpeakerId((prev) => (prev === userId ? null : prev));
    }

    return (

        <div
            className={showParticipants || showChat ? "meeting-room panel-open" : "meeting-room"}
            ref={roomRef}
        >

          <div className="meeting-room-main">

            <FloatingReactions reactions={floatingReactions} />

            <div className="meeting-room-topbar">

                <span className="meeting-room-timer">{formatDuration(durationSeconds)}</span>

                <span className={`meeting-room-network meeting-room-network-${networkStatus}`}>
                    <FaWifi />
                    {networkStatus === "connected" ? "Connected" : networkStatus === "poor" ? "Poor connection" : "Reconnecting…"}
                </span>

                {isLocked && (
                    <span className="meeting-room-lock-badge"><FaLock /> Meeting locked</span>
                )}

                {isPresenting && (
                    <span className="meeting-room-presenting-badge">
                        <FaDesktop /> {iAmPresenting ? "You are presenting" : `${presentingName || "Someone"} is presenting`}
                    </span>
                )}

                {!isPresenting && layoutMode === "speaker" && (
                    <span className="meeting-room-layout-badge"><FaThLarge /> Speaker view</span>
                )}

            </div>

            {connectionLost && (
                <div className="meeting-room-connection-banner">
                    <FaWifi /> Reconnecting…
                </div>
            )}

            {controlState.incomingRequest && (

                <div className="meeting-room-floating-card">
                    <p><strong>{controlState.incomingRequest.fromName}</strong> is requesting control</p>
                    <div className="meeting-room-floating-card-actions">
                        <button type="button" className="allow" onClick={() => respondToControlRequest(true)}>
                            <FaCheck /> Allow
                        </button>
                        <button type="button" className="deny" onClick={() => respondToControlRequest(false)}>
                            <FaTimesIcon /> Deny
                        </button>
                    </div>
                </div>

            )}

            {controlState.grantedToUserId && (

                <div className="meeting-room-floating-card">
                    <p><strong>{controlState.grantedToName}</strong> has control</p>
                    <p className="meeting-room-floating-card-note">
                        This shares awareness only — WorkHub does not transmit mouse or
                        keyboard input between browsers.
                    </p>
                    <button type="button" className="deny" onClick={revokeControl}>Revoke Control</button>
                </div>

            )}

            {controlState.grantedToMe && (

                <div className="meeting-room-floating-card">
                    <p>You have control</p>
                    <p className="meeting-room-floating-card-note">
                        Awareness only — real remote input would require a native app or
                        browser extension, which WorkHub does not provide.
                    </p>
                </div>

            )}

            {isPresenting && !iAmPresenting && !controlState.grantedToMe && !controlState.myRequestPending && (
                <button type="button" className="meeting-room-request-control" onClick={requestControl}>
                    Request Control
                </button>
            )}

            {isPresenting && !iAmPresenting && controlState.myRequestPending && (
                <span className="meeting-room-request-control pending">Request sent…</span>
            )}

            {isPresenting ? (

                <div className="meeting-room-presentation">

                    <div className="meeting-room-main-stage">
                        <video
                            autoPlay
                            playsInline
                            muted
                            className="meeting-room-video"
                            ref={(node) => {
                                if (node && node.srcObject !== mainStageStream) {
                                    node.srcObject = mainStageStream || null;
                                }
                            }}
                        />
                    </div>

                    <div className="meeting-room-thumbnail-strip">
                        {thumbnailList.map((participant) => (
                            <ParticipantVideo
                                key={participant.userId}
                                participant={participant}
                                stream={participant.userId === selfId ? localStream : remoteStreams[participant.userId]}
                                isSelf={participant.userId === selfId}
                                size="small"
                                onSpeakingChange={handleSpeakingChange}
                            />
                        ))}
                    </div>

                </div>

            ) : layoutMode === "speaker" && speakerMain ? (

                <div className="meeting-room-presentation">

                    <div className="meeting-room-main-stage">
                        <ParticipantVideo
                            participant={speakerMain}
                            stream={speakerMain.userId === selfId ? localStream : remoteStreams[speakerMain.userId]}
                            isSelf={speakerMain.userId === selfId}
                            onSpeakingChange={handleSpeakingChange}
                        />
                    </div>

                    <div className="meeting-room-thumbnail-strip">
                        {speakerThumbnails.map((participant) => (
                            <ParticipantVideo
                                key={participant.userId}
                                participant={participant}
                                stream={participant.userId === selfId ? localStream : remoteStreams[participant.userId]}
                                isSelf={participant.userId === selfId}
                                size="small"
                                onSpeakingChange={handleSpeakingChange}
                            />
                        ))}
                    </div>

                </div>

            ) : (

                <div className={`meeting-room-grid ${gridClass}`}>

                    {participantList.map((participant) => (
                        <ParticipantVideo
                            key={participant.userId}
                            participant={participant}
                            stream={participant.userId === selfId ? localStream : remoteStreams[participant.userId]}
                            isSelf={participant.userId === selfId}
                            onSpeakingChange={handleSpeakingChange}
                        />
                    ))}

                </div>

            )}

            {showInfoPanel && (
                <MeetingInfoPanel meeting={meeting} onClose={() => setShowInfoPanel(false)} />
            )}

            <div className="meeting-room-controls">

                <button
                    type="button"
                    className={micOn ? "meeting-room-control-button on" : "meeting-room-control-button"}
                    onClick={handleToggleMic}
                    aria-label={micOn ? "Turn microphone off" : "Turn microphone on"}
                    title={micOn ? "Mute" : "Unmute"}
                >
                    {micOn ? <FaMicrophone /> : <FaMicrophoneSlash />}
                </button>

                <button
                    type="button"
                    className={cameraOn ? "meeting-room-control-button on" : "meeting-room-control-button"}
                    onClick={handleToggleCamera}
                    aria-label={cameraOn ? "Turn camera off" : "Turn camera on"}
                    title={cameraOn ? "Stop video" : "Start video"}
                >
                    {cameraOn ? <FaVideo /> : <FaVideoSlash />}
                </button>

                <button
                    type="button"
                    className={isSharingScreen ? "meeting-room-control-button on" : "meeting-room-control-button"}
                    onClick={handleToggleScreenShare}
                    disabled={isPresenting && !iAmPresenting}
                    aria-label={isSharingScreen ? "Stop presenting" : "Share your screen"}
                    title={isPresenting && !iAmPresenting ? `${presentingName || "Someone"} is presenting` : (isSharingScreen ? "Stop sharing" : "Share screen")}
                >
                    <FaDesktop />
                </button>

                <button
                    type="button"
                    className={myHandRaised ? "meeting-room-control-button on" : "meeting-room-control-button"}
                    onClick={handleToggleRaiseHand}
                    aria-label={myHandRaised ? "Lower hand" : "Raise hand"}
                    title={myHandRaised ? "Lower hand" : "Raise hand"}
                >
                    <FaHandPaper />
                </button>

                <div className="meeting-room-popover-wrap">

                    <button
                        type="button"
                        className={showReactionPicker ? "meeting-room-control-button on" : "meeting-room-control-button"}
                        onClick={() => setShowReactionPicker((prev) => !prev)}
                        aria-label="Reactions"
                        title="Reactions"
                    >
                        <FaSmile />
                    </button>

                    {showReactionPicker && (
                        <ReactionPicker
                            onReact={handleSendReaction}
                            onCloseRequest={() => setShowReactionPicker(false)}
                        />
                    )}

                </div>

                <button
                    type="button"
                    className={showParticipants ? "meeting-room-control-button on" : "meeting-room-control-button"}
                    onClick={() => (showParticipants ? setShowParticipants(false) : handleOpenParticipants())}
                    aria-label="Toggle participants panel"
                    title="Participants"
                >
                    <FaUsers />
                    <span className="meeting-room-control-count">{count}</span>
                    {raisedHandCount > 0 && <span className="meeting-room-control-count hand">{raisedHandCount}</span>}
                </button>

                <button
                    type="button"
                    className={showChat ? "meeting-room-control-button on" : "meeting-room-control-button"}
                    onClick={() => (showChat ? setShowChat(false) : handleOpenChat())}
                    aria-label="Toggle meeting chat"
                    title="Chat"
                >
                    <FaComments />
                    {unreadChat > 0 && <span className="meeting-room-control-count">{unreadChat}</span>}
                </button>

                <div className="meeting-room-popover-wrap">

                    <button
                        type="button"
                        className={showMoreMenu ? "meeting-room-control-button on" : "meeting-room-control-button"}
                        onClick={() => setShowMoreMenu((prev) => !prev)}
                        aria-label="More options"
                        title="More"
                    >
                        <FaEllipsisH />
                    </button>

                    {showMoreMenu && (

                        <div className="meeting-room-dropdown-menu">

                            <button type="button" onClick={() => { setShowInfoPanel(true); setShowMoreMenu(false); }}>
                                <FaInfoCircle /> Meeting Info
                            </button>

                            <button type="button" onClick={() => { setShowDeviceSettings(true); setShowMoreMenu(false); }}>
                                <FaSlidersH /> Device Settings
                            </button>

                            <button
                                type="button"
                                onClick={() => { setLayoutMode((prev) => (prev === "gallery" ? "speaker" : "gallery")); setShowMoreMenu(false); }}
                            >
                                <FaThLarge /> {layoutMode === "gallery" ? "Switch to Speaker View" : "Switch to Gallery View"}
                            </button>

                        </div>

                    )}

                </div>

                {canModerate && (
                    <button
                        type="button"
                        className={isLocked ? "meeting-room-control-button on" : "meeting-room-control-button"}
                        onClick={handleToggleLock}
                        aria-label={isLocked ? "Unlock meeting" : "Lock meeting"}
                        title={isLocked ? "Unlock meeting" : "Lock meeting"}
                    >
                        {isLocked ? <FaLock /> : <FaLockOpen />}
                    </button>
                )}

                {canModerate && (

                    <div className="meeting-room-popover-wrap">

                        <button
                            type="button"
                            className={showHostMenu ? "meeting-room-control-button on" : "meeting-room-control-button"}
                            onClick={() => setShowHostMenu((prev) => !prev)}
                            aria-label="Host controls"
                            title="Host Controls"
                        >
                            <FaCrown />
                        </button>

                        {showHostMenu && (
                            <div className="meeting-room-dropdown-menu">
                                <button type="button" onClick={handleMuteAll}>
                                    <FaMicrophoneSlash /> Mute All Participants
                                </button>
                                <button type="button" onClick={() => { handleOpenParticipants(); setShowHostMenu(false); }}>
                                    <FaUsers /> Manage Participants
                                </button>
                            </div>
                        )}

                    </div>

                )}

                <button
                    type="button"
                    className="meeting-room-control-button"
                    onClick={toggleFullscreen}
                    aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                    title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                >
                    {isFullscreen ? <FaCompress /> : <FaExpand />}
                </button>

                <button
                    type="button"
                    className="meeting-room-control-button leave"
                    onClick={handleLeaveClick}
                    aria-label="Leave meeting"
                    title="Leave"
                >
                    <FaSignOutAlt /> Leave
                </button>

                {isHost && (
                    <button
                        type="button"
                        className="meeting-room-control-button end"
                        onClick={handleEndMeetingClick}
                        disabled={ending}
                        aria-label="End meeting for everyone"
                        title="End Meeting"
                    >
                        <FaPhoneSlash /> End
                    </button>
                )}

            </div>

          </div>

            {showParticipants && (
                <ParticipantsPanel
                    participantList={participantList}
                    waitingParticipants={waitingParticipants}
                    canModerate={canModerate}
                    selfId={selfId}
                    onClose={() => setShowParticipants(false)}
                    onMute={handleMuteParticipant}
                    onDisableCamera={handleDisableParticipantCamera}
                    onRemove={handleRemoveParticipant}
                    onChangeRole={handleChangeRole}
                    onAdmitWaiting={handleAdmitWaiting}
                    onRejectWaiting={handleRejectWaiting}
                />
            )}

            {showChat && (
                <MeetingChatPanel
                    messages={messages}
                    currentUserId={selfId}
                    onSend={handleSendChat}
                    onSendAttachment={handleSendChatAttachment}
                    onClose={() => setShowChat(false)}
                    sending={chatSending}
                    uploadingAttachment={uploadingAttachment}
                />
            )}

            {showDeviceSettings && (

                <div className="meeting-modal-overlay" onClick={() => setShowDeviceSettings(false)}>

                    <div className="meeting-modal meeting-device-settings-modal" onClick={(event) => event.stopPropagation()}>

                        <div className="meeting-modal-header">
                            <div><h2><FaSlidersH /> Device Settings</h2></div>
                            <button type="button" className="meeting-modal-close" onClick={() => setShowDeviceSettings(false)} aria-label="Close device settings">
                                &times;
                            </button>
                        </div>

                        <div className="meeting-lobby-device-selects">

                            <div className="meeting-form-group">
                                <label htmlFor="room-camera-select">Camera</label>
                                <select
                                    id="room-camera-select"
                                    value={selectedCameraId}
                                    onChange={(event) => onCameraChange(event.target.value)}
                                    disabled={devices.cameras.length === 0}
                                >
                                    {devices.cameras.length === 0 && <option>No camera found</option>}
                                    {devices.cameras.map((device) => (
                                        <option key={device.deviceId} value={device.deviceId}>
                                            {device.label || "Camera"}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className="meeting-form-group">
                                <label htmlFor="room-mic-select">Microphone</label>
                                <select
                                    id="room-mic-select"
                                    value={selectedMicId}
                                    onChange={(event) => onMicChange(event.target.value)}
                                    disabled={devices.microphones.length === 0}
                                >
                                    {devices.microphones.length === 0 && <option>No microphone found</option>}
                                    {devices.microphones.map((device) => (
                                        <option key={device.deviceId} value={device.deviceId}>
                                            {device.label || "Microphone"}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {speakerSelectionSupported && devices.speakers.length > 0 && (
                                <div className="meeting-form-group">
                                    <label htmlFor="room-speaker-select">Speaker</label>
                                    <select
                                        id="room-speaker-select"
                                        value={selectedSpeakerId}
                                        onChange={(event) => onSpeakerChange(event.target.value)}
                                    >
                                        {devices.speakers.map((device) => (
                                            <option key={device.deviceId} value={device.deviceId}>
                                                {device.label || "Speaker"}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}

                        </div>

                    </div>

                </div>

            )}

        </div>

    );

}

export default MeetingRoom;
