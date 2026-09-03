import "./MobileNavBackdrop.css";

// Shared by EmployeeLayout and AdminLayout -- only ever mounted while
// the mobile/tablet drawer is open (see useMobileNav). A tap anywhere
// on it closes the drawer, matching the sidebar's own "hide" control
// and Escape.

function MobileNavBackdrop({ onClose }) {

    return (

        <div
            className="mobile-nav-backdrop"
            onClick={onClose}
            aria-hidden="true"
        />

    );

}

export default MobileNavBackdrop;
