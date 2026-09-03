import socket from "./socket";

// ==========================================
// WEBRTC CONFIGURATION
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

// ==========================================
// CALL STATE
// ==========================================

let peerConnection = null;

let localStream = null;

let remoteStream = null;

let currentTargetUserId = null;

// ICE candidates can sometimes arrive
// before setRemoteDescription() finishes.
// We temporarily store them here.

let pendingIceCandidates = [];

// ==========================================
// CREATE PEER CONNECTION
// ==========================================

export const createPeerConnection = (
  targetUserId,
  onRemoteStream
) => {
  // ========================================
  // CLOSE OLD PEER CONNECTION
  // ========================================

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  currentTargetUserId =
    Number(targetUserId);

  pendingIceCandidates = [];

  // ========================================
  // CREATE NEW WEBRTC CONNECTION
  // ========================================

  peerConnection =
    new RTCPeerConnection(
      peerConnectionConfig
    );

  // ========================================
  // CREATE REMOTE MEDIA STREAM
  // ========================================

  remoteStream =
    new MediaStream();

  // ========================================
  // RECEIVE REMOTE AUDIO / VIDEO
  // ========================================

  peerConnection.ontrack =
    (event) => {
      const incomingStream =
        event.streams?.[0];

      if (incomingStream) {
        incomingStream
          .getTracks()
          .forEach(
            (track) => {
              const exists =
                remoteStream
                  .getTracks()
                  .some(
                    (
                      existingTrack
                    ) =>
                      existingTrack.id ===
                      track.id
                  );

              if (!exists) {
                remoteStream.addTrack(
                  track
                );
              }
            }
          );
      } else if (
        event.track
      ) {
        const exists =
          remoteStream
            .getTracks()
            .some(
              (
                existingTrack
              ) =>
                existingTrack.id ===
                event.track.id
            );

        if (!exists) {
          remoteStream.addTrack(
            event.track
          );
        }
      }

      if (
        typeof onRemoteStream ===
        "function"
      ) {
        onRemoteStream(
          remoteStream
        );
      }
    };

  // ========================================
  // SEND ICE CANDIDATES TO OTHER USER
  // ========================================

  peerConnection.onicecandidate =
    (event) => {
      if (
        event.candidate &&
        currentTargetUserId
      ) {
        socket.emit(
          "webrtc:ice-candidate",
          {
            targetUserId:
              currentTargetUserId,

            candidate:
              event.candidate,
          }
        );
      }
    };

  // ========================================
  // CONNECTION STATE
  // ========================================

  peerConnection.onconnectionstatechange =
    () => {
      const state =
        peerConnection
          ?.connectionState;

      console.log(
        "WebRTC connection state:",
        state
      );
    };

  // ========================================
  // ICE CONNECTION STATE
  // ========================================

  peerConnection.oniceconnectionstatechange =
    () => {
      const state =
        peerConnection
          ?.iceConnectionState;

      console.log(
        "WebRTC ICE state:",
        state
      );
    };

  return peerConnection;
};

// ==========================================
// GET LOCAL MICROPHONE / CAMERA
//
// audio = microphone
// video = microphone + camera
// ==========================================

export const getLocalStream =
  async (
    callType = "audio"
  ) => {
    // ========================================
    // STOP PREVIOUS LOCAL STREAM
    // ========================================

    if (localStream) {
      localStream
        .getTracks()
        .forEach(
          (track) => {
            track.stop();
          }
        );

      localStream = null;
    }

    const constraints = {
      audio: true,

      video:
        callType ===
        "video"
          ? {
              width: {
                ideal: 1280,
              },

              height: {
                ideal: 720,
              },

              facingMode:
                "user",
            }
          : false,
    };

    try {
      localStream =
        await navigator
          .mediaDevices
          .getUserMedia(
            constraints
          );

      return localStream;

    } catch (error) {
      console.error(
        "Microphone / camera access error:",
        error
      );

      throw error;
    }
  };

// ==========================================
// ADD LOCAL MEDIA TO PEER CONNECTION
// ==========================================

export const addLocalStream =
  (
    stream
  ) => {
    if (
      !peerConnection ||
      !stream
    ) {
      return;
    }

    stream
      .getTracks()
      .forEach(
        (track) => {
          // Prevent duplicate tracks.

          const alreadyAdded =
            peerConnection
              .getSenders()
              .some(
                (sender) =>
                  sender.track
                    ?.id ===
                  track.id
              );

          if (
            !alreadyAdded
          ) {
            peerConnection.addTrack(
              track,
              stream
            );
          }
        }
      );
  };

// ==========================================
// PROCESS QUEUED ICE CANDIDATES
// ==========================================

const processPendingIceCandidates =
  async () => {
    if (
      !peerConnection ||
      !peerConnection
        .remoteDescription
    ) {
      return;
    }

    const candidates = [
      ...pendingIceCandidates,
    ];

    pendingIceCandidates = [];

    for (
      const candidate
      of candidates
    ) {
      try {
        await peerConnection
          .addIceCandidate(
            new RTCIceCandidate(
              candidate
            )
          );
      } catch (error) {
        console.error(
          "Queued ICE candidate error:",
          error
        );
      }
    }
  };

// ==========================================
// CREATE WEBRTC OFFER
//
// Used by person starting the call.
// ==========================================

export const createOffer =
  async (
    targetUserId
  ) => {
    if (
      !peerConnection
    ) {
      throw new Error(
        "Peer connection not created"
      );
    }

    const offer =
      await peerConnection
        .createOffer();

    await peerConnection
      .setLocalDescription(
        offer
      );

    socket.emit(
      "webrtc:offer",
      {
        targetUserId:
          Number(
            targetUserId
          ),

        offer:
          peerConnection
            .localDescription,
      }
    );

    return (
      peerConnection
        .localDescription
    );
  };

