// Unit tests for the Shift Management Excel report: period maths, row building, workbook
// contents, and the controller's authorization/validation (in-memory fake pool, no database).
const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");

const db = require("./config/db");
const svc = require("./services/shiftReportService");
const { exportShiftReport } = require("./controllers/shiftReportController");

// ---------------------------------------------------------------- period

test("day / week / month periods follow the current date (week = Monday..Sunday)", () => {
    assert.deepEqual(svc.resolveReportPeriod("day", "2026-10-24").dates, ["2026-10-24"]);

    // Saturday 24 Oct 2026 -> week Mon 19 .. Sun 25
    const week = svc.resolveReportPeriod("week", "2026-10-24");
    assert.equal(week.start, "2026-10-19");
    assert.equal(week.end, "2026-10-25");
    assert.equal(week.dates.length, 7);

    // a Sunday belongs to the week that ENDS on it, a Monday starts a new one
    assert.equal(svc.resolveReportPeriod("week", "2026-10-25").start, "2026-10-19");
    assert.equal(svc.resolveReportPeriod("week", "2026-10-26").start, "2026-10-26");

    // week spanning a month and a year boundary
    const edge = svc.resolveReportPeriod("week", "2027-01-01"); // Friday
    assert.equal(edge.start, "2026-12-28");
    assert.equal(edge.end, "2027-01-03");

    const oct = svc.resolveReportPeriod("month", "2026-10-24");
    assert.equal(oct.start, "2026-10-01");
    assert.equal(oct.end, "2026-10-31");
    assert.equal(oct.dates.length, 31);
    assert.equal(svc.resolveReportPeriod("month", "2028-02-10").dates.length, 29, "leap February");
    assert.equal(svc.resolveReportPeriod("month", "2026-02-10").dates.length, 28);
    assert.equal(svc.resolveReportPeriod("month", "2026-12-31").end, "2026-12-31");

    assert.throws(() => svc.resolveReportPeriod("year", "2026-10-24"));
});

test("'today' is decided in the configured timezone, not the host's", () => {
    // 20:00 UTC on 24 Oct is already 01:30 on 25 Oct in India, still the 24th in New York
    const instant = new Date("2026-10-24T20:00:00Z");
    assert.equal(svc.todayInTimezone(instant, "Asia/Kolkata"), "2026-10-25");
    assert.equal(svc.todayInTimezone(instant, "America/New_York"), "2026-10-24");
    assert.equal(svc.todayInTimezone(instant, "UTC"), "2026-10-24");

    assert.equal(svc.resolveTimezone("Europe/London"), "Europe/London");
    assert.equal(svc.resolveTimezone("Not/AZone"), svc.DEFAULT_TIMEZONE, "invalid value falls back");
    assert.equal(svc.resolveTimezone(""), svc.DEFAULT_TIMEZONE);
});

// ---------------------------------------------------------------- rows

test("scheduled hours: normal, overnight, missing times", () => {
    assert.equal(svc.scheduledHours("09:00:00", "18:30:00"), 9.5);
    assert.equal(svc.scheduledHours("22:00", "06:00"), 8, "overnight shift");
    assert.equal(svc.scheduledHours(null, "18:00"), null);
});

const EMPLOYEES = [
    { id: 1, employee_id: "EMP001", full_name: "Asha Rao", designation: "Developer" },
    { id: 2, employee_id: "EMP002", full_name: "Ben Mathew", designation: "Designer" },
];

