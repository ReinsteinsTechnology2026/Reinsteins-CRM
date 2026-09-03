import { useEffect, useRef, useState } from "react";

import { useLocation, useNavigate, useParams } from "react-router-dom";

import {
    FaArrowLeft,
    FaMicrophone,
    FaMicrophoneSlash,
    FaVideo,
    FaVideoSlash,
    FaSignOutAlt,
    FaExclamationTriangle,
    FaHourglassHalf,
} from "react-icons/fa";

import { toast } from "react-toastify";

import {
    getMeeting,
    joinMeeting,
    startMeeting,
    leaveMeeting,
} from "../../services/meetingService";

import socket, { connectSocket } from "../../services/socket";

import * as meetingSessionManager from "../../services/meetingSessionManager";

import MeetingRoom from "./MeetingRoom";

import "../../styles/workItems.css";
import "./MeetingLobby.css";

function getCurrentUser() {

    try {
        return JSON.parse(sessionStorage.getItem("user"));
    } catch (error) {
        return null;
    }

}

// ==========================================
// FRIENDLY MEDIA ERROR MESSAGES
// ==========================================

function describeMediaError(error) {

    switch (error?.name) {

        case "NotAllowedError":
        case "PermissionDeniedError":
            return "Permission was denied.";

        case "NotFoundError":
        case "DevicesNotFoundError":
            return "No matching device was found.";

        case "NotReadableError":
        case "TrackStartError":
            return "The device is already in use by another application.";

        case "OverconstrainedError":
            return "No device matches the requested settings.";

        case "SecurityError":
            return "This page must be served over a secure (HTTPS) connection.";

        default:
            return error?.message || "An unknown error occurred.";

    }

}

// ==========================================
// MEETING LOBBY
//
// Owns the local camera/microphone preview
// from the moment the user arrives here
// through the (Phase 8) WebRTC room, so the
// same MediaStream can flow straight into
// peer connections later without ever being
// re-requested or handed across a route
// navigation (MediaStream objects cannot be
// serialized into router/history state).
//
// Once stage becomes "joined", rendering hands
// off to <MeetingRoom> (Phase 8) — still inside
// this same component/mount, so streamRef.current
// is passed straight in rather than re-requested.
// ==========================================

