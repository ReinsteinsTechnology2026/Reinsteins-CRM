import { useState } from "react";

import { useNavigate, useParams } from "react-router-dom";

import { toast } from "react-toastify";

import {
    joinMeeting,
    extractMeetingCode,
} from "../../services/meetingService";

import "./MeetingModal.css";

function getCurrentUserRole() {

    try {
        return JSON.parse(sessionStorage.getItem("user"))?.role;
    } catch (error) {
        return null;
    }

}

function JoinMeetingModal({ onClose }) {

    const navigate = useNavigate();

    const { companySlug } = useParams();

    const role = getCurrentUserRole();

    const [meetingCodeInput, setMeetingCodeInput] = useState("");

    const [password, setPassword] = useState("");

    const [loading, setLoading] = useState(false);

    async function handleSubmit(event) {

        event.preventDefault();

        const code = extractMeetingCode(meetingCodeInput);

        if (!code) {
            toast.error("Enter a meeting ID or paste a meeting link");
            return;
        }

        try {

            setLoading(true);

            const response = await joinMeeting(code, password);

            toast.success(
                response.participantStatus === "waiting"
                    ? "You're in the waiting room"
                    : "Joined meeting"
            );

            // Company-aware tenant users are rendered under
            // "/:companySlug/admin"/"/:companySlug/employee" --
            // navigating to the unprefixed path would take them off
            // that route tree. Reinsteins (no companySlug) keeps the
            // existing unprefixed path.
            const basePath = companySlug
                ? `/${companySlug}/${role === "admin" ? "admin" : "employee"}`
                : role === "admin" ? "/admin" : "/employee";

            onClose();

            navigate(`${basePath}/meetings/${response.meeting.id}/room`, {
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

        <div className="meeting-modal-overlay">

            <div className="meeting-modal">

                <div className="meeting-modal-header">

                    <div>
                        <h2>Join a Meeting</h2>
                        <p>Enter a meeting ID, or paste a meeting link.</p>
                    </div>

                    <button
                        type="button"
                        className="meeting-modal-close"
                        onClick={onClose}
                    >
                        &times;
                    </button>

                </div>

                <form onSubmit={handleSubmit} className="meeting-modal-form">

                    <div className="meeting-form-group">
                        <label>Meeting ID or Link *</label>
                        <input
                            type="text"
                            placeholder="WH-482-739-215 or a pasted meeting link"
                            value={meetingCodeInput}
                            onChange={(event) => setMeetingCodeInput(event.target.value)}
                            required
                            autoFocus
                        />
                    </div>

                    <div className="meeting-form-group">
                        <label>Password</label>
                        <input
                            type="password"
                            placeholder="Only required if the meeting is password-protected"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                        />
                    </div>

                    <div className="meeting-modal-footer">

                        <button
                            type="button"
                            className="wi-secondary-button"
                            onClick={onClose}
                        >
                            Cancel
                        </button>

                        <button
                            type="submit"
                            className="wi-primary-button"
                            disabled={loading}
                        >
                            {loading ? "Joining..." : "Join Meeting"}
                        </button>

                    </div>

                </form>

            </div>

        </div>

    );

}

export default JoinMeetingModal;