// ==========================================
// HANDLE WEBRTC OFFER
//
// Used by person accepting the call.
// ==========================================

export const handleOffer =
  async (
    targetUserId,
    offer
  ) => {
    if (
      !peerConnection
    ) {
      throw new Error(
        "Peer connection not created"
      );
    }

    if (!offer) {
      throw new Error(
        "WebRTC offer missing"
      );
    }

    // ========================================
    // SET CALLER'S OFFER
    // ========================================

    await peerConnection
      .setRemoteDescription(
        new RTCSessionDescription(
          offer
        )
      );

    // ========================================
    // PROCESS EARLY ICE CANDIDATES
    // ========================================

    await processPendingIceCandidates();

    // ========================================
    // CREATE ANSWER
    // ========================================

    const answer =
      await peerConnection
        .createAnswer();

    await peerConnection
      .setLocalDescription(
        answer
      );

    // ========================================
    // SEND ANSWER TO CALLER
    // ========================================

    socket.emit(
      "webrtc:answer",
      {
        targetUserId:
          Number(
            targetUserId
          ),

        answer:
          peerConnection
            .localDescription,
      }
    );

    return (
      peerConnection
        .localDescription
    );
  };

// ==========================================
// HANDLE WEBRTC ANSWER
//
// Used by person who started the call.
// ==========================================

export const handleAnswer =
  async (
    answer
  ) => {
    if (
      !peerConnection ||
      !answer
    ) {
      return;
    }

    await peerConnection
      .setRemoteDescription(
        new RTCSessionDescription(
          answer
        )
      );

    // ========================================
    // PROCESS EARLY ICE CANDIDATES
    // ========================================

    await processPendingIceCandidates();
  };

// ==========================================
// HANDLE ICE CANDIDATE
// ==========================================

export const handleIceCandidate =
  async (
    candidate
  ) => {
    if (
      !candidate
    ) {
      return;
    }

    // ========================================
    // PEER CONNECTION NOT READY YET
    //
    // Queue candidate until connection exists.
    // ========================================

    if (
      !peerConnection
    ) {
      pendingIceCandidates.push(
        candidate
      );

      return;
    }

    // ========================================
    // REMOTE DESCRIPTION NOT READY
    //
    // Queue candidate until offer/answer
    // has been processed.
    // ========================================

    if (
      !peerConnection
        .remoteDescription
    ) {
      pendingIceCandidates.push(
        candidate
      );

      return;
    }

    // ========================================
    // ADD CANDIDATE IMMEDIATELY
    // ========================================

    try {
      await peerConnection
        .addIceCandidate(
          new RTCIceCandidate(
            candidate
          )
        );
    } catch (error) {
      console.error(
        "Failed to add ICE candidate:",
        error
      );
    }
  };

// ==========================================
// TOGGLE MICROPHONE
//
// Returns TRUE when microphone is ON.
// Returns FALSE when microphone is OFF.
// ==========================================

export const toggleMicrophone =
  () => {
    if (
      !localStream
    ) {
      return false;
    }

    const audioTrack =
      localStream
        .getAudioTracks()[0];

    if (
      !audioTrack
    ) {
      return false;
    }

    audioTrack.enabled =
      !audioTrack.enabled;

    return (
      audioTrack.enabled
    );
  };

// ==========================================
// TOGGLE CAMERA
//
// Returns TRUE when camera is ON.
// Returns FALSE when camera is OFF.
// ==========================================

export const toggleCamera =
  () => {
    if (
      !localStream
    ) {
      return false;
    }

    const videoTrack =
      localStream
        .getVideoTracks()[0];

    if (
      !videoTrack
    ) {
      return false;
    }

    videoTrack.enabled =
      !videoTrack.enabled;

    return (
      videoTrack.enabled
    );
  };

// ==========================================
// GET CURRENT LOCAL STREAM
// ==========================================

export const getCurrentLocalStream =
  () => {
    return localStream;
  };

// ==========================================
// GET CURRENT REMOTE STREAM
// ==========================================

export const getCurrentRemoteStream =
  () => {
    return remoteStream;
  };

// ==========================================
// GET CURRENT TARGET USER ID
// ==========================================

export const getCurrentTargetUserId =
  () => {
    return (
      currentTargetUserId
    );
  };

// ==========================================
// GET PEER CONNECTION
// ==========================================

export const getPeerConnection =
  () => {
    return peerConnection;
  };

// ==========================================
// CLEAN UP CALL
// ==========================================

export const cleanupCall =
  () => {
    // ========================================
    // STOP LOCAL MICROPHONE + CAMERA
    // ========================================

    if (
      localStream
    ) {
      localStream
        .getTracks()
        .forEach(
          (track) => {
            track.stop();
          }
        );

      localStream = null;
    }

    // ========================================
    // STOP REMOTE TRACKS
    // ========================================

    if (
      remoteStream
    ) {
      remoteStream
        .getTracks()
        .forEach(
          (track) => {
            track.stop();
          }
        );

      remoteStream = null;
    }

    // ========================================
    // CLOSE PEER CONNECTION
    // ========================================

    if (
      peerConnection
    ) {
      peerConnection.ontrack =
        null;

      peerConnection.onicecandidate =
        null;

      peerConnection
        .onconnectionstatechange =
        null;

      peerConnection
        .oniceconnectionstatechange =
        null;

      peerConnection.close();

      peerConnection = null;
    }

    // ========================================
    // RESET CALL STATE
    // ========================================

    currentTargetUserId =
      null;

    pendingIceCandidates =
      [];
  };