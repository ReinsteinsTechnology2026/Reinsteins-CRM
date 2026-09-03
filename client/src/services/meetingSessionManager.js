import { toast } from "react-toastify";

import {
    getParticipants,
    endMeeting,
    setMeetingLock,
    admitParticipant,
    rejectParticipant,
    removeParticipant,
    changeParticipantRole,
    getMeetingMessages,
    sendMeetingMessage,
    sendMeetingAttachment,
    leaveMeeting,
} from "./meetingService";

import socket, { connectSocket } from "./socket";

import * as meetingSignalingService from "./meetingSignalingService";

// ==========================================
// MEETING SESSION MANAGER
//
// Module-level singleton -- exists independently
// of any component's mount/unmount, the same
// convention already used by socket.js and
// meetingSignalingService.js in this codebase.
//
// Owns the live meeting session's domain state
// and its entire join/signaling lifecycle (moved
// here from MeetingRoom.jsx, which used to own it
// inside a useEffect whose cleanup ran on every
// unmount -- including ordinary route navigation,
// which is exactly what disconnected the meeting
// when a user clicked a sidebar link). Because
// this state now lives in a plain module instead
// of a component, navigating away no longer tears
// any of it down -- only leaveSession() does.
//
// React components read a snapshot via
// hooks/useMeetingSession.js (useSyncExternalStore)
// and call actions directly from this module.
// ==========================================

const INITIAL_CONTROL_STATE = {
    myRequestPending: false,
    incomingRequest: null,
    grantedToUserId: null,
    grantedToName: null,
    grantedToMe: false,
};

function emptyState() {
    return {
        active: false,
        meetingId: null,
        meeting: null,
        currentUser: null,
        isHost: false,

        localStream: null,
        micOn: true,
        cameraOn: true,
        screenStream: null,
        isSharingScreen: false,

        participants: {},
        remoteStreams: {},
        connectionLost: false,
        terminalState: null, // null | "ended" | "removed"
        presentingUserId: null,
        presentingName: null,
        myRole: "participant",
        waitingParticipants: [],
        isLocked: false,
        messages: [],
        unreadChat: 0,
        controlState: INITIAL_CONTROL_STATE,
    };
}

let state = emptyState();
let snapshot = state;

// Internal-only bookkeeping -- never exposed in the snapshot.
let hasJoinedOnce = false;
let lastReactionSentAt = 0;
let roleByUserId = new Map();
let chatPanelOpen = false;
let registeredHandlers = null; // set of { eventName, handler } pairs from the last joinSession()

const listeners = new Set();
const eventListeners = new Set();

function notify() {
    snapshot = { ...state };
    listeners.forEach((listener) => listener());
}

function emitEvent(event) {
    eventListeners.forEach((listener) => listener(event));
}

export function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getSnapshot() {
    return snapshot;
}

export function subscribeToEvents(listener) {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
}

export function hasActiveSession(meetingId) {
    return state.active && Number(state.meetingId) === Number(meetingId);
}

// ==========================================
// INTERNAL HELPERS
// ==========================================

function selfId() {
    return Number(state.currentUser?.id);
}

function deriveIsHost(userId) {
    return Number(userId) === Number(state.meeting?.host_id);
}

function roleFor(userId) {
    return roleByUserId.get(Number(userId)) || (deriveIsHost(userId) ? "host" : "participant");
}

function buildParticipant(userId, fullName) {
    const role = roleFor(userId);
    return {
        userId: Number(userId),
        fullName: fullName || "Participant",
        role,
        roleLabel: role === "co_host" ? "Co-Host" : role === "presenter" ? "Presenter" : null,
        isHost: deriveIsHost(userId),
        micOn: true,
        cameraOn: true,
        handRaised: false,
        connectionState: "connected",
    };
}

function broadcastMediaState() {
    const audioTrack = state.localStream?.getAudioTracks()[0];
    const videoTrack = state.localStream?.getVideoTracks()[0];

    socket.emit("meeting:media-state", {
        meetingId: state.meetingId,
        isMuted: audioTrack ? !audioTrack.enabled : true,
        isCameraOff: videoTrack ? !videoTrack.enabled : true,
    });
}

