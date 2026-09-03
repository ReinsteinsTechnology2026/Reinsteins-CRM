import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

// Kept as a separate hook from useSidebarCollapsed on purpose -- the
// desktop collapse preference (persisted, manual) and the mobile/
// tablet drawer open/closed state (transient, viewport-driven) are
// unrelated concerns that must never influence each other.

const MOBILE_BREAKPOINT_QUERY = "(max-width: 1023px)";

function useMobileNav() {

    const [mobileNavOpen, setMobileNavOpen] = useState(false);

    const location = useLocation();
    const previousPathname = useRef(location.pathname);

    const openMobileNav = useCallback(() => setMobileNavOpen(true), []);
    const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);

    // Route change closes the drawer -- a safety net alongside the
    // explicit close() every nav item's own click handler already
    // calls, so any navigation that reaches this layout (including
    // ones not triggered through a sidebar item) never leaves the
    // drawer open over a different page.
    useEffect(() => {

        if (location.pathname !== previousPathname.current) {
            previousPathname.current = location.pathname;
            setMobileNavOpen(false);
        }

    }, [location.pathname]);

    // Escape closes the drawer.
    useEffect(() => {

        if (!mobileNavOpen) {
            return;
        }

        const handleKeyDown = (event) => {
            if (event.key === "Escape") {
                setMobileNavOpen(false);
            }
        };

        document.addEventListener("keydown", handleKeyDown);

        return () => document.removeEventListener("keydown", handleKeyDown);

    }, [mobileNavOpen]);

    // Lock background scrolling while the drawer is open; restored
    // automatically on close (including via unmount/navigation).
    useEffect(() => {

        if (!mobileNavOpen) {
            return;
        }

        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";

        return () => {
            document.body.style.overflow = previousOverflow;
        };

    }, [mobileNavOpen]);

    // If the viewport grows past the drawer breakpoint while it's
    // open (e.g. a tablet rotation or a resized window), close it --
    // desktop never shows a drawer/backdrop, so this state should
    // never survive into that mode.
    useEffect(() => {

        const mediaQuery = window.matchMedia(MOBILE_BREAKPOINT_QUERY);

        const handleChange = (event) => {
            if (!event.matches) {
                setMobileNavOpen(false);
            }
        };

        mediaQuery.addEventListener("change", handleChange);

        return () => mediaQuery.removeEventListener("change", handleChange);

    }, []);

    return [mobileNavOpen, { openMobileNav, closeMobileNav }];

}

export default useMobileNav;
