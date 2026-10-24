const ExcelJS = require("exceljs");

// ==========================================
// SHIFT REPORT (Excel export)
//
// Pure functions (no database, no Express) so the period maths, the
// row building and the workbook can be unit-tested directly. The
// controller (shiftReportController.js) only fetches the rows.
//
// SCHEDULED vs ACTUAL: scheduled columns come from shift_schedules,
// actual columns come from attendance. They are never derived from one
// another -- no attendance record means blank actual cells, never the
// scheduled hours.
// ==========================================

const PERIODS = ["day", "week", "month"];

const PERIOD_LABELS = { day: "Daily", week: "Weekly", month: "Monthly" };

const DEFAULT_TIMEZONE = "Asia/Kolkata";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// The report period is decided on the SERVER's clock, in one configured
// timezone, so it never depends on the administrator's browser or the
// host's own timezone. Set APP_TIMEZONE (an IANA name such as
// "Asia/Kolkata"); an unset or invalid value falls back to the default.
function resolveTimezone(configured = process.env.APP_TIMEZONE) {
    const candidate = String(configured || "").trim() || DEFAULT_TIMEZONE;

    try {
        new Intl.DateTimeFormat("en-CA", { timeZone: candidate });
        return candidate;
    } catch {
        return DEFAULT_TIMEZONE;
    }
}

// "YYYY-MM-DD" of `now` as seen in `timeZone`.
function todayInTimezone(now = new Date(), timeZone = resolveTimezone()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(now);
    const pick = (type) => parts.find((p) => p.type === type).value;

    return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

// Wall-clock date ("YYYY-MM-DD") and time ("HH:MM") of an instant in `timeZone`.
function wallClockIn(instant, timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(instant);
    const pick = (type) => parts.find((p) => p.type === type).value;

    return { date: `${pick("year")}-${pick("month")}-${pick("day")}`, time: `${pick("hour")}:${pick("minute")}` };
}

function parseIso(iso) {
    return new Date(`${iso}T00:00:00Z`);
}

function toIso(date) {
    return date.toISOString().slice(0, 10);
}

function addDays(iso, days) {
    const d = parseIso(iso);
    d.setUTCDate(d.getUTCDate() + days);
    return toIso(d);
}

function dayName(iso) {
    return DAY_NAMES[parseIso(iso).getUTCDay()];
}

function isWeekend(iso) {
    const day = parseIso(iso).getUTCDay();
    return day === 0 || day === 6;
}

// day = today; week = Monday..Sunday containing today; month = the
// calendar month containing today. `todayIso` is "YYYY-MM-DD".
function resolveReportPeriod(period, todayIso) {
    if (!PERIODS.includes(period)) {
        throw new Error(`Invalid period "${period}".`);
    }

    let start = todayIso;
    let end = todayIso;

    if (period === "week") {
        const dow = parseIso(todayIso).getUTCDay(); // 0 = Sunday
        start = addDays(todayIso, dow === 0 ? -6 : 1 - dow);
        end = addDays(start, 6);
    } else if (period === "month") {
        const [year, month] = todayIso.split("-").map(Number);
        start = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
        end = toIso(new Date(Date.UTC(year, month, 0)));
    }

    const dates = [];
    for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);

    return { period, label: PERIOD_LABELS[period], start, end, dates };
}