async function loadRoles() {
    try {
        const response = await getParticipants(state.meetingId);
        (response.participants || []).forEach((p) => {
            roleByUserId.set(Number(p.user_id), p.role);
        });
        state.myRole = roleFor(selfId());
        notify();
    } catch (error) {
        console.error("Unable to load participant roles:", error);
    }
}

async function refreshWaitingRoom() {

    const canModerate = state.isHost || state.myRole === "co_host";
    if (!canModerate) return;

    try {
        const response = await getParticipants(state.meetingId);
        state.waitingParticipants = (response.participants || []).filter((p) => p.status === "waiting");
        notify();
    } catch (error) {
        console.error("Unable to load waiting room:", error);
    }

}

async function refreshRoles() {

    try {

        const response = await getParticipants(state.meetingId);

        roleByUserId.clear();
        (response.participants || []).forEach((p) => roleByUserId.set(Number(p.user_id), p.role));

        state.myRole = roleFor(selfId());

        const nextParticipants = { ...state.participants };
        Object.keys(nextParticipants).forEach((key) => {
            const uid = Number(key);
            const role = roleFor(uid);
            nextParticipants[uid] = {
                ...nextParticipants[uid],
                role,
                roleLabel: role === "co_host" ? "Co-Host" : role === "presenter" ? "Presenter" : null,
            };
        });
        state.participants = nextParticipants;

        notify();

    } catch (error) {
        console.error("Unable to refresh participant roles:", error);
    }

}

async function loadChatHistory() {
    try {
        const response = await getMeetingMessages(state.meetingId);
        state.messages = response.messages || [];
        notify();
    } catch (error) {
        console.error("Unable to load meeting chat history:", error);
    }
}

// ==========================================
// SOCKET HANDLERS (moved verbatim from
// MeetingRoom.jsx's former lifecycle effect)
// ==========================================

function handleRoomParticipants(data) {

    if (Number(data.meetingId) !== state.meetingId) return;

    (data.participants || []).forEach(async (p) => {

        const userId = Number(p.userId);

        if (!state.participants[userId]) {
            state.participants = { ...state.participants, [userId]: buildParticipant(userId, p.fullName) };
            notify();
        }

        try {
            const offer = await meetingSignalingService.createOffer(userId);
            socket.emit("meeting:offer", { meetingId: state.meetingId, targetUserId: userId, offer });
        } catch (error) {
            console.error("Unable to create meeting offer:", error);
        }

    });

    broadcastMediaState();

}

function handleParticipantJoined(data) {

    if (Number(data.meetingId) !== state.meetingId) return;
    if (Number(data.userId) === selfId()) return;

    const userId = Number(data.userId);

    if (!state.participants[userId]) {
        state.participants = { ...state.participants, [userId]: buildParticipant(userId, data.fullName) };
        notify();
    }

    broadcastMediaState();

}

function handleParticipantLeft(data) {

    if (Number(data.meetingId) !== state.meetingId) return;

    const userId = Number(data.userId);

    meetingSignalingService.removePeer(userId);

    const nextParticipants = { ...state.participants };
    delete nextParticipants[userId];
    state.participants = nextParticipants;

    const nextRemoteStreams = { ...state.remoteStreams };
    delete nextRemoteStreams[userId];
    state.remoteStreams = nextRemoteStreams;

    const wasPresenting = state.presentingUserId === userId;

    if (state.presentingUserId === userId) state.presentingUserId = null;

    if (wasPresenting) {
        state.presentingName = null;
        state.controlState = INITIAL_CONTROL_STATE;
    }

    notify();

}

async function handleRemoteOffer(data) {

    if (Number(data.meetingId) !== state.meetingId) return;

    const fromUserId = Number(data.fromUserId);

    if (!state.participants[fromUserId]) {
        state.participants = { ...state.participants, [fromUserId]: buildParticipant(fromUserId, undefined) };
        notify();
    }

    try {
        const answer = await meetingSignalingService.handleOffer(fromUserId, data.offer);
        socket.emit("meeting:answer", { meetingId: state.meetingId, targetUserId: fromUserId, answer });
    } catch (error) {
        console.error("Unable to answer meeting offer:", error);
    }

}

async function handleRemoteAnswer(data) {

    if (Number(data.meetingId) !== state.meetingId) return;

    try {
        await meetingSignalingService.handleAnswer(Number(data.fromUserId), data.answer);
    } catch (error) {
        console.error("Unable to process meeting answer:", error);
    }

}

