import { FaTimes, FaCopy, FaInfoCircle } from "react-icons/fa";

import { toast } from "react-toastify";

import { buildMeetingLink } from "../../services/meetingService";

import { formatDate } from "../../utils/workItemStatus";

// ==========================================
// MEETING INFO PANEL
// Read-only display of data already loaded
// onto the `meeting` object (Phase 5/6) — no
// new fetch, no new backend surface.
// ==========================================

function MeetingInfoPanel({ meeting, onClose }) {

    async function copy(value, label) {

        try {
            await navigator.clipboard.writeText(value);
            toast.success(`${label} copied`);
        } catch (error) {
            console.error(error);
            toast.error(`Unable to copy ${label.toLowerCase()}`);
        }

    }

    return (

        <div className="meeting-modal-overlay" onClick={onClose}>

            <div className="meeting-modal meeting-info-modal" onClick={(event) => event.stopPropagation()}>

                <div className="meeting-modal-header">
                    <div>
                        <h2><FaInfoCircle /> Meeting Info</h2>
                    </div>
                    <button type="button" className="meeting-modal-close" onClick={onClose} aria-label="Close meeting info">
                        &times;
                    </button>
                </div>

                <div className="meeting-info-rows">

                    <div className="meeting-info-row">
                        <label>Title</label>
                        <span>{meeting.title}</span>
                    </div>

                    <div className="meeting-info-row">
                        <label>Host</label>
                        <span>{meeting.host_name}</span>
                    </div>

                    {meeting.meeting_type === "scheduled" && (
                        <div className="meeting-info-row">
                            <label>Date</label>
                            <span>{formatDate(meeting.scheduled_date)}</span>
                        </div>
                    )}

                    {meeting.start_time && (
                        <div className="meeting-info-row">
                            <label>Time</label>
                            <span>{String(meeting.start_time).substring(0, 5)}</span>
                        </div>
                    )}

                    <div className="meeting-info-row">
                        <label>Meeting ID</label>
                        <span className="wi-code">{meeting.meeting_code}</span>
                        <button type="button" onClick={() => copy(meeting.meeting_code, "Meeting ID")} title="Copy meeting ID" aria-label="Copy meeting ID">
                            <FaCopy />
                        </button>
                    </div>

                    <div className="meeting-info-row">
                        <label>Link</label>
                        <span className="meeting-info-link">{buildMeetingLink(meeting.meeting_code)}</span>
                        <button type="button" onClick={() => copy(buildMeetingLink(meeting.meeting_code), "Meeting link")} title="Copy meeting link" aria-label="Copy meeting link">
                            <FaCopy />
                        </button>
                    </div>

                </div>

            </div>

        </div>

    );

}

export default MeetingInfoPanel;
