import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useParams,
} from "react-router-dom";

import {
  ToastContainer,
} from "react-toastify";

import "react-toastify/dist/ReactToastify.css";
import ChatNotificationListener from "./components/ChatNotificationListener";
import PersistentMeetingBar from "./components/Meetings/PersistentMeetingBar";
import EmployeeTasks from "./pages/Employee/EmployeeTasks";
// ==========================================
// AUTH PAGES
// ==========================================

import Login from "./pages/Auth/Login";
import Register from "./pages/Auth/Register";

// ==========================================
// ADMIN
// ==========================================

import AdminLayout from "./components/Layout/AdminLayout";

import AdminHome from "./pages/Admin/AdminHome";
import Employees from "./pages/Admin/Employees";
import AdminAttendance from "./pages/Admin/AdminAttendance";
import AdminShiftManagement from "./pages/Admin/AdminShiftManagement";
import AdminLeave from "./pages/Admin/AdminLeave";
import AdminReports from "./pages/Admin/AdminReports";
import AdminSettings from "./pages/Admin/AdminSettings";
import Organization from "./pages/Admin/Organization";
import Organizations from "./pages/Admin/Organizations";
import OrganizationDetail from "./pages/Admin/OrganizationDetail";

// ==========================================
// EMPLOYEE
// ==========================================

import EmployeeLayout from "./components/Layout/EmployeeLayout";

import EmployeeHome from "./pages/Employee/EmployeeHome";
import EmployeeAttendance from "./pages/Employee/EmployeeAttendance";
import EmployeeShiftSchedule from "./pages/Employee/EmployeeShiftSchedule";
import EmployeeLeave from "./pages/Employee/EmployeeLeave";
import EmployeeProfile from "./pages/Employee/EmployeeProfile";
import EmployeeSettings from "./pages/Employee/EmployeeSettings";
import EmployeeEmail from "./pages/Employee/EmployeeEmail";
import MyTeam from "./pages/Employee/MyTeam";
import MyReportingManager from "./pages/Employee/MyReportingManager";
import TeamLeaveApprovals from "./pages/Employee/TeamLeaveApprovals";
import ExecutiveProjects from "./pages/Employee/ExecutiveProjects";
import ProjectWorkspace from "./pages/Employee/ProjectWorkspace";
import ExecutiveOrganization from "./pages/Employee/ExecutiveOrganization";
import ExecutiveReports from "./pages/Employee/ExecutiveReports";

// ==========================================
// TASKS
// ==========================================

import TaskDashboard from "./pages/TaskManagement/TaskDashboard";
import TaskWorkspace from "./pages/TaskManagement/TaskWorkspace";
import AdminTasksList from "./pages/TaskManagement/AdminTasksList";

// ==========================================
// PROJECTS / USER STORIES
// ==========================================

import ProjectsList from "./pages/Projects/ProjectsList";
import UserStoryDetail from "./pages/Projects/UserStoryDetail";

// ==========================================
// CHAT
// ==========================================

import Chat from "./pages/Chat/Chat";

// ==========================================
// MEETINGS
// ==========================================

import MeetingsList from "./pages/Meetings/MeetingsList";
import MeetingDetails from "./pages/Meetings/MeetingDetails";
import MeetingLobby from "./pages/Meetings/MeetingLobby";
import MeetingLinkLanding from "./pages/Meetings/MeetingLinkLanding";

// ==========================================
// PROTECTED ROUTE
// ==========================================

import ProtectedRoute from "./routes/ProtectedRoute";

// ==========================================
// GROWORGS PLATFORM OWNER DASHBOARD (Phase 4)
// A separate product surface from the tenant portal above --
// its own login, its own guard, its own layout. Never linked from
// AdminSidebar/EmployeeSidebar; reachable only by navigating
// directly to /platform/login.
// ==========================================