async function handleRemoteIce(data) {

    if (Number(data.meetingId) !== state.meetingId) return;

    await meetingSignalingService.handleIceCandidate(Number(data.fromUserId), data.candidate);

}

function handleMediaStateChanged(data) {

    const userId = Number(data.userId);

    if (!state.participants[userId]) return;

    state.participants = {
        ...state.participants,
        [userId]: { ...state.participants[userId], micOn: !data.isMuted, cameraOn: !data.isCameraOff },
    };

    notify();

}

function handleHandRaised(data) {

    const userId = Number(data.userId);

    if (!state.participants[userId]) return;

    state.participants = {
        ...state.participants,
        [userId]: { ...state.participants[userId], handRaised: Boolean(data.raised) },
    };

    notify();

}

function handleScreenShareChanged(data) {

    const userId = Number(data.userId);

    state.presentingUserId = data.sharing ? userId : (state.presentingUserId === userId ? null : state.presentingUserId);
    state.presentingName = data.sharing ? data.fullName : null;

    if (!data.sharing) state.controlState = INITIAL_CONTROL_STATE;

    notify();

}

function handleChatMessage(message) {

    if (Number(message.meeting_id) !== state.meetingId) return;

    state.messages = [...state.messages, message];

    if (!chatPanelOpen && Number(message.sender_id) !== selfId()) {
        state.unreadChat += 1;
    }

    notify();

}

function handleReactionBroadcast(data) {
    emitEvent({ type: "reaction", emoji: data.reaction });
}

function handleControlRequested(data) {
    if (Number(data.meetingId) !== state.meetingId) return;
    state.controlState = {
        ...state.controlState,
        incomingRequest: { userId: Number(data.fromUserId), fromName: data.fromName },
    };
    notify();
}

function handleControlResponse(data) {
    if (Number(data.meetingId) !== state.meetingId) return;
    if (data.approved) {
        state.controlState = { ...state.controlState, myRequestPending: false, grantedToMe: true };
        toast.success("You have been given control");
    } else {
        state.controlState = { ...state.controlState, myRequestPending: false };
        toast.error("Your request for control was denied");
    }
    notify();
}

function handleControlRevoked(data) {
    if (Number(data.meetingId) !== state.meetingId) return;
    state.controlState = { ...state.controlState, grantedToMe: false };
    notify();
    toast("Your control was revoked", { icon: "⛔" });
}

function handleWaitingRoomUpdate(data) {
    if (data?.meetingId && Number(data.meetingId) !== state.meetingId) return;
    refreshWaitingRoom();
}

function handleParticipantUpdated(data) {

    if (Number(data.meetingId) !== state.meetingId) return;

    refreshWaitingRoom();

    if (data.action === "role") refreshRoles();

    // Removal itself is NOT handled here -- the removed user's own
    // client (see handleRemoved below) emits meeting:leave on its
    // way out, which produces the normal meeting:participant-left
    // broadcast everyone else already listens for.

}

function handleLockChanged(data) {
    state.isLocked = Boolean(data.isLocked);
    notify();
}

function handleForceMute(data) {
    if (data?.meetingId && Number(data.meetingId) !== state.meetingId) return;
    const audioTrack = state.localStream?.getAudioTracks()[0];
    if (audioTrack && audioTrack.enabled) {
        muteSelf();
        broadcastMediaState();
        toast("You were muted by the host", { icon: "🔇" });
    }
}

function handleForceCameraOff(data) {
    if (data?.meetingId && Number(data.meetingId) !== state.meetingId) return;
    const videoTrack = state.localStream?.getVideoTracks()[0];
    if (videoTrack && videoTrack.enabled) {
        disableCameraSelf();
        broadcastMediaState();
        toast("Your camera was turned off by the host", { icon: "📵" });
    }
}

// Both of these mean the meeting is genuinely over for this user --
// unlike leaveSession(), there's no REST leave call (the participant
// record is already resolved server-side: removed, or the meeting
// itself ended), but local resources (camera/mic/screen tracks, peer
// connections, listeners) are torn down immediately, exactly as a
// real leave would. terminalState stays set so whichever UI is
// currently showing (MeetingRoom's terminal screen, or
// PersistentMeetingBar's toast) can react once, then call
// acknowledgeTerminal() to fully clear the session.