test("rows: working / OFF / leave / weekend default / missing shift; actual columns come ONLY from attendance", () => {
    // Fri 23, Sat 24, Sun 25, Mon 26 Oct 2026
    const dates = ["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"];
    const shifts = [
        { user_id: 1, shift_date: "2026-10-23", status: "working", start_time: "09:00:00", end_time: "17:00:00" },
        { user_id: 1, shift_date: "2026-10-26", status: "off", start_time: null, end_time: null },
        { user_id: 2, shift_date: "2026-10-23", status: "leave", start_time: null, end_time: null },
        { user_id: 2, shift_date: "2026-10-24", status: "working", start_time: "10:00:00", end_time: "14:00:00" },
    ];
    const attendance = [
        { user_id: 1, attendance_date: "2026-10-23", first_login: "09:05", last_logout: "17:20", break_seconds: 3600, work_seconds: 26100, has_open_session: false },
        { user_id: 2, attendance_date: "2026-10-24", first_login: "10:00", last_logout: null, break_seconds: 0, work_seconds: null, has_open_session: true },
    ];
    const rows = svc.buildReportRows({ employees: EMPLOYEES, shifts, attendance, dates });
    const get = (u, d) => rows.find((r) => r.userId === u && r.date === d);

    assert.equal(rows.length, 8, "one row per employee per date");

    const worked = get(1, "2026-10-23");
    assert.equal(worked.shiftStatus, "Working");
    assert.equal(worked.day, "Friday");
    assert.equal(worked.scheduledStart, "09:00");
    assert.equal(worked.scheduledEnd, "17:00");
    assert.equal(worked.scheduledHours, 8);
    assert.equal(worked.actualClockIn, "09:05");
    assert.equal(worked.actualClockOut, "17:20");
    assert.equal(worked.breakHours, 1);
    assert.equal(worked.actualHours, 7.25, "actual hours are the attendance duration (26100s), not the 8 scheduled");

    assert.equal(get(1, "2026-10-24").shiftStatus, "OFF (weekend)");
    assert.equal(get(1, "2026-10-25").shiftStatus, "OFF (weekend)");
    assert.equal(get(1, "2026-10-26").shiftStatus, "OFF");
    assert.equal(get(2, "2026-10-23").shiftStatus, "Leave");
    assert.equal(get(2, "2026-10-26").shiftStatus, "Missing shift", "a weekday with no row");

    // scheduled hours NEVER leak into the actual columns
    const scheduledOnly = get(2, "2026-10-24");
    assert.equal(scheduledOnly.scheduledHours, 4);
    assert.equal(scheduledOnly.attendanceStatus, "In progress");
    assert.equal(scheduledOnly.actualClockOut, "");
    assert.equal(scheduledOnly.actualHours, null, "an open session has no completed hours yet");

    const noRecord = get(1, "2026-10-26");
    assert.equal(noRecord.attendanceStatus, "No record");
    assert.equal(noRecord.actualClockIn, "");
    assert.equal(noRecord.actualHours, null);
    assert.equal(get(1, "2026-10-23").scheduledHours, 8);
    // a day that was scheduled but has no attendance must not borrow the scheduled hours
    const scheduledNoAttendance = svc.buildReportRows({
        employees: [EMPLOYEES[0]],
        shifts: [shifts[0]],
        attendance: [],
        dates: ["2026-10-23"],
    })[0];
    assert.equal(scheduledNoAttendance.scheduledHours, 8);
    assert.equal(scheduledNoAttendance.actualHours, null);
    assert.equal(scheduledNoAttendance.attendanceStatus, "No record");

    const summary = svc.summarizeByEmployee(rows);
    const asha = summary.find((s) => s.employeeId === "EMP001");
    assert.equal(asha.scheduledHours, 8);
    assert.equal(asha.actualHours, 7.25);
    assert.equal(asha.attendanceDays, 1);
    assert.equal(asha.offDays, 3);
});

test("attendance is shown the way the attendance pages show it: instants converted into the report timezone, days bucketed in that timezone", () => {
    const dates = ["2026-10-22", "2026-10-23", "2026-10-24"];
    const sessions = [
        // 03:34-12:04 UTC = 09:04-17:34 IST on the 22nd
        { user_id: 1, login_time: new Date("2026-10-22T03:34:00Z"), logout_time: new Date("2026-10-22T12:04:00Z"), total_break_seconds: 1800, work_duration_seconds: 28200 },
        // a second session the same IST day: counts into the same record
        { user_id: 1, login_time: new Date("2026-10-22T13:00:00Z"), logout_time: new Date("2026-10-22T14:00:00Z"), total_break_seconds: 600, work_duration_seconds: 3000 },
        // 22:30 UTC on the 22nd is 04:00 IST on the 23rd -> belongs to the 23rd in IST, still open
        { user_id: 1, login_time: new Date("2026-10-22T22:30:00Z"), logout_time: null, total_break_seconds: 0, work_duration_seconds: null },
        // another employee, outside the report days
        { user_id: 2, login_time: new Date("2026-10-30T05:00:00Z"), logout_time: new Date("2026-10-30T06:00:00Z"), total_break_seconds: 0, work_duration_seconds: 3600 },
        // a different employee on the same day stays separate
        { user_id: 2, login_time: new Date("2026-10-23T04:00:00Z"), logout_time: new Date("2026-10-23T08:00:00Z"), total_break_seconds: 0, work_duration_seconds: 14400 },
    ];
    const ist = svc.aggregateAttendance(sessions, "Asia/Kolkata", dates);
    const find = (list, u, d) => list.find((r) => r.user_id === u && r.attendance_date === d);

    const day22 = find(ist, 1, "2026-10-22");
    assert.equal(day22.first_login, "09:04", "shown in IST, not the raw stored 03:34");
    assert.equal(day22.last_logout, "19:30");
    assert.equal(day22.break_seconds, 2400, "breaks are summed");
    assert.equal(day22.work_seconds, 31200, "completed sessions are summed");
    assert.equal(day22.has_open_session, false);

    const day23 = find(ist, 1, "2026-10-23");
    assert.equal(day23.first_login, "04:00", "04:00 IST on the 23rd");
    assert.equal(day23.has_open_session, true);
    assert.equal(day23.work_seconds, null, "an open session has no completed hours");

    assert.equal(find(ist, 2, "2026-10-23").first_login, "09:30");
    assert.equal(ist.filter((r) => r.user_id === 2).length, 1, "a session outside the report days is dropped");

    // the same instants in UTC land on different days / times: the configured timezone decides
    const utc = svc.aggregateAttendance(sessions, "UTC", dates);
    assert.equal(find(utc, 1, "2026-10-22").first_login, "03:34");
    assert.ok(find(utc, 1, "2026-10-22").has_open_session, "22:30 UTC is still the 22nd in UTC");
});

