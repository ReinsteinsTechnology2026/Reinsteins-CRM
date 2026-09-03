import { useEffect, useRef, useState } from "react";

import {
    FaMicrophoneSlash,
    FaCrown,
    FaWifi,
    FaHandPaper,
    FaDesktop,
} from "react-icons/fa";

// ==========================================
// LOCAL SPEAKING DETECTOR
//
// Runs a Web Audio AnalyserNode directly on
// this tile's own MediaStream (local for the
// self tile, the real WebRTC-received remote
// stream for everyone else) and reports a
// debounced true/false. Nothing is ever sent
// anywhere — this is pure client-side analysis
// of audio the browser already has, so no new
// signaling event is needed for it.
// ==========================================

function useSpeakingLevel(stream, active) {

    const [speaking, setSpeaking] = useState(false);

    useEffect(() => {

        if (!active || !stream) {
            setSpeaking(false);
            return;
        }

        const audioTrack = stream.getAudioTracks()[0];

        if (!audioTrack) {
            setSpeaking(false);
            return;
        }

        let audioContext;
        let analyser;
        let source;
        let rafId;
        let aboveSince = 0;
        let belowSince = 0;
        let cancelled = false;

        const SPEAKING_THRESHOLD = 18;
        const HOLD_ON_MS = 150;
        const HOLD_OFF_MS = 400;

        try {

            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.75;

            source = audioContext.createMediaStreamSource(stream);
            source.connect(analyser);

            const data = new Uint8Array(analyser.frequencyBinCount);

            const tick = () => {

                if (cancelled) return;

                analyser.getByteFrequencyData(data);

                let sum = 0;
                for (let i = 0; i < data.length; i += 1) sum += data[i];
                const average = sum / data.length;

                const now = performance.now();

                if (average > SPEAKING_THRESHOLD) {
                    if (!aboveSince) aboveSince = now;
                    belowSince = 0;
                    if (now - aboveSince > HOLD_ON_MS) setSpeaking(true);
                } else {
                    if (!belowSince) belowSince = now;
                    aboveSince = 0;
                    if (now - belowSince > HOLD_OFF_MS) setSpeaking(false);
                }

                rafId = requestAnimationFrame(tick);

            };

            tick();

        } catch (error) {
            console.error("Speaking detector unavailable:", error);
        }

        return () => {

            cancelled = true;

            if (rafId) cancelAnimationFrame(rafId);

            try { source?.disconnect(); } catch { /* already disconnected */ }
            try { analyser?.disconnect(); } catch { /* already disconnected */ }
            try { audioContext?.close(); } catch { /* already closed */ }

        };

    }, [stream, active]);

    return speaking;

}

// ==========================================
// PARTICIPANT VIDEO TILE
//
// Always backed by a real MediaStream — the
// local one reused from the Phase 7 lobby for
// the self tile, or a stream captured off a
// real RTCPeerConnection for everyone else.
// No placeholder/fake video is ever rendered.
// ==========================================

function ParticipantVideo({ participant, stream, isSelf, size, onSpeakingChange }) {

    const videoRef = useRef(null);

    const hasVideo = Boolean(stream) && stream.getVideoTracks().some((track) => track.enabled);

    const speaking = useSpeakingLevel(stream, Boolean(participant.micOn));

    const onSpeakingChangeRef = useRef(onSpeakingChange);
    onSpeakingChangeRef.current = onSpeakingChange;

    useEffect(() => {
        onSpeakingChangeRef.current?.(participant.userId, speaking);
    }, [speaking, participant.userId]);

    useEffect(() => {

        if (videoRef.current && videoRef.current.srcObject !== stream) {
            videoRef.current.srcObject = stream || null;
        }

    }, [stream]);

    return (

        <div
            className={
                "meeting-room-tile" +
                (size === "small" ? " small" : "") +
                (speaking ? " speaking" : "") +
                (participant.isPresenting ? " presenting" : "") +
                (participant.connectionState === "reconnecting" ? " reconnecting" : "")
            }
        >

            <video
                ref={videoRef}
                autoPlay
                playsInline
                muted={isSelf}
                className={isSelf ? "meeting-room-video mirrored" : "meeting-room-video"}
            />

            {!hasVideo && (
                <div className="meeting-room-tile-avatar">
                    <span>{participant.fullName?.charAt(0).toUpperCase() || "U"}</span>
                </div>
            )}

            <div className="meeting-room-tile-overlay">

                <div className="meeting-room-tile-name">

                    {participant.isHost && <FaCrown title="Host" />}

                    <span>{participant.fullName}{isSelf ? " (You)" : ""}</span>

                    {!participant.isHost && participant.roleLabel && (
                        <span className="meeting-room-role-badge">{participant.roleLabel}</span>
                    )}

                    {!participant.micOn && <FaMicrophoneSlash title="Muted" />}

                    {participant.handRaised && <FaHandPaper title="Hand raised" className="meeting-hand-icon" />}

                </div>

                {participant.connectionState === "reconnecting" && (
                    <span className="meeting-room-tile-badge">
                        <FaWifi /> Reconnecting…
                    </span>
                )}

                {participant.isPresenting && (
                    <span className="meeting-room-tile-badge presenting">
                        <FaDesktop /> Presenting
                    </span>
                )}

            </div>

        </div>

    );

}

export default ParticipantVideo;
