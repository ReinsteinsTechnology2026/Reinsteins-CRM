import { Outlet } from "react-router-dom";

import AdminSidebar from "./AdminSidebar";
import AdminHeader from "./AdminHeader";
import SidebarToggleButton from "./SidebarToggleButton";
import MobileNavBackdrop from "./MobileNavBackdrop";

import useSidebarCollapsed from "../../hooks/useSidebarCollapsed";
import useMobileNav from "../../hooks/useMobileNav";

import "./AdminLayout.css";

function AdminLayout() {

    // Lives here (the shared layout), not per-page, so every admin
    // route reacts to the same toggle without its own logic. This
    // component itself never unmounts across route changes — only
    // <Outlet/>'s child does — so collapsing while inside a page
    // (e.g. a live meeting) and navigating away never touches that
    // page's own state.

    const [sidebarCollapsed, toggleSidebar] = useSidebarCollapsed();

    // Independent from sidebarCollapsed above -- the desktop collapse
    // preference and the mobile/tablet drawer never share state.
    const [mobileNavOpen, { openMobileNav, closeMobileNav }] = useMobileNav();

    return (

        <div className="admin-layout">

            <AdminSidebar
                collapsed={sidebarCollapsed}
                onToggle={toggleSidebar}
                mobileNavOpen={mobileNavOpen}
                onMobileNavClose={closeMobileNav}
            />

            {mobileNavOpen && (
                <MobileNavBackdrop onClose={closeMobileNav} />
            )}

            {sidebarCollapsed && (
                <SidebarToggleButton onToggle={toggleSidebar} />
            )}

            <main className={sidebarCollapsed ? "admin-main sidebar-collapsed" : "admin-main"}>

                <AdminHeader
                    mobileNavOpen={mobileNavOpen}
                    onOpenMobileNav={openMobileNav}
                />

                <div className="admin-page-content">

                    <Outlet />

                </div>

            </main>

        </div>

    );

}

export default AdminLayout;