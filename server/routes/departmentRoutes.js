const express = require("express");

const {
    getDepartments,
    getDepartmentById,
    getDepartmentMembers,
    createDepartment,
    updateDepartment,
    setDepartmentStatus,
    setDepartmentHead,
} = require("../controllers/departmentController");

const { protect } = require("../middleware/authMiddleware");
const { requireAccess } = require("../middleware/accessMiddleware");

const router = express.Router();

// Reading departments is available to any authenticated user (needed
// for dropdowns across Add Employee/Intern, transfer, org chart,
// etc.) — only creation/editing/status/head changes are restricted.

router.get("/", protect, getDepartments);
router.get("/:id", protect, getDepartmentById);
router.get("/:id/members", protect, getDepartmentMembers);

router.post(
    "/",
    protect,
    requireAccess("super_admin", "admin"),
    createDepartment
);

router.put(
    "/:id",
    protect,
    requireAccess("super_admin", "admin"),
    updateDepartment
);

router.patch(
    "/:id/status",
    protect,
    requireAccess("super_admin", "admin"),
    setDepartmentStatus
);

router.put(
    "/:id/head",
    protect,
    requireAccess("super_admin", "admin"),
    setDepartmentHead
);

module.exports = router;
