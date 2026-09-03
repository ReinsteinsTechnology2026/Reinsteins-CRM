import { useState } from "react";

import { toast } from "react-toastify";

import {
    createMeeting,
    updateMeeting,
} from "../../services/meetingService";

import ParticipantPicker from "./ParticipantPicker";

import "./MeetingModal.css";

function CreateMeetingModal({

    meeting,

    onClose,

    onCreated,

    onUpdated

}) {

    const isEditing = Boolean(meeting);

    const [loading, setLoading] = useState(false);

    const [meetingType, setMeetingType] = useState(
        meeting?.meeting_type || "scheduled"
    );

    const [formData, setFormData] = useState({

        title: meeting?.title || "",
        description: meeting?.description || "",
        scheduledDate: meeting?.scheduled_date
            ? String(meeting.scheduled_date).substring(0, 10)
            : "",
        startTime: meeting?.start_time
            ? String(meeting.start_time).substring(0, 5)
            : "",
        endTime: meeting?.end_time
            ? String(meeting.end_time).substring(0, 5)
            : "",
        allowGuestJoin: meeting?.allow_guest_join !== 0,
        waitingRoomEnabled: Boolean(meeting?.waiting_room_enabled),
        requireHostApproval: Boolean(meeting?.require_host_approval),

    });

    // Password is tri-state on edit: untouched (keep as-is),
    // cleared (remove password), or set to a new value.
    // A plain text field can't distinguish "untouched" from
    // "cleared" on its own, hence the explicit toggle below.

    const [changePassword, setChangePassword] = useState(!isEditing);

    const [password, setPassword] = useState("");

    const [selectedParticipants, setSelectedParticipants] = useState([]);

    function handleChange(event) {

        const { name, value } = event.target;

        setFormData((current) => ({ ...current, [name]: value }));

    }

    function toggleField(name) {

        setFormData((current) => ({ ...current, [name]: !current[name] }));

    }

    async function handleSubmit(event) {

        event.preventDefault();

        if (!formData.title.trim()) {
            toast.error("Meeting title is required");
            return;
        }

        if (meetingType === "scheduled" && !formData.scheduledDate) {
            toast.error("Please select a date for a scheduled meeting");
            return;
        }

        const payload = {
            title: formData.title.trim(),
            description: formData.description.trim(),
            meetingType,
            scheduledDate: formData.scheduledDate || null,
            startTime: formData.startTime || null,
            endTime: formData.endTime || null,
            allowGuestJoin: formData.allowGuestJoin,
            waitingRoomEnabled: formData.waitingRoomEnabled,
            requireHostApproval: formData.requireHostApproval,
            participantUserIds: selectedParticipants.map((p) => p.id),
        };

        if (changePassword) {
            payload.password = password;
        }

        try {

            setLoading(true);

            if (isEditing) {

                const response = await updateMeeting(meeting.id, payload);

                toast.success("Meeting updated successfully");

                onUpdated(response.meeting);

            } else {

                const response = await createMeeting(payload);

                toast.success(
                    `Meeting created — ID: ${response.meeting.meeting_code}`
                );

                onCreated(response.meeting);

            }

        } catch (error) {

            console.error(error);

            toast.error(
                error.response?.data?.message ||
                (isEditing ? "Unable to update meeting" : "Unable to create meeting")
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
                        <h2>{isEditing ? "Edit Meeting" : "Create New Meeting"}</h2>
                        <p>
                            {isEditing
                                ? "Update this meeting's details."
                                : "Set up a meeting for your team."}
                        </p>
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

                    {isEditing && (

                        <div className="meeting-code-display">
                            <span>Meeting ID</span>
                            <strong>{meeting.meeting_code}</strong>
                        </div>

                    )}

                    {!isEditing && (

                        <div className="meeting-type-toggle">

                            <button
                                type="button"
                                className={meetingType === "scheduled" ? "active" : ""}
                                onClick={() => setMeetingType("scheduled")}
                            >
                                Schedule for Later
                            </button>

                            <button
                                type="button"
                                className={meetingType === "instant" ? "active" : ""}
                                onClick={() => setMeetingType("instant")}
                            >
                                Start Instantly
                            </button>

                        </div>

                    )}

                    <div className="meeting-form-group">
                        <label>Meeting Title *</label>
                        <input
                            type="text"
                            name="title"
                            placeholder="Example: Weekly Team Sync"
                            value={formData.title}
                            onChange={handleChange}
                            required
                        />
                    </div>

                    <div className="meeting-form-group">
                        <label>Description</label>
                        <textarea
                            name="description"
                            rows={3}
                            placeholder="What is this meeting about?"
                            value={formData.description}
                            onChange={handleChange}
                        />
                    </div>

                    {meetingType === "scheduled" && (

                        <div className="meeting-form-grid">

                            <div className="meeting-form-group">
                                <label>Date *</label>
                                <input
                                    type="date"
                                    name="scheduledDate"
                                    value={formData.scheduledDate}
                                    onChange={handleChange}
                                    required={meetingType === "scheduled"}
                                />
                            </div>

                            <div className="meeting-form-group" />

                            <div className="meeting-form-group">
                                <label>Start Time</label>
                                <input
                                    type="time"
                                    name="startTime"
                                    value={formData.startTime}
                                    onChange={handleChange}
                                />
                            </div>

                            <div className="meeting-form-group">
                                <label>End Time</label>
                                <input
                                    type="time"
                                    name="endTime"
                                    value={formData.endTime}
                                    onChange={handleChange}
                                />
                            </div>

                        </div>

                    )}

                    <ParticipantPicker
                        meetingId={meeting?.id}
                        value={selectedParticipants}
                        onChange={setSelectedParticipants}
                        scheduledDate={formData.scheduledDate}
                        startTime={formData.startTime}
                        endTime={formData.endTime}
                    />

                    <div className="meeting-form-group">

                        <label>Meeting Password</label>

                        {isEditing && !changePassword ? (

                            <button
                                type="button"
                                className="wi-secondary-button"
                                onClick={() => setChangePassword(true)}
                            >
                                {meeting.has_password ? "Change Password" : "Set a Password"}
                            </button>

                        ) : (

                            <>
                                <input
                                    type="text"
                                    placeholder="Leave blank for no password"
                                    value={password}
                                    onChange={(event) => setPassword(event.target.value)}
                                />
                                <p className="meeting-form-hint">
                                    {isEditing
                                        ? "Leave blank to remove the current password."
                                        : "Optional. Participants will need this to join."}
                                </p>
                            </>

                        )}

                    </div>

                    <div className="meeting-form-toggle-row">
                        <div>
                            <strong>Allow Guest Joining</strong>
                            <span>Any WorkHub user can join with the meeting ID/link</span>
                        </div>
                        <button
                            type="button"
                            className={
                                formData.allowGuestJoin
                                    ? "meeting-switch on"
                                    : "meeting-switch"
                            }
                            onClick={() => toggleField("allowGuestJoin")}
                            aria-label="Toggle allow guest joining"
                        />
                    </div>

                    <div className="meeting-form-toggle-row">
                        <div>
                            <strong>Waiting Room</strong>
                            <span>New participants wait until admitted</span>
                        </div>
                        <button
                            type="button"
                            className={
                                formData.waitingRoomEnabled
                                    ? "meeting-switch on"
                                    : "meeting-switch"
                            }
                            onClick={() => toggleField("waitingRoomEnabled")}
                            aria-label="Toggle waiting room"
                        />
                    </div>

                    <div className="meeting-form-toggle-row">
                        <div>
                            <strong>Require Host Approval</strong>
                            <span>Host must approve each participant before entry</span>
                        </div>
                        <button
                            type="button"
                            className={
                                formData.requireHostApproval
                                    ? "meeting-switch on"
                                    : "meeting-switch"
                            }
                            onClick={() => toggleField("requireHostApproval")}
                            aria-label="Toggle require host approval"
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
                            {loading
                                ? "Saving..."
                                : isEditing
                                    ? "Save Changes"
                                    : meetingType === "instant"
                                        ? "Create & Start"
                                        : "Create Meeting"}
                        </button>

                    </div>

                </form>

            </div>

        </div>

    );

}

export default CreateMeetingModal;
