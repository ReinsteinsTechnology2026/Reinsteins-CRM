import { Outlet } from "react-router-dom";

import PublicNavbar from "../Public/PublicNavbar";
import PublicFooter from "../Public/PublicFooter";

import "../../styles/publicTheme.css";
import "../../styles/publicComponents.css";

// ==========================================
// PUBLIC LAYOUT (Phase 6)
// Wraps every public marketing page (/, /features, /solutions,
// /pricing, /about, /contact, /login). Completely separate from
// AdminLayout/EmployeeLayout (tenant portal) and PlatformLayout
// (Platform Owner Dashboard) -- shares no component, no CSS file,
// no route guard with either.
// ==========================================

function PublicLayout() {
  return (
    <div className="public-shell">
      <PublicNavbar />
      <main>
        <Outlet />
      </main>
      <PublicFooter />
    </div>
  );
}

export default PublicLayout;
