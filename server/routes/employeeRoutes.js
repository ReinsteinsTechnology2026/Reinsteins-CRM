const express = require("express");

const {
  getEmployees,
  createEmployee,
  updateEmployee,
  changeEmployeeStatus,
  getMyProfile,
  updateMyProfile,
  uploadMyProfilePhoto,
  getNextEmployeeId,
  getNextInternId,
  resignEmployee,
  terminateEmployee,
  rehireEmployee,
  getEmploymentHistory,
  completeInternship,
  discontinueInternship,
  convertInternToEmployee,
  rehireIntern,
} = require(
  "../controllers/employeeController"
);

const {
  protect,
} = require(
  "../middleware/authMiddleware"
);

const {
  requireAccess,
} = require(
  "../middleware/accessMiddleware"
);

// Employee/intern management is Super Admin + Admin + HR per Part 14
// — role='admin' (adminOnly) still always passes every requireAccess
// check, so nothing existing changes for admins; this only ADDS HR.

const manageEmployees = requireAccess("super_admin", "admin", "hr");

const {
  uploadProfilePhoto,
} = require(
  "../middleware/uploadMiddleware"
);

const router = express.Router();

// ==========================================
// EMPLOYEE - GET MY PROFILE
// ==========================================

router.get(
  "/profile/me",
  protect,
  getMyProfile
);

// ==========================================
// EMPLOYEE - UPDATE MY PROFILE
// ==========================================

router.put(
  "/profile/me",
  protect,
  updateMyProfile
);

// ==========================================
// EMPLOYEE - UPLOAD PROFILE PHOTO
// Field name must be: profilePhoto
// ==========================================

router.post(
  "/profile/photo",
  protect,
  uploadProfilePhoto.single(
    "profilePhoto"
  ),
  uploadMyProfilePhoto
);

// ==========================================
// ADMIN - GET ALL EMPLOYEES
// ==========================================

router.get(
  "/",
  protect,
  manageEmployees,
getEmployees
);

// ==========================================
// ADMIN - PREVIEW NEXT EMPLOYEE ID
// Display-only, for the Add Employee modal.
// ==========================================

router.get(
  "/next-employee-id",
  protect,
  manageEmployees,
getNextEmployeeId
);

// ==========================================
// ADMIN - PREVIEW NEXT INTERN ID
// Display-only, for the Add Intern modal.
// ==========================================

router.get(
  "/next-intern-id",
  protect,
  manageEmployees,
getNextInternId
);

// ==========================================
// ADMIN - CREATE EMPLOYEE OR INTERN
// One endpoint for both — createEmployee
// branches on employmentType in the body
// ('employee' by default, 'intern' for Add
// Intern). See employeeController.js.
// ==========================================

router.post(
  "/",
  protect,
  manageEmployees,
createEmployee
);

// ==========================================
// ADMIN - UPDATE EMPLOYEE
// ==========================================

router.put(
  "/:id",
  protect,
  manageEmployees,
updateEmployee
);

// ==========================================
// ADMIN - CHANGE EMPLOYEE STATUS
// ==========================================

router.patch(
  "/:id/status",
  protect,
  manageEmployees,
changeEmployeeStatus
);

// ==========================================
// ADMIN - EMPLOYEE LIFECYCLE
// Resign / terminate / rehire never delete a
// record — see employeeController.js. Only an
// authorized admin can reach these; employees
// have no route to them at all.
// ==========================================

router.post(
  "/:id/resign",
  protect,
  manageEmployees,
resignEmployee
);

router.post(
  "/:id/terminate",
  protect,
  manageEmployees,
terminateEmployee
);

router.post(
  "/:id/rehire",
  protect,
  manageEmployees,
rehireEmployee
);

router.get(
  "/:id/employment-history",
  protect,
  manageEmployees,
getEmploymentHistory
);

// ==========================================
// ADMIN - INTERN LIFECYCLE
// Complete / discontinue / convert / rehire
// never delete a record. "Terminate Internship"
// deliberately reuses the existing /:id/terminate
// route above — the action is identical for
// employees and interns. Only an authorized
// admin can reach any of these.
// ==========================================

router.post(
  "/:id/complete-internship",
  protect,
  manageEmployees,
completeInternship
);

router.post(
  "/:id/discontinue-internship",
  protect,
  manageEmployees,
discontinueInternship
);

router.post(
  "/:id/convert-to-employee",
  protect,
  manageEmployees,
convertInternToEmployee
);

router.post(
  "/:id/rehire-intern",
  protect,
  manageEmployees,
rehireIntern
);

module.exports = router;