// ==========================================
// SHIFT MANAGEMENT VIEW HELPERS (Day / Week / Month)
// Pure functions, no React/DOM. All dates are LOCAL calendar dates and are
// serialised as YYYY-MM-DD from their local parts -- never via
// toISOString(), which converts to UTC and shifts the date by a day for
// anyone east of UTC (e.g. local midnight in IST is the previous UTC day).
// ==========================================

export const VIEW_DAY = "day";
export const VIEW_WEEK = "week";
export const VIEW_MONTH = "month";
export const VIEW_RANGE = "range"; // Custom range: a start and an end date chosen by the user
export const VIEWS = [VIEW_DAY, VIEW_WEEK, VIEW_MONTH, VIEW_RANGE];

// Longest Custom range (both ends included). This limit exists in the CLIENT only (it bounds the
// number of table columns the page draws); GET /api/shifts itself does not enforce a maximum.
export const MAX_CUSTOM_RANGE_DAYS = 92;

// Years the month/year picker offers (keeps every Date it builds well inside the valid range).
export const MIN_PICKER_YEAR = 2000;
export const MAX_PICKER_YEAR = 2100;

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n) => String(n).padStart(2, "0");

export function toIsoDate(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// "YYYY-MM-DD" -> local midnight Date (same convention the page already
// uses with `new Date(\`${d}T00:00:00\`)`).
export function parseIsoDate(iso) {
    const [y, m, d] = String(iso).split("-").map(Number);
    return new Date(y, m - 1, d);
}

export function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date, amount) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}

export function getMondayOf(date) {
    const day = date.getDay();
    return addDays(startOfDay(date), day === 0 ? -6 : 1 - day);
}