function tearDownForTerminalState() {
    state.localStream?.getTracks().forEach((track) => track.stop());
    state.screenStream?.getTracks().forEach((track) => track.stop());
    meetingSignalingService.cleanupAll();
    unregisterListeners();
}

function handleRemoved(data) {

    if (data?.meetingId && Number(data.meetingId) !== state.meetingId) return;

    // Tell the room we're gone BEFORE tearing down locally, so every
    // other participant gets the normal meeting:participant-left
    // broadcast and actually closes its peer connection to us.

    socket.emit("meeting:leave", { meetingId: state.meetingId });

    tearDownForTerminalState();
    state.terminalState = "removed";
    notify();

}

function handleMeetingEndedEvent(data) {
    if (data?.meetingId && Number(data.meetingId) !== state.meetingId) return;
    tearDownForTerminalState();
    state.terminalState = "ended";
    notify();
}

function handleMeetingError(data) {
    toast.error(data?.message || "A meeting signaling error occurred");
}

function setupSignaling() {

    meetingSignalingService.setLocalStream(state.localStream);

    meetingSignalingService.init({

        onRemoteStream: (userId, stream) => {
            state.remoteStreams = { ...state.remoteStreams, [userId]: stream };
            notify();
        },

        onIceCandidate: (userId, candidate) => {
            socket.emit("meeting:ice-candidate", { meetingId: state.meetingId, targetUserId: userId, candidate });
        },

        onConnectionStateChange: (userId, connState) => {

            if (connState === "failed" || connState === "closed") {

                meetingSignalingService.removePeer(userId);

                const nextRemoteStreams = { ...state.remoteStreams };
                delete nextRemoteStreams[userId];
                state.remoteStreams = nextRemoteStreams;

                const nextParticipants = { ...state.participants };
                delete nextParticipants[userId];
                state.participants = nextParticipants;

                notify();

            } else if (connState === "disconnected") {

                if (state.participants[userId]) {
                    state.participants = {
                        ...state.participants,
                        [userId]: { ...state.participants[userId], connectionState: "reconnecting" },
                    };
                    notify();
                }

            } else if (connState === "connected") {

                if (state.participants[userId]) {
                    state.participants = {
                        ...state.participants,
                        [userId]: { ...state.participants[userId], connectionState: "connected" },
                    };
                    notify();
                }

            }

        },

    });

}

function joinRoom() {

    hasJoinedOnce = true;

    state.participants = { [selfId()]: buildParticipant(selfId(), state.currentUser?.fullName) };
    state.remoteStreams = {};
    notify();

    socket.emit("meeting:join", { meetingId: state.meetingId });

}

function handleSocketDisconnect() {
    state.connectionLost = true;
    notify();
}

function handleSocketReconnect() {

    state.connectionLost = false;
    notify();

    if (!hasJoinedOnce) return;

    meetingSignalingService.cleanupAll();
    setupSignaling();
    joinRoom();

}

function registerListeners() {

    const entries = [
        ["meeting:room-participants", handleRoomParticipants],
        ["meeting:participant-joined", handleParticipantJoined],
        ["meeting:participant-left", handleParticipantLeft],
        ["meeting:offer", handleRemoteOffer],
        ["meeting:answer", handleRemoteAnswer],
        ["meeting:ice-candidate", handleRemoteIce],
        ["meeting:media-state-changed", handleMediaStateChanged],
        ["meeting:hand-raised", handleHandRaised],
        ["meeting:screen-share-changed", handleScreenShareChanged],
        ["meeting:chat-message", handleChatMessage],
        ["meeting:reaction-broadcast", handleReactionBroadcast],
        ["meeting:control-requested", handleControlRequested],
        ["meeting:control-response", handleControlResponse],
        ["meeting:control-revoked", handleControlRevoked],
        ["meeting:waiting-room-update", handleWaitingRoomUpdate],
        ["meeting:participant-updated", handleParticipantUpdated],
        ["meeting:lock-changed", handleLockChanged],
        ["meeting:force-mute", handleForceMute],
        ["meeting:force-camera-off", handleForceCameraOff],
        ["meeting:removed", handleRemoved],
        ["meeting:ended", handleMeetingEndedEvent],
        ["meeting:error", handleMeetingError],
        ["disconnect", handleSocketDisconnect],
        ["connect", handleSocketReconnect],
    ];

    entries.forEach(([eventName, handler]) => socket.on(eventName, handler));

    registeredHandlers = entries;

}