import PlatformProtectedRoute from "./routes/PlatformProtectedRoute";
import PlatformLayout from "./components/Layout/PlatformLayout";
import PlatformLogin from "./pages/Platform/PlatformLogin";
import PlatformDashboard from "./pages/Platform/PlatformDashboard";
import PlatformCompanies from "./pages/Platform/PlatformCompanies";
import PlatformCompanyDetails from "./pages/Platform/PlatformCompanyDetails";
import PlatformDemoRequests from "./pages/Platform/PlatformDemoRequests";
import PlatformDemoRequestDetails from "./pages/Platform/PlatformDemoRequestDetails";
import PlatformPlans from "./pages/Platform/PlatformPlans";
import PlatformUsers from "./pages/Platform/PlatformUsers";
import PlatformPayments from "./pages/Platform/PlatformPayments";
import PlatformAnalytics from "./pages/Platform/PlatformAnalytics";
import PlatformSupport from "./pages/Platform/PlatformSupport";
import PlatformAuditLogs from "./pages/Platform/PlatformAuditLogs";
import PlatformEmailLogs from "./pages/Platform/PlatformEmailLogs";
import PlatformSettings from "./pages/Platform/PlatformSettings";

// ==========================================
// GROWORGS PUBLIC WEBSITE (Phase 6)
// Separate marketing site -- own layout, own pages, no route guard
// (everything here is intentionally public/unauthenticated).
// ==========================================

import PublicLayout from "./components/Layout/PublicLayout";
import PublicHome from "./pages/Public/Home";
import PublicFeatures from "./pages/Public/Features";
import PublicSolutions from "./pages/Public/Solutions";
import PublicPricing from "./pages/Public/Pricing";
import PublicAbout from "./pages/Public/About";
import PublicContact from "./pages/Public/Contact";
import PortalLogin from "./pages/Public/PortalLogin";

// ==========================================
// ADMIN / EMPLOYEE ROUTE DEFINITIONS (Phase 5)
//
// Declared ONCE as plain data, then rendered under TWO different
// URL prefixes below: the existing legacy "/admin"/"/employee"
// (unchanged, Reinsteins-only via /api/auth/login) and the new
// company-aware "/:companySlug/admin"/"/:companySlug/employee"
// (via /api/tenant-auth/:companySlug/login). No page component is
// duplicated -- only the route path strings are generated twice,
// which is what "reuse existing pages/components, don't duplicate
// the entire portal" means in React Router terms: one AdminHome,
// one Employees page, etc., reachable at two URL shapes.
// ==========================================

const ADMIN_ROUTES = [
  { path: "employees", Component: Employees },
  { path: "attendance", Component: AdminAttendance },
  { path: "shift-management", Component: AdminShiftManagement },
  { path: "tasks", Component: AdminTasksList },
  { path: "task-workspace/:taskId", Component: TaskWorkspace },
  { path: "projects", Component: ProjectsList },
  { path: "projects/:id", Component: ProjectWorkspace },
  { path: "user-stories/:id", Component: UserStoryDetail },
  { path: "leave", Component: AdminLeave },
  { path: "reports", Component: AdminReports },
  { path: "chat", Component: Chat },
  { path: "meetings", Component: MeetingsList },
  { path: "meetings/:id", Component: MeetingDetails },
  { path: "meetings/:id/room", Component: MeetingLobby },
  { path: "settings", Component: AdminSettings },
  { path: "organization", Component: Organization },
  { path: "organization/:tab", Component: Organization },
  { path: "organizations", Component: Organizations },
  { path: "organizations/:id", Component: OrganizationDetail },
];

const EMPLOYEE_ROUTES = [
  { path: "attendance", Component: EmployeeAttendance },
  { path: "shift-schedule", Component: EmployeeShiftSchedule },
  { path: "tasks", Component: EmployeeTasks },
  { path: "task-workspace/:taskId", Component: TaskWorkspace },
  { path: "leave", Component: EmployeeLeave },
  { path: "profile", Component: EmployeeProfile },
  { path: "chat", Component: Chat },
  { path: "email", Component: EmployeeEmail },
  { path: "meetings", Component: MeetingsList },
  { path: "meetings/:id", Component: MeetingDetails },
  { path: "meetings/:id/room", Component: MeetingLobby },
  { path: "settings", Component: EmployeeSettings },
  { path: "team", Component: MyTeam },
  { path: "team/leave-approvals", Component: TeamLeaveApprovals },
  { path: "reporting-manager", Component: MyReportingManager },
  { path: "projects", Component: ExecutiveProjects },
  { path: "projects/:id", Component: ProjectWorkspace },
  { path: "organization", Component: ExecutiveOrganization },
  { path: "reports", Component: ExecutiveReports },
];

