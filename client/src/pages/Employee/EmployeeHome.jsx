import {
  useEffect,
  useState,
} from "react";

import {
  FaTasks,
  FaCalendarAlt,
  FaClock,
  FaCheckCircle,
  FaPlay,
  FaStop,
  FaPause,
  FaPlayCircle,
} from "react-icons/fa";

import {
  toast,
} from "react-toastify";

import { useNavigate } from "react-router-dom";

import api from "../../services/api";

import { getTasks } from "../../services/taskManagementService";
import { getMyActiveSprints } from "../../services/sprintService";

import TagChips from "../../components/TagChips";

import {
  TASK_STATUS_LABELS,
  TASK_STATUS_CLASS,
  PRIORITY_CLASS,
  formatDate,
} from "../../utils/workItemStatus";

import {
  getActiveTasks,
  getDueSoonTasks,
  getOverdueTasks,
  getPendingReviewTasks,
  getRecentlyUpdatedTasks,
} from "../../utils/dashboardStats";

import ExecutiveDashboard from "./ExecutiveDashboard";
import { isExecutiveDashboardUser } from "../../utils/executiveAccess";

import "../../styles/workItems.css";
import "./EmployeeHome.css";

// ==========================================
// CURRENT USER ID
// The login flow (Login.jsx) only ever writes
// the user to sessionStorage -- this mirrors the
// same helper already used in ProjectWorkspace.jsx
// rather than the unrelated localStorage read
// below (kept as-is; it's a pre-existing, separate
// issue not touched here).
// ==========================================

function getCurrentUserId() {
  try {
    return JSON.parse(sessionStorage.getItem("user"))?.id ?? null;
  } catch {
    return null;
  }
}