test("summary totals are summed from exact minutes/seconds, then rounded once (no per-day rounding drift)", () => {
    // 8h20m scheduled = 8.33h per day: five days is 41.67h, not 5 x 8.33 = 41.65
    const dates = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"];
    const shifts = dates.map((d) => ({ user_id: 1, shift_date: d, status: "working", start_time: "09:00:00", end_time: "17:20:00" }));
    // each day 29999s = 8.3331h (shown as 8.33), but five days really are 41.6661h -> 41.67
    const attendance = dates.map((d) => ({ user_id: 1, attendance_date: d, first_login: "09:00", last_logout: "17:20", break_seconds: 1799, work_seconds: 29999, has_open_session: false }));
    const rows = svc.buildReportRows({ employees: [EMPLOYEES[0]], shifts, attendance, dates });
    assert.equal(rows[0].scheduledHours, 8.33);
    assert.equal(rows[0].actualHours, 8.33);
    const [s] = svc.summarizeByEmployee(rows);
    assert.equal(s.scheduledHours, 41.67);
    assert.equal(s.actualHours, 41.67);
    assert.equal(s.breakHours, 2.5);
    assert.ok(!("actualSeconds" in s) && !("scheduledMinutes" in s), "internal accumulators are not exposed");
});

test("file names: period and, for one employee, the employee id (sanitised)", () => {
    assert.equal(svc.reportFilename("day"), "Employee_Shift_Report_Daily.xlsx");
    assert.equal(svc.reportFilename("week"), "Employee_Shift_Report_Weekly.xlsx");
    assert.equal(svc.reportFilename("month"), "Employee_Shift_Report_Monthly.xlsx");
    assert.equal(svc.reportFilename("week", { id: 2, employee_id: "EMP002" }), "Employee_Shift_Report_Weekly_EMP002.xlsx");
    assert.equal(svc.reportFilename("day", { id: 9, employee_id: 'a/b"c d' }), "Employee_Shift_Report_Daily_abcd.xlsx");
    assert.equal(svc.reportFilename("day", { id: 9, employee_id: null }), "Employee_Shift_Report_Daily_User9.xlsx");
});

// ---------------------------------------------------------------- workbook

test("workbook is a real .xlsx: Summary + Detail sheets, headers, rows and totals", async () => {
    const range = svc.resolveReportPeriod("week", "2026-10-24");
    const rows = svc.buildReportRows({
        employees: EMPLOYEES,
        shifts: [{ user_id: 1, shift_date: "2026-10-23", status: "working", start_time: "09:00:00", end_time: "17:00:00" }],
        attendance: [{ user_id: 1, attendance_date: "2026-10-23", first_login: "09:05", last_logout: "17:20", break_seconds: 3600, work_seconds: 26100, has_open_session: false }],
        dates: range.dates,
    });
    const buffer = await svc.buildWorkbook({ rows, range, scopeLabel: "All employees", timeZone: "Asia/Kolkata", generatedAt: new Date("2026-10-24T08:00:00Z") });

    assert.equal(buffer.slice(0, 2).toString(), "PK", "xlsx is a zip container");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ["Summary", "Detail"]);

    const detail = wb.getWorksheet("Detail");
    const headers = detail.getRow(1).values.slice(1);
    assert.deepEqual(headers, [
        "Employee ID", "Employee Name", "Designation", "Date", "Day", "Shift Status", "Scheduled Start", "Scheduled End",
        "Scheduled Hours", "Attendance", "Actual Clock-In", "Actual Clock-Out", "Break Duration (hrs)", "Actual Working Hours",
    ]);
    assert.equal(detail.rowCount, 1 + 14, "header + 2 employees x 7 days");
    const friday = detail.getRows(2, 14).find((r) => r.getCell(1).value === "EMP001" && r.getCell(4).value === "2026-10-23");
    assert.equal(friday.getCell(9).value, 8);
    assert.equal(friday.getCell(11).value, "09:05");
    assert.equal(friday.getCell(14).value, 7.25);

    const summary = wb.getWorksheet("Summary");
    const text = [];
    summary.eachRow((r) => text.push(r.values.slice(1).join("|")));
    const joined = text.join("\n");
    assert.match(joined, /Employee Shift Report - Weekly/);
    assert.match(joined, /2026-10-19 to 2026-10-25/);
    assert.match(joined, /Asia\/Kolkata/);
    assert.match(joined, /TOTAL\|2 employees\|\|1\|/, "total row: 1 working day across both employees");
    assert.match(joined, /Actual hours come from attendance records only/);
});

