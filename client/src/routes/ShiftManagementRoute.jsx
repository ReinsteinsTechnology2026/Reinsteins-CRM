import { Navigate, useLocation } from "react-router-dom";

import AdminShiftManagement from "../pages/Admin/AdminShiftManagement";
import { resolveShiftManagementAccess } from "../utils/shiftAccess";

// ==========================================
// EMPLOYEE-PORTAL "shift-management" ROUTE
//
// Lets admin-tier users who sign in to the employee portal
// (system_access = 'admin' | 'super_admin') open the existing company-wide
// Shift Management page. Anyone else is redirected to their own Shift
// Schedule. The decision uses role/system_access only (utils/shiftAccess.js),
// never designation.
//
// This is a navigation convenience, not the security boundary: the page's
// shift and employee-list requests are authorized by the backend on every
// call, so a stale or edited client-side user object cannot widen access.
// ==========================================

function readSessionUser() {
  try {
    return JSON.parse(sessionStorage.getItem("user"));
  } catch {
    return null;
  }
}

function ShiftManagementRoute() {
  const { pathname } = useLocation();

  const access = resolveShiftManagementAccess(readSessionUser(), pathname);

  if (!access.allow) {
    return <Navigate to={access.redirectTo} replace />;
  }

  return <AdminShiftManagement />;
}

export default ShiftManagementRoute;