function unregisterListeners() {
    (registeredHandlers || []).forEach(([eventName, handler]) => socket.off(eventName, handler));
    registeredHandlers = null;
}

// ==========================================
// PUBLIC ACTIONS
// ==========================================

export async function joinSession({ meetingId, meeting, currentUser, isHost, localStream }) {

    if (hasActiveSession(meetingId)) return; // Return to Meeting -- already joined, no-op

    // A different meeting is still active (e.g. the user opened a
    // second meeting from MeetingsList while the first was minimized
    // in the persistent bar) -- a person can only meaningfully be in
    // one call at a time, so cleanly leave the old one first rather
    // than leaking its streams/connections/listeners.
    if (state.active) {
        await leaveSession();
    }

    state = emptyState();

    state.active = true;
    state.meetingId = Number(meetingId);
    state.meeting = meeting;
    state.currentUser = currentUser;
    state.isHost = Boolean(isHost);
    state.localStream = localStream;
    state.micOn = localStream?.getAudioTracks()[0]?.enabled ?? true;
    state.cameraOn = localStream?.getVideoTracks()[0]?.enabled ?? true;
    state.myRole = isHost ? "host" : "participant";

    roleByUserId = new Map();
    hasJoinedOnce = false;
    lastReactionSentAt = 0;
    chatPanelOpen = false;

    notify();

    registerListeners();

    connectSocket();

    await loadRoles();
    await Promise.all([loadChatHistory(), refreshWaitingRoom()]);

    setupSignaling();
    joinRoom();

}

export function setChatPanelOpen(open) {
    chatPanelOpen = open;
    if (open) {
        state.unreadChat = 0;
        notify();
    }
}

export function toggleMic() {
    const track = state.localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    state.micOn = track.enabled;
    notify();
    broadcastMediaState();
}

export function toggleCamera() {
    const track = state.localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    state.cameraOn = track.enabled;
    notify();
    broadcastMediaState();
}

export function muteSelf() {
    const track = state.localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = false;
    state.micOn = false;
    notify();
}

export function disableCameraSelf() {
    const track = state.localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = false;
    state.cameraOn = false;
    notify();
}

export async function startScreenShare() {

    if (state.isSharingScreen) return;

    if (state.presentingUserId && state.presentingUserId !== selfId()) {
        toast.error(`${state.presentingName || "Someone"} is already presenting`);
        return;
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
        toast.error("Screen sharing isn't supported in this browser");
        return;
    }

    try {

        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });

        const screenTrack = stream.getVideoTracks()[0];

        state.screenStream = stream;

        screenTrack.onended = () => stopScreenShare();

        await meetingSignalingService.setActiveVideoTrack(screenTrack);

        state.isSharingScreen = true;
        state.presentingUserId = selfId();
        state.presentingName = state.currentUser?.fullName;
        notify();

        socket.emit("meeting:screen-share-state", { meetingId: state.meetingId, sharing: true });

    } catch (error) {

        if (error.name !== "NotAllowedError") {
            console.error(error);
            toast.error("Unable to start screen sharing");
        }

    }

}

export async function stopScreenShare() {

    if (!state.isSharingScreen) return;

    state.screenStream?.getTracks().forEach((track) => track.stop());
    state.screenStream = null;

    const cameraTrack = state.localStream?.getVideoTracks()[0] || null;

    await meetingSignalingService.setActiveVideoTrack(cameraTrack);

    state.isSharingScreen = false;
    state.presentingUserId = null;
    state.presentingName = null;
    state.controlState = INITIAL_CONTROL_STATE;
    notify();

    socket.emit("meeting:screen-share-state", { meetingId: state.meetingId, sharing: false });

}

export function toggleRaiseHand(currentlyRaised) {
    const next = !currentlyRaised;
    socket.emit("meeting:hand-raise", { meetingId: state.meetingId, raised: next });
    return next;
}