// Preserves the :id (or any other) URL param when redirecting an old
// /platform/... path to its /owner/... equivalent, e.g.
// /platform/companies/7 -> /owner/companies/7, not the literal
// string ":id".
function ParamRedirect({ to }) {
  const params = useParams();
  const resolved = Object.entries(params).reduce(
    (path, [key, value]) => path.replace(`:${key}`, value),
    to
  );
  return <Navigate to={resolved} replace />;
}

function buildRoleRoutes(basePath, IndexComponent, routeDefs, allowedRole, Layout) {
  return (
    <Route
      key={basePath}
      element={
        <ProtectedRoute allowedRole={allowedRole}>
          <Layout />
        </ProtectedRoute>
      }
    >

      <Route
        path={basePath}
        element={<IndexComponent />}
      />

      {routeDefs.map(({ path, Component }) => (
        <Route
          key={path}
          path={`${basePath}/${path}`}
          element={<Component />}
        />
      ))}

    </Route>
  );
}

// admin.zioventure.com is the Platform Owner portal's public hostname;
// crm.zioventure.com keeps serving the tenant/marketing app unchanged.
// Same SPA bundle for both hosts, so this is the only hostname check
// needed -- /owner/* already works under any hostname today.
const isPlatformOwnerHost =
  typeof window !== "undefined" &&
  window.location.hostname === "admin.zioventure.com";