function MeetingLobby() {

    const { id } = useParams();

    const navigate = useNavigate();

    const location = useLocation();

    const currentUser = getCurrentUser();

    const basePath = currentUser?.role === "admin" ? "/admin" : "/employee";

    const videoRef = useRef(null);

    const streamRef = useRef(null);

    // If a persistent meeting session for this exact meeting is
    // already active (the user navigated away and is now returning,
    // e.g. via PersistentMeetingBar's "Return to Meeting"), reuse it
    // as-is -- never re-fetch the meeting, never re-request camera/
    // mic, never re-join. See the device-setup effect and the new
    // join-handoff effect below for the corresponding guards.

    const existingSession = meetingSessionManager.hasActiveSession(id)
        ? meetingSessionManager.getSnapshot()
        : null;

    // ==========================================
    // MEETING DATA
    // Fast path: the previous page already
    // fetched/joined and handed us the meeting
    // (and, if it already joined on our behalf,
    // the resulting participantStatus) via
    // navigation state. Falls back to a fresh
    // fetch on a direct visit/refresh — which
    // only succeeds for the host, an admin, or
    // an already-established participant, per
    // the existing Phase 5 access rules.
    // ==========================================

    const [meeting, setMeeting] = useState(existingSession?.meeting || location.state?.meeting || null);

    const [meetingLoading, setMeetingLoading] = useState(!meeting);

    const [meetingError, setMeetingError] = useState(null);

    // Depends only on meeting/currentUser, both already available --
    // computed here (rather than further down, where it used to live)
    // because the device-setup and join-handoff effects below need it.

    const isHost = meeting && Number(meeting.host_id) === Number(currentUser?.id);

    // ==========================================
    // STAGE: preview | joining | waiting | joined | rejected
    // ==========================================

    const [stage, setStage] = useState(
        existingSession
            ? "joined"
            : location.state?.participantStatus === "waiting"
            ? "waiting"
            : location.state?.participantStatus === "joined"
                ? "joined"
                : "preview"
    );

    const [joinPassword, setJoinPassword] = useState("");

    const [joinLoading, setJoinLoading] = useState(false);

    // ==========================================
    // DEVICE STATE
    // ==========================================

    const [micOn, setMicOn] = useState(true);

    const [cameraOn, setCameraOn] = useState(true);

    const [mediaError, setMediaError] = useState(null);

    const [mediaReady, setMediaReady] = useState(Boolean(existingSession));

    const [devices, setDevices] = useState({ cameras: [], microphones: [], speakers: [] });

    const [selectedCameraId, setSelectedCameraId] = useState("");

    const [selectedMicId, setSelectedMicId] = useState("");

    const [selectedSpeakerId, setSelectedSpeakerId] = useState("");

    const [speakerSelectionSupported, setSpeakerSelectionSupported] = useState(false);

    // ==========================================
    // LOAD MEETING (fallback path only)
    // ==========================================

    useEffect(() => {

        if (meeting) return;

        let cancelled = false;

        async function loadMeeting() {

            try {

                setMeetingLoading(true);

                const response = await getMeeting(id);

                if (!cancelled) setMeeting(response.meeting);

            } catch (error) {

                console.error(error);

                if (!cancelled) {
                    setMeetingError(
                        error.response?.data?.message ||
                        "Unable to load this meeting. You may need to join it from the Meetings page first."
                    );
                }

            } finally {

                if (!cancelled) setMeetingLoading(false);

            }

        }

        loadMeeting();

        return () => { cancelled = true; };

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    // ==========================================
    // DEVICE SETUP
    // Runs once — acquires camera+mic, falling
    // back to whichever single device works so
    // one blocked device never blocks the other.
    // ==========================================

    useEffect(() => {

        // Already active in meetingSessionManager (Return to Meeting) --
        // reuse the existing camera/mic stream as-is, never re-acquire
        // media. streamRef.current is intentionally left unset in this
        // branch, so this effect's own cleanup below is a safe no-op.

        if (meetingSessionManager.hasActiveSession(id)) return;

        let cancelled = false;

        async function setupMedia() {

            if (!navigator.mediaDevices?.getUserMedia) {
                setMediaError(
                    "This browser does not support camera/microphone access."
                );
                setMediaReady(true);
                return;
            }

            let workingStream = null;
            const problems = [];

            try {

                workingStream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: true,
                });

            } catch (bothError) {

                try {

                    workingStream = await navigator.mediaDevices.getUserMedia({ audio: true });

                    problems.push(
                        `Camera access was blocked (${describeMediaError(bothError)}). ` +
                        "You can continue with your camera turned off."
                    );

                } catch (audioOnlyError) {

                    try {

                        workingStream = await navigator.mediaDevices.getUserMedia({ video: true });

                        problems.push(
                            `Microphone access was blocked (${describeMediaError(audioOnlyError)}). ` +
                            "You can continue with your microphone turned off."
                        );

                    } catch (videoOnlyError) {

                        if (!cancelled) {
                            setMediaError(
                                "Camera and microphone are both unavailable: " +
                                describeMediaError(videoOnlyError)
                            );
                            setMediaReady(true);
                        }

                        return;

                    }

                }

            }

            if (cancelled) {
                workingStream.getTracks().forEach((track) => track.stop());
                return;
            }

            streamRef.current = workingStream;

            setCameraOn(workingStream.getVideoTracks().length > 0);
            setMicOn(workingStream.getAudioTracks().length > 0);

            if (problems.length > 0) setMediaError(problems.join(" "));

            if (videoRef.current) videoRef.current.srcObject = workingStream;

            setMediaReady(true);

            await refreshDevices();

        }

        setupMedia();

        navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);

        return () => {

            cancelled = true;

            navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);

            // If this stream was successfully handed off to
            // meetingSessionManager (the user actually joined, then
            // navigated away), it's the SAME MediaStream object the
            // singleton now owns -- stopping its tracks here would kill
            // the persistent session's camera/mic, exactly the bug this
            // feature exists to fix. Only stop it when no session ever
            // claimed it (e.g. the user backed out of the pre-join
            // preview without joining).

            if (!meetingSessionManager.hasActiveSession(id)) {
                streamRef.current?.getTracks().forEach((track) => track.stop());
            }

            streamRef.current = null;

        };

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ==========================================
    // HAND OFF TO THE PERSISTENT SESSION
    // The moment a fresh join succeeds (stage
    // becomes "joined" with media ready),
    // meetingSessionManager takes ownership of the
    // camera/mic stream and the whole join/
    // signaling lifecycle from here on -- it will
    // keep running even if this component
    // unmounts later (route navigation). A no-op
    // if a session for this meeting is already
    // active (Return to Meeting).
    // ==========================================

    useEffect(() => {

        if (stage !== "joined" || !mediaReady) return;

        meetingSessionManager.joinSession({
            meetingId: meeting.id,
            meeting,
            currentUser,
            isHost,
            localStream: streamRef.current,
        });

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stage, mediaReady]);

    async function refreshDevices() {

        if (!navigator.mediaDevices?.enumerateDevices) return;

        try {

            const allDevices = await navigator.mediaDevices.enumerateDevices();

            setDevices({
                cameras: allDevices.filter((device) => device.kind === "videoinput"),
                microphones: allDevices.filter((device) => device.kind === "audioinput"),
                speakers: allDevices.filter((device) => device.kind === "audiooutput"),
            });

            setSpeakerSelectionSupported(
                typeof HTMLMediaElement !== "undefined" &&
                typeof HTMLMediaElement.prototype.setSinkId === "function"
            );

            const activeVideoTrack = streamRef.current?.getVideoTracks()[0];
            const activeAudioTrack = streamRef.current?.getAudioTracks()[0];

            if (activeVideoTrack) {
                setSelectedCameraId(activeVideoTrack.getSettings().deviceId || "");
            }

            if (activeAudioTrack) {
                setSelectedMicId(activeAudioTrack.getSettings().deviceId || "");
            }

        } catch (error) {

            console.error("Unable to list devices:", error);

        }

    }

    // ==========================================
    // TOGGLE MIC / CAMERA
    // Actually flips MediaStreamTrack.enabled —
    // not just a UI flag.
    // ==========================================

    function toggleMic() {

        const track = streamRef.current?.getAudioTracks()[0];

        if (!track) {
            toast.error("No microphone is available");
            return;
        }

        track.enabled = !track.enabled;

        setMicOn(track.enabled);

    }

    function toggleCamera() {

        const track = streamRef.current?.getVideoTracks()[0];

        if (!track) {
            toast.error("No camera is available");
            return;
        }

        track.enabled = !track.enabled;

        setCameraOn(track.enabled);

    }

    // Unconditional (as opposed to toggleMic/toggleCamera) — used
    // when the host forces a mute/camera-off via meeting:force-mute
    // / meeting:force-camera-off, where the target must always end
    // up OFF regardless of its current state, never re-enabled.

    function muteMic() {

        const track = streamRef.current?.getAudioTracks()[0];

        if (!track) return;

        track.enabled = false;

        setMicOn(false);

    }

    function disableCamera() {

        const track = streamRef.current?.getVideoTracks()[0];

        if (!track) return;

        track.enabled = false;

        setCameraOn(false);

    }

    // ==========================================
    // DEVICE SWITCHING
    // Stops the old track and replaces it inside
    // the SAME MediaStream object (rather than
    // creating a new stream), so the reference
    // held by the <video> element — and, in
    // Phase 8, by any RTCRtpSender — stays valid.
    // ==========================================

    async function handleCameraChange(deviceId) {

        if (!deviceId || !streamRef.current) return;

        try {

            const replacement = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: deviceId } },
            });

            const newTrack = replacement.getVideoTracks()[0];

            streamRef.current.getVideoTracks().forEach((track) => {
                track.stop();
                streamRef.current.removeTrack(track);
            });

            newTrack.enabled = cameraOn;

            streamRef.current.addTrack(newTrack);

            if (videoRef.current) videoRef.current.srcObject = streamRef.current;

            setSelectedCameraId(deviceId);

        } catch (error) {

            console.error(error);

            toast.error("Unable to switch camera: " + describeMediaError(error));

        }

    }

    async function handleMicChange(deviceId) {

        if (!deviceId || !streamRef.current) return;

        try {

            const replacement = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: deviceId } },
            });

            const newTrack = replacement.getAudioTracks()[0];

            streamRef.current.getAudioTracks().forEach((track) => {
                track.stop();
                streamRef.current.removeTrack(track);
            });

            newTrack.enabled = micOn;

            streamRef.current.addTrack(newTrack);

            setSelectedMicId(deviceId);

        } catch (error) {

            console.error(error);

            toast.error("Unable to switch microphone: " + describeMediaError(error));

        }

    }

    async function handleSpeakerChange(deviceId) {

        setSelectedSpeakerId(deviceId);

        if (videoRef.current?.setSinkId) {

            try {
                await videoRef.current.setSinkId(deviceId);
            } catch (error) {
                console.error(error);
                toast.error("Unable to switch speaker");
            }

        }

    }

    // ==========================================
    // WAITING ROOM — REAL-TIME ADMIT/REJECT
    // Uses the existing Phase 5 socket events
    // (meeting:admitted / meeting:rejected),
    // emitted to this user's already-established
    // personal room. Not WebRTC signaling.
    // ==========================================

    useEffect(() => {

        if (stage !== "waiting" || !meeting) return;

        connectSocket();

        function handleAdmitted(data) {
            if (Number(data.meetingId) === Number(meeting.id)) {
                toast.success("The host admitted you to the meeting");
                setStage("joined");
            }
        }

        function handleRejected(data) {
            if (Number(data.meetingId) === Number(meeting.id)) {
                toast.error("The host declined your request to join");
                setStage("rejected");
            }
        }

        socket.on("meeting:admitted", handleAdmitted);
        socket.on("meeting:rejected", handleRejected);

        return () => {
            socket.off("meeting:admitted", handleAdmitted);
            socket.off("meeting:rejected", handleRejected);
        };

    }, [stage, meeting]);

    // ==========================================
    // JOIN NOW
    // ==========================================

    // Entry points that already performed the join/start
    // action for us (JoinMeetingModal, MeetingLinkLanding)
    // set the initial stage straight to "waiting"/"joined",
    // so this "preview" stage — and its Join Now button —
    // is only ever reached when a live join/start still
    // needs to happen.

    const alreadyResolved = Boolean(location.state?.participantStatus);

    async function handleJoinNow() {

        try {

            setJoinLoading(true);

            if (meeting.status === "live") {

                const response = await joinMeeting(meeting.meeting_code, joinPassword);

                setStage(response.participantStatus === "waiting" ? "waiting" : "joined");

            } else if (meeting.status === "scheduled" && (isHost || currentUser?.role === "admin")) {

                await startMeeting(meeting.id);

                setStage("joined");

            } else {

                toast.error("This meeting hasn't started yet");

            }

        } catch (error) {

            console.error(error);

            toast.error(error.response?.data?.message || "Unable to join meeting");

        } finally {

            setJoinLoading(false);

        }

    }

    // ==========================================
    // LEAVE / CANCEL
    // ==========================================

    // Only reached pre-join now (the waiting-room "Cancel" button) --
    // no meetingSessionManager session exists yet at that stage, so
    // this keeps its original full teardown exactly as before.

    async function handleLeave() {

        if (meeting) {
            socket.emit("meeting:leave", { meetingId: meeting.id });
        }

        streamRef.current?.getTracks().forEach((track) => track.stop());

        try {
            if (meeting) await leaveMeeting(meeting.id);
        } catch (error) {
            console.error(error);
        }

        navigate(`${basePath}/meetings`);

    }

    // Passed to <MeetingRoom onLeave={...}> -- MeetingRoom's own Leave
    // button already calls meetingSessionManager.leaveSession() (the
    // one place real teardown happens) before invoking this, so this
    // is a pure navigation callback, never a second teardown.

    function handleRoomLeave() {
        navigate(`${basePath}/meetings`);
    }

    // Used when the meeting has already ended (host ended it, or the
    // meeting:ended/removed broadcast arrived) — meetingSessionManager
    // already stopped every stream/connection the moment that
    // happened (see tearDownForTerminalState in
    // meetingSessionManager.js); acknowledgeTerminal() just clears the
    // session record itself. No REST leave call is made — the
    // participant record is already resolved server-side.

    function handleExitAfterEnd() {

        streamRef.current?.getTracks().forEach((track) => track.stop());

        meetingSessionManager.acknowledgeTerminal();

        navigate(`${basePath}/meetings`);

    }

    // ==========================================
    // RENDER
    // ==========================================

    if (meetingLoading) {
        return <div className="wi-loading">Loading meeting...</div>;
    }

    if (meetingError || !meeting) {

        return (
            <div className="wi-page">
                <div className="wi-empty-state">
                    <FaExclamationTriangle />
                    <h3>Unable to open this meeting</h3>
                    <p>{meetingError || "Meeting not found."}</p>
                    <button
                        type="button"
                        className="wi-secondary-button"
                        onClick={() => navigate(`${basePath}/meetings`)}
                    >
                        Back to Meetings
                    </button>
                </div>
            </div>
        );

    }

    const needsPassword =
        meeting.has_password && !isHost && meeting.status === "live" && !alreadyResolved;

    // The "joined" stage renders the actual video-call room, which
    // wants to fit the available WorkHub content area rather than
    // grow with the standard page padding/breadcrumb chrome (that's
    // what was producing an extra outer page scrollbar on top of the
    // room's own layout). Every other stage keeps the normal .wi-page
    // treatment unchanged.

    return (

        <div className={stage === "joined" ? "wi-page meeting-room-page" : "wi-page"}>

            <div className="wi-breadcrumb">
                <button type="button" onClick={() => navigate(`${basePath}/meetings/${meeting.id}`)}>
                    <FaArrowLeft /> {meeting.title}
                </button>
                <span>/</span>
                <span className="current">
                    {stage === "joined" ? "Room" : "Lobby"}
                </span>
            </div>

            {stage === "waiting" ? (

                <div className="meeting-lobby-waiting">

                    <FaHourglassHalf />

                    <h2>You are in the waiting room</h2>

                    <p>
                        The host has been notified. You'll be admitted automatically as
                        soon as {meeting.host_name} lets you in.
                    </p>

                    <button
                        type="button"
                        className="wi-secondary-button"
                        onClick={handleLeave}
                    >
                        <FaSignOutAlt /> Cancel
                    </button>

                </div>

            ) : stage === "rejected" ? (

                <div className="meeting-lobby-waiting meeting-lobby-rejected">

                    <FaExclamationTriangle />

                    <h2>Your request to join was declined</h2>

                    <p>The host did not admit you to this meeting.</p>

                    <button
                        type="button"
                        className="wi-secondary-button"
                        onClick={() => navigate(`${basePath}/meetings`)}
                    >
                        Back to Meetings
                    </button>

                </div>

            ) : stage === "joined" ? (

                // Entry points that resolve straight to "joined" on
                // mount (JoinMeetingModal, MeetingLinkLanding) can get
                // here before the camera/mic setup effect above has
                // finished. MeetingRoom captures streamRef.current only
                // once, on its own mount, so it must wait for that
                // effect to settle (mediaReady) rather than risk
                // starting peer connections with a stream that isn't
                // there yet.

                mediaReady ? (

                    <MeetingRoom
                        meeting={meeting}
                        currentUser={currentUser}
                        isHost={isHost}
                        localStream={streamRef.current}
                        onLeave={handleRoomLeave}
                        onEnded={handleExitAfterEnd}
                        devices={devices}
                        selectedCameraId={selectedCameraId}
                        selectedMicId={selectedMicId}
                        selectedSpeakerId={selectedSpeakerId}
                        speakerSelectionSupported={speakerSelectionSupported}
                        onCameraChange={handleCameraChange}
                        onMicChange={handleMicChange}
                        onSpeakerChange={handleSpeakerChange}
                    />

                ) : (

                    <div className="wi-loading">Setting up your camera and microphone...</div>

                )

            ) : (

                <div className="meeting-lobby">

                    <div className="meeting-lobby-preview-column">

                        <div className="meeting-lobby-preview">

                            <video ref={videoRef} autoPlay muted playsInline />

                            {!cameraOn && mediaReady && (
                                <div className="meeting-lobby-avatar-overlay">
                                    <span className="meeting-lobby-avatar">
                                        {currentUser?.fullName?.charAt(0).toUpperCase() || "U"}
                                    </span>
                                </div>
                            )}

                            {!mediaReady && (
                                <div className="meeting-lobby-preview-loading">
                                    Setting up your camera...
                                </div>
                            )}

                        </div>

                        <div className="meeting-lobby-device-row">

                            <button
                                type="button"
                                className={micOn ? "meeting-device-toggle on" : "meeting-device-toggle"}
                                onClick={toggleMic}
                                disabled={!mediaReady}
                                aria-label={micOn ? "Turn microphone off" : "Turn microphone on"}
                                title={micOn ? "Turn microphone off" : "Turn microphone on"}
                            >
                                {micOn ? <FaMicrophone /> : <FaMicrophoneSlash />}
                                {micOn ? "Mic On" : "Mic Off"}
                            </button>

                            <button
                                type="button"
                                className={cameraOn ? "meeting-device-toggle on" : "meeting-device-toggle"}
                                onClick={toggleCamera}
                                disabled={!mediaReady}
                                aria-label={cameraOn ? "Turn camera off" : "Turn camera on"}
                                title={cameraOn ? "Turn camera off" : "Turn camera on"}
                            >
                                {cameraOn ? <FaVideo /> : <FaVideoSlash />}
                                {cameraOn ? "Camera On" : "Camera Off"}
                            </button>

                        </div>

                        {mediaError && (
                            <div className="meeting-lobby-media-error">
                                <FaExclamationTriangle /> {mediaError}
                            </div>
                        )}

                        <div className="meeting-lobby-device-selects">

                            <div className="meeting-form-group">
                                <label htmlFor="lobby-camera-select">Camera</label>
                                <select
                                    id="lobby-camera-select"
                                    value={selectedCameraId}
                                    onChange={(event) => handleCameraChange(event.target.value)}
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
                                <label htmlFor="lobby-mic-select">Microphone</label>
                                <select
                                    id="lobby-mic-select"
                                    value={selectedMicId}
                                    onChange={(event) => handleMicChange(event.target.value)}
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
                                    <label htmlFor="lobby-speaker-select">Speaker</label>
                                    <select
                                        id="lobby-speaker-select"
                                        value={selectedSpeakerId}
                                        onChange={(event) => handleSpeakerChange(event.target.value)}
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

                    <div className="meeting-lobby-info-column">

                        <span className="meeting-lobby-brand">Reinsteins WorkHub</span>

                        <h1>Ready to join?</h1>

                        <div className="meeting-lobby-meta">

                            <div>
                                <label>Meeting</label>
                                <span>{meeting.title}</span>
                            </div>

                            <div>
                                <label>Host</label>
                                <span>{meeting.host_name}</span>
                            </div>

                            <div>
                                <label>Meeting ID</label>
                                <span className="wi-code">{meeting.meeting_code}</span>
                            </div>

                            <div>
                                <label>Joining as</label>
                                <span>{currentUser?.fullName}</span>
                            </div>

                        </div>

                        {needsPassword && (
                            <div className="meeting-form-group">
                                <label htmlFor="lobby-password">Meeting Password</label>
                                <input
                                    id="lobby-password"
                                    type="password"
                                    placeholder="Enter the meeting password"
                                    value={joinPassword}
                                    onChange={(event) => setJoinPassword(event.target.value)}
                                />
                            </div>
                        )}

                        {meeting.status === "scheduled" && !isHost && currentUser?.role !== "admin" ? (

                            <p className="meeting-lobby-hint">
                                This meeting hasn't started yet. You'll be able to join once
                                the host starts it.
                            </p>

                        ) : (

                            <button
                                type="button"
                                className="wi-primary-button meeting-lobby-join-button"
                                onClick={handleJoinNow}
                                disabled={joinLoading}
                            >
                                {joinLoading
                                    ? "Joining..."
                                    : meeting.status === "live"
                                        ? "Join Now"
                                        : "Start Meeting"}
                            </button>

                        )}

                        <button
                            type="button"
                            className="wi-secondary-button"
                            onClick={handleLeave}
                        >
                            <FaArrowLeft /> Back
                        </button>

                    </div>

                </div>

            )}

        </div>

    );

}

export default MeetingLobby;
