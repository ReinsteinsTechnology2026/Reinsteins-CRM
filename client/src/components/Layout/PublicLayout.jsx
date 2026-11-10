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

  // A link to the section the address bar already points at (for example "Request a Demo" while on /#demo) does not change the location,
  // so the effect above would not run. Only that case is handled here; every other link goes through the router as usual.
  useEffect(() => {
    const onClick = (event) => {
      const link = event.target.closest && event.target.closest("a[href*='#']");
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname !== window.location.pathname || !url.hash || url.hash !== window.location.hash) return;
      const target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
      if (!target) return;
      event.preventDefault();
      const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    };
    // capture phase: runs before the router's own link handler, which would otherwise mark the click as handled first
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

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
