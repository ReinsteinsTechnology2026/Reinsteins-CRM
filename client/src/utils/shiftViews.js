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
export const VIEWS = [VIEW_DAY, VIEW_WEEK, VIEW_MONTH];

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

// The visible date range for a view around an anchor date.
export function getViewRange(view, anchor) {
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

    return { view, start: toIsoDate(start), end: toIsoDate(end), dates };
}

// Previous / next page of the same view. direction is -1 or +1.
export function shiftAnchor(view, anchor, direction) {
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

export function formatRangeLabel(view, anchor, locale = "en-IN") {
    const range = getViewRange(view, anchor);

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

export const VIEW_LABELS = { [VIEW_DAY]: "Day", [VIEW_WEEK]: "Week", [VIEW_MONTH]: "Month" };

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
export function filterSummary(view, anchor, employee) {
    const who = employee
        ? `${employee.fullName}${employee.employeeId ? ` (${employee.employeeId})` : ""}`
        : "all employees";
    return `${VIEW_LABELS[view]} ${formatRangeLabel(view, anchor)}: ${who}`;
}
