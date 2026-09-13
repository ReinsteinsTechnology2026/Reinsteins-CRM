import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  FaChartPie, FaBuilding, FaCog, FaSignOutAlt, FaInbox, FaLayerGroup,
  FaCreditCard, FaUsers, FaChartLine, FaLifeRing, FaBell, FaClipboardList, FaEnvelope,
} from "react-icons/fa";
import { toast } from "react-toastify";

import platformApi from "../../services/platformApi";
import "../../styles/platformTheme.css";
import "../../styles/platformComponents.css";
import "./PlatformLayout.css";

// ==========================================
// PLATFORM LAYOUT
//
// Deliberately its own shell, not a reuse/extension of
// AdminLayout.jsx -- the Platform Owner Dashboard is a separate
// product surface (platform administration, not the tenant portal),
// so it gets its own navigation, its own branding, and its own
// visual identity (styles/platformTheme.css). Never linked from
// AdminSidebar/EmployeeSidebar -- reachable only via /owner/login.
//
// NOTIFICATION BELL (Phase 12N): backed by the real, durable
// platform_notifications table -- GET /notifications,
// GET /notifications/unread-count, PATCH /:id/read, PATCH /read-all.
// Replaces the earlier version of this bell, which derived "unread"
// from a sessionStorage count comparison against the Dashboard's
// attentionRequired payload (documented then as a stopgap for "no
// notifications table exists yet" -- Phase 12 adds one, so this now
// reads real per-notification read state that survives logout/reload/
// a different device, exactly what durable storage means here). Still
// deliberately does NOT poll in real time -- refreshes once per page
// load plus whenever the panel is opened or an item is marked read,
// matching "do not add unnecessary real-time infrastructure".
// ==========================================

function PlatformLayout() {
  const navigate = useNavigate();

  const platformUserRaw = sessionStorage.getItem("platformUser");
  const platformUser = platformUserRaw ? JSON.parse(platformUserRaw) : null;

  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showPanel, setShowPanel] = useState(false);

  const loadNotifications = () => {
    platformApi.get("/notifications").then((response) => setNotifications(response.data.notifications || [])).catch(() => {});
    platformApi.get("/notifications/unread-count").then((response) => setUnreadCount(response.data.count || 0)).catch(() => {});
  };

  useEffect(() => { loadNotifications(); }, []);

  const handleOpenPanel = () => {
    setShowPanel((v) => {
      if (!v) loadNotifications();
      return !v;
    });
  };

  const handleItemClick = async (notification) => {
    setShowPanel(false);
    if (!notification.isRead) {
      try { await platformApi.patch(`/notifications/${notification.id}/read`); } catch { /* non-fatal */ }
    }
    if (notification.companyId) navigate(`/owner/companies/${notification.companyId}`);
    loadNotifications();
  };

  const markAllRead = async () => {
    try { await platformApi.patch("/notifications/read-all"); } catch { /* non-fatal */ }
    loadNotifications();
  };

  const handleLogout = () => {
    sessionStorage.removeItem("platformToken");
    sessionStorage.removeItem("platformUser");
    toast.success("Logged out");
    navigate("/owner/login", { replace: true });
  };

  return (
    <div className="platform-shell platform-layout">

      <aside className="platform-sidebar">

        <div className="platform-sidebar-brand">
          <span className="platform-wordmark platform-wordmark-sm">
            <span className="brand-zio">Zio</span><span className="brand-venture">Venture</span>
          </span>
        </div>

        <nav className="platform-nav">
          <NavLink
            to="/owner/dashboard"
            className={({ isActive }) => `platform-nav-link${isActive ? " active" : ""}`}
          >
            <FaChartPie /> <span>Dashboard</span>
          </NavLink>

          <NavLink
            to="/owner/companies"
            className={({ isActive }) => `platform-nav-link${isActive ? " active" : ""}`}
          >
            <FaBuilding /> <span>Companies</span>
          </NavLink>

          <NavLink
            to="/owner/demo-requests"
            className={({ isActive }) => `platform-nav-link${isActive ? " active" : ""}`}
          >
            <FaInbox /> <span>Demo Requests</span>
          </NavLink>

          <NavLink
            to="/owner/plans"
            className={({ isActive }) => `platform-nav-link${isActive ? " active" : ""}`}
          >
            <FaLayerGroup /> <span>Subscriptions</span>
          </NavLink>

          <NavLink
            to="/owner/payments"
            className={({ isActive }) => `platform-nav-link${isActive ? " active" : ""}`}
          >
            <FaCreditCard /> <span>Payments</span>
          </NavLink>

          <NavLink
            to="/owner/users"
            className={({ isActive }) => `platform-nav-link${isActive ? " active" : ""}`}
          >
            <FaUsers /> <span>Users</span>
          </NavLink>

          <NavLink
            to="/owner/analytics"
            className={({ isActive }) => `platform-nav-link${isActive ? " active" : ""}`}
          >
            <FaChartLine /> <span>Analytics</span>
          </NavLink>

          <NavLink
            to="/owner/audit-logs"
            className={({ isActive }) => `platform-nav-link${isActive ? " active" : ""}`}
          >
            <FaClipboardList /> <span>Audit Logs</span>
          </NavLink>

          <NavLink
            to="/owner/email-logs"
            className={({ isActive }) => `platform-nav-link${isActive ? " active" : ""}`}
          >
            <FaEnvelope /> <span>Email Logs</span>
          </NavLink>

          <NavLink
            to="/owner/support"
            className={({ isActive }) => `platform-nav-link${isActive ? " active" : ""}`}
          >
            <FaLifeRing /> <span>Support</span>
          </NavLink>

          <NavLink
            to="/owner/settings"
            className={({ isActive }) => `platform-nav-link${isActive ? " active" : ""}`}
          >
            <FaCog /> <span>Platform Settings</span>
          </NavLink>
        </nav>

        <div className="platform-sidebar-footer">

          <div style={{ position: "relative" }}>
            <button
              className="platform-logout-button"
              onClick={handleOpenPanel}
              aria-label="Notifications"
            >
              <FaBell /> <span>Notifications</span>
              {unreadCount > 0 && <span className="platform-notif-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>}
            </button>

            {showPanel && (
              <div className="platform-notif-panel">
                <div className="platform-notif-panel-header">
                  <strong>Notifications</strong>
                  {unreadCount > 0 && (
                    <button onClick={markAllRead} className="platform-notif-mark-read">Mark all as read</button>
                  )}
                </div>
                {notifications.length === 0 && (
                  <div className="platform-notif-empty">Nothing needs your attention right now.</div>
                )}
                {notifications.map((n) => (
                  <div
                    key={n.id}
                    className="platform-notif-item"
                    style={{ fontWeight: n.isRead ? 400 : 600 }}
                    onClick={() => handleItemClick(n)}
                  >
                    {n.title}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="platform-owner-badge">
            <div className="platform-owner-avatar">
              {platformUser?.name?.charAt(0)?.toUpperCase() || "P"}
            </div>
            <div className="platform-owner-meta">
              <span className="platform-owner-name">{platformUser?.name || "Platform Owner"}</span>
              <span className="platform-owner-email">{platformUser?.email || ""}</span>
            </div>
          </div>

          <button className="platform-logout-button" onClick={handleLogout}>
            <FaSignOutAlt /> <span>Logout</span>
          </button>
        </div>

      </aside>

      <main className="platform-main">
        <Outlet />
      </main>

    </div>
  );
}

export default PlatformLayout;
