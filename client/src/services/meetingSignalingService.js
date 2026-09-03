// ==========================================
// MEETING WEBRTC SIGNALING (MESH)
//
// Multi-peer counterpart to callService.js's
// 1:1 design. callService.js keeps a single
// module-level RTCPeerConnection because only
// one call is ever active; a meeting can have
// several participants at once, so this keeps
// a Map<userId, RTCPeerConnection> instead —
// one direct connection per other participant
// (mesh topology, intentionally V1, ~2-8 people).
//
// Reuses the exact STUN configuration already
// proven in callService.js. No TURN server yet.
//
// This module owns only the RTCPeerConnection
// lifecycle. It does not touch Socket.IO itself —
// the caller (MeetingRoom.jsx) wires the
// onIceCandidate callback to socket.emit(
// "meeting:offer"/"meeting:answer"/"meeting:ice-candidate")
// using the exact Phase 5 event names/payloads.
// ==========================================

const peerConnectionConfig = {
  iceServers: [
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
      ],
    },
  ],
};

let localStream = null;

// While screen sharing is active, this is the track every
// peer connection's outgoing video sender should carry
// instead of the camera track — including connections
// created AFTER sharing started (a participant joining
// mid-share must also receive the screen, not the camera).

let outgoingVideoTrack = null;

const peerConnections = new Map();

const remoteStreams = new Map();

// ICE candidates can arrive before setRemoteDescription()
// finishes — queued per-peer until it's safe to add them,
// same approach as callService.js's single-peer queue.

const pendingIceCandidates = new Map();

let handlers = {
  onRemoteStream: null,
  onPeerClosed: null,
  onIceCandidate: null,
  onConnectionStateChange: null,
};

export const setLocalStream = (stream) => {
  localStream = stream;
};

export const init = (newHandlers = {}) => {
  handlers = { ...handlers, ...newHandlers };
};

const attachLocalTracks = (peerConnection) => {
  if (!localStream) return;

  localStream.getTracks().forEach((track) => {
    const trackToSend = track.kind === "video" && outgoingVideoTrack ? outgoingVideoTrack : track;

    const alreadyAdded = peerConnection
      .getSenders()
      .some((sender) => sender.track?.id === trackToSend.id);

    if (!alreadyAdded) {
      peerConnection.addTrack(trackToSend, localStream);
    }
  });
};

// ==========================================
// SCREEN SHARE (Phase 9)
//
// Swaps the outgoing video track on every
// existing peer connection's sender via
// RTCRtpSender.replaceTrack() — no SDP
// renegotiation, no second video track, no
// new offer/answer round trip. Also records
// the track so any peer connection created
// AFTER sharing starts (a late joiner) picks
// it up automatically via attachLocalTracks.
//
// Trade-off this implies: remote participants
// see either your camera OR your shared
// screen in your video slot, never both at
// once — a second simultaneous video track
// would require full renegotiation, which is
// deliberately out of scope for V1.
// ==========================================

export const setActiveVideoTrack = async (track) => {
  outgoingVideoTrack = track || null;

  const targetTrack = outgoingVideoTrack || localStream?.getVideoTracks()[0] || null;

  for (const peerConnection of peerConnections.values()) {
    const sender = peerConnection
      .getSenders()
      .find((candidate) => candidate.track && candidate.track.kind === "video");

    if (sender) {

      if (sender.track?.id !== targetTrack?.id) {
        try {
          await sender.replaceTrack(targetTrack);
        } catch (error) {
          console.error("Unable to replace outgoing video track:", error);
        }
      }

    } else if (targetTrack) {

      // No video sender exists yet (camera permission was never
      // granted, so only an audio track was ever attached) — add
      // the screen track fresh instead of replacing.

      try {
        peerConnection.addTrack(targetTrack, localStream || new MediaStream([targetTrack]));
      } catch (error) {
        console.error("Unable to add outgoing video track:", error);
      }

    }
  }
};

