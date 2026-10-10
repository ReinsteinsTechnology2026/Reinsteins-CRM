import { useEffect, useMemo, useRef, useState } from "react";
import { FaCalendarWeek, FaChevronLeft, FaChevronRight, FaTrash, FaTimes, FaUserShield, FaCopy, FaSearch } from "react-icons/fa";
import { toast } from "react-toastify";

import api from "../../services/api";
import {
    getShifts,
    createShift,
    updateShift,
    deleteShift,
    bulkSaveShifts,
    searchShiftEmployees,
} from "../../services/shiftScheduleService";
import EmployeeNameplate from "../../components/EmployeeNameplate";
import TimeInput12h from "../../components/TimeInput12h";
import { formatTime12h, formatTimeRange12h, calculateShiftDuration } from "../../utils/timeFormat";
import socket, { connectSocket } from "../../services/socket";

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

function shiftCellLabel(entry, isDefaultOffDay) {
    if (!entry) return isDefaultOffDay ? "OFF" : "—";
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

const EMPTY_SELF_FORM = { id: null, shiftDate: "", status: "working", startTime: "09:00", endTime: "18:00", notes: "" };
const EMPTY_OVERRIDE_FORM = { id: null, userId: "", shiftDate: "", status: "working", startTime: "09:00", endTime: "18:00", notes: "" };

function AdminShiftManagement() {
    const currentUser = useMemo(() => getCurrentUser(), []);

    const [weekStart, setWeekStart] = useState(() => getMondayOf(new Date()));
    const [shifts, setShifts] = useState([]);
    const [defaultOffDates, setDefaultOffDates] = useState(() => new Set());
    const [employees, setEmployees] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    // Split per form (not one shared `saving` boolean) -- otherwise
    // submitting the self-service form would also disable the
    // Administrative Override form's buttons, and vice versa.
    const [selfSaveState, setSelfSaveState] = useState("idle");
    const [overrideSaveState, setOverrideSaveState] = useState("idle");
    const saving = selfSaveState !== "idle";
    const overrideSaving = overrideSaveState !== "idle";
    const selfSubmittingRef = useRef(false);
    const overrideSubmittingRef = useRef(false);
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
            setDefaultOffDates(new Set(Array.isArray(data.defaultOffDates) ? data.defaultOffDates : []));

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

    // ==========================================
    // REAL-TIME UPDATES
    // This page is reached only by role==='admin' (route-gated), and
    // admin-tier sockets always join the broad, tenant-wide shift
    // room (see app.js's connect-time room plan) -- the same
    // unrestricted access this tier already has over REST. So any
    // change whose date falls in the currently-displayed week is
    // merged regardless of which employee it belongs to -- unlike the
    // narrower, authorization-filtered merge on
    // EmployeeShiftSchedule.jsx (reached by every other tier,
    // including the one REST actually restricts: Manager). The
    // payload carries notes too, so a live-merged row is already
    // complete.
    // ==========================================

    useEffect(() => {
        connectSocket();

        const handleShiftUpdated = (payload) => {
            if (!payload || !weekDates.includes(payload.shiftDate)) return;

            setShifts((prev) => {
                const withoutThisId = prev.filter((s) => s.id !== payload.id);
                if (payload.action === "deleted") return withoutThisId;

                const employee = employees.find((e) => e.id === payload.userId);

                return [
                    ...withoutThisId,
                    {
                        id: payload.id,
                        user_id: payload.userId,
                        full_name: employee?.full_name,
                        designation: employee?.designation,
                        shift_date: payload.shiftDate,
                        status: payload.status,
                        start_time: payload.startTime,
                        end_time: payload.endTime,
                        notes: payload.notes ?? null,
                    },
                ];
            });
        };

        const handleConnect = () => loadSchedule();

        socket.on("shift:updated", handleShiftUpdated);
        socket.on("connect", handleConnect);

        return () => {
            socket.off("shift:updated", handleShiftUpdated);
            socket.off("connect", handleConnect);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [weekDates, employees]);

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

        if (selfSubmittingRef.current) return;
        selfSubmittingRef.current = true;

        const payload = {
            shiftDate: selfForm.shiftDate,
            status: selfForm.status,
            startTime: selfForm.status === "working" ? selfForm.startTime : null,
            endTime: selfForm.status === "working" ? selfForm.endTime : null,
            notes: selfForm.notes,
        };

        try {
            setSelfSaveState("saving");

            if (selfForm.id) {
                await updateShift(selfForm.id, payload);
                toast.success("Your schedule was updated");
            } else {
                await createShift(payload);
                toast.success("Your schedule was added");
            }

            setSelfSaveState("saved");
            await loadSchedule();
            setTimeout(() => {
                setShowSelfForm(false);
                setSelfSaveState("idle");
            }, 500);

        } catch (err) {
            console.error("Save my shift error:", err);
            toast.error(err.response?.data?.message || "Unable to save your schedule");
            setSelfSaveState("idle");
        } finally {
            selfSubmittingRef.current = false;
        }
    };

    const handleSelfDelete = async () => {
        if (!selfForm.id || selfSubmittingRef.current) return;
        selfSubmittingRef.current = true;

        try {
            setSelfSaveState("saving");
            await deleteShift(selfForm.id);
            toast.success("Your schedule entry was removed");
            setShowSelfForm(false);
            setSelfSaveState("idle");
            await loadSchedule();
        } catch (err) {
            console.error("Delete my shift error:", err);
            toast.error(err.response?.data?.message || "Unable to remove your schedule entry");
            setSelfSaveState("idle");
        } finally {
            selfSubmittingRef.current = false;
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

        if (overrideSubmittingRef.current) return;
        overrideSubmittingRef.current = true;

        const payload = {
            userId: overrideForm.userId,
            shiftDate: overrideForm.shiftDate,
            status: overrideForm.status,
            startTime: overrideForm.status === "working" ? overrideForm.startTime : null,
            endTime: overrideForm.status === "working" ? overrideForm.endTime : null,
            notes: overrideForm.notes,
        };

        try {
            setOverrideSaveState("saving");

            if (overrideForm.id) {
                await updateShift(overrideForm.id, payload);
                toast.success("Shift updated successfully (administrative override)");
            } else {
                await createShift(payload);
                toast.success("Shift created successfully (administrative override)");
            }

            setOverrideSaveState("saved");
            await loadSchedule();
            setTimeout(() => {
                setShowOverrideForm(false);
                setOverrideSaveState("idle");
            }, 500);

        } catch (err) {
            console.error("Save override shift error:", err);
            toast.error(err.response?.data?.message || "Unable to save shift");
            setOverrideSaveState("idle");
        } finally {
            overrideSubmittingRef.current = false;
        }
    };

    const handleOverrideDelete = async () => {
        if (!overrideForm.id || overrideSubmittingRef.current) return;
        overrideSubmittingRef.current = true;

        try {
            setOverrideSaveState("saving");
            await deleteShift(overrideForm.id);
            toast.success("Shift deleted successfully (administrative override)");
            setShowOverrideForm(false);
            setOverrideSaveState("idle");
            await loadSchedule();
        } catch (err) {
            console.error("Delete override shift error:", err);
            toast.error(err.response?.data?.message || "Unable to delete shift");
            setOverrideSaveState("idle");
        } finally {
            overrideSubmittingRef.current = false;
        }
    };

    // ==========================================
    // EMPLOYEE SEARCH (organization-wide -- Admin/Super Admin)
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

            <section className="shift-search-panel">
                <h3><FaSearch /> Search Employee (organization-wide)</h3>
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
                                                    <span className={`shift-status-badge ${result.status}`}>
                                                        {result.isDefaultOff ? "OFF" : result.status}
                                                    </span>
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
                                            const isDefaultOffDay = !entry && defaultOffDates.has(date);
                                            const baseClass = entry?.status === "off" || entry?.status === "leave"
                                                ? `shift-cell shift-cell-${entry.status}`
                                                : entry
                                                    ? "shift-cell shift-cell-working"
                                                    : isDefaultOffDay
                                                        ? "shift-cell shift-cell-off"
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
                                                    {row.isSelf && !entry
                                                        ? (isDefaultOffDay ? "OFF" : "+ Add")
                                                        : shiftCellLabel(entry, isDefaultOffDay)}
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
                                        <TimeInput12h
                                            value={selfForm.startTime}
                                            onChange={(value) => setSelfForm((prev) => ({ ...prev, startTime: value }))}
                                            label="Start Time"
                                            required
                                        />
                                    </div>
                                    <div className="employee-form-group">
                                        <label>End Time</label>
                                        <TimeInput12h
                                            value={selfForm.endTime}
                                            onChange={(value) => setSelfForm((prev) => ({ ...prev, endTime: value }))}
                                            label="End Time"
                                            required
                                        />
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
                                        {selfSaveState === "saving"
                                            ? "Saving..."
                                            : selfSaveState === "saved"
                                                ? "Saved ✓"
                                                : selfForm.id ? "Save Changes" : "Add"}
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
                                        <TimeInput12h
                                            value={overrideForm.startTime}
                                            onChange={(value) => setOverrideForm((prev) => ({ ...prev, startTime: value }))}
                                            label="Start Time"
                                            required
                                        />
                                    </div>
                                    <div className="employee-form-group">
                                        <label>End Time</label>
                                        <TimeInput12h
                                            value={overrideForm.endTime}
                                            onChange={(value) => setOverrideForm((prev) => ({ ...prev, endTime: value }))}
                                            label="End Time"
                                            required
                                        />
                                    </div>
                                </div>
                            )}

                            <div className="employee-form-group">
                                <label>Notes (optional)</label>
                                <textarea name="notes" value={overrideForm.notes} onChange={handleOverrideFieldChange} rows={2} placeholder="Any additional notes..." />
                            </div>

                            <div className="employee-modal-actions">
                                {overrideForm.id ? (
                                    <button type="button" className="shift-delete-button" onClick={handleOverrideDelete} disabled={overrideSaving}>
                                        <FaTrash /> Delete
                                    </button>
                                ) : <span />}
                                <div className="shift-form-actions-right">
                                    <button type="button" className="cancel-employee-button" onClick={() => setShowOverrideForm(false)}>Cancel</button>
                                    <button type="submit" className="save-employee-button" disabled={overrideSaving}>
                                        {overrideSaveState === "saving"
                                            ? "Saving..."
                                            : overrideSaveState === "saved"
                                                ? "Saved ✓"
                                                : overrideForm.id ? "Save Changes" : "Create Shift"}
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
