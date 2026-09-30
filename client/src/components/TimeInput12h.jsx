import { parseTimeTo12h, to24Hour } from "../utils/timeFormat";

// ==========================================
// TIME INPUT (12-HOUR, AM/PM)
//
// Controlled component: `value` is always a 24-hour "HH:MM" string
// (matching shift_schedules.start_time/end_time's wire format and the
// backend's existing TIME_PATTERN validation, both left untouched) --
// this component only changes how the user ENTERS that value. Native
// <input type="time"> renders the browser's own locale/24-hour widget
// with no way to force a separate AM/PM control, so this replaces it
// with three plain <select> elements (hour/minute/meridiem) styled to
// match the existing .employee-form-group inputs -- the first custom
// time picker in this codebase, since none existed to reuse.
// ==========================================

const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

function TimeInput12h({ value, onChange, required = false, label }) {
    const { hour, minute, meridiem } = parseTimeTo12h(value);

    function emit(nextHour, nextMinute, nextMeridiem) {
        onChange(to24Hour(nextHour, nextMinute, nextMeridiem));
    }

    return (
        <div className="time-input-12h" role="group" aria-label={label || "Time"}>
            <select
                className="time-input-12h-select time-input-12h-hour"
                value={hour}
                onChange={(event) => emit(event.target.value, minute, meridiem)}
                required={required}
                aria-label={`${label || "Time"} - hour`}
            >
                {HOURS.map((h) => (
                    <option key={h} value={h}>{h}</option>
                ))}
            </select>
            <span className="time-input-12h-colon">:</span>
            <select
                className="time-input-12h-select time-input-12h-minute"
                value={minute}
                onChange={(event) => emit(hour, event.target.value, meridiem)}
                required={required}
                aria-label={`${label || "Time"} - minute`}
            >
                {MINUTES.map((m) => (
                    <option key={m} value={m}>{m}</option>
                ))}
            </select>
            <select
                className="time-input-12h-select time-input-12h-meridiem"
                value={meridiem}
                onChange={(event) => emit(hour, minute, event.target.value)}
                required={required}
                aria-label={`${label || "Time"} - AM or PM`}
            >
                <option value="AM">AM</option>
                <option value="PM">PM</option>
            </select>
        </div>
    );
}

export default TimeInput12h;
