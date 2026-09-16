import { useEffect, useMemo, useState } from "react";
import { FaCalendarWeek, FaChevronLeft, FaChevronRight, FaTrash, FaTimes, FaUserShield, FaCopy } from "react-icons/fa";
import { toast } from "react-toastify";

import api from "../../services/api";
import {
    getShifts,
    createShift,
    updateShift,
    deleteShift,
    bulkSaveShifts,
} from "../../services/shiftScheduleService";
import EmployeeNameplate from "../../components/EmployeeNameplate";

import "./AdminShiftManagement.css";

// ==========================================
// DATE HELPERS (same conventions as EmployeeShiftSchedule.jsx)
// ==========================================

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function toIsoDate(date) {
    return date.toISOString().slice(0, 10);
}

function getMondayOf(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

function addDays(date, amount) {
    const d = new Date(date);
    d.setDate(d.getDate() + amount);
    return d;
}

function formatRangeLabel(monday) {
    const sunday = addDays(monday, 6);
    const opts = { day: "numeric", month: "short" };
    return `${monday.toLocaleDateString("en-IN", opts)} - ${sunday.toLocaleDateString("en-IN", opts)}`;
}

function formatTimeLabel(time) {
    if (!time) return "";
    const [h, m] = time.split(":");
    const hour = Number(h);
    const suffix = hour >= 12 ? "PM" : "AM";
    const displayHour = hour % 12 === 0 ? 12 : hour % 12;
    return m === "00" ? `${displayHour}${suffix}` : `${displayHour}:${m}${suffix}`;
}

function shiftCellLabel(entry) {
    if (!entry) return "—";
    if (entry.status === "off") return "OFF";
    if (entry.status === "leave") return "LEAVE";
    if (entry.start_time && entry.end_time) {
        return `${formatTimeLabel(entry.start_time)}-${formatTimeLabel(entry.end_time)}`;
    }
    return "—";
}

function getCurrentUser() {
    try {
        return JSON.parse(sessionStorage.getItem("user"));
    } catch {
        return null;
    }
}

const EMPTY_SELF_FORM = { id: null, shiftDate: "", status: "working", startTime: "09:00", endTime: "18:00", notes: "" };
const EMPTY_OVERRIDE_FORM = { id: null, userId: "", shiftDate: "", status: "working", startTime: "09:00", endTime: "18:00", notes: "" };

function AdminShiftManagement() {
    const currentUser = useMemo(() => getCurrentUser(), []);

    const [weekStart, setWeekStart] = useState(() => getMondayOf(new Date()));
    const [shifts, setShifts] = useState([]);
    const [employees, setEmployees] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const [copying, setCopying] = useState(false);

    // Two SEPARATE forms/modals -- self-service (no employee picker,
    // always the admin's own row) and the explicit administrative
    // override (requires picking an employee, clearly labeled as an
    // override everywhere it appears in the UI). Never merged into one
    // form: Part 6/8 of the corrected requirement is explicit that
    // these two actions must stay visually and functionally distinct,
    // not "admin edits everyone by default."
    const [showSelfForm, setShowSelfForm] = useState(false);
    const [selfForm, setSelfForm] = useState(EMPTY_SELF_FORM);

    const [showOverrideForm, setShowOverrideForm] = useState(false);
    const [overrideForm, setOverrideForm] = useState(EMPTY_OVERRIDE_FORM);

    const weekDates = useMemo(
        () => Array.from({ length: 7 }, (_, i) => toIsoDate(addDays(weekStart, i))),
        [weekStart]
    );

    const loadSchedule = async () => {
        try {
            setLoading(true);
            setError("");

            const data = await getShifts(weekDates[0], weekDates[6]);
            setShifts(Array.isArray(data.shifts) ? data.shifts : []);

        } catch (err) {
            console.error("Load shift schedule error:", err);
            setShifts([]);
            setError(err.response?.data?.message || "Unable to load the shift schedule");
        } finally {
            setLoading(false);
        }
    };

    const loadEmployees = async () => {
        try {
            const response = await api.get("/employees");
            setEmployees((response.data.employees || []).filter((e) => e.employment_status === "active"));
        } catch (err) {
            console.error("Load employees error:", err);
        }
    };

    useEffect(() => {
        loadSchedule();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [weekStart]);

    useEffect(() => {
        loadEmployees();
    }, []);

    // Company-wide view: every active employee gets a row (even with a
    // blank week), my own row pinned to the top and highlighted.
    const employeeRows = useMemo(() => {
        const byUser = new Map();

        for (const employee of employees) {
            byUser.set(employee.id, {
                userId: employee.id,
                fullName: employee.full_name,
                designation: employee.designation,
                isSelf: currentUser?.id === employee.id,
                days: {},
            });
        }

        for (const shift of shifts) {
            if (!byUser.has(shift.user_id)) {
                byUser.set(shift.user_id, {
                    userId: shift.user_id,
                    fullName: shift.full_name,
                    designation: shift.designation,
                    isSelf: currentUser?.id === shift.user_id,
                    days: {},
                });
            }
            byUser.get(shift.user_id).days[shift.shift_date] = shift;
        }

        const rows = Array.from(byUser.values());
        rows.sort((a, b) => {
            if (a.isSelf) return -1;
            if (b.isSelf) return 1;
            return (a.fullName || "").localeCompare(b.fullName || "");
        });
        return rows;
    }, [shifts, employees, currentUser]);

    // ==========================================
    // MY SCHEDULE (self-service -- identical model to the employee page)
    // ==========================================

    const openSelfAdd = (date) => {
        setSelfForm({ ...EMPTY_SELF_FORM, shiftDate: date });
        setShowSelfForm(true);
    };

    const openSelfEdit = (entry) => {
        setSelfForm({
            id: entry.id,
            shiftDate: entry.shift_date,
            status: entry.status,
            startTime: entry.start_time || "09:00",
            endTime: entry.end_time || "18:00",
            notes: entry.notes || "",
        });
        setShowSelfForm(true);
    };

    const handleSelfFieldChange = (event) => {
        const { name, value } = event.target;
        setSelfForm((prev) => ({ ...prev, [name]: value }));
    };

    const handleSelfSubmit = async (event) => {
        event.preventDefault();

        const payload = {
            shiftDate: selfForm.shiftDate,
            status: selfForm.status,
            startTime: selfForm.status === "working" ? selfForm.startTime : null,
            endTime: selfForm.status === "working" ? selfForm.endTime : null,
            notes: selfForm.notes,
        };

        try {
            setSaving(true);

            if (selfForm.id) {
                await updateShift(selfForm.id, payload);
                toast.success("Your schedule was updated");
            } else {
                await createShift(payload);
                toast.success("Your schedule was added");
            }

            setShowSelfForm(false);
            await loadSchedule();

        } catch (err) {
            console.error("Save my shift error:", err);
            toast.error(err.response?.data?.message || "Unable to save your schedule");
        } finally {
            setSaving(false);
        }
    };

    const handleSelfDelete = async () => {
        if (!selfForm.id) return;

        try {
            setSaving(true);
            await deleteShift(selfForm.id);
            toast.success("Your schedule entry was removed");
            setShowSelfForm(false);
            await loadSchedule();
        } catch (err) {
            console.error("Delete my shift error:", err);
            toast.error(err.response?.data?.message || "Unable to remove your schedule entry");
        } finally {
            setSaving(false);
        }
    };

    // ==========================================
    // ADMINISTRATIVE OVERRIDE (explicit, separate action -- manage
    // another employee's schedule on their behalf)
    // ==========================================

    const openOverrideCreate = () => {
        setOverrideForm({ ...EMPTY_OVERRIDE_FORM, shiftDate: weekDates[0] });
        setShowOverrideForm(true);
    };

    const handleOverrideFieldChange = (event) => {
        const { name, value } = event.target;

        setOverrideForm((prev) => {
            const next = { ...prev, [name]: value };

            // Once both employee and date are chosen, auto-populate from
            // an existing entry for that combination (within the
            // currently loaded week) so picking an already-scheduled
            // employee/date edits it in place instead of hitting the
            // create endpoint's duplicate-entry 409.
            if ((name === "userId" || name === "shiftDate") && next.userId && next.shiftDate) {
                const existing = shifts.find(
                    (s) => Number(s.user_id) === Number(next.userId) && s.shift_date === next.shiftDate
                );

                if (existing) {
                    return {
                        id: existing.id,
                        userId: next.userId,
                        shiftDate: next.shiftDate,
                        status: existing.status,
                        startTime: existing.start_time || "09:00",
                        endTime: existing.end_time || "18:00",
                        notes: existing.notes || "",
                    };
                }

                // No existing entry for this combination -- make sure a
                // previously-populated id (from a prior selection that DID
                // match) doesn't linger and turn this into an accidental
                // update of the wrong row.
                return { ...next, id: null };
            }

            return next;
        });
    };

    const handleOverrideSubmit = async (event) => {
        event.preventDefault();

        if (!overrideForm.userId) {
            toast.error("Select an employee");
            return;
        }
        if (!overrideForm.shiftDate) {
            toast.error("Select a date");
            return;
        }

        const payload = {
            userId: overrideForm.userId,
            shiftDate: overrideForm.shiftDate,
            status: overrideForm.status,
            startTime: overrideForm.status === "working" ? overrideForm.startTime : null,
            endTime: overrideForm.status === "working" ? overrideForm.endTime : null,
            notes: overrideForm.notes,
        };

        try {
            setSaving(true);

            if (overrideForm.id) {
                await updateShift(overrideForm.id, payload);
                toast.success("Shift updated successfully (administrative override)");
            } else {
                await createShift(payload);
                toast.success("Shift created successfully (administrative override)");
            }

            setShowOverrideForm(false);
            await loadSchedule();

        } catch (err) {
            console.error("Save override shift error:", err);
            toast.error(err.response?.data?.message || "Unable to save shift");
        } finally {
            setSaving(false);
        }
    };

    const handleOverrideDelete = async () => {
        if (!overrideForm.id) return;

        try {
            setSaving(true);
            await deleteShift(overrideForm.id);
            toast.success("Shift deleted successfully (administrative override)");
            setShowOverrideForm(false);
            await loadSchedule();
        } catch (err) {
            console.error("Delete override shift error:", err);
            toast.error(err.response?.data?.message || "Unable to delete shift");
        } finally {
            setSaving(false);
        }
    };

    const handleCopyPreviousWeekAllEmployees = async () => {
        try {
            setCopying(true);

            const previousMonday = addDays(weekStart, -7);
            const previousSunday = addDays(previousMonday, 6);

            const data = await getShifts(toIsoDate(previousMonday), toIsoDate(previousSunday));
            const previousShifts = data.shifts || [];

            if (previousShifts.length === 0) {
                toast.error("Previous week has no shifts to copy");
                return;
            }

            const shiftedEntries = previousShifts.map((entry) => ({
                userId: entry.user_id,
                shiftDate: toIsoDate(addDays(new Date(`${entry.shift_date}T00:00:00`), 7)),
                status: entry.status,
                startTime: entry.start_time,
                endTime: entry.end_time,
                notes: entry.notes,
            }));

            const result = await bulkSaveShifts(shiftedEntries);
            toast.success(result.message || "Previous week copied successfully");
            await loadSchedule();

        } catch (err) {
            console.error("Copy previous week error:", err);
            toast.error(err.response?.data?.message || "Unable to copy previous week");
        } finally {
            setCopying(false);
        }
    };

    return (
        <div className="admin-page-content">

            <section className="shift-schedule-header">
                <div>
                    <h2>Shift Management</h2>
                    <p>Company Schedule -- everyone's shifts are visible. Your own row (highlighted) is self-service, like any employee.</p>
                </div>
            </section>

            <section className="shift-schedule-week-nav">
                <button type="button" className="shift-week-nav-button" onClick={() => setWeekStart((prev) => addDays(prev, -7))}>
                    <FaChevronLeft /> Previous Week
                </button>
                <span className="shift-week-range">
                    <FaCalendarWeek /> {formatRangeLabel(weekStart)}
                </span>
                <button type="button" className="shift-week-nav-button" onClick={() => setWeekStart((prev) => addDays(prev, 7))}>
                    Next Week <FaChevronRight />
                </button>
            </section>

            {/* ADMINISTRATIVE OVERRIDE -- deliberately separated from the
                table's own self-service interaction, visually distinct
                (warning-toned), and always requires explicitly picking an
                employee. Never triggered by clicking someone else's row. */}
            <section className="shift-override-panel">
                <div className="shift-override-panel-text">
                    <FaUserShield />
                    <div>
                        <strong>Administrative Override</strong>
                        <p>Manage another employee's schedule on their behalf. Every use is recorded in the schedule's audit history.</p>
                    </div>
                </div>
                <div className="shift-override-panel-actions">
                    <button type="button" className="shift-secondary-button" onClick={handleCopyPreviousWeekAllEmployees} disabled={copying}>
                        <FaCopy /> {copying ? "Copying..." : "Copy Previous Week (All Employees)"}
                    </button>
                    <button type="button" className="shift-override-button" onClick={openOverrideCreate}>
                        <FaUserShield /> Manage Employee Schedule
                    </button>
                </div>
            </section>

            <section className="shift-schedule-card">

                {loading ? (
                    <div className="shift-schedule-loading">Loading shift schedule...</div>
                ) : error ? (
                    <div className="shift-schedule-error">{error}</div>
                ) : employeeRows.length === 0 ? (
                    <div className="shift-schedule-empty">
                        <FaCalendarWeek />
                        <h3>No employees to schedule</h3>
                        <p>Add active employees first, then they can build their own shift schedule here.</p>
                    </div>
                ) : (
                    <div className="shift-table-wrapper">
                        <table className="shift-table">
                            <thead>
                                <tr>
                                    <th>Employee</th>
                                    {weekDates.map((date, i) => (
                                        <th key={date}>
                                            {WEEKDAY_LABELS[i]}
                                            <span className="shift-table-date">
                                                {new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                                            </span>
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {employeeRows.map((row) => (
                                    <tr key={row.userId} className={row.isSelf ? "shift-row-self" : ""}>
                                        <td>
                                            <EmployeeNameplate name={row.isSelf ? `${row.fullName} (You)` : row.fullName} designation={row.designation} size="sm" />
                                        </td>
                                        {weekDates.map((date) => {
                                            const entry = row.days[date];
                                            const baseClass = entry?.status === "off" || entry?.status === "leave"
                                                ? `shift-cell shift-cell-${entry.status}`
                                                : entry
                                                    ? "shift-cell shift-cell-working"
                                                    : "shift-cell shift-cell-empty";
                                            // Only MY row is directly clickable (self-service). Every
                                            // other employee's row is read-only here -- reaching it
                                            // requires the explicit Administrative Override panel above.
                                            const cellClass = row.isSelf ? `${baseClass} shift-cell-editable` : baseClass;
                                            return (
                                                <td
                                                    key={date}
                                                    className={cellClass}
                                                    onClick={row.isSelf ? () => (entry ? openSelfEdit(entry) : openSelfAdd(date)) : undefined}
                                                    role={row.isSelf ? "button" : undefined}
                                                    tabIndex={row.isSelf ? 0 : undefined}
                                                >
                                                    {row.isSelf && !entry ? "+ Add" : shiftCellLabel(entry)}
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

            </section>

            {/* MY SCHEDULE MODAL -- self only, no employee picker */}
            {showSelfForm && (
                <div className="employee-modal-overlay">
                    <div className="employee-modal">
                        <div className="employee-modal-header">
                            <div>
                                <h2>{selfForm.id ? "Edit My Schedule" : "Add My Schedule"}</h2>
                                <p>{selfForm.shiftDate ? new Date(`${selfForm.shiftDate}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" }) : ""}</p>
                            </div>
                            <button type="button" className="modal-close" onClick={() => setShowSelfForm(false)}>
                                <FaTimes />
                            </button>
                        </div>

                        <form onSubmit={handleSelfSubmit}>
                            <div className="employee-form-group">
                                <label>Status</label>
                                <select name="status" value={selfForm.status} onChange={handleSelfFieldChange}>
                                    <option value="working">Working</option>
                                    <option value="off">Off</option>
                                    <option value="leave">Leave</option>
                                </select>
                            </div>

                            {selfForm.status === "working" && (
                                <div className="shift-form-time-row">
                                    <div className="employee-form-group">
                                        <label>Start Time</label>
                                        <input type="time" name="startTime" value={selfForm.startTime} onChange={handleSelfFieldChange} required />
                                    </div>
                                    <div className="employee-form-group">
                                        <label>End Time</label>
                                        <input type="time" name="endTime" value={selfForm.endTime} onChange={handleSelfFieldChange} required />
                                    </div>
                                </div>
                            )}

                            <div className="employee-form-group">
                                <label>Notes (optional)</label>
                                <textarea name="notes" value={selfForm.notes} onChange={handleSelfFieldChange} rows={2} placeholder="Any additional notes..." />
                            </div>

                            <div className="employee-modal-actions">
                                {selfForm.id ? (
                                    <button type="button" className="shift-delete-button" onClick={handleSelfDelete} disabled={saving}>
                                        <FaTrash /> Remove
                                    </button>
                                ) : <span />}
                                <div className="shift-form-actions-right">
                                    <button type="button" className="cancel-employee-button" onClick={() => setShowSelfForm(false)}>Cancel</button>
                                    <button type="submit" className="save-employee-button" disabled={saving}>
                                        {saving ? "Saving..." : selfForm.id ? "Save Changes" : "Add"}
                                    </button>
                                </div>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* ADMINISTRATIVE OVERRIDE MODAL -- requires an employee picker,
                distinctly labeled throughout as an override action */}
            {showOverrideForm && (
                <div className="employee-modal-overlay">
                    <div className="employee-modal shift-override-modal">
                        <div className="employee-modal-header">
                            <div>
                                <h2><FaUserShield /> Administrative Override</h2>
                                <p>You are managing another employee's schedule on their behalf.</p>
                            </div>
                            <button type="button" className="modal-close" onClick={() => setShowOverrideForm(false)}>
                                <FaTimes />
                            </button>
                        </div>

                        <form onSubmit={handleOverrideSubmit}>
                            <div className="employee-form-group">
                                <label>Employee</label>
                                <select name="userId" value={overrideForm.userId} onChange={handleOverrideFieldChange} disabled={!!overrideForm.id} required>
                                    <option value="">Select employee</option>
                                    {employees.map((employee) => (
                                        <option key={employee.id} value={employee.id}>
                                            {employee.full_name}{employee.designation ? ` — ${employee.designation}` : ""}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className="employee-form-group">
                                <label>Date</label>
                                <input type="date" name="shiftDate" value={overrideForm.shiftDate} onChange={handleOverrideFieldChange} disabled={!!overrideForm.id} required />
                            </div>

                            <div className="employee-form-group">
                                <label>Status</label>
                                <select name="status" value={overrideForm.status} onChange={handleOverrideFieldChange}>
                                    <option value="working">Working</option>
                                    <option value="off">Off</option>
                                    <option value="leave">Leave</option>
                                </select>
                            </div>

                            {overrideForm.status === "working" && (
                                <div className="shift-form-time-row">
                                    <div className="employee-form-group">
                                        <label>Start Time</label>
                                        <input type="time" name="startTime" value={overrideForm.startTime} onChange={handleOverrideFieldChange} required />
                                    </div>
                                    <div className="employee-form-group">
                                        <label>End Time</label>
                                        <input type="time" name="endTime" value={overrideForm.endTime} onChange={handleOverrideFieldChange} required />
                                    </div>
                                </div>
                            )}

                            <div className="employee-form-group">
                                <label>Notes (optional)</label>
                                <textarea name="notes" value={overrideForm.notes} onChange={handleOverrideFieldChange} rows={2} placeholder="Any additional notes..." />
                            </div>

                            <div className="employee-modal-actions">
                                {overrideForm.id ? (
                                    <button type="button" className="shift-delete-button" onClick={handleOverrideDelete} disabled={saving}>
                                        <FaTrash /> Delete
                                    </button>
                                ) : <span />}
                                <div className="shift-form-actions-right">
                                    <button type="button" className="cancel-employee-button" onClick={() => setShowOverrideForm(false)}>Cancel</button>
                                    <button type="submit" className="save-employee-button" disabled={saving}>
                                        {saving ? "Saving..." : overrideForm.id ? "Save Changes" : "Create Shift"}
                                    </button>
                                </div>
                            </div>
                        </form>
                    </div>
                </div>
            )}

        </div>
    );
}

export default AdminShiftManagement;
