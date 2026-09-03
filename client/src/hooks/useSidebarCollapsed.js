import { useCallback, useEffect, useState } from "react";

// Shared by AdminLayout and EmployeeLayout so the collapse/expand
// state and its localStorage persistence live in exactly one place
// rather than being reimplemented per role. Collapsing on one page
// (e.g. inside a live meeting) and navigating to another does not
// remount this hook's owner (the Layout stays mounted across route
// changes — only <Outlet/>'s child swaps), so state already survives
// navigation even before persistence; localStorage additionally
// carries the preference across a full page reload/new tab.

const STORAGE_KEY = "wh-sidebar-collapsed";

function readStoredValue() {

    try {
        return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
        return false;
    }

}

function useSidebarCollapsed() {

    const [collapsed, setCollapsed] = useState(readStoredValue);

    useEffect(() => {

        try {
            localStorage.setItem(STORAGE_KEY, String(collapsed));
        } catch {
            // Private browsing / storage disabled — the preference
            // simply won't persist across reloads, which is a
            // harmless degrade rather than a broken feature.
        }

    }, [collapsed]);

    const toggle = useCallback(() => setCollapsed((prev) => !prev), []);

    return [collapsed, toggle];

}

export default useSidebarCollapsed;
