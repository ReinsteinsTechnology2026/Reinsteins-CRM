import "./EmployeeSidebar.css";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";

import {
  FaHome,
  FaCalendarCheck,
  FaCalendarWeek,
  FaTasks,
  FaCalendarAlt,
  FaUser,
  FaComments,
  FaEnvelope,
  FaVideo,
  FaCog,
  FaChevronLeft,
  FaUsers,
  FaUserTie,
  FaClipboardCheck,
  FaProjectDiagram,
  FaSitemap,
  FaChartBar,
} from "react-icons/fa";
import CompanyLogo from "../Common/CompanyLogo";
import api from "../../services/api";

import socket, {
  connectSocket,
} from "../../services/socket";

import { isExecutiveDashboardUser } from "../../utils/executiveAccess";
import { hasProjectAccess } from "../../utils/projectAccess";

function EmployeeSidebar({ collapsed, onToggle, mobileNavOpen, onMobileNavClose }) {
  const navigate =
    useNavigate();

  // Phase 8 fix: every menu path below previously hardcoded the
  // legacy basePath prefix, breaking in-app navigation for
  // company-aware tenant users (see AdminSidebar.jsx for the same
  // fix and full reasoning).
  const { companySlug } = useParams();
  const basePath = companySlug ? `/${companySlug}/employee` : "/employee";

  // ==========================================
  // MOBILE/TABLET DRAWER — FOCUS ON OPEN
  //
  // Lightweight focus handling (no focus-trap
  // library): move focus into the drawer itself
  // when it opens, so keyboard/AT users land
  // somewhere sensible instead of it silently
  // sliding in behind them. Returning focus to
  // the hamburger button on close is handled by
  // EmployeeHeader itself.
  // ==========================================

  const sidebarRef = useRef(null);
  const wasMobileNavOpen = useRef(mobileNavOpen);

  useEffect(() => {

    if (!wasMobileNavOpen.current && mobileNavOpen) {
      sidebarRef.current?.focus();
    }

    wasMobileNavOpen.current = mobileNavOpen;

  }, [mobileNavOpen]);

  // Every nav click closes the mobile/tablet drawer (no-op on
  // desktop, where it's already closed) in addition to navigating.
  const handleNavigate = useCallback(
    (path) => {
      navigate(path);
      onMobileNavClose?.();
    },
    [navigate, onMobileNavClose]
  );

  // ==========================================
  // CURRENT USER'S SYSTEM ACCESS
  // Only used to decide whether the management-
  // facing nav items (My Team, Team Leave
  // Approvals) are shown — actual authorization
  // is always re-checked server-side regardless
  // of what this shows. Anyone can still see
  // "My Reporting Manager" — that's their own
  // relationship, not a management capability.
  // ==========================================

  const currentUser = (() => {
    try {
      return JSON.parse(sessionStorage.getItem("user"));
    } catch {
      return null;
    }
  })();

  const hasTeamVisibility = [
    "super_admin",
    "admin",
    "executive",
    "hr",
    "department_head",
    "manager",
    "team_lead",
  ].includes(currentUser?.systemAccess);

  // ==========================================
  // EXECUTIVE DASHBOARD NAVIGATION
  // Founder/Chairman (by designation — see
  // executiveAccess.js) get a distinct nav set
  // built around company oversight instead of
  // the personal attendance/task workflow.
  // Nothing here removes those features globally
  // — every other user type still sees the
  // normal menu below unchanged.
  // ==========================================

  const isExecutive = isExecutiveDashboardUser(currentUser);

  // Founder/Chairman already get Projects via their own executive
  // menu below — this only applies to the standard menu, so the
  // sidebar never shows two separate "Projects" entries for the
  // same user.

  const showProjectsNavItem =
    !isExecutive && hasProjectAccess(currentUser);

  const location =
    useLocation();

  const [
    unreadChatCount,
    setUnreadChatCount,
  ] = useState(0);

  // ==========================================
  // GET TOTAL UNREAD CHAT COUNT
  // ==========================================

  const fetchUnreadChatCount =
    useCallback(
      async () => {
        try {
          const response =
            await api.get(
              "/chat/conversations"
            );

          const conversations =
            response.data
              ?.conversations ||
            response.data ||
            [];

          if (
            !Array.isArray(
              conversations
            )
          ) {
            setUnreadChatCount(
              0
            );

            return;
          }

          const totalUnread =
            conversations.reduce(
              (
                total,
                conversation
              ) => {
                return (
                  total +
                  Number(
                    conversation
                      .unread_count ||
                    conversation
                      .unreadCount ||
                    0
                  )
                );
              },
              0
            );

          setUnreadChatCount(
            totalUnread
          );

        } catch (error) {
          console.error(
            "Failed to fetch unread chat count:",
            error
          );
        }
      },
      []
    );

  // ==========================================
  // SOCKET.IO + UNREAD COUNT
  // ==========================================

  useEffect(() => {
    // Initial unread count

    fetchUnreadChatCount();

    // Make sure authenticated
    // Socket.IO connection is active.

    connectSocket();

    // ========================================
    // NEW MESSAGE
    // ========================================

    const handleNewMessage =
      () => {
        fetchUnreadChatCount();
      };

    // ========================================
    // CONVERSATION UPDATED
    // ========================================

    const handleConversationUpdated =
      () => {
        fetchUnreadChatCount();
      };

    // ========================================
    // SOCKET RECONNECTED
    // ========================================

    const handleSocketConnect =
      () => {
        fetchUnreadChatCount();
      };

    socket.on(
      "message:new",
      handleNewMessage
    );

    socket.on(
      "conversation:updated",
      handleConversationUpdated
    );

    socket.on(
      "connect",
      handleSocketConnect
    );

    // ========================================
    // FALLBACK POLLING
    //
    // Socket.IO should update instantly.
    // This is kept as a safety fallback.
    // ========================================

    const interval =
      setInterval(
        fetchUnreadChatCount,
        30000
      );

    // ========================================
    // CLEANUP
    // ========================================

    return () => {
      socket.off(
        "message:new",
        handleNewMessage
      );

      socket.off(
        "conversation:updated",
        handleConversationUpdated
      );

      socket.off(
        "connect",
        handleSocketConnect
      );

      clearInterval(
        interval
      );
    };
  }, [
    fetchUnreadChatCount,
  ]);

  // ==========================================
  // REFRESH COUNT WHEN PAGE CHANGES
  //
  // Important when employee reads messages
  // and moves between pages.
  // ==========================================

  useEffect(() => {
    fetchUnreadChatCount();
  }, [
    location.pathname,
    fetchUnreadChatCount,
  ]);

  // ==========================================
  // MENU ITEMS
  // ==========================================

  // Executive (Founder/Chairman) menu is a distinct, self-contained
  // list — no attendance clock-in, no personal task/leave workflow.
  // Chat/Meetings/My Profile/Settings still point at the exact same
  // existing routes everyone else uses.

  const executiveMenuItems = [
    {
      name: "Dashboard",
      icon: <FaHome />,
      path: basePath,
    },
    {
      name: "Projects",
      icon: <FaProjectDiagram />,
      path: `${basePath}/projects`,
    },
    {
      name: "Organization",
      icon: <FaSitemap />,
      path: `${basePath}/organization`,
    },
    {
      name: "Reports",
      icon: <FaChartBar />,
      path: `${basePath}/reports`,
    },
    {
      name: "Approvals",
      icon: <FaClipboardCheck />,
      path: `${basePath}/team/leave-approvals`,
    },
    {
      name: "Chat",
      icon: <FaComments />,
      path: `${basePath}/chat`,
      showBadge: true,
    },
    {
      name: "Email",
      icon: <FaEnvelope />,
      path: `${basePath}/email`,
    },
    {
      name: "Meetings",
      icon: <FaVideo />,
      path: `${basePath}/meetings`,
    },
    {
      name: "My Profile",
      icon: <FaUser />,
      path: `${basePath}/profile`,
    },
    {
      name: "Settings",
      icon: <FaCog />,
      path: `${basePath}/settings`,
    },
  ];

  const standardMenuItems = [
    {
      name: "Dashboard",
      icon: <FaHome />,
      path: basePath,
    },
    {
      name: "Attendance",
      icon: <FaCalendarCheck />,
      path:
        `${basePath}/attendance`,
    },
    {
      name: "Shift Schedule",
      icon: <FaCalendarWeek />,
      path:
        `${basePath}/shift-schedule`,
    },
    {
      name: "My Tasks",
      icon: <FaTasks />,
      path:
        `${basePath}/tasks`,
    },
    ...(showProjectsNavItem
      ? [
          {
            name: "Projects",
            icon: <FaProjectDiagram />,
            path: `${basePath}/projects`,
          },
        ]
      : []),
    {
      name: "My Leave",
      icon: <FaCalendarAlt />,
      path:
        `${basePath}/leave`,
    },
    {
      name: "My Reporting Manager",
      icon: <FaUserTie />,
      path:
        `${basePath}/reporting-manager`,
    },
    ...(hasTeamVisibility
      ? [
          {
            name: "My Team",
            icon: <FaUsers />,
            path: `${basePath}/team`,
          },
          {
            name: "Team Leave Approvals",
            icon: <FaClipboardCheck />,
            path: `${basePath}/team/leave-approvals`,
          },
        ]
      : []),
    {
      name: "My Profile",
      icon: <FaUser />,
      path:
        `${basePath}/profile`,
    },
    {
      name: "Chat",
      icon: <FaComments />,
      path:
        `${basePath}/chat`,
      showBadge: true,
    },
    {
      name: "Email",
      icon: <FaEnvelope />,
      path:
        `${basePath}/email`,
    },
    {
      name: "Meetings",
      icon: <FaVideo />,
      path:
        `${basePath}/meetings`,
    },
    {
      name: "Settings",
      icon: <FaCog />,
      path:
        `${basePath}/settings`,
    },
  ];

  const menuItems = isExecutive
    ? executiveMenuItems
    : standardMenuItems;

  // ==========================================
  // CHECK ACTIVE PAGE
  // ==========================================

  const isActive = (
    path
  ) => {
    if (
      path ===
      basePath
    ) {
      return (
        location.pathname ===
        basePath
      );
    }

    return location.pathname.startsWith(
      path
    );
  };

  const sidebarClassName = [
    "employee-sidebar",
    collapsed ? "collapsed" : "",
    mobileNavOpen ? "mobile-open" : "",
  ].filter(Boolean).join(" ");

  return (
    <aside
      id="employee-mobile-sidebar"
      ref={sidebarRef}
      tabIndex={-1}
      className={sidebarClassName}
    >

      {/* ======================================
          BRAND
      ====================================== */}

      <div className="employee-sidebar-brand">

       <div className="sidebar-logo">

  <CompanyLogo size={46} />

</div>

        <div>

          <h2>
            Reinsteins
          </h2>

          <span>
            WorkHub
          </span>

        </div>

      </div>

      {/* ======================================
          NAVIGATION
      ====================================== */}

      <nav className="employee-sidebar-navigation">

        {/* DASHBOARD (+ inline sidebar collapse arrow, same row) */}

        <div className="sidebar-item-row">

          <button
            type="button"
            className={
              isActive(
                menuItems[0].path
              )
                ? "employee-sidebar-item active"
                : "employee-sidebar-item"
            }
            onClick={() =>
              handleNavigate(
                menuItems[0].path
              )
            }
          >

            <span className="employee-sidebar-menu-icon">
              {
                menuItems[0].icon
              }
            </span>

            <span className="employee-sidebar-menu-name">
              {
                menuItems[0].name
              }
            </span>

          </button>

          <button
            type="button"
            className="sidebar-collapse-inline-button"
            onClick={onToggle}
            aria-label="Hide sidebar"
            title="Hide sidebar"
          >
            <FaChevronLeft />
          </button>

        </div>

        {menuItems.slice(1).map(
          (item) => (

            <button
              type="button"
              key={
                item.path
              }
              className={
                isActive(
                  item.path
                )
                  ? "employee-sidebar-item active"
                  : "employee-sidebar-item"
              }
              onClick={() =>
                handleNavigate(
                  item.path
                )
              }
            >

              <span className="employee-sidebar-menu-icon">
                {
                  item.icon
                }
              </span>

              <span className="employee-sidebar-menu-name">
                {
                  item.name
                }
              </span>

              {item.showBadge &&
                unreadChatCount >
                  0 && (

                <span className="employee-chat-unread-badge">
                  {
                    unreadChatCount >
                    99
                      ? "99+"
                      : unreadChatCount
                  }
                </span>

              )}

            </button>

          )
        )}

      </nav>

    </aside>
  );
}

export default EmployeeSidebar;