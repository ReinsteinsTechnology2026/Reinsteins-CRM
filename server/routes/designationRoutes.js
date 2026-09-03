const express = require("express");

const {
    getDesignations,
    createDesignation,
    updateDesignation,
    setDesignationStatus,
} = require("../controllers/designationController");

const { protect } = require("../middleware/authMiddleware");
const { requireAccess } = require("../middleware/accessMiddleware");

const router = express.Router();

router.get("/", protect, getDesignations);

router.post(
    "/",
    protect,
    requireAccess("super_admin", "admin", "hr"),
    createDesignation
);

router.put(
    "/:id",
    protect,
    requireAccess("super_admin", "admin", "hr"),
    updateDesignation
);

router.patch(
    "/:id/status",
    protect,
    requireAccess("super_admin", "admin", "hr"),
    setDesignationStatus
);

module.exports = router;