// "09:00:00" / "09:00" -> minutes since midnight, or null.
function timeToMinutes(value) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(value ?? ""));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function formatClock(value) {
    const minutes = timeToMinutes(value);
    if (minutes === null) return "";

    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Scheduled hours for a working shift. An end time at or before the
// start time is an overnight shift (runs into the next day).
function scheduledMinutes(startTime, endTime) {
    const start = timeToMinutes(startTime);
    const end = timeToMinutes(endTime);
    if (start === null || end === null) return null;

    return end > start ? end - start : end + 24 * 60 - start;
}

function scheduledHours(startTime, endTime) {
    const minutes = scheduledMinutes(startTime, endTime);
    return minutes === null ? null : round2(minutes / 60);
}

function secondsToHours(seconds) {
    return seconds === null || seconds === undefined || seconds === "" ? null : round2(Number(seconds) / 3600);
}

function shiftStatusFor(shift, date) {
    if (!shift) {
        return isWeekend(date) ? "OFF (weekend)" : "Missing shift";
    }

    if (shift.status === "off") return "OFF";
    if (shift.status === "leave") return "Leave";

    return timeToMinutes(shift.start_time) === null || timeToMinutes(shift.end_time) === null
        ? "Working (times missing)"
        : "Working";
}

// Combines raw attendance sessions into one record per employee per calendar
// day. The attendance pages show a session by reading login_time as an INSTANT
// (new Date(login_time) in the browser), so the report does the same: each
// instant is converted into `timeZone` for both the clock time and the day it
// belongs to. Several sessions on one day become: earliest clock-in, latest
// clock-out, summed break and worked time. work_duration_seconds is NULL until a
// session ends, so an open session adds nothing and sets has_open_session.
// Only days inside `dates` are returned.
function aggregateAttendance(sessions, timeZone, dates) {
    const wanted = new Set(dates);
    const byKey = new Map();

    for (const session of sessions) {
        const login = new Date(session.login_time);
        if (Number.isNaN(login.getTime())) continue;

        const { date } = wallClockIn(login, timeZone);
        if (!wanted.has(date)) continue;

        const key = `${session.user_id}|${date}`;
        const logout = session.logout_time ? new Date(session.logout_time) : null;
        let record = byKey.get(key);

        if (!record) {
            record = {
                user_id: session.user_id,
                attendance_date: date,
                firstLoginAt: login,
                lastLogoutAt: null,
                break_seconds: 0,
                work_seconds: null,
                has_open_session: false,
            };
            byKey.set(key, record);
        }

        if (login < record.firstLoginAt) record.firstLoginAt = login;
        if (logout && !Number.isNaN(logout.getTime()) && (!record.lastLogoutAt || logout > record.lastLogoutAt)) {
            record.lastLogoutAt = logout;
        }
        if (!session.logout_time) record.has_open_session = true;

        record.break_seconds += Number(session.total_break_seconds) || 0;
        if (session.work_duration_seconds !== null && session.work_duration_seconds !== undefined) {
            record.work_seconds = (record.work_seconds || 0) + Number(session.work_duration_seconds);
        }
    }

    return [...byKey.values()].map((r) => ({
        user_id: r.user_id,
        attendance_date: r.attendance_date,
        first_login: wallClockIn(r.firstLoginAt, timeZone).time,
        last_logout: r.lastLogoutAt ? wallClockIn(r.lastLogoutAt, timeZone).time : null,
        break_seconds: r.break_seconds,
        work_seconds: r.work_seconds,
        has_open_session: r.has_open_session,
    }));
}

// One row per employee per date. `shifts` are shift_schedules rows
// (shift_date as "YYYY-MM-DD"); `attendance` are per-user-per-date
// aggregates (see the controller's query).
function buildReportRows({ employees, shifts, attendance, dates }) {
    const shiftByKey = new Map(shifts.map((s) => [`${s.user_id}|${s.shift_date}`, s]));
    const attendanceByKey = new Map(attendance.map((a) => [`${a.user_id}|${a.attendance_date}`, a]));
    const rows = [];

    for (const employee of employees) {
        for (const date of dates) {
            const shift = shiftByKey.get(`${employee.id}|${date}`) || null;
            const record = attendanceByKey.get(`${employee.id}|${date}`) || null;
            const status = shiftStatusFor(shift, date);
            const working = status === "Working";
            const inProgress = Boolean(record && record.has_open_session);

            rows.push({
                userId: employee.id,
                employeeId: employee.employee_id || "",
                employeeName: employee.full_name || "",
                designation: employee.designation || "",
                date,
                day: dayName(date),
                shiftStatus: status,
                scheduledStart: working ? formatClock(shift.start_time) : "",
                scheduledEnd: working ? formatClock(shift.end_time) : "",
                scheduledHours: working ? scheduledHours(shift.start_time, shift.end_time) : null,
                scheduledMinutes: working ? scheduledMinutes(shift.start_time, shift.end_time) : 0,
                attendanceStatus: record ? (inProgress ? "In progress" : "Recorded") : "No record",
                actualClockIn: record ? formatClock(record.first_login) : "",
                actualClockOut: record && record.last_logout ? formatClock(record.last_logout) : "",
                breakHours: record ? secondsToHours(record.break_seconds) : null,
                // Completed sessions only; a session still open has no
                // duration yet and is flagged "In progress" above.
                actualHours: record ? secondsToHours(record.work_seconds) : null,
                // exact seconds, kept only so the Summary totals are summed from the
                // real values and rounded once (not from already-rounded daily hours)
                workSeconds: record ? Number(record.work_seconds) || 0 : 0,
                breakSeconds: record ? Number(record.break_seconds) || 0 : 0,
            });
        }
    }

    return rows;
}

function summarizeByEmployee(rows) {
    const byUser = new Map();

    for (const row of rows) {
        if (!byUser.has(row.userId)) {
            byUser.set(row.userId, {
                employeeId: row.employeeId,
                employeeName: row.employeeName,
                designation: row.designation,
                workingDays: 0,
                offDays: 0,
                leaveDays: 0,
                missingShiftDays: 0,
                scheduledMinutes: 0,
                attendanceDays: 0,
                actualSeconds: 0,
                breakSeconds: 0,
            });
        }

        const s = byUser.get(row.userId);

        if (row.shiftStatus.startsWith("Working")) s.workingDays += 1;
        else if (row.shiftStatus.startsWith("OFF")) s.offDays += 1;
        else if (row.shiftStatus === "Leave") s.leaveDays += 1;
        else if (row.shiftStatus === "Missing shift") s.missingShiftDays += 1;

        s.scheduledMinutes += row.scheduledMinutes;

        if (row.attendanceStatus !== "No record") s.attendanceDays += 1;
        s.actualSeconds += row.workSeconds;
        s.breakSeconds += row.breakSeconds;
    }

    return [...byUser.values()].map(({ actualSeconds, breakSeconds, scheduledMinutes: minutes, ...s }) => ({
        ...s,
        scheduledHours: round2(minutes / 60),
        actualHours: round2(actualSeconds / 3600),
        breakHours: round2(breakSeconds / 3600),
    }));
}

function reportFilename(period, employee) {
    const base = `Employee_Shift_Report_${PERIOD_LABELS[period]}`;
    if (!employee) return `${base}.xlsx`;

    const id = String(employee.employee_id || `User${employee.id}`).replace(/[^A-Za-z0-9_-]/g, "");
    return `${base}_${id || `User${employee.id}`}.xlsx`;
}

const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0E744A" } };
const HEADER_FONT = { bold: true, color: { argb: "FFFFFFFF" } };
const TOTAL_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE3F6EC" } };

function styleHeader(row) {
    row.eachCell((cell) => {
        cell.fill = HEADER_FILL;
        cell.font = HEADER_FONT;
        cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    });
    row.height = 30;
}

async function buildWorkbook({ rows, range, scopeLabel, timeZone, generatedAt = new Date() }) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Reinsteins WorkHub";
    workbook.created = generatedAt;

    // ---- Summary sheet
    const summary = workbook.addWorksheet("Summary");
    summary.addRow([`Employee Shift Report - ${range.label}`]).font = { bold: true, size: 14 };
    summary.addRow(["Period", range.start === range.end ? range.start : `${range.start} to ${range.end}`]);
    summary.addRow(["Employees", scopeLabel]);
    summary.addRow(["Timezone", timeZone]);
    summary.addRow([
        "Generated",
        new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(generatedAt),
    ]);
    summary.addRow([
        "Note",
        "Scheduled hours come from the shift schedule. Actual hours come from attendance records only; blank means no attendance record.",
    ]);
    summary.addRow([]);

    const summaryColumns = [
        ["Employee ID", 14],
        ["Employee Name", 26],
        ["Designation", 24],
        ["Working Days", 14],
        ["OFF Days", 11],
        ["Leave Days", 12],
        ["Missing Shift Days", 18],
        ["Total Scheduled Hours", 20],
        ["Days With Attendance", 20],
        ["Total Actual Hours", 18],
        ["Total Break Hours", 17],
    ];
    styleHeader(summary.addRow(summaryColumns.map(([title]) => title)));
    summary.columns = summaryColumns.map(([, width]) => ({ width }));

    const perEmployee = summarizeByEmployee(rows);
    for (const s of perEmployee) {
        summary.addRow([
            s.employeeId,
            s.employeeName,
            s.designation,
            s.workingDays,
            s.offDays,
            s.leaveDays,
            s.missingShiftDays,
            s.scheduledHours,
            s.attendanceDays,
            s.actualHours,
            s.breakHours,
        ]);
    }

    const sum = (key) => round2(perEmployee.reduce((total, s) => total + s[key], 0));
    const totalRow = summary.addRow([
        "TOTAL",
        `${perEmployee.length} employee${perEmployee.length === 1 ? "" : "s"}`,
        "",
        sum("workingDays"),
        sum("offDays"),
        sum("leaveDays"),
        sum("missingShiftDays"),
        sum("scheduledHours"),
        sum("attendanceDays"),
        sum("actualHours"),
        sum("breakHours"),
    ]);
    totalRow.font = { bold: true };
    totalRow.eachCell((cell) => {
        cell.fill = TOTAL_FILL;
    });
    for (const col of [8, 10, 11]) summary.getColumn(col).numFmt = "0.00";
    summary.getCell("B6").alignment = { wrapText: false };

    // ---- Detail sheet
    const detail = workbook.addWorksheet("Detail", { views: [{ state: "frozen", ySplit: 1 }] });
    const detailColumns = [
        ["Employee ID", "employeeId", 14],
        ["Employee Name", "employeeName", 26],
        ["Designation", "designation", 24],
        ["Date", "date", 13],
        ["Day", "day", 12],
        ["Shift Status", "shiftStatus", 22],
        ["Scheduled Start", "scheduledStart", 16],
        ["Scheduled End", "scheduledEnd", 16],
        ["Scheduled Hours", "scheduledHours", 16],
        ["Attendance", "attendanceStatus", 14],
        ["Actual Clock-In", "actualClockIn", 16],
        ["Actual Clock-Out", "actualClockOut", 17],
        ["Break Duration (hrs)", "breakHours", 19],
        ["Actual Working Hours", "actualHours", 20],
    ];
    detail.columns = detailColumns.map(([header, key, width]) => ({ header, key, width }));
    styleHeader(detail.getRow(1));

    for (const row of rows) detail.addRow(row);

    for (const key of ["scheduledHours", "breakHours", "actualHours"]) detail.getColumn(key).numFmt = "0.00";
    detail.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: detailColumns.length } };

    return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = {
    PERIODS,
    DEFAULT_TIMEZONE,
    resolveTimezone,
    todayInTimezone,
    resolveReportPeriod,
    addDays,
    aggregateAttendance,
    scheduledHours,
    buildReportRows,
    summarizeByEmployee,
    reportFilename,
    buildWorkbook,
};
