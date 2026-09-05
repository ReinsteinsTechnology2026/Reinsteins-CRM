import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { FaChartPie, FaBuilding, FaCog, FaSignOutAlt, FaInbox, FaLayerGroup } from "react-icons/fa";
import { toast } from "react-toastify";

import "../../styles/platformTheme.css";
import "../../styles/platformComponents.css";
import "./PlatformLayout.css";

// ==========================================
// PLATFORM LAYOUT (Phase 4)
//
// Deliberately its own shell, not a reuse/extension of
// AdminLayout.jsx -- the Platform Owner Dashboard is a separate
// product surface (platform administration, not the tenant portal),
// so it gets its own navigation, its own branding, and its own
// visual identity (styles/platformTheme.css). Never linked from
// AdminSidebar/EmployeeSidebar -- reachable only via /platform/login.
// ==========================================

function PlatformLayout() {
  const navigate = useNavigate();

  const platformUserRaw = sessionStorage.getItem("platformUser");
  const platformUser = platformUserRaw ? JSON.parse(platformUserRaw) : null;

  const handleLogout = () => {
    sessionStorage.removeItem("platformToken");
    sessionStorage.removeItem("platformUser");
    toast.success("Logged out");
    navigate("/platform/login", { replace: true });
  };

  return (
    <div className="platform-shell platform-layout">

      <aside className="platform-sidebar">

        <div className="platform-sidebar-brand">
          <span className="platform-wordmark platform-wordmark-sm">
            Grow<span className="platform-wordmark-accent">Orgs</span>
          </span>
        </div>

        <nav className="platform-nav">
          <NavLink
            to="/platform/dashboard"
            className={({ isActive }) => `platform-nav-link${isActive ? " active" : ""}`}
          >
            <FaChartPie /> <span>Dashboard</span>
          </NavLink>

          <NavLink
            to="/platform/companies"
            className={({ isActive }) => `platform-nav-link${isActive ? " active" : ""}`}
          >
            <FaBuilding /> <span>Companies</span>
          </NavLink>

          <NavLink
            to="/platform/demo-requests"
            className={({ isActive }) => `platform-nav-link${isActive ? " active" : ""}`}
          >
            <FaInbox /> <span>Demo Requests</span>
          </NavLink>

          <NavLink
            to="/platform/plans"
            className={({ isActive }) => `platform-nav-link${isActive ? " active" : ""}`}
          >
            <FaLayerGroup /> <span>Plans</span>
          </NavLink>

          <NavLink
            to="/platform/settings"
            className={({ isActive }) => `platform-nav-link${isActive ? " active" : ""}`}
          >
            <FaCog /> <span>Settings</span>
          </NavLink>
        </nav>

        <div className="platform-sidebar-footer">
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
