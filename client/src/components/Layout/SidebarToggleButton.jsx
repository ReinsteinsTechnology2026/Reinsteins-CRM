import { FaChevronRight } from "react-icons/fa";

import "./SidebarToggleButton.css";

// ==========================================
// SIDEBAR TOGGLE BUTTON — REOPEN CONTROL
//
// The Layout only mounts this while the sidebar is collapsed (see
// AdminLayout.jsx / EmployeeLayout.jsx), so it is always the "show
// sidebar" arrow — a small, fixed control near the left edge of the
// page. The "hide sidebar" control lives inside the sidebar itself
// now, beside the Dashboard nav item, since the sidebar is visible
// (not width:0/overflow:hidden) whenever that one would need to
// show.
// ==========================================

function SidebarToggleButton({ onToggle }) {

    return (

        <button
            type="button"
            className="sidebar-toggle-button"
            onClick={onToggle}
            aria-label="Show sidebar"
            title="Show sidebar"
        >
            <FaChevronRight />
        </button>

    );

}

export default SidebarToggleButton;
