import { useEffect, useMemo, useState } from "react";
import { FaCalendarWeek, FaChevronLeft, FaChevronRight, FaTimes, FaTrash } from "react-icons/fa";
import { toast } from "react-toastify";

import { getShifts, createShift, updateShift, deleteShift } from "../../services/shiftScheduleService";
import EmployeeNameplate from "../../components/EmployeeNameplate";

import "./EmployeeShiftSchedule.css";

// ==========================================
// DATE HELPERS
// (No shared date-utility file exists in this codebase -- every
// other page with a date range, e.g. EmployeeAttendance.jsx, keeps
// its own small local helpers, so this follows the same convention.)
// ==========================================

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function toIsoDate(date) {
    return date.toISOString().slice(0, 10);
}

function getMondayOf(date) {
    const d = new Date(date);
    const day = d.getDay(); // 0 = Sunday
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

const EMPTY_FORM = {
    id: null,
    shiftDate: "",
    status: "working",
    startTime: "09:00",
    endTime: "18:00",
    notes: "",
};

function EmployeeShiftSchedule() {
    const currentUser = useMemo(() => getCurrentUser(), []);

    const [weekStart, setWeekStart] = useState(() => getMondayOf(new Date()));
    const [shifts, setShifts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);

    const [showForm, setShowForm] = useState(false);
    const [formData, setFormData] = useState(EMPTY_FORM);

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
            toast.error(err.response?.data?.message || "Unable to load the shift schedule");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadSchedule();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [weekStart]);

    // Group the flat shift list by employee so each row/card only has
    // to look up its own 7 day-cells. My own row is always seeded (even
    // with zero entries this week) so I always have somewhere to add my
    // first shift, and is pinned to the top of the list.
    const employeeRows = useMemo(() => {
        const byUser = new Map();

        if (currentUser?.id) {
            byUser.set(currentUser.id, {
                userId: currentUser.id,
                fullName: currentUser.fullName,
                designation: currentUser.designation,
                isSelf: true,
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
            } else if (shift.user_id === currentUser?.id) {
                // Refresh from the live, authoritative row (name/designation)
                // in case the sessionStorage snapshot is stale.
                byUser.get(shift.user_id).fullName = shift.full_name;
                byUser.get(shift.user_id).designation = shift.designation;
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
    }, [shifts, currentUser]);

    // ==========================================
    // MY SCHEDULE FORM
    // ==========================================

    const openAdd = (date) => {
        setFormData({ ...EMPTY_FORM, shiftDate: date });
        setShowForm(true);
    };

    const openEdit = (entry) => {
        setFormData({
            id: entry.id,
            shiftDate: entry.shift_date,
            status: entry.status,
            startTime: entry.start_time || "09:00",
            endTime: entry.end_time || "18:00",
            notes: entry.notes || "",
        });
        setShowForm(true);
    };

    const handleFieldChange = (event) => {
        const { name, value } = event.target;
        setFormData((prev) => ({ ...prev, [name]: value }));
    };

    const handleSubmit = async (event) => {
        event.preventDefault();

        const payload = {
            shiftDate: formData.shiftDate,
            status: formData.status,
            startTime: formData.status === "working" ? formData.startTime : null,
            endTime: formData.status === "working" ? formData.endTime : null,
            notes: formData.notes,
        };

        try {
            setSaving(true);

            if (formData.id) {
                await updateShift(formData.id, payload);
                toast.success("Your schedule was updated");
            } else {
                // No userId sent -- the backend always derives "my own
                // schedule" from the authenticated session for a plain
                // self-service create.
                await createShift(payload);
                toast.success("Your schedule was added");
            }

            setShowForm(false);
            await loadSchedule();

        } catch (err) {
            console.error("Save my shift error:", err);
            toast.error(err.response?.data?.message || "Unable to save your schedule");
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!formData.id) return;

        try {
            setSaving(true);
            await deleteShift(formData.id);
            toast.success("Your schedule entry was removed");
            setShowForm(false);
            await loadSchedule();
        } catch (err) {
            console.error("Delete my shift error:", err);
            toast.error(err.response?.data?.message || "Unable to remove your schedule entry");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="employee-page-content">

            <section className="shift-schedule-header">
                <div>
                    <h2>Shift Schedule</h2>
                    <p>Company Schedule -- everyone's shifts are visible here. Your own row (highlighted) is yours to manage.</p>
                </div>
            </section>

            <section className="shift-schedule-week-nav">
                <button
                    type="button"
                    className="shift-week-nav-button"
                    onClick={() => setWeekStart((prev) => addDays(prev, -7))}
                    aria-label="Previous week"
                >
                    <FaChevronLeft /> Previous Week
                </button>

                <span className="shift-week-range">
                    <FaCalendarWeek /> {formatRangeLabel(weekStart)}
                </span>

                <button
                    type="button"
                    className="shift-week-nav-button"
                    onClick={() => setWeekStart((prev) => addDays(prev, 7))}
                    aria-label="Next week"
                >
                    Next Week <FaChevronRight />
                </button>
            </section>

            <section className="shift-schedule-card">

                {loading ? (
                    <div className="shift-schedule-loading">Loading shift schedule...</div>
                ) : error ? (
                    <div className="shift-schedule-error">{error}</div>
                ) : employeeRows.length === 0 ? (
                    <div className="shift-schedule-empty">
                        <FaCalendarWeek />
                        <h3>No shifts scheduled</h3>
                        <p>No shift schedule has been set for this week yet.</p>
                    </div>
                ) : (
                    <>
                        {/* DESKTOP TABLE */}
                        <div className="shift-table-wrapper shift-desktop-only">
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
                                                const cellClass = row.isSelf ? `${baseClass} shift-cell-editable` : baseClass;
                                                return (
                                                    <td
                                                        key={date}
                                                        className={cellClass}
                                                        onClick={row.isSelf ? () => (entry ? openEdit(entry) : openAdd(date)) : undefined}
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

                        {/* MOBILE CARDS */}
                        <div className="shift-cards-mobile">
                            {employeeRows.map((row) => (
                                <div className={row.isSelf ? "shift-employee-card shift-row-self" : "shift-employee-card"} key={row.userId}>
                                    <EmployeeNameplate name={row.isSelf ? `${row.fullName} (You)` : row.fullName} designation={row.designation} size="md" />
                                    <div className="shift-employee-card-days">
                                        {weekDates.map((date, i) => {
                                            const entry = row.days[date];
                                            const baseClass = entry?.status === "off" || entry?.status === "leave"
                                                ? `shift-day-badge shift-cell-${entry.status}`
                                                : entry
                                                    ? "shift-day-badge shift-cell-working"
                                                    : "shift-day-badge shift-cell-empty";
                                            return (
                                                <div
                                                    className="shift-employee-card-day"
                                                    key={date}
                                                    onClick={row.isSelf ? () => (entry ? openEdit(entry) : openAdd(date)) : undefined}
                                                    role={row.isSelf ? "button" : undefined}
                                                    tabIndex={row.isSelf ? 0 : undefined}
                                                >
                                                    <span className="shift-employee-card-day-label">{WEEKDAY_LABELS[i]}</span>
                                                    <span className={baseClass}>{row.isSelf && !entry ? "+ Add" : shiftCellLabel(entry)}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                )}

            </section>

            {showForm && (
                <div className="employee-modal-overlay">
                    <div className="employee-modal">
                        <div className="employee-modal-header">
                            <div>
                                <h2>{formData.id ? "Edit My Schedule" : "Add My Schedule"}</h2>
                                <p>{formData.shiftDate ? new Date(`${formData.shiftDate}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" }) : ""}</p>
                            </div>
                            <button type="button" className="modal-close" onClick={() => setShowForm(false)}>
                                <FaTimes />
                            </button>
                        </div>

                        <form onSubmit={handleSubmit}>

                            <div className="employee-form-group">
                                <label>Status</label>
                                <select name="status" value={formData.status} onChange={handleFieldChange}>
                                    <option value="working">Working</option>
                                    <option value="off">Off</option>
                                    <option value="leave">Leave</option>
                                </select>
                            </div>

                            {formData.status === "working" && (
                                <div className="shift-form-time-row">
                                    <div className="employee-form-group">
                                        <label>Start Time</label>
                                        <input type="time" name="startTime" value={formData.startTime} onChange={handleFieldChange} required />
                                    </div>
                                    <div className="employee-form-group">
                                        <label>End Time</label>
                                        <input type="time" name="endTime" value={formData.endTime} onChange={handleFieldChange} required />
                                    </div>
                                </div>
                            )}

                            <div className="employee-form-group">
                                <label>Notes (optional)</label>
                                <textarea name="notes" value={formData.notes} onChange={handleFieldChange} rows={2} placeholder="Any additional notes..." />
                            </div>

                            <div className="employee-modal-actions">
                                {formData.id ? (
                                    <button type="button" className="shift-delete-button" onClick={handleDelete} disabled={saving}>
                                        <FaTrash /> Remove
                                    </button>
                                ) : (
                                    <span />
                                )}
                                <div className="shift-form-actions-right">
                                    <button type="button" className="cancel-employee-button" onClick={() => setShowForm(false)}>Cancel</button>
                                    <button type="submit" className="save-employee-button" disabled={saving}>
                                        {saving ? "Saving..." : formData.id ? "Save Changes" : "Add"}
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

export default EmployeeShiftSchedule;
