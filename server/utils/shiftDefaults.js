// Single source of truth for "which dates default to OFF when no
// shift_schedules row exists." Saturday/Sunday default to OFF; this
// is a presentation/response concern only -- nothing here writes a
// row, and an explicit shift_schedules row for a weekend date always
// wins (callers check the real row first, this is only consulted
// when none exists).

const DEFAULT_WEEKEND_STATUS = "off";

// `dateStr` is a "YYYY-MM-DD" string. Parsed as UTC (not local time)
// so the result is identical regardless of the server's timezone --
// shift dates are calendar dates, not instants.
function isWeekendDate(dateStr) {
    const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
    return day === 0 || day === 6;
}

// Every ISO date between startDate and endDate (inclusive) that is a
// Saturday or Sunday.
function computeDefaultOffDates(startDate, endDate) {
    const dates = [];
    const cursor = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);

    while (cursor <= end) {
        const iso = cursor.toISOString().slice(0, 10);
        if (isWeekendDate(iso)) dates.push(iso);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return dates;
}

// ==========================================
// REAL-TIME RECIPIENT SCOPING
// Mirrors shiftScheduleController.js's getShiftVisibilityScope/
// isAdminTier EXACTLY (same precedence: admin-tier checked first),
// so a socket's room membership never grants more than that same
// user's REST requests already would. Kept here, not duplicated in
// app.js, so the rule lives in exactly one place.
// ==========================================

function isAdminTierUser(user) {
    return user?.role === "admin" || ["admin", "super_admin"].includes(user?.systemAccess);
}

function isManagerTierUser(user) {
    return !isAdminTierUser(user) && user?.systemAccess === "manager";
}

// Which shift-event rooms a newly-connected socket should join.
//
// Deliberately narrower than "whatever REST allows this tier to look
// up on request": being ABLE to fetch one specific employee's shift
// via an explicit ?userId=/search call (a one-off, user-initiated
// PULL) is not the same authorization as being PUSHED live updates
// about every employee, unasked (a standing, ambient subscription).
// Nothing in this feature's requirements asks for the latter, and
// every page's own default view only ever shows the rows this plan
// grants live updates for -- so this mirrors what each tier actually
// SEES by default, not the outer limit of what REST would allow them
// to request one at a time.
//
// - Admin/Super Admin: the broad, tenant-wide room. Matches BOTH
//   their unrestricted REST access AND AdminShiftManagement.jsx's own
//   default view, which already fetches and displays the full
//   company roster.
// - Manager: the one tier REST also actually RESTRICTS (self + direct
//   reports only, 403 on anyone else) -- and the one tier whose
//   default grid also shows exactly that (self + team, via
//   getShiftVisibilityScope's "team" scope). They watch each direct
//   report's own personal room; never the broad room.
// - Every other tier (plain Employee, HR, Executive, Department Head,
//   Team Lead): no broad room, no extra watches. Their own personal
//   room (joined by every tier unconditionally, elsewhere) is the
//   only one, matching their default grid, which only ever shows
//   their own row.
function resolveShiftRoomPlan(user, directReportIds = []) {
    if (isAdminTierUser(user)) {
        return { joinBroadRoom: true, watchUserIds: [] };
    }
    if (isManagerTierUser(user)) {
        return { joinBroadRoom: false, watchUserIds: directReportIds };
    }
    return { joinBroadRoom: false, watchUserIds: [] };
}

module.exports = {
    DEFAULT_WEEKEND_STATUS,
    isWeekendDate,
    computeDefaultOffDates,
    isAdminTierUser,
    isManagerTierUser,
    resolveShiftRoomPlan,
};
