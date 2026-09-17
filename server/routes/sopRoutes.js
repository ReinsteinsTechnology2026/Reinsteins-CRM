const express = require("express");

const {
    listSops,
    createSop,
    deleteSop,
} = require("../controllers/sopController");

const { protect } = require("../middleware/authMiddleware");
const { requireAccess } = require("../middleware/accessMiddleware");
const { uploadSop } = require("../middleware/sopUploadMiddleware");

const router = express.Router();

// ==========================================
// SOP ROUTES (Phase 17c)
//
// VIEW: every authenticated tenant user (protect only) -- Employees,
// Interns, HR, Managers, Team Leads, Executives, etc. can all
// list/view/download SOPs.
//
// MUTATE (upload/delete): Admin/Super Admin only, per the explicit
// requirement -- unlike Shift Schedule (Phase 17b), HR is
// deliberately NOT included here. requireAccess("super_admin",
// "admin") already covers role='admin' too (accessMiddleware.js's
// unconditional role==='admin' bypass), so this is exactly
// "Admin or Super Admin", nothing broader.
// ==========================================

const manageSops = requireAccess("super_admin", "admin");

router.get("/", protect, listSops);

router.post("/", protect, manageSops, uploadSop.single("sopFile"), createSop);

router.delete("/:id", protect, manageSops, deleteSop);

module.exports = router;