function App() {

  return (

    <BrowserRouter>

      <Routes>

        {/* ==================================
            GROWORGS PUBLIC WEBSITE (Phase 6)
            "/" is now the public marketing homepage, not the legacy
            login form -- the legacy Reinsteins login moved to
            /legacy-login (untouched component, just a new path; see
            below) so it stays fully reachable without occupying "/".
            Own layout (PublicLayout), own navbar/footer, own theme
            (styles/publicTheme.css) -- shares nothing with the
            tenant portal, Platform Dashboard, or Reinsteins' own
            branding.
        ================================== */}

        <Route element={<PublicLayout />}>
          <Route
            path="/"
            element={
              isPlatformOwnerHost
                ? <Navigate to="/owner/login" replace />
                : <PublicHome />
            }
          />
          <Route path="/features" element={<PublicFeatures />} />
          <Route path="/solutions" element={<PublicSolutions />} />
          <Route path="/pricing" element={<PublicPricing />} />
          <Route path="/about" element={<PublicAbout />} />
          <Route path="/contact" element={<PublicContact />} />
          <Route path="/login" element={<PortalLogin />} />
        </Route>

        <Route
          path="/register"
          element={<Register />}
        />

        {/* ==================================
            LEGACY REINSTEINS LOGIN (moved off "/" this phase)
            Same Login component, same /api/auth/login endpoint,
            completely unmodified behavior -- only its route path
            changed. Not linked from public navigation; reachable
            directly if ever needed for troubleshooting/backward
            compatibility.
        ================================== */}

        <Route
          path="/legacy-login"
          element={<Login />}
        />

        {/* ==================================
            COMPANY-AWARE LOGIN (Phase 5)
            Same Login component as "/legacy-login" -- useParams()
            inside it picks up companySlug and posts to
            /api/tenant-auth/:companySlug/login instead of the
            legacy /api/auth/login. The slug comes only from this
            URL segment, never from a form field.
        ================================== */}

        <Route
          path="/:companySlug/login"
          element={<Login />}
        />

        {/* ==================================
            ADMIN (legacy, unprefixed -- Reinsteins via the
            original /api/auth/login, byte-identical to before
            Phase 5)
        ================================== */}

        {buildRoleRoutes("/admin", AdminHome, ADMIN_ROUTES, "admin", AdminLayout)}

        {/* ==================================
            EMPLOYEE (legacy, unprefixed)
        ================================== */}

        {buildRoleRoutes("/employee", EmployeeHome, EMPLOYEE_ROUTES, "employee", EmployeeLayout)}

        {/* ==================================
            COMPANY-AWARE ADMIN / EMPLOYEE (Phase 5)
            Identical page components, mounted under
            /:companySlug/admin and /:companySlug/employee.
            ProtectedRoute (routes/ProtectedRoute.jsx) detects the
            companySlug param automatically and verifies via
            GET /api/tenant-auth/me, cross-checking the URL's slug
            against the company the caller's token ACTUALLY
            resolves to server-side -- never trusting the URL alone.
        ================================== */}

        {buildRoleRoutes("/:companySlug/admin", AdminHome, ADMIN_ROUTES, "admin", AdminLayout)}

        {buildRoleRoutes("/:companySlug/employee", EmployeeHome, EMPLOYEE_ROUTES, "employee", EmployeeLayout)}

        {/* ==================================
            SHAREABLE MEETING LINK
            Role-agnostic — works for any
            logged-in user regardless of role,
            so a copied meeting link works for
            whoever it's shared with.
        ================================== */}

        <Route
          path="/meeting/:meetingCode"
          element={
            <ProtectedRoute>
              <MeetingLinkLanding />
            </ProtectedRoute>
          }
        />

        {/* ==================================
            ZIOVENTURE PLATFORM OWNER DASHBOARD
            Separate from every tenant/company route above --
            own login, own guard (PlatformProtectedRoute), own
            layout (PlatformLayout). Not reachable through any
            tenant navigation link.

            /owner/* is the canonical path (login redirects here,
            the sidebar links here, the public site's "Platform
            Owner Login" link points here). The old /platform/*
            paths are kept working as redirects below so nothing
            that already links or is bookmarked to them breaks.
        ================================== */}

        <Route
          path="/owner/login"
          element={<PlatformLogin />}
        />

        <Route
          element={
            <PlatformProtectedRoute>
              <PlatformLayout />
            </PlatformProtectedRoute>
          }
        >

          <Route
            path="/owner/dashboard"
            element={<PlatformDashboard />}
          />

          <Route
            path="/owner/companies"
            element={<PlatformCompanies />}
          />

          <Route
            path="/owner/companies/:id"
            element={<PlatformCompanyDetails />}
          />

          <Route
            path="/owner/demo-requests"
            element={<PlatformDemoRequests />}
          />

          <Route
            path="/owner/demo-requests/:id"
            element={<PlatformDemoRequestDetails />}
          />

          <Route
            path="/owner/plans"
            element={<PlatformPlans />}
          />

          <Route
            path="/owner/users"
            element={<PlatformUsers />}
          />

          <Route
            path="/owner/payments"
            element={<PlatformPayments />}
          />

          <Route
            path="/owner/analytics"
            element={<PlatformAnalytics />}
          />

          <Route
            path="/owner/audit-logs"
            element={<PlatformAuditLogs />}
          />

          <Route
            path="/owner/email-logs"
            element={<PlatformEmailLogs />}
          />

          <Route
            path="/owner/support"
            element={<PlatformSupport />}
          />

          <Route
            path="/owner/settings"
            element={<PlatformSettings />}
          />

        </Route>

        {/* ---------- /platform/* -> /owner/* redirects (backward compatibility) ---------- */}

        <Route path="/platform/login" element={<Navigate to="/owner/login" replace />} />
        <Route path="/platform/dashboard" element={<Navigate to="/owner/dashboard" replace />} />
        <Route path="/platform/companies" element={<Navigate to="/owner/companies" replace />} />
        <Route path="/platform/companies/:id" element={<ParamRedirect to="/owner/companies/:id" />} />
        <Route path="/platform/demo-requests" element={<Navigate to="/owner/demo-requests" replace />} />
        <Route path="/platform/demo-requests/:id" element={<ParamRedirect to="/owner/demo-requests/:id" />} />
        <Route path="/platform/plans" element={<Navigate to="/owner/plans" replace />} />
        <Route path="/platform/settings" element={<Navigate to="/owner/settings" replace />} />

        {/* ==================================
            TEST ROUTES
        ================================== */}

        <Route
          path="/task-management-test"
          element={
            <ProtectedRoute allowedRole="admin">
              <TaskDashboard />
            </ProtectedRoute>
          }
        />

        <Route
          path="/task-management-test-employee"
          element={
            <ProtectedRoute allowedRole="employee">
              <TaskDashboard />
            </ProtectedRoute>
          }
        />

        {/* ==================================
            FALLBACK
            An unknown URL now lands on the public marketing
            homepage (a real, useful page) rather than a login form.
        ================================== */}

        <Route
          path="*"
          element={
            <Navigate
              to="/"
              replace
            />
          }
        />

      </Routes>

      <ChatNotificationListener />

      <PersistentMeetingBar />

      <ToastContainer
        position="top-right"
        autoClose={3000}
      />

    </BrowserRouter>

  );

}

export default App;