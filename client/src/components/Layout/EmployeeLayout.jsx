import { Outlet } from "react-router-dom";

import EmployeeSidebar from "./EmployeeSidebar";
import EmployeeHeader from "./EmployeeHeader";
import SidebarToggleButton from "./SidebarToggleButton";
import MobileNavBackdrop from "./MobileNavBackdrop";

import useSidebarCollapsed from "../../hooks/useSidebarCollapsed";
import useMobileNav from "../../hooks/useMobileNav";

import "./EmployeeLayout.css";

function EmployeeLayout() {

    // Lives here (the shared layout), not per-page, so every
    // employee route reacts to the same toggle without its own
    // logic. This component itself never unmounts across route
    // changes — only <Outlet/>'s child does — so collapsing while
    // inside a page (e.g. a live meeting) and navigating away never
    // touches that page's own state.

    const [sidebarCollapsed, toggleSidebar] = useSidebarCollapsed();

    // Independent from sidebarCollapsed above -- the desktop collapse
    // preference and the mobile/tablet drawer never share state.
    const [mobileNavOpen, { openMobileNav, closeMobileNav }] = useMobileNav();

    return (

        <div className="employee-layout">

            <EmployeeSidebar
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

            <main className={sidebarCollapsed ? "employee-main sidebar-collapsed" : "employee-main"}>

                <EmployeeHeader
                    mobileNavOpen={mobileNavOpen}
                    onOpenMobileNav={openMobileNav}
                />

                <div className="employee-page-content">

                    <Outlet />

                </div>

            </main>

        </div>

    );

}

export default EmployeeLayout;