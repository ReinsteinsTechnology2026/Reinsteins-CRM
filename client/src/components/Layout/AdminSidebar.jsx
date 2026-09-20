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
import CompanyLogo from "../Common/CompanyLogo";
import {
  FaChartPie,
  FaUsers,
  FaCalendarCheck,
  FaCalendarWeek,
  FaBook,
  FaTasks,
  FaCalendarAlt,
  FaChartBar,
  FaComments,
  FaVideo,
  FaCog,
  FaSitemap,
  FaBuilding,
  FaChevronLeft,
  FaChevronDown,
  FaChevronRight,
} from "react-icons/fa";

import api from "../../services/api";

import socket, {
  connectSocket,
} from "../../services/socket";

import "./AdminSidebar.css";

function AdminSidebar({ collapsed, onToggle, mobileNavOpen, onMobileNavClose }) {
  const navigate =
    useNavigate();

  const location =
    useLocation();

  // Phase 8 fix: every nav target below previously hardcoded the
  // legacy "/admin" prefix, even though this same component is also
  // rendered under the company-aware "/:companySlug/admin" route
  // tree (see App.jsx buildRoleRoutes()). That meant a tenant user
  // clicking any sidebar item was sent to the unprefixed legacy
  // route, which ProtectedRoute treats as a Reinsteins-only path and
  // bounces to /legacy-login -- effectively breaking every in-app
  // navigation for non-Reinsteins tenants. basePath restores the
  // company prefix when present; Reinsteins (no companySlug) is
  // completely unaffected.
  const { companySlug } = useParams();
  const basePath = companySlug ? `/${companySlug}/admin` : "/admin";

  // ==========================================
  // MOBILE/TABLET DRAWER — FOCUS ON OPEN
  //
  // Lightweight focus handling (no focus-trap
  // library): move focus into the drawer itself
  // when it opens. Returning focus to the
  // hamburger button on close is handled by
  // AdminHeader itself.
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
            "Failed to fetch admin unread chat count:",
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
    // Load unread messages initially

    fetchUnreadChatCount();

    // Make sure authenticated
    // Socket.IO connection is active

    connectSocket();

    // ========================================
    // NEW MESSAGE EVENT
    // ========================================

    const handleNewMessage =
      () => {
        fetchUnreadChatCount();
      };

    // ========================================
    // CONVERSATION UPDATED EVENT
    // ========================================

    const handleConversationUpdated =
      () => {
        fetchUnreadChatCount();
      };

    // ========================================
    // SOCKET CONNECT / RECONNECT
    // ========================================

    const handleSocketConnect =
      () => {
        fetchUnreadChatCount();
      };

    // ========================================
    // LISTEN FOR SOCKET EVENTS
    // ========================================

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
    // Socket.IO updates instantly.
    // This checks every 30 seconds as backup.
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
  // REFRESH UNREAD COUNT WHEN PAGE CHANGES
  // ==========================================

  useEffect(() => {
    fetchUnreadChatCount();
  }, [
    location.pathname,
    fetchUnreadChatCount,
  ]);

  // ==========================================
  // CHECK ACTIVE PAGE
  // ==========================================

  const isActive = (
    path
  ) => {
    if (
      path === basePath
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

  // ==========================================
  // ORGANIZATION SECTION (Org Chart / Departments /
  // Designations) -- expandable, seeded open if the
  // user is already somewhere under /admin/organization
  // so the right sub-item highlights on load; free to
  // toggle afterward.
  // ==========================================

  const [organizationExpanded, setOrganizationExpanded] = useState(
    () =>
      location.pathname === `${basePath}/organization` ||
      location.pathname.startsWith(`${basePath}/organization/`)
  );

  const sidebarClassName = [
    "admin-sidebar",
    collapsed ? "collapsed" : "",
    mobileNavOpen ? "mobile-open" : "",
  ].filter(Boolean).join(" ");

  return (
    <aside
      id="admin-mobile-sidebar"
      ref={sidebarRef}
      tabIndex={-1}
      className={sidebarClassName}
    >

      {/* ======================================
          BRAND
      ====================================== */}

      <div className="sidebar-brand">

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

      <nav className="sidebar-navigation">

        {/* DASHBOARD (+ inline sidebar collapse arrow, same row) */}

        <div className="sidebar-item-row">

          <button
            type="button"
            className={`sidebar-item ${
              isActive(
                basePath
              )
                ? "active"
                : ""
            }`}
            onClick={() =>
              handleNavigate(
                basePath
              )
            }
          >
            <FaChartPie />

            <span className="admin-sidebar-menu-name">
              Dashboard
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

        {/* TECHOPS -- opens Projects directly. Labeled "TechOps" to
            stay visually and conceptually distinct from
            "Organization" below, which is the unrelated internal
            company-structure area (Org Chart / Departments /
            Designations). */}

        <button
          type="button"
          className={`sidebar-item ${
            isActive(
              `${basePath}/projects`
            )
              ? "active"
              : ""
          }`}
          onClick={() =>
            handleNavigate(
              `${basePath}/projects`
            )
          }
        >
          <FaBuilding />

          <span className="admin-sidebar-menu-name">
            TechOps
          </span>
        </button>

        {/* TASKS */}

        <button
          type="button"
          className={`sidebar-item ${
            isActive(
              `${basePath}/tasks`
            )
              ? "active"
              : ""
          }`}
          onClick={() =>
            handleNavigate(
              `${basePath}/tasks`
            )
          }
        >
          <FaTasks />

          <span className="admin-sidebar-menu-name">
            Tasks
          </span>
        </button>

        {/* EMPLOYEES */}

        <button
          type="button"
          className={`sidebar-item ${
            isActive(
              `${basePath}/employees`
            )
              ? "active"
              : ""
          }`}
          onClick={() =>
            handleNavigate(
              `${basePath}/employees`
            )
          }
        >
          <FaUsers />

          <span className="admin-sidebar-menu-name">
            Employees
          </span>
        </button>

        {/* ATTENDANCE */}

        <button
          type="button"
          className={`sidebar-item ${
            isActive(
              `${basePath}/attendance`
            )
              ? "active"
              : ""
          }`}
          onClick={() =>
            handleNavigate(
              `${basePath}/attendance`
            )
          }
        >
          <FaCalendarCheck />

          <span className="admin-sidebar-menu-name">
            Attendance
          </span>
        </button>

        {/* SHIFT MANAGEMENT */}

        <button
          type="button"
          className={`sidebar-item ${
            isActive(
              `${basePath}/shift-management`
            )
              ? "active"
              : ""
          }`}
          onClick={() =>
            handleNavigate(
              `${basePath}/shift-management`
            )
          }
        >
          <FaCalendarWeek />

          <span className="admin-sidebar-menu-name">
            Shift Management
          </span>
        </button>

        {/* SOP LIBRARY */}

        <button
          type="button"
          className={`sidebar-item ${
            isActive(
              `${basePath}/sops`
            )
              ? "active"
              : ""
          }`}
          onClick={() =>
            handleNavigate(
              `${basePath}/sops`
            )
          }
        >
          <FaBook />

          <span className="admin-sidebar-menu-name">
            SOPs
          </span>
        </button>

        {/* LEAVE MANAGEMENT */}

        <button
          type="button"
          className={`sidebar-item ${
            isActive(
              `${basePath}/leave`
            )
              ? "active"
              : ""
          }`}
          onClick={() =>
            handleNavigate(
              `${basePath}/leave`
            )
          }
        >
          <FaCalendarAlt />

          <span className="admin-sidebar-menu-name">
            Leave Management
          </span>
        </button>

        {/* REPORTS */}

        <button
          type="button"
          className={`sidebar-item ${
            isActive(
              `${basePath}/reports`
            )
              ? "active"
              : ""
          }`}
          onClick={() =>
            handleNavigate(
              `${basePath}/reports`
            )
          }
        >
          <FaChartBar />

          <span className="admin-sidebar-menu-name">
            Reports
          </span>
        </button>

        {/* CHAT */}

        <button
          type="button"
          className={`sidebar-item ${
            isActive(
              `${basePath}/chat`
            )
              ? "active"
              : ""
          }`}
          onClick={() =>
            handleNavigate(
              `${basePath}/chat`
            )
          }
        >
          <FaComments />

          <span className="admin-sidebar-menu-name">
            Chat
          </span>

          {unreadChatCount >
            0 && (

            <span className="admin-chat-unread-badge">
              {
                unreadChatCount >
                99
                  ? "99+"
                  : unreadChatCount
              }
            </span>

          )}

        </button>

        {/* MEETINGS */}

        <button
          type="button"
          className={`sidebar-item ${
            isActive(
              `${basePath}/meetings`
            )
              ? "active"
              : ""
          }`}
          onClick={() =>
            handleNavigate(
              `${basePath}/meetings`
            )
          }
        >
          <FaVideo />

          <span className="admin-sidebar-menu-name">
            Meetings
          </span>
        </button>

        {/* ORGANIZATION -- internal company structure (Org
            Chart / Departments / Designations). Distinct from
            TechOps above. Expandable: the parent button only
            toggles the sub-list; each sub-item deep-links to
            its own tab on the SAME existing Organization page
            (client/src/pages/Admin/Organization.jsx) -- no new
            page, no duplicated logic. */}

        <button
          type="button"
          className={`sidebar-item ${
            // Deliberately NOT the shared isActive() helper here --
            // isActive() does a startsWith() match, and
            // "/admin/organizations" (TechOps, plural) starts with
            // "/admin/organization" (this item, singular), which
            // would falsely highlight this button while on the
            // TechOps page. This explicit check requires an exact
            // match or a "/" boundary right after "organization",
            // so the plural route never matches.
            location.pathname === `${basePath}/organization` ||
            location.pathname.startsWith(`${basePath}/organization/`)
              ? "active"
              : ""
          }`}
          onClick={() =>
            setOrganizationExpanded(
              (prev) => !prev
            )
          }
        >
          <FaSitemap />

          <span className="admin-sidebar-menu-name">
            Organization
          </span>

          {organizationExpanded ? (
            <FaChevronDown className="sidebar-expand-caret" />
          ) : (
            <FaChevronRight className="sidebar-expand-caret" />
          )}
        </button>

        {organizationExpanded && (

          <div className="sidebar-subitems">

            <button
              type="button"
              className={`sidebar-subitem ${
                isActive(`${basePath}/organization/org-chart`)
                  ? "active"
                  : ""
              }`}
              onClick={() =>
                handleNavigate(`${basePath}/organization/org-chart`)
              }
            >
              <span className="admin-sidebar-menu-name">
                Org Chart
              </span>
            </button>

            <button
              type="button"
              className={`sidebar-subitem ${
                isActive(`${basePath}/organization/departments`)
                  ? "active"
                  : ""
              }`}
              onClick={() =>
                handleNavigate(`${basePath}/organization/departments`)
              }
            >
              <span className="admin-sidebar-menu-name">
                Departments
              </span>
            </button>

            <button
              type="button"
              className={`sidebar-subitem ${
                isActive(`${basePath}/organization/designations`)
                  ? "active"
                  : ""
              }`}
              onClick={() =>
                handleNavigate(`${basePath}/organization/designations`)
              }
            >
              <span className="admin-sidebar-menu-name">
                Designations
              </span>
            </button>

          </div>

        )}

        {/* SETTINGS */}

        <button
          type="button"
          className={`sidebar-item ${
            isActive(
              `${basePath}/settings`
            )
              ? "active"
              : ""
          }`}
          onClick={() =>
            handleNavigate(
              `${basePath}/settings`
            )
          }
        >
          <FaCog />

          <span className="admin-sidebar-menu-name">
            Settings
          </span>
        </button>

      </nav>

      {/* ======================================
          FOOTER
      ====================================== */}

      <div className="sidebar-footer">

        <p>
          Reinsteins Technology
        </p>

        <span>
          Admin Workspace
        </span>

      </div>

    </aside>
  );
}

export default AdminSidebar;
