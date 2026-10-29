import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { FaCalendarWeek, FaChevronLeft, FaChevronRight, FaTrash, FaTimes, FaUserShield, FaCopy, FaSearch, FaFileExcel, FaDownload } from "react-icons/fa";
import { toast } from "react-toastify";

import api from "../../services/api";
import {
    getShifts,
    createShift,
    updateShift,
    deleteShift,
    bulkSaveShifts,
    searchShiftEmployees,
    exportShiftReport,
} from "../../services/shiftScheduleService";
import EmployeeNameplate from "../../components/EmployeeNameplate";
import MonthYearPicker from "../../components/MonthYearPicker";
import TimeInput12h from "../../components/TimeInput12h";
import { formatTime12h, formatTimeRange12h, calculateShiftDuration } from "../../utils/timeFormat";
import socket, { connectSocket } from "../../services/socket";
import {
    VIEW_DAY,
    VIEW_WEEK,
    VIEW_MONTH,
    VIEW_RANGE,
    MAX_CUSTOM_RANGE_DAYS,
    NAV_LABELS,
    PICKER_LABELS,
    toIsoDate,
    parseIsoDate,
    addDays,
    getMondayOf,
    getViewRange,
    formatRangeLabel,
    weekdayLabel,
    buildShiftQuery,
    shouldMergeLiveUpdate,
    needsServerLookup,
    overrideFormFromShift,
    resolveOverrideTarget,
} from "../../utils/shiftViews";
import {
    initialScheduleState,
    scheduleReducer,
    createRequestGuard,
    buildScheduleRows,
    filterChipText,
    employeeLabel,
    employeeFromSearchResult,
    showsDayDetail,
} from "../../utils/shiftScheduleState";

import "./AdminShiftManagement.css";

// ==========================================
// DATE HELPERS -- Day/Week/Month range math lives in utils/shiftViews.js
// (local-date based, never toISOString()).
// ==========================================

const VIEW_OPTIONS = [
    { value: VIEW_DAY, label: "Day" },
    { value: VIEW_WEEK, label: "Week" },
    { value: VIEW_MONTH, label: "Month" },
    { value: VIEW_RANGE, label: "Custom range" },
];

// "Copy Previous Week" is defined for one week at a time, which a custom range is not.
const COPY_WEEK_DISABLED_REASON = "Copy Previous Week works on one week at a time. Switch to Day, Week or Month view to use it.";

// Reports panel: only the period KIND is chosen here; the server works out
// the actual dates from the current date (no calendar, no custom range).
const REPORT_PERIODS = [
    { value: "day", label: "Day" },
    { value: "week", label: "Week" },
    { value: "month", label: "Month" },
];

const REPORT_PERIOD_HINTS = {
    day: "Excel report for today",
    week: "Excel report for this week (Mon-Sun)",
    month: "Excel report for this month",
};

