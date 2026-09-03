import { useMemo, useState } from "react";

import { FaChevronLeft, FaChevronRight, FaPlus, FaUserAlt, FaUsers } from "react-icons/fa";

import {
    MEETING_STATUS_LABELS,
    MEETING_STATUS_CLASS,
} from "../../utils/workItemStatus";

import "./MeetingsCalendar.css";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTH_LABELS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

// Local-timezone date key, matching how formatDate/formatDateTime in
// utils/workItemStatus.js already interpret scheduled_date (no explicit
// UTC handling anywhere else in the Meetings feature -- kept consistent).

function toDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function addDays(date, amount) {
    const next = new Date(date);
    next.setDate(next.getDate() + amount);
    return next;
}

function startOfWeek(date) {
    const next = new Date(date);
    next.setDate(next.getDate() - next.getDay());
    next.setHours(0, 0, 0, 0);
    return next;
}

function formatClockTime(value) {

    if (!value) return null;

    const [hourStr, minuteStr] = String(value).substring(0, 5).split(":");
    const hour = Number(hourStr);
    const suffix = hour >= 12 ? "PM" : "AM";
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;

    return `${hour12}:${minuteStr} ${suffix}`;

}

function meetingDateKey(meeting) {

    const raw = meeting.scheduled_date || meeting.created_at;

    if (!raw) return null;

    const date = new Date(raw);

    if (Number.isNaN(date.getTime())) return null;

    return toDateKey(date);

}

