import {
  useEffect,
  useRef,
  useState,
} from "react";

import {
  useNavigate,
  useParams,
} from "react-router-dom";

import {
  FaBars,
  FaBell,
  FaCheckDouble,
  FaTrash,
  FaSignOutAlt,
  FaDesktop,
} from "react-icons/fa";

import api from "../../services/api";

import socket, {
  connectSocket,
} from "../../services/socket";

import {
  getNotificationPermission,
  requestNotificationPermission,
} from "../../services/browserNotification";

import EmployeeProfileAvatar from "../EmployeeProfileAvatar";

import "./EmployeeHeader.css";

function EmployeeHeader({ mobileNavOpen, onOpenMobileNav }) {
  const navigate =
    useNavigate();

  // Phase 8 fix: notification navigation below previously hardcoded
  // the legacy "/employee" prefix, breaking in-app notification
  // clicks for company-aware tenant users (see AdminSidebar.jsx for
  // the same fix and full reasoning).
  const { companySlug } = useParams();
  const basePath = companySlug ? `/${companySlug}/employee` : "/employee";

  // ==========================================
  // MOBILE/TABLET DRAWER — HAMBURGER FOCUS
  //
  // Lightweight focus handling (no focus-trap
  // library): when the drawer closes, return
  // focus to the button that opened it. Moving
  // focus INTO the drawer on open is handled by
  // EmployeeSidebar itself.
  // ==========================================

  const hamburgerRef = useRef(null);
  const wasMobileNavOpen = useRef(mobileNavOpen);

  useEffect(() => {

    if (wasMobileNavOpen.current && !mobileNavOpen) {
      hamburgerRef.current?.focus();
    }

    wasMobileNavOpen.current = mobileNavOpen;

  }, [mobileNavOpen]);

  // ==========================================
  // USER
  // ==========================================

  const storedUser =
    sessionStorage.getItem(
      "user"
    );

  let user = null;

  try {
    user =
      storedUser
        ? JSON.parse(
            storedUser
          )
        : null;
  } catch (error) {
    console.error(
      "Unable to parse user session:",
      error
    );

    user = null;
  }

  // ==========================================
  // STATE
  // ==========================================

  const [
    notifications,
    setNotifications,
  ] = useState([]);

  const [
    unreadCount,
    setUnreadCount,
  ] = useState(0);

  const [
    isOpen,
    setIsOpen,
  ] = useState(false);

  const [
    loading,
    setLoading,
  ] = useState(false);

  const dropdownRef =
    useRef(null);

  const [
    desktopPermission,
    setDesktopPermission,
  ] = useState(() => getNotificationPermission());

  // ==========================================
  // LOAD NOTIFICATIONS
  // ==========================================

  const loadNotifications =
    async () => {
      try {
        setLoading(
          true
        );

        const response =
          await api.get(
            "/notifications"
          );

        const data =
          response.data
            ?.notifications ||
          [];

        setNotifications(
          data
        );

        const unread =
          data.filter(
            (
              notification
            ) =>
              !Boolean(
                Number(
                  notification
                    .is_read
                )
              )
          ).length;

        setUnreadCount(
          unread
        );
      } catch (error) {
        console.error(
          "Load Notifications Error:",
          error
        );
      } finally {
        setLoading(
          false
        );
      }
    };

  // ==========================================
  // LOAD UNREAD COUNT
  // ==========================================

  const loadUnreadCount =
    async () => {
      try {
        const response =
          await api.get(
            "/notifications/unread-count"
          );

        setUnreadCount(
          Number(
            response.data
              ?.unreadCount
          ) || 0
        );
      } catch (error) {
        console.error(
          "Unread Count Error:",
          error
        );
      }
    };

  // ==========================================
  // INITIAL LOAD
  // ==========================================

  useEffect(() => {
    loadUnreadCount();

    connectSocket();

    const handleNewNotification =
      (notification) => {
        setNotifications(
          (current) => [
            notification,
            ...current,
          ]
        );

        setUnreadCount(
          (current) =>
            current + 1
        );
      };

    socket.on(
      "notification:new",
      handleNewNotification
    );

    const interval =
      setInterval(
        loadUnreadCount,
        30000
      );

    return () => {
      socket.off(
        "notification:new",
        handleNewNotification
      );

      clearInterval(
        interval
      );
    };
  }, []);

  // ==========================================
  // CLOSE DROPDOWN WHEN CLICKING OUTSIDE
  // ==========================================

  useEffect(() => {
    const handleClickOutside =
      (event) => {
        if (
          dropdownRef.current &&
          !dropdownRef.current.contains(
            event.target
          )
        ) {
          setIsOpen(
            false
          );
        }
      };

    document.addEventListener(
      "mousedown",
      handleClickOutside
    );

    return () => {
      document.removeEventListener(
        "mousedown",
        handleClickOutside
      );
    };
  }, []);

  // ==========================================
  // TOGGLE NOTIFICATIONS
  // ==========================================

  const handleBellClick =
    async () => {
      const nextState =
        !isOpen;

      setIsOpen(
        nextState
      );

      if (
        nextState
      ) {
        await loadNotifications();
      }
    };

  // ==========================================
  // MARK ONE AS READ + NAVIGATE TO REFERENCE
  // ==========================================

  const markAsRead =
    async (
      notification
    ) => {
      const alreadyRead =
        Boolean(
          Number(
            notification
              .is_read
          )
        );

      if (
        !alreadyRead
      ) {

        try {
          await api.put(
            `/notifications/${notification.id}/read`
          );

          setNotifications(
            (
              currentNotifications
            ) =>
              currentNotifications.map(
                (item) =>
                  item.id ===
                  notification.id
                    ? {
                        ...item,
                        is_read:
                          1,
                      }
                    : item
              )
          );

          setUnreadCount(
            (
              currentCount
            ) =>
              Math.max(
                0,
                currentCount -
                  1
              )
          );
        } catch (error) {
          console.error(
            "Mark Notification Read Error:",
            error
          );
        }

      }

      if (
        notification.reference_type ===
          "task" &&
        notification.reference_id
      ) {

        setIsOpen(false);

        navigate(
          `${basePath}/task-workspace/${notification.reference_id}`
        );

      }

      if (
        notification.reference_type ===
          "conversation" &&
        notification.reference_id
      ) {

        setIsOpen(false);

        navigate(
          `${basePath}/chat`,
          {
            state: {
              openConversationId:
                notification.reference_id,
            },
          }
        );

      }

      if (
        notification.reference_type ===
        "leave"
      ) {

        setIsOpen(false);

        // Pending-approval notifications (sent to a manager or
        // final approver) go to the approvals queue; every other
        // leave notification (approved/rejected) is the requester's
        // own status update, so it goes to their own leave page.
        navigate(
          notification.type?.startsWith(
            "leave_pending"
          )
            ? `${basePath}/team/leave-approvals`
            : `${basePath}/leave`
        );

      }

      if (
        notification.reference_type ===
          "meeting" &&
        notification.reference_id
      ) {

        setIsOpen(false);

        navigate(
          `${basePath}/meetings/${notification.reference_id}`
        );

      }
    };

  // ==========================================
  // ENABLE DESKTOP NOTIFICATIONS
  // Only ever called from this explicit click —
  // never requested automatically on load.
  // ==========================================

  const handleEnableDesktopNotifications =
    async () => {
      const result =
        await requestNotificationPermission();

      setDesktopPermission(
        result
      );
    };

  // ==========================================
  // MARK ALL AS READ
  // ==========================================

  const markAllAsRead =
    async () => {
      try {
        await api.put(
          "/notifications/read-all"
        );

        setNotifications(
          (
            currentNotifications
          ) =>
            currentNotifications.map(
              (
                notification
              ) => ({
                ...notification,
                is_read:
                  1,
              })
            )
        );

        setUnreadCount(
          0
        );
      } catch (error) {
        console.error(
          "Mark All Read Error:",
          error
        );
      }
    };

  // ==========================================
  // DELETE NOTIFICATION
  // ==========================================

  const deleteNotification =
    async (
      notificationId
    ) => {
      try {
        const notification =
          notifications.find(
            (item) =>
              item.id ===
              notificationId
          );

        await api.delete(
          `/notifications/${notificationId}`
        );

        setNotifications(
          (
            currentNotifications
          ) =>
            currentNotifications.filter(
              (item) =>
                item.id !==
                notificationId
            )
        );

        const wasUnread =
          notification &&
          !Boolean(
            Number(
              notification
                .is_read
            )
          );

        if (
          wasUnread
        ) {
          setUnreadCount(
            (
              currentCount
            ) =>
              Math.max(
                0,
                currentCount -
                  1
              )
          );
        }
      } catch (error) {
        console.error(
          "Delete Notification Error:",
          error
        );
      }
    };

  // ==========================================
  // FORMAT DATE
  // ==========================================

  const formatDate =
    (value) => {
      if (
        !value
      ) {
        return "";
      }

      const date =
        new Date(
          value
        );

      if (
        Number.isNaN(
          date.getTime()
        )
      ) {
        return "";
      }

      return date.toLocaleString(
        "en-IN",
        {
          day:
            "2-digit",

          month:
            "short",

          year:
            "numeric",

          hour:
            "2-digit",

          minute:
            "2-digit",
        }
      );
    };

  // ==========================================
  // LOGOUT
  // ==========================================

  const handleLogout =
    () => {
      // Remove authentication only
      // for this browser tab/session.

      sessionStorage.removeItem(
        "token"
      );

      sessionStorage.removeItem(
        "user"
      );

      // Remove old authentication
      // left from previous localStorage setup.
      localStorage.removeItem(
        "token"
      );

      localStorage.removeItem(
        "user"
      );

      navigate(
        "/",
        {
          replace:
            true,
        }
      );
    };

  // ==========================================
  // RENDER
  // ==========================================

  return (
    <header className="employee-header">

      <div className="employee-header-left">

        {/* ======================================
            MOBILE/TABLET NAV TOGGLE
            Only visible below 1024px (see CSS) --
            desktop keeps its existing sidebar
            controls untouched.
        ====================================== */}

        <button
          type="button"
          ref={hamburgerRef}
          className="mobile-nav-toggle"
          onClick={onOpenMobileNav}
          aria-label="Open navigation menu"
          aria-expanded={mobileNavOpen}
          aria-controls="employee-mobile-sidebar"
        >
          <FaBars />
        </button>

        {/* ======================================
            HEADER TITLE
        ====================================== */}

        <div className="employee-header-title">

          <h1>
            My Dashboard
          </h1>

          <p>
            Welcome back,{" "}
            {user?.fullName ||
              "Employee"}
          </p>

          {user?.designation ? (
            <span className="employee-header-designation">
              {user.designation}
            </span>
          ) : null}

        </div>

      </div>

      {/* ======================================
          HEADER ACTIONS
      ====================================== */}

      <div className="employee-header-right">

        {/* ==================================
            NOTIFICATIONS
        ================================== */}

        <div
          className="employee-header-actions"
          ref={
            dropdownRef
          }
        >

          <button
            type="button"
            className="employee-notification-button"
            onClick={
              handleBellClick
            }
            aria-label="Notifications"
            title="Notifications"
          >

            <FaBell />

            {unreadCount >
              0 && (

              <span className="employee-notification-badge">

                {unreadCount >
                99
                  ? "99+"
                  : unreadCount}

              </span>

            )}

          </button>

          {/* ==================================
              NOTIFICATION DROPDOWN
          ================================== */}

          {isOpen && (

            <div className="employee-notification-dropdown">

              <div className="employee-notification-dropdown-header">

                <div>

                  <h3>
                    Notifications
                  </h3>

                  <p>
                    {unreadCount}{" "}
                    unread
                  </p>

                </div>

                {unreadCount >
                  0 && (

                  <button
                    type="button"
                    className="employee-mark-all-button"
                    onClick={
                      markAllAsRead
                    }
                  >

                    <FaCheckDouble />

                    Mark all read

                  </button>

                )}

              </div>

              {desktopPermission === "default" && (

                <button
                  type="button"
                  className="employee-enable-desktop-notifications"
                  onClick={handleEnableDesktopNotifications}
                >
                  <FaDesktop /> Enable Desktop Notifications
                </button>

              )}

              <div className="employee-notification-list">

                {loading ? (

                  <div className="employee-notification-empty">

                    Loading
                    notifications...

                  </div>

                ) : notifications.length ===
                  0 ? (

                  <div className="employee-notification-empty">

                    <FaBell />

                    <h4>
                      No notifications
                    </h4>

                    <p>
                      You don't have
                      any notifications
                      yet.
                    </p>

                  </div>

                ) : (

                  notifications.map(
                    (
                      notification
                    ) => {
                      const isRead =
                        Boolean(
                          Number(
                            notification
                              .is_read
                          )
                        );

                      return (

                        <div
                          key={
                            notification.id
                          }
                          className={
                            isRead
                              ? "employee-notification-item"
                              : "employee-notification-item unread"
                          }
                        >

                          <button
                            type="button"
                            className="employee-notification-content"
                            onClick={() =>
                              markAsRead(
                                notification
                              )
                            }
                          >

                            <div className="employee-notification-item-top">

                              <h4>

                                {
                                  notification
                                    .title
                                }

                              </h4>

                              {!isRead && (

                                <span className="employee-notification-unread-dot" />

                              )}

                            </div>

                            <p>

                              {
                                notification
                                  .message
                              }

                            </p>

                            <span className="employee-notification-date">

                              {formatDate(
                                notification
                                  .created_at
                              )}

                            </span>

                          </button>

                          <button
                            type="button"
                            className="employee-notification-delete"
                            onClick={() =>
                              deleteNotification(
                                notification.id
                              )
                            }
                            aria-label="Delete notification"
                            title="Delete notification"
                          >

                            <FaTrash />

                          </button>

                        </div>

                      );
                    }
                  )

                )}

              </div>

            </div>

          )}

        </div>

        {/* ==================================
            EMPLOYEE PROFILE
        ================================== */}

        <div className="employee-header-profile">

          <EmployeeProfileAvatar />

          <div>

            <p>
              {user?.fullName ||
                "Employee"}
            </p>

          <span>
  {user?.designation || "Employee"}
</span>

          </div>

        </div>

        {/* ==================================
            LOGOUT
        ================================== */}

        <button
          type="button"
          className="employee-logout"
          onClick={
            handleLogout
          }
          title="Logout"
          aria-label="Logout"
        >

          <FaSignOutAlt />

        </button>

      </div>

    </header>
  );
}

export default EmployeeHeader;