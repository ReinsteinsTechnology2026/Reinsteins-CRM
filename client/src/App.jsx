import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
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
import EmployeeLeave from "./pages/Employee/EmployeeLeave";
import EmployeeProfile from "./pages/Employee/EmployeeProfile";
import EmployeeSettings from "./pages/Employee/EmployeeSettings";
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

function App() {

  return (

    <BrowserRouter>

      <Routes>

        {/* ==================================
            PUBLIC
        ================================== */}

        <Route
          path="/"
          element={<Login />}
        />

        <Route
          path="/register"
          element={<Register />}
        />

        {/* ==================================
            ADMIN
        ================================== */}

        <Route
          element={
            <ProtectedRoute allowedRole="admin">
              <AdminLayout />
            </ProtectedRoute>
          }
        >

          <Route
            path="/admin"
            element={<AdminHome />}
          />

          <Route
            path="/admin/employees"
            element={<Employees />}
          />

          <Route
            path="/admin/attendance"
            element={<AdminAttendance />}
          />

          <Route
            path="/admin/tasks"
            element={<AdminTasksList />}
          />

          <Route
            path="/admin/task-workspace/:taskId"
            element={<TaskWorkspace />}
          />

          <Route
            path="/admin/projects"
            element={<ProjectsList />}
          />

          <Route
            path="/admin/projects/:id"
            element={<ProjectWorkspace />}
          />

          <Route
            path="/admin/user-stories/:id"
            element={<UserStoryDetail />}
          />

          <Route
            path="/admin/leave"
            element={<AdminLeave />}
          />

          <Route
            path="/admin/reports"
            element={<AdminReports />}
          />

          <Route
            path="/admin/chat"
            element={<Chat />}
          />

          <Route
            path="/admin/meetings"
            element={<MeetingsList />}
          />

          <Route
            path="/admin/meetings/:id"
            element={<MeetingDetails />}
          />

          <Route
            path="/admin/meetings/:id/room"
            element={<MeetingLobby />}
          />

          <Route
            path="/admin/settings"
            element={<AdminSettings />}
          />

          <Route
            path="/admin/organization"
            element={<Organization />}
          />

          <Route
            path="/admin/organization/:tab"
            element={<Organization />}
          />

          <Route
            path="/admin/organizations"
            element={<Organizations />}
          />

          <Route
            path="/admin/organizations/:id"
            element={<OrganizationDetail />}
          />

        </Route>

        {/* ==================================
            EMPLOYEE
        ================================== */}

        <Route
          element={
            <ProtectedRoute allowedRole="employee">
              <EmployeeLayout />
            </ProtectedRoute>
          }
        >

          <Route
            path="/employee"
            element={<EmployeeHome />}
          />

          <Route
            path="/employee/attendance"
            element={<EmployeeAttendance />}
          />

 <Route
    path="/employee/tasks"
    element={<EmployeeTasks />}
/>

          <Route
            path="/employee/task-workspace/:taskId"
            element={<TaskWorkspace />}
          />

          <Route
            path="/employee/leave"
            element={<EmployeeLeave />}
          />

          <Route
            path="/employee/profile"
            element={<EmployeeProfile />}
          />

          <Route
            path="/employee/chat"
            element={<Chat />}
          />

          <Route
            path="/employee/meetings"
            element={<MeetingsList />}
          />

          <Route
            path="/employee/meetings/:id"
            element={<MeetingDetails />}
          />

          <Route
            path="/employee/meetings/:id/room"
            element={<MeetingLobby />}
          />

          <Route
            path="/employee/settings"
            element={<EmployeeSettings />}
          />

          <Route
            path="/employee/team"
            element={<MyTeam />}
          />

          <Route
            path="/employee/team/leave-approvals"
            element={<TeamLeaveApprovals />}
          />

          <Route
            path="/employee/reporting-manager"
            element={<MyReportingManager />}
          />

          <Route
            path="/employee/projects"
            element={<ExecutiveProjects />}
          />

          <Route
            path="/employee/projects/:id"
            element={<ProjectWorkspace />}
          />

          <Route
            path="/employee/organization"
            element={<ExecutiveOrganization />}
          />

          <Route
            path="/employee/reports"
            element={<ExecutiveReports />}
          />

        </Route>

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