export function sendReaction(emoji) {

    const now = Date.now();
    if (now - lastReactionSentAt < 400) return;
    lastReactionSentAt = now;

    socket.emit("meeting:reaction", { meetingId: state.meetingId, reaction: emoji });

}

export function requestControl() {
    if (!state.presentingUserId || state.presentingUserId === selfId()) return;
    socket.emit("meeting:control-request", { meetingId: state.meetingId, targetUserId: state.presentingUserId });
    state.controlState = { ...state.controlState, myRequestPending: true };
    notify();
}

export function respondToControlRequest(approved) {

    const request = state.controlState.incomingRequest;
    if (!request) return;

    socket.emit("meeting:control-response", { meetingId: state.meetingId, targetUserId: request.userId, approved });

    state.controlState = {
        ...state.controlState,
        incomingRequest: null,
        grantedToUserId: approved ? request.userId : null,
        grantedToName: approved ? request.fromName : null,
    };
    notify();

}

export function revokeControl() {
    if (!state.controlState.grantedToUserId) return;
    socket.emit("meeting:control-revoke", { meetingId: state.meetingId, targetUserId: state.controlState.grantedToUserId });
    state.controlState = { ...state.controlState, grantedToUserId: null, grantedToName: null };
    notify();
}

export async function sendChatMessage(text) {
    await sendMeetingMessage(state.meetingId, text);
    // meeting:chat-message (reaching everyone in the room, including
    // the sender) is what actually appends it -- nothing appended
    // optimistically here, matching the original behavior.
}

export async function sendChatAttachment(file) {
    await sendMeetingAttachment(state.meetingId, file);
}

export function muteParticipant(userId) {
    socket.emit("meeting:force-mute", { meetingId: state.meetingId, targetUserId: userId });
}

export function disableParticipantCamera(userId) {
    socket.emit("meeting:force-camera-off", { meetingId: state.meetingId, targetUserId: userId });
}

export async function removeParticipantFromMeeting(userId) {
    await removeParticipant(state.meetingId, userId);
}

export async function changeParticipantRoleInMeeting(userId, role) {
    await changeParticipantRole(state.meetingId, userId, role);
}

export async function admitWaiting(userId) {
    await admitParticipant(state.meetingId, userId);
    state.waitingParticipants = state.waitingParticipants.filter((p) => Number(p.user_id) !== Number(userId));
    notify();
}

export async function rejectWaiting(userId) {
    await rejectParticipant(state.meetingId, userId);
    state.waitingParticipants = state.waitingParticipants.filter((p) => Number(p.user_id) !== Number(userId));
    notify();
}

export function muteAllParticipants() {

    const targets = Object.values(state.participants).filter((p) => p.userId !== selfId() && p.micOn);

    targets.forEach((p) => {
        socket.emit("meeting:force-mute", { meetingId: state.meetingId, targetUserId: p.userId });
    });

    return targets.length;

}

export async function toggleLock() {
    await setMeetingLock(state.meetingId, !state.isLocked);
}

export async function endMeetingForAll() {
    await endMeeting(state.meetingId);
    // No local teardown here -- relies on the resulting meeting:ended
    // broadcast (handleMeetingEndedEvent above), same as today.
}

// Called once the terminal-state UI (MeetingRoom's end screen, or
// PersistentMeetingBar's toast) has been shown -- by this point
// tearDownForTerminalState() already stopped every stream/connection,
// so this just clears the session record itself.

export function acknowledgeTerminal() {
    state = emptyState();
    roleByUserId = new Map();
    hasJoinedOnce = false;
    chatPanelOpen = false;
    notify();
}

// ==========================================
// LEAVE SESSION -- the ONLY place that does
// real teardown. Called from the in-room Leave
// button and the persistent bar's Leave button.
// ==========================================

export async function leaveSession() {

    if (!state.active) return;

    const meetingId = state.meetingId;

    socket.emit("meeting:leave", { meetingId });

    state.localStream?.getTracks().forEach((track) => track.stop());
    state.screenStream?.getTracks().forEach((track) => track.stop());

    meetingSignalingService.cleanupAll();

    unregisterListeners();

    try {
        await leaveMeeting(meetingId);
    } catch (error) {
        console.error(error);
    }

    state = emptyState();
    roleByUserId = new Map();
    hasJoinedOnce = false;
    chatPanelOpen = false;

    notify();

}