function EmployeeHome() {
  // ==========================================
  // EXECUTIVE DASHBOARD
  // Founder/Chairman (by designation, see
  // executiveAccess.js) get a company-overview
  // dashboard instead of the normal attendance/
  // task-focused one — same "/employee" URL for
  // everyone. This is only READ before render
  // (not inside a hook), so it must not gate any
  // hook call below — the branch happens at the
  // very end, right before the JSX return, so
  // every hook still runs on every render as
  // React requires.
  // ==========================================

  const sessionUser = (() => {
    try {
      return JSON.parse(sessionStorage.getItem("user"));
    } catch {
      return null;
    }
  })();

  const showExecutiveDashboard = isExecutiveDashboardUser(sessionUser);

  const navigate = useNavigate();

  const currentUserId = getCurrentUserId();

  // ==========================================
  // ATTENDANCE STATE
  // ==========================================

  const [
    isOnline,
    setIsOnline,
  ] = useState(false);

  const [
    isOnBreak,
    setIsOnBreak,
  ] = useState(false);

  const [
    attendance,
    setAttendance,
  ] = useState(null);

  const [
    completedSeconds,
    setCompletedSeconds,
  ] = useState(0);

  const [
    liveWorkSeconds,
    setLiveWorkSeconds,
  ] = useState(0);

  const [
    liveBreakSeconds,
    setLiveBreakSeconds,
  ] = useState(0);

  const [
    attendanceLoading,
    setAttendanceLoading,
  ] = useState(true);

  // ==========================================
  // TASK STATE
  // Sourced from the live Task Management module
  // (same membership-scoped GET /task-management/
  // tasks already used by AdminTasksList/
  // EmployeeTasks) -- NOT the legacy /tasks/my
  // endpoint, which filters by task creator, not
  // assignee, and would be empty/wrong for a normal
  // project-assigned employee.
  // ==========================================

  const [
    allTasks,
    setAllTasks,
  ] = useState([]);

  // ==========================================
  // ACTIVE SPRINT STATE
  // ==========================================

  const [
    activeSprints,
    setActiveSprints,
  ] = useState([]);

  // ==========================================
  // LEAVE STATE
  // ==========================================

  const [
    myLeaves,
    setMyLeaves,
  ] = useState([]);

  // ==========================================
  // FORMAT SECONDS
  // ==========================================

  const formatDuration = (
    seconds
  ) => {
    const safeSeconds =
      Math.max(
        0,
        Math.floor(
          Number(seconds) ||
            0
        )
      );

    const hours =
      Math.floor(
        safeSeconds / 3600
      );

    const minutes =
      Math.floor(
        (
          safeSeconds %
          3600
        ) / 60
      );

    const secs =
      safeSeconds % 60;

    return [
      hours,
      minutes,
      secs,
    ]
      .map(
        (value) =>
          String(
            value
          ).padStart(
            2,
            "0"
          )
      )
      .join(":");
  };

  // ==========================================
  // FORMAT TIME
  // ==========================================

  const formatTime = (
    date
  ) => {
    if (!date) {
      return "--";
    }

    return new Date(
      date
    ).toLocaleTimeString(
      [],
      {
        hour:
          "2-digit",

        minute:
          "2-digit",

        second:
          "2-digit",
      }
    );
  };

  // ==========================================
  // LOAD ATTENDANCE STATUS
  // ==========================================

  const loadAttendanceStatus =
    async () => {
      try {
        setAttendanceLoading(
          true
        );

        const response =
          await api.get(
            "/attendance/status"
          );

        setIsOnline(
          Boolean(
            response.data
              .isOnline
          )
        );

        setIsOnBreak(
          Boolean(
            response.data
              .isOnBreak
          )
        );

        setAttendance(
          response.data
            .attendance
        );

        setCompletedSeconds(
          Number(
            response.data
              .totalWorkSeconds
          ) || 0
        );
      } catch (error) {
        console.error(
          "Attendance status error:",
          error
        );

        toast.error(
          error.response?.data
            ?.message ||
            "Unable to load attendance"
        );
      } finally {
        setAttendanceLoading(
          false
        );
      }
    };

  // ==========================================
  // LOAD MY TASKS (live Task Management module)
  // ==========================================

  const loadAllTasks =
    async () => {
      try {
        const response = await getTasks();

        setAllTasks(response.tasks || []);
      } catch (error) {
        console.error(
          "Unable to load dashboard tasks:",
          error
        );
      }
    };

  // ==========================================
  // LOAD MY ACTIVE SPRINTS
  // ==========================================

  const loadActiveSprints =
    async () => {
      try {
        const response = await getMyActiveSprints();

        setActiveSprints(response.sprints || []);
      } catch (error) {
        console.error(
          "Unable to load dashboard sprints:",
          error
        );
      }
    };

  // ==========================================
  // LOAD MY LEAVE REQUESTS
  // ==========================================

  const loadMyLeaves =
    async () => {
      try {
        const response =
          await api.get(
            "/leaves/my"
          );

        setMyLeaves(
          response.data
            .leaves || []
        );
      } catch (error) {
        console.error(
          "Unable to load dashboard leaves:",
          error
        );
      }
    };

  // ==========================================
  // LOAD DASHBOARD DATA
  // ==========================================

  useEffect(() => {
    loadAttendanceStatus();
    loadAllTasks();
    loadActiveSprints();
    loadMyLeaves();
  }, []);

  // ==========================================
  // TASK STATISTICS
  // My tasks = assigned to me, across every
  // project I'm a member of (allTasks is already
  // membership-scoped server-side).
  // ==========================================

  const myTasks =
    allTasks.filter(
      (task) =>
        Number(task.assigned_to) === Number(currentUserId)
    );

  const completedTasks =
    myTasks.filter(
      (task) =>
        task.status ===
        "closed"
    );

  const pendingTasks =
    getActiveTasks(allTasks, currentUserId);

  const dueSoonTasks =
    getDueSoonTasks(allTasks, currentUserId);

  const overdueTasks =
    getOverdueTasks(allTasks, currentUserId);

  const pendingReviewTasks =
    getPendingReviewTasks(allTasks, currentUserId);

  const recentlyUpdatedTasks =
    getRecentlyUpdatedTasks(allTasks, currentUserId, 5);

  // "Attention" list shown in the My Work panel --
  // overdue first, then due soon, then everything
  // else currently active, capped at 6 rows so the
  // panel stays compact (matches "avoid clutter").
  const myWorkTasks = [
    ...overdueTasks,
    ...dueSoonTasks.filter((task) => !overdueTasks.includes(task)),
    ...pendingTasks.filter(
      (task) => !overdueTasks.includes(task) && !dueSoonTasks.includes(task)
    ),
  ].slice(0, 6);

  // ==========================================
  // LEAVE STATISTICS
  // ==========================================

  const pendingLeaves =
    myLeaves.filter(
      (leave) =>
        leave.status ===
        "pending"
    );

  // ==========================================
  // LIVE WORK + BREAK TIMER
  // ==========================================

  useEffect(() => {
    if (
      !isOnline ||
      !attendance?.login_time
    ) {
      setLiveWorkSeconds(
        0
      );

      setLiveBreakSeconds(
        0
      );

      return;
    }

    const calculateTime =
      () => {
        const now =
          Date.now();

        const loginTime =
          new Date(
            attendance
              .login_time
          ).getTime();

        const totalSessionSeconds =
          Math.max(
            0,
            Math.floor(
              (
                now -
                loginTime
              ) / 1000
            )
          );

        const savedBreakSeconds =
          Number(
            attendance
              .total_break_seconds
          ) || 0;

        let currentBreakSeconds =
          0;

        if (
          isOnBreak &&
          attendance
            ?.break_start_time
        ) {
          const breakStartTime =
            new Date(
              attendance
                .break_start_time
            ).getTime();

          currentBreakSeconds =
            Math.max(
              0,
              Math.floor(
                (
                  now -
                  breakStartTime
                ) / 1000
              )
            );
        }

        const totalBreakSeconds =
          savedBreakSeconds +
          currentBreakSeconds;

        const workingSeconds =
          Math.max(
            0,
            totalSessionSeconds -
              totalBreakSeconds
          );

        setLiveWorkSeconds(
          workingSeconds
        );

        setLiveBreakSeconds(
          currentBreakSeconds
        );
      };

    calculateTime();

    const timer =
      setInterval(
        calculateTime,
        1000
      );

    return () =>
      clearInterval(
        timer
      );
  }, [
    isOnline,
    isOnBreak,
    attendance,
  ]);

  // ==========================================
  // GO ONLINE
  // ==========================================

  const handleGoOnline =
    async () => {
      try {
        setAttendanceLoading(
          true
        );

        const response =
          await api.post(
            "/attendance/online"
          );

        setIsOnline(
          true
        );

        setIsOnBreak(
          false
        );

        setAttendance(
          response.data
            .attendance
        );

        setLiveWorkSeconds(
          0
        );

        setLiveBreakSeconds(
          0
        );

        toast.success(
          "You are now online"
        );
      } catch (error) {
        toast.error(
          error.response?.data
            ?.message ||
            "Unable to go online"
        );
      } finally {
        setAttendanceLoading(
          false
        );
      }
    };

  // ==========================================
  // START BREAK
  // ==========================================

  const handleStartBreak =
    async () => {
      try {
        setAttendanceLoading(
          true
        );

        const response =
          await api.post(
            "/attendance/break/start"
          );

        setIsOnline(
          true
        );

        setIsOnBreak(
          true
        );

        setAttendance(
          response.data
            .attendance
        );

        setLiveBreakSeconds(
          0
        );

        toast.success(
          "Break started"
        );
      } catch (error) {
        toast.error(
          error.response?.data
            ?.message ||
            "Unable to start break"
        );
      } finally {
        setAttendanceLoading(
          false
        );
      }
    };

  // ==========================================
  // END BREAK
  // ==========================================

  const handleEndBreak =
    async () => {
      try {
        setAttendanceLoading(
          true
        );

        const response =
          await api.post(
            "/attendance/break/end"
          );

        setIsOnline(
          true
        );

        setIsOnBreak(
          false
        );

        setAttendance(
          response.data
            .attendance
        );

        setLiveBreakSeconds(
          0
        );

        toast.success(
          "Break ended. You are back to work."
        );
      } catch (error) {
        toast.error(
          error.response?.data
            ?.message ||
            "Unable to end break"
        );
      } finally {
        setAttendanceLoading(
          false
        );
      }
    };

  // ==========================================
  // GO OFFLINE
  // ==========================================

  const handleGoOffline =
    async () => {
      try {
        setAttendanceLoading(
          true
        );

        const response =
          await api.post(
            "/attendance/offline"
          );

        const finishedSession =
          response.data
            .attendance;

        setCompletedSeconds(
          (previous) =>
            previous +
            Number(
              finishedSession
                ?.work_duration_seconds ||
                0
            )
        );

        setAttendance(
          finishedSession
        );

        setIsOnline(
          false
        );

        setIsOnBreak(
          false
        );

        setLiveWorkSeconds(
          0
        );

        setLiveBreakSeconds(
          0
        );

        toast.success(
          "You are now offline"
        );
      } catch (error) {
        toast.error(
          error.response?.data
            ?.message ||
            "Unable to go offline"
        );
      } finally {
        setAttendanceLoading(
          false
        );
      }
    };

  // ==========================================
  // TODAY TOTAL WORKING TIME
  // ==========================================

  const todayTotalSeconds =
    completedSeconds +
    (
      isOnline
        ? liveWorkSeconds
        : 0
    );

  // ==========================================
  // ATTENDANCE STATUS
  // ==========================================

  const getStatusText =
    () => {
      if (!isOnline) {
        return "OFFLINE";
      }

      if (isOnBreak) {
        return "ON BREAK";
      }

      return "WORKING";
    };

  const getStatusClass =
    () => {
      if (!isOnline) {
        return "offline";
      }

      if (isOnBreak) {
        return "break";
      }

      return "online";
    };

  // ==========================================
  // RENDER
  // ==========================================

  if (showExecutiveDashboard) {
    return <ExecutiveDashboard />;
  }

 return (
    <>

        {/* ==================================
            DASHBOARD CONTENT
        ================================== */}

        <div className="employee-page-content">

          {/* ==================================
              WELCOME
          ================================== */}

          <section className="employee-welcome-card">

            <div>

              <span className="welcome-label">
                Employee Workspace
              </span>

              <h2>
                Hello,{" "}
                {sessionUser?.fullName}
              </h2>

              <p>
                Manage your attendance,
                assigned tasks and work
                activities from your
                WorkHub dashboard.
              </p>

            </div>

 <div className="welcome-employee-id">

  

  <strong>{sessionUser?.employeeId}</strong>

</div>

          </section>

          {/* ==================================
              STAT CARDS
          ================================== */}

          <div className="employee-stats-grid">

            {/* TODAY WORK HOURS */}

            <div className="employee-stat-card">

              <div className="employee-stat-icon">

                <FaClock />

              </div>

              <div>

                <p>
                  Today's Work Hours
                </p>

                <h3>
                  {formatDuration(
                    todayTotalSeconds
                  )}
                </h3>

                <span>

                  {isOnBreak
                    ? "Work timer paused"
                    : isOnline
                    ? "Currently working"
                    : "Total completed time"}

                </span>

              </div>

            </div>

            {/* COMPLETED TASKS */}

            <div className="employee-stat-card">

              <div className="employee-stat-icon">

                <FaCheckCircle />

              </div>

              <div>

                <p>
                  Tasks Completed
                </p>

                <h3>
                  {
                    completedTasks.length
                  }
                </h3>

                <span>

                  {completedTasks.length ===
                  0
                    ? "No completed tasks"
                    : `${completedTasks.length} completed task${
                        completedTasks.length >
                        1
                          ? "s"
                          : ""
                      }`}

                </span>

              </div>

            </div>

            {/* PENDING TASKS */}

            <div className="employee-stat-card">

              <div className="employee-stat-icon">

                <FaTasks />

              </div>

              <div>

                <p>
                  Pending Tasks
                </p>

                <h3>
                  {
                    pendingTasks.length
                  }
                </h3>

                <span>

                  {pendingTasks.length ===
                  0
                    ? "No pending tasks"
                    : `${pendingTasks.length} task${
                        pendingTasks.length >
                        1
                          ? "s"
                          : ""
                      } in progress`}

                </span>

              </div>

            </div>

            {/* LEAVE REQUESTS */}

            <div className="employee-stat-card">

              <div className="employee-stat-icon">

                <FaCalendarAlt />

              </div>

              <div>

                <p>
                  Leave Requests
                </p>

                <h3>
                  {
                    pendingLeaves.length
                  }
                </h3>

                <span>

                  {pendingLeaves.length ===
                  0
                    ? "No pending requests"
                    : `${pendingLeaves.length} pending leave request${
                        pendingLeaves.length >
                        1
                          ? "s"
                          : ""
                      }`}

                </span>

              </div>

            </div>

          </div>

          {/* ==================================
              MY WORK — active/overdue/due-soon
              tasks assigned to me, compact rows,
              same table pattern already used by
              AdminTasksList/BacklogTab. Clicking a
              row opens the real, unmodified Task
              Workspace; "View all" opens the real
              My Tasks page — no data or filtering
              logic is duplicated here. Full-width,
              above the panel grid, since it's the
              primary actionable widget.
          ================================== */}

          <section className="employee-panel employee-panel-wide">

            <div className="employee-panel-header employee-panel-header-row">
              <div>
                <h3>My Work</h3>
                <span>Tasks needing your attention</span>
              </div>
              <button
                type="button"
                className="employee-panel-link"
                onClick={() => navigate("/employee/tasks")}
              >
                View all
              </button>
            </div>

            {myWorkTasks.length === 0 ? (

              <div className="employee-empty-state">
                Nothing needs your attention right now.
              </div>

            ) : (

              <div className="wi-table-wrapper employee-work-table">
                <table className="wi-table">
                  <tbody>
                    {myWorkTasks.map((task) => {

                      const isOverdue = overdueTasks.includes(task);
                      const isDueSoon = !isOverdue && dueSoonTasks.includes(task);

                      return (
                        <tr
                          key={task.id}
                          onClick={() => navigate(`/employee/task-workspace/${task.id}`)}
                        >
                          <td>
                            <div className="wi-table-task-cell">
                              <strong>{task.task_title}</strong>
                              {task.taskTags?.length > 0 && (
                                <TagChips tags={task.taskTags} max={3} />
                              )}
                            </div>
                          </td>
                          <td>
                            <span className={PRIORITY_CLASS[task.priority] || "priority-pill priority-medium"}>
                              {task.priority}
                            </span>
                          </td>
                          <td>
                            <span className={TASK_STATUS_CLASS[task.status] || "status-pill status-neutral"}>
                              {TASK_STATUS_LABELS[task.status] || task.status}
                            </span>
                          </td>
                          <td>
                            <span className={isOverdue ? "employee-due-overdue" : isDueSoon ? "employee-due-soon" : undefined}>
                              {isOverdue ? "Overdue " : ""}{formatDate(task.due_date)}
                            </span>
                          </td>
                        </tr>
                      );

                    })}
                  </tbody>
                </table>
              </div>

            )}

          </section>

          {/* ==================================
              DASHBOARD PANELS
          ================================== */}

          <div className="employee-dashboard-panels">

            {/* ==================================
                ATTENDANCE
            ================================== */}

            <section className="employee-panel attendance-control-panel">

              <div className="employee-panel-header">

                <h3>
                  Today's Attendance
                </h3>

                <span>
                  Manage your work
                  session and breaks
                </span>

              </div>

              <div className="attendance-control-content">

                {/* STATUS */}

                <div
                  className={`attendance-status ${getStatusClass()}`}
                >

                  <span className="status-dot" />

                  {getStatusText()}

                </div>

                {/* WORKING TIME */}

                <div className="attendance-time-display">

                  <span>
                    Working Time
                  </span>

                  <strong>

                    {formatDuration(
                      isOnline
                        ? liveWorkSeconds
                        : 0
                    )}

                  </strong>

                </div>

                {/* BREAK TIME */}

                {isOnBreak && (

                  <div className="break-time-display">

                    <span>
                      Current Break Time
                    </span>

                    <strong>

                      {formatDuration(
                        liveBreakSeconds
                      )}

                    </strong>

                  </div>

                )}

                {/* ATTENDANCE DETAILS */}

                <div className="attendance-details">

                  <div>

                    <span>
                      Start Time
                    </span>

                    <strong>

                      {attendance
                        ?.login_time
                        ? formatTime(
                            attendance
                              .login_time
                          )
                        : "--"}

                    </strong>

                  </div>

                  <div>

                    <span>
                      End Time
                    </span>

                    <strong>

                      {!isOnline &&
                      attendance
                        ?.logout_time
                        ? formatTime(
                            attendance
                              .logout_time
                          )
                        : "--"}

                    </strong>

                  </div>

                </div>

                {/* GO ONLINE */}

                {!isOnline && (

                  <button
                    type="button"
                    className="go-online-button"
                    onClick={
                      handleGoOnline
                    }
                    disabled={
                      attendanceLoading
                    }
                  >

                    <FaPlay />

                    {attendanceLoading
                      ? "Processing..."
                      : "Go Online"}

                  </button>

                )}

                {/* WORKING ACTIONS */}

                {isOnline &&
                  !isOnBreak && (

                  <div className="attendance-action-buttons">

                    <button
                      type="button"
                      className="start-break-button"
                      onClick={
                        handleStartBreak
                      }
                      disabled={
                        attendanceLoading
                      }
                    >

                      <FaPause />

                      {attendanceLoading
                        ? "Processing..."
                        : "Start Break"}

                    </button>

                    <button
                      type="button"
                      className="go-offline-button"
                      onClick={
                        handleGoOffline
                      }
                      disabled={
                        attendanceLoading
                      }
                    >

                      <FaStop />

                      {attendanceLoading
                        ? "Processing..."
                        : "Go Offline"}

                    </button>

                  </div>

                )}

                {/* BREAK ACTIONS */}

                {isOnline &&
                  isOnBreak && (

                  <div className="attendance-action-buttons">

                    <button
                      type="button"
                      className="end-break-button"
                      onClick={
                        handleEndBreak
                      }
                      disabled={
                        attendanceLoading
                      }
                    >

                      <FaPlayCircle />

                      {attendanceLoading
                        ? "Processing..."
                        : "End Break"}

                    </button>

                    <button
                      type="button"
                      className="go-offline-button"
                      onClick={
                        handleGoOffline
                      }
                      disabled={
                        attendanceLoading
                      }
                    >

                      <FaStop />

                      {attendanceLoading
                        ? "Processing..."
                        : "Go Offline"}

                    </button>

                  </div>

                )}

              </div>

            </section>

            {/* ==================================
                CURRENT SPRINT — reuses the exact
                progress calculation already shown
                on the Sprints tab (closed/total),
                just rendered compactly here.
            ================================== */}

            <section className="employee-panel">

              <div className="employee-panel-header">
                <h3>Current Sprint</h3>
                <span>Active sprint across your projects</span>
              </div>

              {activeSprints.length === 0 ? (

                <div className="employee-empty-state">
                  No active sprint right now.
                </div>

              ) : (

                <div className="employee-sprint-list">
                  {activeSprints.map((sprint) => {

                    const pct = sprint.task_count > 0
                      ? Math.round((sprint.closed_task_count / sprint.task_count) * 100)
                      : 0;

                    return (
                      <div key={sprint.id} className="employee-sprint-item">
                        <div className="employee-sprint-item-top">
                          <strong>{sprint.name}</strong>
                          <span>{sprint.project_name}</span>
                        </div>
                        <div className="employee-sprint-progress-track">
                          <div
                            className="employee-sprint-progress-fill"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="employee-sprint-item-meta">
                          {sprint.closed_task_count} / {sprint.task_count} tasks closed
                          {sprint.end_date ? ` · Ends ${formatDate(sprint.end_date)}` : ""}
                        </span>
                      </div>
                    );

                  })}
                </div>

              )}

            </section>

            {/* ==================================
                RECENTLY UPDATED — simple recency
                sort on the tasks already loaded
                above, not a separate activity feed.
            ================================== */}

            <section className="employee-panel">

              <div className="employee-panel-header">
                <h3>Recently Updated</h3>
                <span>Your latest task changes</span>
              </div>

              {recentlyUpdatedTasks.length === 0 ? (

                <div className="employee-empty-state">
                  No recent task activity.
                </div>

              ) : (

                <div className="employee-recent-list">
                  {recentlyUpdatedTasks.map((task) => (
                    <div
                      key={task.id}
                      className="employee-recent-item"
                      onClick={() => navigate(`/employee/task-workspace/${task.id}`)}
                    >
                      <div>
                        <strong>{task.task_title}</strong>
                        <span>{task.project_name || "No Project"}</span>
                      </div>
                      <span className={TASK_STATUS_CLASS[task.status] || "status-pill status-neutral"}>
                        {TASK_STATUS_LABELS[task.status] || task.status}
                      </span>
                    </div>
                  ))}
                </div>

              )}

            </section>

            {/* ==================================
                PENDING REVIEW — my own submissions
                currently awaiting an authorized
                reviewer's decision.
            ================================== */}

            <section className="employee-panel">

              <div className="employee-panel-header">
                <h3>Pending Review</h3>
                <span>Your submissions awaiting approval</span>
              </div>

              {pendingReviewTasks.length === 0 ? (

                <div className="employee-empty-state">
                  Nothing waiting on review.
                </div>

              ) : (

                <div className="employee-recent-list">
                  {pendingReviewTasks.map((task) => (
                    <div
                      key={task.id}
                      className="employee-recent-item"
                      onClick={() => navigate(`/employee/task-workspace/${task.id}`)}
                    >
                      <div>
                        <strong>{task.task_title}</strong>
                        <span>{task.project_name || "No Project"}</span>
                      </div>
                      <span className="status-pill status-pending-review">
                        Pending Review
                      </span>
                    </div>
                  ))}
                </div>

              )}

            </section>

          </div>

        </div>

      </>


  );
}

export default EmployeeHome;