// First day of the month `amount` months away. Always day 1, so there is no
// day-of-month overflow (Jan 31 + 1 month must be February, not March).
export function addMonths(date, amount) {
    return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

export function weekdayLabel(date) {
    return WEEKDAY_SHORT[date.getDay()];
}

// ==========================================
// CUSTOM RANGE
// ==========================================

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A real calendar date in YYYY-MM-DD form ("2026-02-31" is not one).
function isRealIsoDate(value) {
    return typeof value === "string" && ISO_DATE.test(value) && toIsoDate(parseIsoDate(value)) === value;
}

// Calendar days from start to end, both included. Pure UTC arithmetic on the date
// parts, so a daylight-saving change or the browser's time zone can never add or
// remove a day.
export function inclusiveDayCount(startIso, endIso) {
    const utc = (iso) => {
        const [y, m, d] = iso.split("-").map(Number);
        return Date.UTC(y, m - 1, d);
    };
    return Math.round((utc(endIso) - utc(startIso)) / 86400000) + 1;
}

const invalidRange = (code, message) => ({ valid: false, code, message });

// Is this start/end pair a range the page may ask the shift API for? Every failure has a
// stable `code` (for tests) and a `message` shown inline to the user.
export function validateCustomRange(start, end, maxDays = MAX_CUSTOM_RANGE_DAYS) {
    const hasStart = start !== null && start !== undefined && start !== "";
    const hasEnd = end !== null && end !== undefined && end !== "";

    if (!hasStart && !hasEnd) return invalidRange("missing_both", "Choose a start date and an end date.");
    if (!hasStart) return invalidRange("missing_start", "Choose a start date.");
    if (!hasEnd) return invalidRange("missing_end", "Choose an end date.");
    if (!isRealIsoDate(start) || !isRealIsoDate(end)) return invalidRange("invalid_date", "Enter valid dates.");
    if (start > end) return invalidRange("end_before_start", "The start date cannot be after the end date.");

    const days = inclusiveDayCount(start, end);
    if (days > maxDays) {
        return invalidRange("too_long", `That range is ${days} days. Choose at most ${maxDays} days (about 3 months).`);
    }

    return { valid: true, days };
}

// "19 Oct 2026 - 25 Dec 2026" (a single date when both ends are the same day).
export function formatCustomRangeLabel(start, end, locale = "en-IN") {
    const opts = { day: "numeric", month: "short", year: "numeric" };
    const from = parseIsoDate(start).toLocaleDateString(locale, opts);
    return start === end ? from : `${from} - ${parseIsoDate(end).toLocaleDateString(locale, opts)}`;
}

// What the "Selected dates" caption says when there is no usable range: nothing chosen yet, only one
// of the two dates chosen, or dates that ARE there but cannot be used (reversed, unreal, too long).
export function invalidCustomRangeLabel(code) {
    if (code === "missing_both") return "No dates selected";
    if (code === "missing_start" || code === "missing_end") return "Choose both dates";
    return "Dates not valid";
}

// Short month names for the month/year picker, from the same locale as every other label.
export function monthShortLabels(locale = "en-IN") {
    return Array.from({ length: 12 }, (_, i) => new Date(2026, i, 1).toLocaleDateString(locale, { month: "short" }));
}

// The visible date range for a view around an anchor date. For the Custom range view the
// range comes from `custom` ({ start, end }) instead of the anchor; when it is not a valid
// range the result has `valid: false`, an `error` message and NO dates -- the caller must
// not request shifts for it.
export function getViewRange(view, anchor, custom) {
    if (view === VIEW_RANGE) {
        const check = validateCustomRange(custom && custom.start, custom && custom.end);

        if (!check.valid) return { view, start: null, end: null, dates: [], valid: false, code: check.code, error: check.message };

        const dates = [];
        for (let d = parseIsoDate(custom.start); toIsoDate(d) <= custom.end; d = addDays(d, 1)) dates.push(toIsoDate(d));

        return { view, start: custom.start, end: custom.end, dates, valid: true };
    }

    let start;
    let end;

    if (view === VIEW_DAY) {
        start = startOfDay(anchor);
        end = start;
    } else if (view === VIEW_MONTH) {
        start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
        end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    } else {
        start = getMondayOf(anchor);
        end = addDays(start, 6);
    }

    const dates = [];
    for (let d = start; d <= end; d = addDays(d, 1)) dates.push(toIsoDate(d));

    return { view, start: toIsoDate(start), end: toIsoDate(end), dates, valid: true };
}

// Previous / next page of the same view. direction is -1 or +1.
export function shiftAnchor(view, anchor, direction) {
    if (view === VIEW_RANGE) return anchor; // a custom range has no previous/next page
    if (view === VIEW_DAY) return addDays(anchor, direction);
    if (view === VIEW_MONTH) return addMonths(anchor, direction);
    return addDays(getMondayOf(anchor), 7 * direction);
}

// Switching view keeps the user's place. Week/Month simply show the
// week/month containing the current anchor; Day lands on today when today is
// inside the range they were looking at, otherwise on that range's first day.
export function anchorForView(nextView, anchor, currentRange, today) {
    if (nextView !== VIEW_DAY) return anchor;

    const todayIso = toIsoDate(today);
    const inRange = todayIso >= currentRange.start && todayIso <= currentRange.end;
    return inRange ? startOfDay(today) : parseIsoDate(currentRange.start);
}

export function formatRangeLabel(view, anchor, locale = "en-IN", custom) {
    const range = getViewRange(view, anchor, custom);

    if (view === VIEW_RANGE) {
        return range.valid ? formatCustomRangeLabel(range.start, range.end, locale) : invalidCustomRangeLabel(range.code);
    }

    if (view === VIEW_MONTH) {
        return parseIsoDate(range.start).toLocaleDateString(locale, { month: "long", year: "numeric" });
    }
    if (view === VIEW_DAY) {
        return parseIsoDate(range.start).toLocaleDateString(locale, {
            weekday: "long", day: "numeric", month: "short", year: "numeric",
        });
    }

    const opts = { day: "numeric", month: "short" };
    const start = parseIsoDate(range.start);
    const end = parseIsoDate(range.end);
    // Include the year when the week straddles a year boundary.
    const withYear = start.getFullYear() !== end.getFullYear();
    return `${start.toLocaleDateString(locale, withYear ? { ...opts, year: "numeric" } : opts)} - ${end.toLocaleDateString(locale, withYear ? { ...opts, year: "numeric" } : opts)}`;
}

export const NAV_LABELS = {
    [VIEW_DAY]: { prev: "Previous Day", next: "Next Day" },
    [VIEW_WEEK]: { prev: "Previous Week", next: "Next Week" },
    [VIEW_MONTH]: { prev: "Previous Month", next: "Next Month" },
};

// ==========================================
// EMPLOYEE FILTER (independent of the Day/Week/Month view)
// ==========================================

// Query for the existing shift API: the date range plus, when an employee is
// selected, `userId` so the filtering happens server-side. No employee = all.
export function buildShiftQuery(range, employeeId) {
    const hasEmployee = employeeId !== null && employeeId !== undefined && employeeId !== "";
    return {
        startDate: range.start,
        endDate: range.end,
        extraParams: hasEmployee ? { userId: employeeId } : {},
    };
}

// Table rows after the employee filter (no filter = every row, untouched).
export function filterRowsByEmployee(rows, employeeId) {
    if (employeeId === null || employeeId === undefined || employeeId === "") return rows;
    return rows.filter((row) => Number(row.userId) === Number(employeeId));
}

// Should a live `shift:updated` payload be merged into what is on screen?
// Only if its date is inside the visible range and, with an employee filter,
// only if it belongs to that employee.
export function shouldMergeLiveUpdate(payload, visibleDates, employeeId) {
    if (!payload || !visibleDates.includes(payload.shiftDate)) return false;
    if (employeeId === null || employeeId === undefined || employeeId === "") return true;
    return Number(payload.userId) === Number(employeeId);
}

// ==========================================
// ADMINISTRATIVE OVERRIDE TARGET LOOKUP
// With an employee filter active (or a date outside the loaded range) the
// page has NOT loaded the chosen employee's shift for the chosen date, so a
// local lookup alone would miss an existing entry and the create call would
// hit the duplicate-entry 409. These helpers decide when to ask the server
// and how to turn an existing entry into the override form.
// ==========================================

const hasValue = (v) => v !== null && v !== undefined && v !== "";

// Is the (employee, date) pair possibly missing from what is loaded?
export function needsServerLookup({ userId, shiftDate, selectedEmployeeId, rangeDates }) {
    if (!rangeDates.includes(shiftDate)) return true;
    return hasValue(selectedEmployeeId) && Number(userId) !== Number(selectedEmployeeId);
}

export function overrideFormFromShift(shift, defaults = {}) {
    return {
        id: shift.id,
        userId: String(shift.user_id),
        shiftDate: shift.shift_date,
        status: shift.status,
        startTime: shift.start_time || defaults.startTime || "09:00",
        endTime: shift.end_time || defaults.endTime || "18:00",
        notes: shift.notes || "",
    };
}

// Finds the existing entry for (userId, shiftDate): the loaded shifts first,
// then -- only when they cannot be complete for that pair -- the existing
// shift API for that single day and employee (`fetchDay(shiftDate, userId)`
// resolves to the API response). Never throws: a failed lookup is reported so
// the caller can still rely on the server's own duplicate-entry check.
export async function resolveOverrideTarget({ userId, shiftDate, shifts, selectedEmployeeId, rangeDates, fetchDay }) {
    const matches = (s) => Number(s.user_id) === Number(userId) && s.shift_date === shiftDate;

    const local = shifts.find(matches);
    if (local) return { shift: local, lookupFailed: false };

    if (!needsServerLookup({ userId, shiftDate, selectedEmployeeId, rangeDates })) {
        return { shift: null, lookupFailed: false };
    }

    try {
        const data = await fetchDay(shiftDate, userId);
        const found = (Array.isArray(data?.shifts) ? data.shifts : []).find(matches);
        return { shift: found || null, lookupFailed: false };
    } catch {
        return { shift: null, lookupFailed: true };
    }
}

// ==========================================
// SEARCH + DATE PICKER FOLLOW THE SELECTED VIEW
// ==========================================

export const VIEW_LABELS = { [VIEW_DAY]: "Day", [VIEW_WEEK]: "Week", [VIEW_MONTH]: "Month", [VIEW_RANGE]: "Custom range" };

// The date picker sets the date the selected view is built around, so its
// label says which range that date selects.
export const PICKER_LABELS = {
    [VIEW_DAY]: "Day",
    [VIEW_WEEK]: "Any date in the week",
    [VIEW_MONTH]: "Any date in the month",
};

// Picker value (YYYY-MM-DD) -> local Date, or null for an empty/invalid value
// (a cleared picker must not move the range).
export function anchorFromPickerValue(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
    const date = parseIsoDate(value);
    return Number.isNaN(date.getTime()) || toIsoDate(date) !== value ? null : date;
}

// The search endpoint answers for ONE date, so per-day columns (status, times,
// duration) only make sense in the Day view. Week/Month pick the employee and
// the schedule table below shows their whole week/month.
export function searchShowsDayDetail(view) {
    return view === VIEW_DAY;
}

// One line saying exactly what is on screen, e.g.
// "Week 19 Oct - 25 Oct: Asha Rao (EMP002)" / "Month October 2026: all employees".
export function filterSummary(view, anchor, employee, custom) {
    const who = employee
        ? `${employee.fullName}${employee.employeeId ? ` (${employee.employeeId})` : ""}`
        : "all employees";
    return `${VIEW_LABELS[view]} ${formatRangeLabel(view, anchor, "en-IN", custom)}: ${who}`;
}