// ---------------------------------------------------------------- controller

function fakeRes() {
    const res = { statusCode: null, body: null, headers: {} };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.send = (b) => { res.body = b; return res; };
    res.set = (h) => { Object.assign(res.headers, h); return res; };
    return res;
}

function withFakePool(handler) {
    const original = db.query;
    const calls = [];
    db.query = async (sql, params = []) => { calls.push({ sql, params }); return handler(sql, params); };
    return { calls, restore: () => { db.query = original; } };
}

const ADMIN = { userAccess: { role: "admin", systemAccess: "admin" }, user: { id: 99 } };

test("controller: non-admin tiers are refused before any query runs", async () => {
    for (const userAccess of [{ role: "employee", systemAccess: "employee" }, { role: "employee", systemAccess: "manager" }, undefined]) {
        const fake = withFakePool(() => { throw new Error("must not query"); });
        try {
            const res = fakeRes();
            await exportShiftReport({ query: { period: "week", employee: "all" }, userAccess, user: { id: 5 } }, res);
            assert.equal(res.statusCode, 403);
            assert.equal(fake.calls.length, 0);
        } finally { fake.restore(); }
    }
});

test("controller: invalid period / employee are rejected; unknown employee is 404", async () => {
    const fake = withFakePool(() => [[]]);
    try {
        for (const [query, status] of [
            [{ period: "year" }, 400],
            [{}, 400],
            [{ period: "week", employee: "abc" }, 400],
            [{ period: "week", employee: "1; DROP TABLE users" }, 400],
            [{ period: "week", employee: "0" }, 400],
            [{ period: "week", employee: "-3" }, 400],
            [{ period: "week", employee: "7" }, 404],
        ]) {
            const res = fakeRes();
            await exportShiftReport({ ...ADMIN, query }, res);
            assert.equal(res.statusCode, status, JSON.stringify(query));
        }
    } finally { fake.restore(); }
});

test("controller: admin gets a real xlsx download; queries are read-only and parameterised", async () => {
    const fake = withFakePool((sql) => {
        if (/FROM users/.test(sql)) return [[EMPLOYEES[1]]];
        if (/FROM shift_schedules/.test(sql)) return [[]];
        if (/FROM attendance/.test(sql)) return [[]];
        throw new Error("unexpected query " + sql);
    });
    try {
        const res = fakeRes();
        await exportShiftReport({ ...ADMIN, query: { period: "month", employee: "2" } }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers["Content-Type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        assert.match(res.headers["Content-Disposition"], /^attachment; filename="Employee_Shift_Report_Monthly_EMP002\.xlsx"$/);
        assert.equal(res.headers["Cache-Control"], "no-store");
        assert.equal(res.body.slice(0, 2).toString(), "PK");

        for (const { sql, params } of fake.calls) {
            assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i.test(sql), "read-only");
            assert.ok(!/EMP002|\$\{/.test(sql), "values are bound parameters, never interpolated");
            assert.ok(Array.isArray(params));
        }
        const shiftCall = fake.calls.find((c) => /FROM shift_schedules/.test(c.sql));
        assert.ok(shiftCall.params.includes(2), "filtered to the selected employee only");
    } finally { fake.restore(); }
});

test("controller: 'all' reads every active employee, nothing from the request picks the date range", async () => {
    const fake = withFakePool((sql) => {
        if (/FROM users/.test(sql)) return [EMPLOYEES];
        return [[]];
    });
    try {
        const res = fakeRes();
        await exportShiftReport({ ...ADMIN, query: { period: "day", employee: "all", startDate: "1999-01-01", endDate: "1999-01-02" } }, res);
        assert.equal(res.statusCode, 200);
        assert.match(res.headers["Content-Disposition"], /Employee_Shift_Report_Daily\.xlsx"$/);
        const usersCall = fake.calls.find((c) => /FROM users/.test(c.sql));
        assert.match(usersCall.sql, /employment_status = 'active'/);
        const shiftCall = fake.calls.find((c) => /FROM shift_schedules/.test(c.sql));
        assert.ok(!shiftCall.params.includes("1999-01-01"), "client-supplied dates are ignored");
        assert.equal(shiftCall.params[0], shiftCall.params[1], "a day report covers a single date");
    } finally { fake.restore(); }
});
