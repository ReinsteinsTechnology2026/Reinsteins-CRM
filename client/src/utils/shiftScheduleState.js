// ==========================================
// SHIFT MANAGEMENT -- ONE STATE MACHINE FOR VIEW, DATE, EMPLOYEE AND SEARCH
// Pure functions, no React/DOM, so the behaviour can be run and tested directly.
//
// The Day / Week / Month view, the selected date (anchor) and the employee
// filter live in ONE state object and are changed only through the reducer
// below, so selecting or clearing an employee can never reset the range, and
// changing the view/date can never drop the employee.
// ==========================================

import {
    VIEW_DAY,
    VIEW_WEEK,
    VIEW_MONTH,
    VIEW_RANGE,
    MIN_PICKER_YEAR,
    MAX_PICKER_YEAR,
    anchorForView,
    anchorFromPickerValue,
    getViewRange,
    parseIsoDate,
    shiftAnchor,
} from "./shiftViews.js"; // explicit extension so plain Node ESM (the tests) can load this file too

export function initialScheduleState(today = new Date()) {
    return {
        view: VIEW_WEEK,
        anchor: today,
        // The Custom range view's dates ("YYYY-MM-DD", or "" while not chosen). Kept even when the
        // user switches to another view and back.
        custom: { start: "", end: "" },
        employee: null, // { userId, fullName, employeeId, designation } or null = everyone
        searchOpen: false,
    };
}

export function scheduleReducer(state, action) {
    switch (action.type) {
        case "setView": {
            if (action.view === state.view) return state;

            const current = getViewRange(state.view, state.anchor, state.custom);
            let custom = state.custom;
            let anchor = state.anchor;

            if (current.valid) {
                // Day lands on today when today is inside the range being left, otherwise on its first day.
                anchor = anchorForView(action.view, state.anchor, current, action.today || new Date());
                // Leaving a custom range for Week/Month shows the week/month it STARTS in, not an old anchor.
                if (state.view === VIEW_RANGE && action.view !== VIEW_DAY) anchor = parseIsoDate(current.start);
            }

            // First time in Custom range: start from what was on screen, so the dates are never blank.
            if (action.view === VIEW_RANGE && !custom.start && !custom.end && current.valid) {
                custom = { start: current.start, end: current.end };
            }

            return { ...state, view: action.view, anchor, custom };
        }
        case "setCustomRange": {
            // Only the keys given change; anything that is not a string counts as "not chosen".
            const next = { ...state.custom };
            if ("start" in action) next.start = typeof action.start === "string" ? action.start : "";
            if ("end" in action) next.end = typeof action.end === "string" ? action.end : "";
            return { ...state, custom: next };
        }
        case "pickMonth": {
            // The month/year picker: shows that whole month. An out-of-range pick never moves the range.
            const year = Number(action.year);
            const month = Number(action.month);
            const ok = Number.isInteger(year) && year >= MIN_PICKER_YEAR && year <= MAX_PICKER_YEAR && Number.isInteger(month) && month >= 0 && month <= 11;
            return ok ? { ...state, view: VIEW_MONTH, anchor: new Date(year, month, 1) } : state;
        }
        case "step":
            return { ...state, anchor: shiftAnchor(state.view, state.anchor, action.direction) };
        case "pickDate": {
            // an empty / invalid picker value never moves the range
            const next = anchorFromPickerValue(action.value);
            return next ? { ...state, anchor: next } : state;
        }
        case "selectEmployee":
            // range and view untouched; the results panel dismisses itself
            return { ...state, employee: action.employee, searchOpen: false };
        case "clearEmployee":
            // everyone again, for the SAME view and date range
            return { ...state, employee: null };
        case "openSearch":
            return { ...state, searchOpen: true };
        case "closeSearch":
            return { ...state, searchOpen: false };
        default:
            return state;
    }
}

// ==========================================
// LATEST-REQUEST-WINS
// An answer may only be applied if no newer request has started since.
// ==========================================

export function createRequestGuard() {
    let latest = 0;
    return {
        begin: () => ++latest,
        isCurrent: (id) => id === latest,
        // Invalidate everything in flight (e.g. when the search is dismissed).
        cancelAll: () => { latest += 1; },
    };
}

// ==========================================
// TABLE ROWS
// Every active employee gets a row (even with a blank range), my own row
// pinned first. With an employee filter only that employee is shown -- and
// that employee gets a row even if GET /employees did not return them (it
// lists role='employee' accounts only, while search finds any active user),
// so a valid, empty schedule is never mistaken for "no employees".
// ==========================================

export function buildScheduleRows({ employees, shifts, currentUserId, selectedEmployee }) {
    const byUser = new Map();
    const addRow = (userId, fullName, designation) => {
        if (byUser.has(userId)) {
            // a row created from a bare live-update shift has no name yet
            const existing = byUser.get(userId);
            if (!existing.fullName && fullName) existing.fullName = fullName;
            if (!existing.designation && designation) existing.designation = designation;
            return existing;
        }
        const row = { userId, fullName, designation, isSelf: currentUserId === userId, days: {} };
        byUser.set(userId, row);
        return row;
    };

    for (const employee of employees) addRow(employee.id, employee.full_name, employee.designation);
    for (const shift of shifts) addRow(shift.user_id, shift.full_name, shift.designation).days[shift.shift_date] = shift;
    if (selectedEmployee) addRow(selectedEmployee.userId, selectedEmployee.fullName, selectedEmployee.designation);

    const rows = Array.from(byUser.values()).sort((a, b) => {
        if (a.isSelf) return -1;
        if (b.isSelf) return 1;
        return (a.fullName || "").localeCompare(b.fullName || "");
    });

    if (!selectedEmployee) return rows;
    return rows.filter((row) => Number(row.userId) === Number(selectedEmployee.userId));
}

// ==========================================
// SEARCH RESULT / CHIP TEXT
// ==========================================

export function employeeLabel(employee) {
    return `${employee.fullName}${employee.employeeId ? ` (${employee.employeeId})` : ""}`;
}

// "Filtered: Shafiq Mohammad (RS005)"
export function filterChipText(employee) {
    return `Filtered: ${employeeLabel(employee)}`;
}

export function employeeFromSearchResult(result) {
    return {
        userId: result.userId,
        fullName: result.fullName,
        employeeId: result.employeeId,
        designation: result.designation,
    };
}

// Per-day detail (status/times) in search results only makes sense in Day view:
// the search endpoint answers for one date.
export function showsDayDetail(view) {
    return view === VIEW_DAY;
}
