const pool = require("../config/db");
const { isAdminTier } = require("./shiftScheduleController");
const {
    PERIODS,
    resolveTimezone,
    todayInTimezone,
    resolveReportPeriod,
    addDays,
    aggregateAttendance,
    buildReportRows,
    reportFilename,
    buildWorkbook,
} = require("../services/shiftReportService");

// ==========================================
// GET /api/shifts/report/export?period=day|week|month&employee=all|<userId>
//
// Streams a real .xlsx built from shift_schedules + attendance.
//   - Admin / Super Admin only (the same isAdminTier boundary the shift
//     write overrides use); everyone else gets 403.
//   - Tenant isolation is the tenant's own database (`pool` is the
//     per-request tenant pool), exactly like every other shift query.
//   - The period is decided here from the server clock in the
//     configured timezone -- the client never sends a date, so there is
//     nothing to tamper with.
//   - Read-only: SELECTs only.
// ==========================================

const exportShiftReport = async (req, res) => {
    try {
        if (!isAdminTier(req)) {
            return res.status(403).json({
                success: false,
                message: "Only Admin/Super Admin can export shift reports.",
            });
        }

        const period = String(req.query.period || "").toLowerCase();

        if (!PERIODS.includes(period)) {
            return res.status(400).json({
                success: false,
                message: "Invalid period. Use day, week or month.",
            });
        }

        const employeeParam = String(req.query.employee ?? "all").trim().toLowerCase();
        let selected = null;

        if (employeeParam !== "all") {
            if (!/^[1-9]\d{0,9}$/.test(employeeParam)) {
                return res.status(400).json({ success: false, message: "Invalid employee id." });
            }

            const [found] = await pool.query(
                `SELECT id, employee_id, full_name, designation FROM users WHERE id = ? AND employment_status = 'active' LIMIT 1`,
                [Number(employeeParam)]
            );

            if (found.length === 0) {
                return res.status(404).json({ success: false, message: "Employee not found." });
            }

            selected = found[0];
        }

        const timeZone = resolveTimezone();
        const range = resolveReportPeriod(period, todayInTimezone(new Date(), timeZone));

        let employees;

        if (selected) {
            employees = [selected];
        } else {
            [employees] = await pool.query(
                `SELECT id, employee_id, full_name, designation
                 FROM users
                 WHERE employment_status = 'active'
                 ORDER BY full_name ASC, id ASC`
            );
        }

        const ids = employees.map((e) => e.id);
        let shifts = [];
        let attendance = [];

        if (ids.length > 0) {
            const idList = ids.map(() => "?").join(",");

            [shifts] = await pool.query(
                `SELECT user_id, TO_CHAR(shift_date, 'YYYY-MM-DD') AS shift_date, status, start_time, end_time
                 FROM shift_schedules
                 WHERE shift_date >= ? AND shift_date <= ? AND user_id IN (${idList})`,
                [range.start, range.end, ...ids]
            );

            // Raw sessions, read with a day of slack on both sides: which calendar
            // day a session belongs to is decided in the report timezone (see
            // aggregateAttendance), which can differ from the stored value's day.
            [attendance] = await pool.query(
                `SELECT user_id, login_time, logout_time, total_break_seconds, work_duration_seconds
                 FROM attendance
                 WHERE login_time >= ?::timestamp AND login_time < ?::timestamp AND user_id IN (${idList})
                 ORDER BY login_time ASC`,
                [addDays(range.start, -1), addDays(range.end, 2), ...ids]
            );

            attendance = aggregateAttendance(attendance, timeZone, range.dates);
        }

        const rows = buildReportRows({ employees, shifts, attendance, dates: range.dates });
        const buffer = await buildWorkbook({
            rows,
            range,
            scopeLabel: selected
                ? `${selected.full_name}${selected.employee_id ? ` (${selected.employee_id})` : ""}`
                : "All employees",
            timeZone,
        });

        const filename = reportFilename(period, selected);

        res.set({
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Access-Control-Expose-Headers": "Content-Disposition",
            "Cache-Control": "no-store",
        });

        return res.status(200).send(buffer);
    } catch (error) {
        console.error("Export Shift Report Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to generate the shift report",
        });
    }
};

module.exports = { exportShiftReport };