export const createPeerConnection = (targetUserId) => {
  const userId = Number(targetUserId);

  const existing = peerConnections.get(userId);
  if (existing) return existing;

  const peerConnection = new RTCPeerConnection(peerConnectionConfig);

  attachLocalTracks(peerConnection);

  peerConnection.ontrack = (event) => {
    let stream = remoteStreams.get(userId);

    if (!stream) {
      stream = new MediaStream();
      remoteStreams.set(userId, stream);
    }

    const incomingTracks = event.streams?.[0]
      ? event.streams[0].getTracks()
      : event.track
        ? [event.track]
        : [];

    incomingTracks.forEach((track) => {
      const exists = stream.getTracks().some((t) => t.id === track.id);
      if (!exists) stream.addTrack(track);
    });

    if (typeof handlers.onRemoteStream === "function") {
      handlers.onRemoteStream(userId, stream);
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && typeof handlers.onIceCandidate === "function") {
      handlers.onIceCandidate(userId, event.candidate);
    }
  };

  peerConnection.onconnectionstatechange = () => {
    if (typeof handlers.onConnectionStateChange === "function") {
      handlers.onConnectionStateChange(userId, peerConnection.connectionState);
    }
  };

  peerConnections.set(userId, peerConnection);
  pendingIceCandidates.set(userId, []);

  return peerConnection;
};

const processPendingIceCandidates = async (userId) => {
  const peerConnection = peerConnections.get(userId);
  const queued = pendingIceCandidates.get(userId);

  if (!peerConnection || !peerConnection.remoteDescription || !queued?.length) return;

  const candidates = [...queued];
  pendingIceCandidates.set(userId, []);

  for (const candidate of candidates) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error("Queued meeting ICE candidate error:", error);
    }
  }
};

// ==========================================
// Called by the newly-joining participant,
// once per already-present participant
// (see meeting:room-participants handling
// in MeetingRoom.jsx) — this is the only
// side that ever calls createOffer, which
// avoids glare / duplicate offer-answer pairs.
// ==========================================

export const createOffer = async (targetUserId) => {
  const peerConnection = createPeerConnection(targetUserId);

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  return peerConnection.localDescription;
};

export const handleOffer = async (fromUserId, offer) => {
  const peerConnection = createPeerConnection(fromUserId);

  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  await processPendingIceCandidates(Number(fromUserId));

  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  return peerConnection.localDescription;
};

export const handleAnswer = async (fromUserId, answer) => {
  const peerConnection = peerConnections.get(Number(fromUserId));

  if (!peerConnection || !answer) return;

  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  await processPendingIceCandidates(Number(fromUserId));
};

export const handleIceCandidate = async (fromUserId, candidate) => {
  if (!candidate) return;

  const userId = Number(fromUserId);
  const peerConnection = peerConnections.get(userId);

  if (!peerConnection || !peerConnection.remoteDescription) {
    const queue = pendingIceCandidates.get(userId) || [];
    queue.push(candidate);
    pendingIceCandidates.set(userId, queue);
    return;
  }

  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    console.error("Meeting ICE candidate error:", error);
  }
};

export const removePeer = (targetUserId) => {
  const userId = Number(targetUserId);
  const peerConnection = peerConnections.get(userId);

  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
  }

  peerConnections.delete(userId);
  pendingIceCandidates.delete(userId);
  remoteStreams.delete(userId);

  if (typeof handlers.onPeerClosed === "function") {
    handlers.onPeerClosed(userId);
  }
};

export const hasPeer = (targetUserId) => peerConnections.has(Number(targetUserId));

export const getPeerIds = () => Array.from(peerConnections.keys());

export const cleanupAll = () => {
  Array.from(peerConnections.keys()).forEach((userId) => {
    const peerConnection = peerConnections.get(userId);

    if (peerConnection) {
      peerConnection.ontrack = null;
      peerConnection.onicecandidate = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.close();
    }
  });

  peerConnections.clear();
  pendingIceCandidates.clear();
  remoteStreams.clear();

  localStream = null;
  outgoingVideoTrack = null;

  handlers = {
    onRemoteStream: null,
    onPeerClosed: null,
    onIceCandidate: null,
    onConnectionStateChange: null,
  };
};
