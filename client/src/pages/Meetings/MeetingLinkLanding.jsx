import { useState } from "react";

import { useNavigate, useParams } from "react-router-dom";

import { FaVideo } from "react-icons/fa";

import { toast } from "react-toastify";

import { joinMeeting } from "../../services/meetingService";

import "../../styles/workItems.css";
import "./MeetingModal.css";
import "./Meetings.css";

function getCurrentUser() {

    try {
        return JSON.parse(sessionStorage.getItem("user"));
    } catch (error) {
        return null;
    }

}

// ==========================================
// SHARED MEETING LINK LANDING
//
// Reached via /meeting/:meetingCode — a bare,
// role-agnostic route (any authenticated user)
// so a copied meeting link works regardless of
// whether the recipient is an admin or an
// employee. Joining here routes them into their
// own role-scoped meeting room afterward.
// ==========================================

function MeetingLinkLanding() {

    const { meetingCode } = useParams();

    const navigate = useNavigate();

    const currentUser = getCurrentUser();

    const [password, setPassword] = useState("");

    const [loading, setLoading] = useState(false);

    async function handleJoin(event) {

        event.preventDefault();

        try {

            setLoading(true);

            const response = await joinMeeting(meetingCode, password);

            toast.success(
                response.participantStatus === "waiting"
                    ? "You're in the waiting room"
                    : "Joined meeting"
            );

            const basePath = currentUser?.role === "admin" ? "/admin" : "/employee";

            navigate(`${basePath}/meetings/${response.meeting.id}/room`, {
                replace: true,
                state: {
                    meeting: response.meeting,
                    participantStatus: response.participantStatus,
                },
            });

        } catch (error) {

            console.error(error);

            toast.error(
                error.response?.data?.message || "Unable to join meeting"
            );

        } finally {

            setLoading(false);

        }

    }

    return (

        <div className="wi-page meeting-link-landing">

            <div className="meeting-room-placeholder">

                <FaVideo />

                <h2>Join Meeting</h2>

                <p>Meeting ID: <strong>{meetingCode}</strong></p>

                <form onSubmit={handleJoin} className="meeting-link-landing-form">

                    <div className="meeting-form-group">
                        <label>Password (if required)</label>
                        <input
                            type="password"
                            placeholder="Meeting password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                        />
                    </div>

                    <button
                        type="submit"
                        className="wi-primary-button meeting-link-landing-submit"
                        disabled={loading}
                    >
                        {loading ? "Joining..." : "Join Meeting"}
                    </button>

                </form>

            </div>

        </div>

    );

}

export default MeetingLinkLanding;