// With responseType "blob" an error body arrives as a Blob, so read the
// server's message out of it.
async function readReportError(err) {
    try {
        const data = err?.response?.data;
        if (data instanceof Blob) {
            return JSON.parse(await data.text()).message || "Unable to download the report";
        }
        return data?.message || "Unable to download the report";
    } catch {
        return "Unable to download the report";
    }
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

    // View (Day/Week/Month), selected date, employee filter and the search
    // panel's open/closed state live in ONE reducer (utils/shiftScheduleState.js),
    // so selecting/clearing an employee never resets the range and changing
    // the view/date never drops the employee.
    const [schedule, dispatch] = useReducer(scheduleReducer, undefined, () => initialScheduleState());
    const { view, anchor, custom, employee: selectedEmployee, searchOpen } = schedule;
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
    // Latest override-target lookup, so a slow answer for an earlier
    // employee/date can never overwrite the form for the current one.
    const overrideLookupRef = useRef(0);
    const [copying, setCopying] = useState(false);

    // Reports panel. The period itself is decided by the server from the
    // current date; the client only says day / week / month and which employee.
    const [reportPeriod, setReportPeriod] = useState("week");
    const [reportScope, setReportScope] = useState("all");
    const [reportEmployeeId, setReportEmployeeId] = useState("");
    const [reportDownloading, setReportDownloading] = useState(false);
    const reportDownloadingRef = useRef(false);

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
    const [searchResults, setSearchResults] = useState(null);
    const [searching, setSearching] = useState(false);
    // The query last submitted (so the Day-view results can be refreshed when the
    // date changes).
    const [submittedQuery, setSubmittedQuery] = useState("");
    // Latest-request-wins: an answer is applied only if no newer request began.
    const scheduleGuardRef = useRef(createRequestGuard());
    const searchGuardRef = useRef(createRequestGuard());

    // The visible date range (1 day, the Mon-Sun week, the whole calendar month, or
    // the user's Custom range) -- drives the fetch, the table columns and the
    // live-update merge. A Custom range that is incomplete, reversed or longer than
    // MAX_CUSTOM_RANGE_DAYS has `valid: false` and no dates; it is never requested.
    const range = useMemo(() => getViewRange(view, anchor, custom), [view, anchor, custom]);
    const weekDates = range.dates;
    const selectedEmployeeId = selectedEmployee ? selectedEmployee.userId : null;
    // Always the CURRENT range/employee, even when read from a handler that was
    // created on an earlier render (e.g. the reload after a save).
    const paramsRef = useRef(null);
    paramsRef.current = { range, selectedEmployeeId };

    // Month/year picker: opened by the Month button, closed by choosing a month, Esc,
    // a click outside, or leaving the Month view.
    const [monthPickerOpen, setMonthPickerOpen] = useState(false);
    const viewSwitchRef = useRef(null);
    const closeMonthPicker = useCallback(() => setMonthPickerOpen(false), []);

    const handleViewChange = (nextView) => dispatch({ type: "setView", view: nextView, today: new Date() });

    // The Month button opens the month/year picker (and toggles it while already in Month view).
    const handleViewButton = (nextView) => {
        if (nextView === VIEW_MONTH) {
            if (view !== VIEW_MONTH) handleViewChange(VIEW_MONTH);
            setMonthPickerOpen(view === VIEW_MONTH ? !monthPickerOpen : true);
            return;
        }

        setMonthPickerOpen(false);
        handleViewChange(nextView);
    };

    const handleMonthPicked = (year, month) => {
        dispatch({ type: "pickMonth", year, month });
        setMonthPickerOpen(false);
        const monthButton = viewSwitchRef.current && viewSwitchRef.current.querySelector("[data-view=month]");
        if (monthButton) monthButton.focus();
    };

    const handleStep = (direction) => {
        setMonthPickerOpen(false);
        dispatch({ type: "step", direction });
    };

    const loadSchedule = async () => {
        const { range: wanted, selectedEmployeeId: wantedEmployeeId } = paramsRef.current;

        // An invalid Custom range never reaches the API (also covers a socket reconnect or a
        // reload after a save while the range is being edited).
        if (!wanted.valid) return;

        const requestId = scheduleGuardRef.current.begin();

        try {
            setLoading(true);
            setError("");

            // Server-side filtering: ?userId= (already supported by the shift API)
            // when an employee is selected, so only their rows are fetched.
            const { extraParams } = buildShiftQuery(wanted, wantedEmployeeId);
            const data = await getShifts(wanted.start, wanted.end, extraParams);
            if (!scheduleGuardRef.current.isCurrent(requestId)) return;

            setShifts(Array.isArray(data.shifts) ? data.shifts : []);
            setDefaultOffDates(new Set(Array.isArray(data.defaultOffDates) ? data.defaultOffDates : []));

        } catch (err) {
            if (!scheduleGuardRef.current.isCurrent(requestId)) return;
            console.error("Load shift schedule error:", err);
            setShifts([]);
            setError(err.response?.data?.message || "Unable to load the shift schedule");
        } finally {
            if (scheduleGuardRef.current.isCurrent(requestId)) setLoading(false);
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
        if (!range.valid) {
            // Nothing to ask the server for: drop whatever was in flight and show no stale rows.
            scheduleGuardRef.current.cancelAll();
            setShifts([]);
            setDefaultOffDates(new Set());
            setError("");
            setLoading(false);
            return;
        }

        loadSchedule();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [range.valid, range.start, range.end, selectedEmployeeId]);

    useEffect(() => {
        loadEmployees();
    }, []);

    // ==========================================
    // REAL-TIME UPDATES
    // This page is reached only by role==='admin' (route-gated), and
    // admin-tier sockets always join the broad, tenant-wide shift
    // room (see app.js's connect-time room plan) -- the same
    // unrestricted access this tier already has over REST. So any
    // change whose date falls in the currently-displayed range is
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
            if (!shouldMergeLiveUpdate(payload, weekDates, selectedEmployeeId)) return;

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
    }, [range.start, range.end, employees, selectedEmployeeId]);

    // Company-wide view: every active employee gets a row (even with a blank
    // range), my own row pinned to the top; with an employee filter only that
    // employee (who always gets a row -- see buildScheduleRows).
    const employeeRows = useMemo(
        () => buildScheduleRows({ employees, shifts, currentUserId: currentUser?.id, selectedEmployee }),
        [shifts, employees, currentUser, selectedEmployee]
    );

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
        // With an employee filter active only that employee's shifts are loaded,
        // so start the override on them (their existing entry is then found and
        // edited in place instead of hitting the duplicate-entry 409).
        const existing = selectedEmployeeId
            ? shifts.find((s) => Number(s.user_id) === Number(selectedEmployeeId) && s.shift_date === weekDates[0])
            : null;
        setOverrideForm(existing
            ? {
                id: existing.id,
                userId: String(selectedEmployeeId),
                shiftDate: existing.shift_date,
                status: existing.status,
                startTime: existing.start_time || "09:00",
                endTime: existing.end_time || "18:00",
                notes: existing.notes || "",
            }
            : {
                ...EMPTY_OVERRIDE_FORM,
                shiftDate: weekDates[0],
                userId: selectedEmployeeId ? String(selectedEmployeeId) : "",
            });
        setShowOverrideForm(true);
    };

    // Existing entry for an (employee, date): the loaded shifts first, then --
    // when an employee filter is active or the date is outside the loaded
    // range -- the existing shift API for just that employee and day.
    const findOverrideTarget = (userId, shiftDate) =>
        resolveOverrideTarget({
            userId,
            shiftDate,
            shifts,
            selectedEmployeeId,
            rangeDates: weekDates,
            fetchDay: (date, id) => getShifts(date, date, { userId: id }),
        });

    const handleOverrideFieldChange = (event) => {
        const { name, value } = event.target;

        if (name !== "userId" && name !== "shiftDate") {
            setOverrideForm((prev) => ({ ...prev, [name]: value }));
            return;
        }

        const next = { ...overrideForm, [name]: value };

        // Once both employee and date are chosen, auto-populate from an
        // existing entry for that combination so picking an already-scheduled
        // employee/date edits it in place instead of hitting the create
        // endpoint's duplicate-entry 409.
        if (!next.userId || !next.shiftDate) {
            setOverrideForm(next);
            return;
        }

        const lookupId = ++overrideLookupRef.current;
        const loaded = shifts.find(
            (s) => Number(s.user_id) === Number(next.userId) && s.shift_date === next.shiftDate
        );

        if (loaded) {
            setOverrideForm(overrideFormFromShift(loaded));
            return;
        }

        // No loaded entry for this combination -- make sure a
        // previously-populated id (from a prior selection that DID match)
        // doesn't linger and turn this into an accidental update of the
        // wrong row.
        setOverrideForm({ ...next, id: null });

        // With an employee filter active (or a date outside the loaded range)
        // the entry may exist but not be loaded: ask the server for just that
        // employee and day.
        if (needsServerLookup({ userId: next.userId, shiftDate: next.shiftDate, selectedEmployeeId, rangeDates: weekDates })) {
            findOverrideTarget(next.userId, next.shiftDate).then(({ shift, lookupFailed }) => {
                if (lookupId !== overrideLookupRef.current) return;
                if (shift) setOverrideForm(overrideFormFromShift(shift));
                else if (lookupFailed) toast.error("Unable to check for an existing entry for this employee and date");
            });
        }
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

        // Creating: if an entry already exists for this employee/date that the
        // form has not shown yet (e.g. the lookup was still in flight, or an
        // employee filter hid it), show it for review instead of saving over it
        // or hitting the duplicate-entry error.
        if (!overrideForm.id) {
            const { shift: existing } = await findOverrideTarget(overrideForm.userId, overrideForm.shiftDate);
            if (existing) {
                setOverrideForm(overrideFormFromShift(existing));
                toast.info("An entry already exists for this employee and date. Review it and save to update it.");
                overrideSubmittingRef.current = false;
                return;
            }
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

    // Runs the (name / employee ID) search for one date and returns the results,
    // or null when a newer search has started meanwhile (stale answers are dropped).
    const runSearch = async (query, date) => {
        const requestId = searchGuardRef.current.begin();

        try {
            setSearching(true);
            const data = await searchShiftEmployees(query, date);
            if (!searchGuardRef.current.isCurrent(requestId)) return null;
            const results = Array.isArray(data.results) ? data.results : [];
            setSearchResults(results);
            return results;
        } catch (err) {
            if (!searchGuardRef.current.isCurrent(requestId)) return null;
            console.error("Search shift employees error:", err);
            toast.error(err.response?.data?.message || "Unable to search employees");
            setSearchResults([]);
            return [];
        } finally {
            if (searchGuardRef.current.isCurrent(requestId)) setSearching(false);
        }
    };

    // Choosing an employee filters the schedule and dismisses the results.
    const selectEmployee = (result) => {
        searchGuardRef.current.cancelAll();
        setSearching(false);
        setSearchResults(null);
        setSearchQuery("");
        setSubmittedQuery("");
        dispatch({ type: "selectEmployee", employee: employeeFromSearchResult(result) });
    };

    // Everyone again, for the same view and date range.
    const clearEmployeeFilter = () => dispatch({ type: "clearEmployee" });

    const openSearch = () => dispatch({ type: "openSearch" });

    const closeSearch = () => {
        searchGuardRef.current.cancelAll();
        setSearching(false);
        setSearchResults(null);
        setSubmittedQuery("");
        dispatch({ type: "closeSearch" });
    };

    const handleSearch = async (event) => {
        event.preventDefault();

        const query = searchQuery.trim();

        if (!query) {
            searchGuardRef.current.cancelAll();
            setSearching(false);
            setSearchResults(null);
            setSubmittedQuery("");
            return;
        }

        setSubmittedQuery(query);
        const results = await runSearch(query, toIsoDate(anchor));

        // Exactly one match = the employee being looked for: filter to them.
        // With several matches the user picks one from the list.
        if (results && results.length === 1) selectEmployee(results[0]);
    };

    // Day-view results show that day's status, so refresh them when the date
    // changes; Week/Month results are just the matched employees.
    useEffect(() => {
        if (searchOpen && submittedQuery && showsDayDetail(view)) runSearch(submittedQuery, toIsoDate(anchor));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [anchor, view]);

    const handleCopyPreviousWeekAllEmployees = async () => {
        // "Previous week" is not defined for a custom range (the button is disabled there too).
        if (view === VIEW_RANGE) return;

        try {
            setCopying(true);

            // "Previous Week" is relative to the week containing the current
            // anchor, whichever view (Day/Week/Month) is showing.
            const weekStart = getMondayOf(anchor);
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
                shiftDate: toIsoDate(addDays(parseIsoDate(entry.shift_date), 7)),
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

    const handleDownloadReport = async () => {
        if (reportDownloadingRef.current) return;
        if (reportScope === "employee" && !reportEmployeeId) {
            toast.error("Select an employee first");
            return;
        }

        reportDownloadingRef.current = true;
        setReportDownloading(true);

        try {
            const { blob, filename } = await exportShiftReport(
                reportPeriod,
                reportScope === "employee" ? reportEmployeeId : "all"
            );
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error("Download shift report error:", err);
            toast.error(await readReportError(err));
        } finally {
            reportDownloadingRef.current = false;
            setReportDownloading(false);
        }
    };

    const rangeLabel = formatRangeLabel(view, anchor, "en-IN", custom);
    const isCustomRange = view === VIEW_RANGE;
    // incomplete choices ("pick a start date") are hints, real mistakes (reversed / too long) are alerts
    const rangeMessageRole = range.code && range.code.startsWith("missing_") ? "status" : "alert";

    return (
        <div className="admin-page-content shift-page">

            <header className="shift-page-header">
                <div className="shift-management-title">
                    <h2>Shift Management</h2>
                    <p>Company schedule -- everyone's shifts. Your own row (highlighted) is self-service.</p>
                </div>

                <section className="shift-reports-panel" aria-label="Reports">
                    <div className="shift-reports-panel-text">
                        <FaFileExcel />
                        <div>
                            <strong>Reports</strong>
                            <p>{REPORT_PERIOD_HINTS[reportPeriod]}</p>
                        </div>
                    </div>

                    <div className="shift-reports-controls">
                        <div className="shift-reports-toggle" role="group" aria-label="Report period">
                            {REPORT_PERIODS.map((option) => (
                                <button
                                    key={option.value}
                                    type="button"
                                    className={`shift-reports-toggle-button${reportPeriod === option.value ? " active" : ""}`}
                                    aria-pressed={reportPeriod === option.value}
                                    onClick={() => setReportPeriod(option.value)}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>

                        <div className="shift-reports-toggle" role="group" aria-label="Report employees">
                            <button
                                type="button"
                                className={`shift-reports-toggle-button${reportScope === "all" ? " active" : ""}`}
                                aria-pressed={reportScope === "all"}
                                onClick={() => setReportScope("all")}
                            >
                                All Employees
                            </button>
                            <button
                                type="button"
                                className={`shift-reports-toggle-button${reportScope === "employee" ? " active" : ""}`}
                                aria-pressed={reportScope === "employee"}
                                onClick={() => setReportScope("employee")}
                            >
                                Particular Employee
                            </button>
                        </div>
                    </div>

                    <div className="shift-reports-actions">
                        {reportScope === "employee" && (
                            <label className="shift-reports-employee">
                                <span className="shift-visually-hidden">Employee for the report</span>
                                <select
                                    value={reportEmployeeId}
                                    onChange={(event) => setReportEmployeeId(event.target.value)}
                                >
                                    <option value="">Select an employee</option>
                                    {employees.map((employee) => (
                                        <option key={employee.id} value={employee.id}>
                                            {employee.full_name}{employee.employee_id ? ` (${employee.employee_id})` : ""}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        )}
                        <button
                            type="button"
                            className="shift-reports-download"
                            onClick={handleDownloadReport}
                            disabled={reportDownloading || (reportScope === "employee" && !reportEmployeeId)}
                        >
                            <FaDownload /> {reportDownloading ? "Preparing..." : "Download Excel"}
                        </button>
                    </div>
                </section>
            </header>

            <section className="shift-toolbar" aria-label="Schedule controls">
                <div className="shift-toolbar-row">
                    <div className="shift-field">
                        <span className="shift-field-label" id="shift-view-label">View</span>
                        {/* The popover sits under the switch so it opens next to the Month button */}
                        <div className="shift-view-switch" ref={viewSwitchRef}>
                            <div className="shift-view-toggle" role="group" aria-labelledby="shift-view-label">
                                {VIEW_OPTIONS.map((option) => (
                                    <button
                                        key={option.value}
                                        type="button"
                                        data-view={option.value}
                                        className={`shift-view-toggle-button${view === option.value ? " active" : ""}`}
                                        aria-pressed={view === option.value}
                                        aria-haspopup={option.value === VIEW_MONTH ? "dialog" : undefined}
                                        aria-expanded={option.value === VIEW_MONTH ? monthPickerOpen : undefined}
                                        onClick={() => handleViewButton(option.value)}
                                    >
                                        {option.label}
                                    </button>
                                ))}
                            </div>

                            {monthPickerOpen && (
                                <MonthYearPicker
                                    year={anchor.getFullYear()}
                                    month={anchor.getMonth()}
                                    onSelect={handleMonthPicked}
                                    onClose={closeMonthPicker}
                                    containerRef={viewSwitchRef}
                                />
                            )}
                        </div>
                    </div>

                    <div className="shift-field shift-view-nav-field">
                        <span className="shift-field-label">{isCustomRange ? "Selected dates" : "Showing"}</span>
                        <div className="shift-view-nav">
                            {!isCustomRange && (
                                <button type="button" className="shift-week-nav-button" onClick={() => handleStep(-1)}>
                                    <FaChevronLeft /> {NAV_LABELS[view].prev}
                                </button>
                            )}
                            <span className="shift-week-range" aria-live="polite">
                                <FaCalendarWeek /> {rangeLabel}
                            </span>
                            {isCustomRange && range.valid && (
                                <span className="shift-range-count" data-testid="shift-range-count">
                                    {range.dates.length} {range.dates.length === 1 ? "day" : "days"}
                                </span>
                            )}
                            {!isCustomRange && (
                                <button type="button" className="shift-week-nav-button" onClick={() => handleStep(1)}>
                                    {NAV_LABELS[view].next} <FaChevronRight />
                                </button>
                            )}
                        </div>
                    </div>

                    {(view === VIEW_DAY || view === VIEW_WEEK) && (
                        <label className="shift-date-field">
                            <span>{PICKER_LABELS[view]}</span>
                            <input
                                type="date"
                                className="shift-date-input"
                                value={toIsoDate(anchor)}
                                onChange={(event) => dispatch({ type: "pickDate", value: event.target.value })}
                            />
                        </label>
                    )}

                    {isCustomRange && (
                        <div className="shift-range-group">
                            <div className="shift-range-fields" role="group" aria-label="Custom date range">
                                <label className="shift-date-field">
                                    <span>Start date</span>
                                    <input
                                        type="date"
                                        name="rangeStart"
                                        className="shift-range-input"
                                        value={custom.start}
                                        max={custom.end || undefined}
                                        aria-invalid={!range.valid}
                                        aria-describedby="shift-range-note"
                                        onChange={(event) => dispatch({ type: "setCustomRange", start: event.target.value })}
                                    />
                                </label>
                                <label className="shift-date-field">
                                    <span>End date</span>
                                    <input
                                        type="date"
                                        name="rangeEnd"
                                        className="shift-range-input"
                                        value={custom.end}
                                        min={custom.start || undefined}
                                        aria-invalid={!range.valid}
                                        aria-describedby="shift-range-note"
                                        onChange={(event) => dispatch({ type: "setCustomRange", end: event.target.value })}
                                    />
                                </label>
                            </div>
                            {/* One line directly under the two inputs: the limit while the range is usable, the reason once it is not */}
                            {range.valid ? (
                                <p id="shift-range-note" className="shift-range-note shift-range-hint" data-testid="shift-range-hint">
                                    Up to {MAX_CUSTOM_RANGE_DAYS} days
                                </p>
                            ) : (
                                <p id="shift-range-note" className="shift-range-note shift-range-message" role={rangeMessageRole} data-testid="shift-range-message">
                                    {range.error}
                                </p>
                            )}
                        </div>
                    )}

                    <div className="shift-field shift-find-field">
                        <span className="shift-field-label">Employee</span>
                        <button
                            type="button"
                            className="shift-week-nav-button shift-find-button"
                            aria-expanded={searchOpen}
                            aria-controls="shift-finder"
                            onClick={searchOpen ? closeSearch : openSearch}
                        >
                            <FaSearch /> {selectedEmployee ? "Change employee" : "Find employee"}
                        </button>
                    </div>
                </div>

                <div className="shift-toolbar-row shift-toolbar-actions">
                    <div className="shift-toolbar-admin-actions">
                        <button
                            type="button"
                            className="shift-secondary-button"
                            onClick={handleCopyPreviousWeekAllEmployees}
                            disabled={copying || isCustomRange}
                            aria-describedby={isCustomRange ? "shift-copy-hint" : undefined}
                            title={isCustomRange ? COPY_WEEK_DISABLED_REASON : undefined}
                        >
                            <FaCopy /> {copying ? "Copying..." : "Copy Previous Week (All Employees)"}
                        </button>
                        <button type="button" className="shift-secondary-button" onClick={openOverrideCreate}>
                            <FaUserShield /> Manage Employee Schedule
                        </button>
                    </div>
                </div>

                {isCustomRange && (
                    <p id="shift-copy-hint" className="shift-copy-hint" data-testid="shift-copy-hint">
                        {COPY_WEEK_DISABLED_REASON}
                    </p>
                )}

                {selectedEmployee && (
                    <div className="shift-filter-chip" role="status">
                        <span className="shift-filter-chip-text" data-testid="shift-filter-summary">{filterChipText(selectedEmployee)}</span>
                        <button
                            type="button"
                            className="shift-filter-chip-clear"
                            aria-label={`Clear employee filter (${employeeLabel(selectedEmployee)})`}
                            title="Clear filter"
                            onClick={clearEmployeeFilter}
                        >
                            <FaTimes />
                        </button>
                    </div>
                )}

                {searchOpen && (
                    <div id="shift-finder" className="shift-finder">
                        <form className="shift-search-input-row" role="search" onSubmit={handleSearch}>
                            <label className="shift-visually-hidden" htmlFor="shift-search-input">Search employees by name or employee ID</label>
                            <input
                                id="shift-search-input"
                                type="search"
                                className="shift-search-input"
                                placeholder="Search by name or employee ID..."
                                value={searchQuery}
                                onChange={(event) => setSearchQuery(event.target.value)}
                                autoFocus
                            />
                            <button type="submit" className="shift-week-nav-button">
                                {searching ? "Searching..." : "Search"}
                            </button>
                            <button type="button" className="shift-week-nav-button" onClick={closeSearch} aria-label="Close search">
                                <FaTimes />
                            </button>
                        </form>

                        {searchResults !== null && (
                            searchResults.length === 0 ? (
                                <div className="shift-search-empty" role="status">No matching employees found.</div>
                            ) : (
                                <ul className="shift-finder-results" aria-label="Matching employees">
                                    {searchResults.map((result) => (
                                        <li key={result.userId}>
                                            <button
                                                type="button"
                                                className="shift-finder-item"
                                                onClick={() => selectEmployee(result)}
                                            >
                                                <span className="shift-finder-name">{employeeLabel(result)}</span>
                                                <span className="shift-finder-meta">
                                                    {[result.designation, result.departmentName].filter(Boolean).join(" · ")}
                                                </span>
                                                {showsDayDetail(view) && (
                                                    <span className="shift-finder-day">
                                                        {result.status ? (
                                                            <span className={`shift-status-badge ${result.status}`}>
                                                                {result.isDefaultOff ? "OFF" : result.status}
                                                            </span>
                                                        ) : (
                                                            <span className="shift-status-badge off">no entry</span>
                                                        )}
                                                        {" "}
                                                        {result.startTime && result.endTime
                                                            ? `${formatTime12h(result.startTime)} - ${formatTime12h(result.endTime)} (${calculateShiftDuration(result.startTime, result.endTime) || "—"})`
                                                            : ""}
                                                    </span>
                                                )}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )
                        )}
                    </div>
                )}
            </section>

            <section className="shift-schedule-card">

                {!range.valid ? (
                    <div className="shift-schedule-empty" data-testid="shift-range-prompt">
                        <FaCalendarWeek />
                        <h3>Select a date range</h3>
                        <p>Choose a start date and an end date (up to {MAX_CUSTOM_RANGE_DAYS} days) to see the shifts in between.</p>
                    </div>
                ) : loading ? (
                    <div className="shift-schedule-loading" role="status">Loading shift schedule...</div>
                ) : error ? (
                    <div className="shift-schedule-error" role="alert">
                        {error}{" "}
                        <button type="button" className="shift-week-nav-button" onClick={loadSchedule}>Retry</button>
                    </div>
                ) : employeeRows.length === 0 ? (
                    <div className="shift-schedule-empty">
                        <FaCalendarWeek />
                        <h3>No employees to schedule</h3>
                        <p>Add active employees first, then they can build their own shift schedule here.</p>
                    </div>
                ) : (
                    <div className="shift-table-wrapper">
                        <table className={`shift-table${view === VIEW_MONTH || isCustomRange ? " shift-table-month" : ""}`} aria-label={`Shift schedule, ${rangeLabel}`}>
                            <thead>
                                <tr>
                                    <th>Employee</th>
                                    {weekDates.map((date) => (
                                        <th key={date} data-date={date}>
                                            {weekdayLabel(parseIsoDate(date))}
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
                                            // requires the explicit "Manage Employee Schedule" action in the toolbar.
                                            const cellClass = row.isSelf ? `${baseClass} shift-cell-editable` : baseClass;
                                            return (
                                                <td
                                                    key={date}
                                                    data-date={date}
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

                {selectedEmployee && !loading && !error && shifts.length === 0 && (
                    <div className="shift-empty-note" role="status">
                        No shifts are recorded for {employeeLabel(selectedEmployee)} in this {view}.
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
                                <p>You are managing another employee's schedule on their behalf. Every use is recorded in the audit history.</p>
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
