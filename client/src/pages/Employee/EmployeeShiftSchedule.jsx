import { useEffect, useMemo, useState } from "react";
import { FaCalendarWeek, FaChevronLeft, FaChevronRight, FaTimes, FaTrash, FaSearch } from "react-icons/fa";
import { toast } from "react-toastify";

import { getShifts, createShift, updateShift, deleteShift, searchShiftEmployees } from "../../services/shiftScheduleService";
import EmployeeNameplate from "../../components/EmployeeNameplate";
import TimeInput12h from "../../components/TimeInput12h";
import { formatTime12h, formatTimeRange12h, calculateShiftDuration } from "../../utils/timeFormat";

import "./EmployeeShiftSchedule.css";

// ==========================================
// DATE HELPERS
// (No shared date-utility file exists in this codebase -- every
// other page with a date range, e.g. EmployeeAttendance.jsx, keeps
// its own small local helpers, so this follows the same convention.
// Time formatting, however, now lives in the shared
// utils/timeFormat.js -- see that file's header comment for why this
// one specific helper is centralized rather than duplicated.)
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

function shiftCellLabel(entry) {
    if (!entry) return "—";
    if (entry.status === "off") return "OFF";
    if (entry.status === "leave") return "LEAVE";
    if (entry.start_time && entry.end_time) {
        return formatTimeRange12h(entry.start_time, entry.end_time);
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

// Display-only role bucket -- purely for which header text/description
// to show. The backend independently re-enforces the real visibility
// scope on every request regardless of what this returns (see
// shiftScheduleController.js's getShiftVisibilityScope), same pattern
// this codebase already uses elsewhere for client-side role display
// (e.g. SopLibrary.jsx's isAdminTier).
function isAdminTier(user) {
    return user?.role === "admin" || ["admin", "super_admin"].includes(user?.systemAccess);
}

function isManagerTier(user) {
    return user?.systemAccess === "manager";
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

    const [searchQuery, setSearchQuery] = useState("");
    const [searchDate, setSearchDate] = useState(() => toIsoDate(new Date()));
    const [searchResults, setSearchResults] = useState(null);
    const [searching, setSearching] = useState(false);

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

    // ==========================================
    // EMPLOYEE SEARCH
    // Backend enforces the same visibility scope as the board above
    // (Manager -> team only; everyone else -> organization-wide) --
    // this is never a frontend-only filter.
    // ==========================================

    const handleSearch = async (event) => {
        event.preventDefault();

        if (!searchQuery.trim()) {
            setSearchResults(null);
            return;
        }

        try {
            setSearching(true);
            const data = await searchShiftEmployees(searchQuery.trim(), searchDate);
            setSearchResults(Array.isArray(data.results) ? data.results : []);
        } catch (err) {
            console.error("Search shift employees error:", err);
            toast.error(err.response?.data?.message || "Unable to search employees");
            setSearchResults([]);
        } finally {
            setSearching(false);
        }
    };

    return (
        <div className="employee-page-content">

            <section className="shift-schedule-header">
                <div>
                    <h2>Shift Schedule</h2>
                    <p>
                        {isAdminTier(currentUser)
                            ? "Company Schedule -- every employee's shift is shown below. Your own row (highlighted) is yours to manage."
                            : isManagerTier(currentUser)
                                ? "My Team Schedule -- you and your direct reports. Your own row (highlighted) is yours to manage."
                                : "My Schedule -- your own shift. Use search below to look up a colleague's shift."}
                    </p>
                </div>
            </section>

            <section className="shift-search-panel">
                <h3><FaSearch /> Search Employee Shift</h3>
                <form className="shift-search-input-row" onSubmit={handleSearch}>
                    <input
                        type="text"
                        className="shift-search-input"
                        placeholder="Search by name or employee ID..."
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                    />
                    <input
                        type="date"
                        className="shift-search-date-input"
                        value={searchDate}
                        onChange={(event) => setSearchDate(event.target.value)}
                    />
                    <button type="submit" className="shift-week-nav-button" disabled={searching}>
                        {searching ? "Searching..." : "Search"}
                    </button>
                </form>

                {searchResults !== null && (
                    searchResults.length === 0 ? (
                        <div className="shift-search-empty">No matching employees found.</div>
                    ) : (
                        <div className="shift-search-results">
                            <table className="shift-table">
                                <thead>
                                    <tr>
                                        <th>Employee</th>
                                        <th>Date</th>
                                        <th>Status</th>
                                        <th>Start</th>
                                        <th>End</th>
                                        <th>Duration</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {searchResults.map((result) => (
                                        <tr key={result.userId}>
                                            <td>
                                                <EmployeeNameplate name={result.fullName} designation={result.departmentName ? `${result.designation || ""} · ${result.departmentName}` : result.designation} size="sm" />
                                            </td>
                                            <td>{new Date(`${result.shiftDate}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</td>
                                            <td>
                                                {result.status ? (
                                                    <span className={`shift-status-badge ${result.status}`}>{result.status}</span>
                                                ) : (
                                                    <span className="shift-status-badge off">no entry</span>
                                                )}
                                            </td>
                                            <td>{formatTime12h(result.startTime) || "—"}</td>
                                            <td>{formatTime12h(result.endTime) || "—"}</td>
                                            <td>{calculateShiftDuration(result.startTime, result.endTime) || "—"}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )
                )}
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
                                        <TimeInput12h
                                            value={formData.startTime}
                                            onChange={(value) => setFormData((prev) => ({ ...prev, startTime: value }))}
                                            label="Start Time"
                                            required
                                        />
                                    </div>
                                    <div className="employee-form-group">
                                        <label>End Time</label>
                                        <TimeInput12h
                                            value={formData.endTime}
                                            onChange={(value) => setFormData((prev) => ({ ...prev, endTime: value }))}
                                            label="End Time"
                                            required
                                        />
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
