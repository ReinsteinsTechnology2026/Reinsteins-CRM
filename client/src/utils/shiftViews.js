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
