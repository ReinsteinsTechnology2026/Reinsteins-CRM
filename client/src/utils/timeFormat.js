// ==========================================
// SHIFT TIME FORMATTING (12-hour display/input <-> 24-hour storage)
//
// shift_schedules.start_time/end_time remain native 24-hour "HH:MM"
// strings on the wire (matching the Postgres TIME column and the
// backend's unchanged TIME_PATTERN validation) -- these helpers only
// convert at the UI boundary. Centralized here, rather than
// duplicated per-page (this codebase's usual convention for small
// helpers), because the same conversion is now needed by both shift
// pages AND the shared TimeInput12h component, and the display format
// must be identical everywhere it appears.
// ==========================================

export function formatTime12h(time) {
    if (!time) return "";
    const [hStr, mStr] = String(time).split(":");
    const hour = Number(hStr);
    if (!Number.isFinite(hour)) return "";
    const minute = (mStr || "00").padStart(2, "0");
    const suffix = hour >= 12 ? "PM" : "AM";
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${String(hour12).padStart(2, "0")}:${minute} ${suffix}`;
}

export function formatTimeRange12h(startTime, endTime) {
    if (!startTime || !endTime) return "";
    return `${formatTime12h(startTime)} - ${formatTime12h(endTime)}`;
}

// 24-hour "HH:MM"(:SS) -> { hour: "03", minute: "00", meridiem: "PM" },
// for populating TimeInput12h (both from an existing saved value in
// edit mode, and as the initial default for a new entry).
export function parseTimeTo12h(time) {
    if (!time) {
        return { hour: "09", minute: "00", meridiem: "AM" };
    }
    const [hStr, mStr] = String(time).split(":");
    const hour24 = Number(hStr);
    if (!Number.isFinite(hour24)) {
        return { hour: "09", minute: "00", meridiem: "AM" };
    }
    const minute = (mStr || "00").padStart(2, "0");
    const meridiem = hour24 >= 12 ? "PM" : "AM";
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    return { hour: String(hour12).padStart(2, "0"), minute, meridiem };
}

// { hour: 1-12, minute: 0-59, meridiem: "AM"|"PM" } -> 24-hour "HH:MM",
// exactly the format the backend's TIME_PATTERN already validates --
// no backend/schema change needed for this half of the conversion.
export function to24Hour(hour12, minute, meridiem) {
    let hour = Number(hour12) % 12;
    if (meridiem === "PM") hour += 12;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// Handles an overnight wrap (end <= start means the end time is on the
// next calendar day) defensively -- the existing backend validation
// still rejects start >= end at save time (unchanged, see
// shiftScheduleController.js's validateShiftInput), so this branch is
// not reachable via normal validated data today; kept only so this
// formatter never throws/mis-renders on unexpected input.
export function calculateShiftDuration(startTime, endTime) {
    if (!startTime || !endTime) return "";
    const [sh, sm] = String(startTime).split(":").map(Number);
    const [eh, em] = String(endTime).split(":").map(Number);
    if (![sh, sm, eh, em].every(Number.isFinite)) return "";

    const startMinutes = sh * 60 + sm;
    let endMinutes = eh * 60 + em;
    if (endMinutes <= startMinutes) {
        endMinutes += 24 * 60;
    }

    const totalMinutes = endMinutes - startMinutes;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
}
