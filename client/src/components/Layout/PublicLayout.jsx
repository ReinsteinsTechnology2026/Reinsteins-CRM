import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";

import PublicNavbar from "../Public/PublicNavbar";
import PublicFooter from "../Public/PublicFooter";

import "../../styles/publicTheme.css";
import "../../styles/publicComponents.css";
import "../../styles/publicSite.css";

// ==========================================
// PUBLIC LAYOUT
// Wraps every public marketing page (/, /features, /solutions, /pricing, /about, /contact, /login). Completely separate from
// AdminLayout/EmployeeLayout (tenant portal) and PlatformLayout (Owner Portal): it shares no component, no CSS file and no route guard.
// ScrollManager makes "/#section" links land on their section (below the sticky bar) and sends every other navigation to the top.
// ==========================================

function ScrollManager() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (hash) {
      const id = decodeURIComponent(hash.slice(1));
      // wait a frame so the section exists after a route change
      const frame = requestAnimationFrame(() => {
        const target = document.getElementById(id);
        if (target) target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      });
      return () => cancelAnimationFrame(frame);
    }
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    return undefined;
  }, [pathname, hash]);

  return null;
}

function PublicLayout() {
  return (
    <div className="public-shell">
      <ScrollManager />
      <PublicNavbar />
      <main id="main">
        <Outlet />
      </main>
      <PublicFooter />
    </div>
  );
}

export default PublicLayout;