function MeetingsCalendar({ meetings, onSelectMeeting, onCreateMeeting }) {

    const [scope, setScope] = useState("month");
    const [anchorDate, setAnchorDate] = useState(new Date());

    const meetingsByDay = useMemo(() => {

        const map = new Map();

        meetings.forEach((meeting) => {

            const key = meetingDateKey(meeting);

            if (!key) return;

            if (!map.has(key)) map.set(key, []);

            map.get(key).push(meeting);

        });

        for (const list of map.values()) {
            list.sort((a, b) => String(a.start_time || "").localeCompare(String(b.start_time || "")));
        }

        return map;

    }, [meetings]);

    const todayKey = toDateKey(new Date());

    function goToday() {
        setAnchorDate(new Date());
    }

    function goPrev() {
        if (scope === "month") {
            setAnchorDate((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1));
        } else if (scope === "week") {
            setAnchorDate((current) => addDays(current, -7));
        } else {
            setAnchorDate((current) => addDays(current, -1));
        }
    }

    function goNext() {
        if (scope === "month") {
            setAnchorDate((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1));
        } else if (scope === "week") {
            setAnchorDate((current) => addDays(current, 7));
        } else {
            setAnchorDate((current) => addDays(current, 1));
        }
    }

    function renderMeetingChip(meeting) {

        const time = formatClockTime(meeting.start_time);

        return (

            <button
                type="button"
                key={meeting.id}
                className="cal-meeting-chip"
                onClick={() => onSelectMeeting(meeting)}
                title={meeting.title}
            >

                <span
                    className={
                        MEETING_STATUS_CLASS[meeting.status] || "status-pill status-neutral"
                    }
                >
                    {MEETING_STATUS_LABELS[meeting.status] || meeting.status}
                </span>

                <span className="cal-meeting-chip-title">
                    {time && <strong>{time}</strong>} {meeting.title}
                </span>

                <span className="cal-meeting-chip-meta">
                    <FaUserAlt /> {meeting.host_name}
                    <FaUsers /> {meeting.participant_count}
                </span>

            </button>

        );

    }

    function renderMonthView() {

        const year = anchorDate.getFullYear();
        const month = anchorDate.getMonth();

        const firstOfMonth = new Date(year, month, 1);
        const gridStart = startOfWeek(firstOfMonth);

        const cells = [];

        for (let i = 0; i < 42; i++) {
            cells.push(addDays(gridStart, i));
        }

        return (

            <div className="cal-month-grid">

                {WEEKDAY_LABELS.map((label) => (
                    <div className="cal-weekday-label" key={label}>{label}</div>
                ))}

                {cells.map((cellDate) => {

                    const key = toDateKey(cellDate);
                    const dayMeetings = meetingsByDay.get(key) || [];
                    const isCurrentMonth = cellDate.getMonth() === month;
                    const isToday = key === todayKey;

                    const visible = dayMeetings.slice(0, 3);
                    const overflow = dayMeetings.length - visible.length;

                    return (

                        <div
                            key={key}
                            className={
                                "cal-day-cell" +
                                (isCurrentMonth ? "" : " cal-day-outside") +
                                (isToday ? " cal-day-today" : "")
                            }
                        >

                            <span className="cal-day-number">{cellDate.getDate()}</span>

                            <div className="cal-day-chips">
                                {visible.map(renderMeetingChip)}
                                {overflow > 0 && (
                                    <span className="cal-day-overflow">+{overflow} more</span>
                                )}
                            </div>

                        </div>

                    );

                })}

            </div>

        );

    }

    function renderAgendaColumns(days) {

        return (

            <div className="cal-agenda-columns">

                {days.map((dayDate) => {

                    const key = toDateKey(dayDate);
                    const dayMeetings = meetingsByDay.get(key) || [];
                    const isToday = key === todayKey;

                    return (

                        <div
                            key={key}
                            className={"cal-agenda-column" + (isToday ? " cal-day-today" : "")}
                        >

                            <div className="cal-agenda-column-header">
                                <span>{WEEKDAY_LABELS[dayDate.getDay()]}</span>
                                <strong>{dayDate.getDate()}</strong>
                            </div>

                            <div className="cal-agenda-column-body">

                                {dayMeetings.length === 0 ? (
                                    <span className="cal-agenda-empty">No meetings</span>
                                ) : (
                                    dayMeetings.map(renderMeetingChip)
                                )}

                            </div>

                        </div>

                    );

                })}

            </div>

        );

    }

    function renderWeekView() {

        const start = startOfWeek(anchorDate);
        const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

        return renderAgendaColumns(days);

    }

    function renderDayView() {
        return renderAgendaColumns([anchorDate]);
    }

    const rangeLabel = useMemo(() => {

        if (scope === "month") {
            return `${MONTH_LABELS[anchorDate.getMonth()]} ${anchorDate.getFullYear()}`;
        }

        if (scope === "week") {
            const start = startOfWeek(anchorDate);
            const end = addDays(start, 6);
            const sameMonth = start.getMonth() === end.getMonth();
            return sameMonth
                ? `${MONTH_LABELS[start.getMonth()]} ${start.getDate()} – ${end.getDate()}, ${end.getFullYear()}`
                : `${MONTH_LABELS[start.getMonth()]} ${start.getDate()} – ${MONTH_LABELS[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
        }

        return `${WEEKDAY_LABELS[anchorDate.getDay()]}, ${MONTH_LABELS[anchorDate.getMonth()]} ${anchorDate.getDate()}, ${anchorDate.getFullYear()}`;

    }, [scope, anchorDate]);

    return (

        <div className="meetings-calendar">

            <div className="cal-toolbar">

                <div className="cal-toolbar-nav">

                    <button type="button" className="cal-nav-btn" onClick={goPrev} aria-label="Previous">
                        <FaChevronLeft />
                    </button>

                    <button type="button" className="cal-today-btn" onClick={goToday}>
                        Today
                    </button>

                    <button type="button" className="cal-nav-btn" onClick={goNext} aria-label="Next">
                        <FaChevronRight />
                    </button>

                    <span className="cal-range-label">{rangeLabel}</span>

                </div>

                <div className="cal-toolbar-actions">

                    <div className="cal-scope-toggle">
                        {["month", "week", "day"].map((option) => (
                            <button
                                type="button"
                                key={option}
                                className={scope === option ? "active" : ""}
                                onClick={() => setScope(option)}
                            >
                                {option.charAt(0).toUpperCase() + option.slice(1)}
                            </button>
                        ))}
                    </div>

                    <button type="button" className="wi-primary-button" onClick={onCreateMeeting}>
                        <FaPlus /> New Meeting
                    </button>

                </div>

            </div>

            {scope === "month" && renderMonthView()}
            {scope === "week" && renderWeekView()}
            {scope === "day" && renderDayView()}

        </div>

    );

}

export default MeetingsCalendar;
