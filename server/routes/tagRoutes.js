const express = require("express");

const router = express.Router();

const { getTags } = require("../controllers/tagController");

const { protect } = require("../middleware/authMiddleware");

const { requireActiveUser } = require("../middleware/accessMiddleware");

// ==========================================
// GET /api/tags?search=
// Any active authenticated user -- tags are a
// global reusable dictionary, not project-scoped,
// so no project membership/permission check applies
// here (matches how this app treats other global
// default entities, e.g. security group names).
// ==========================================

router.get(
    "/",
    protect,
    requireActiveUser,
    getTags
);

module.exports = router;
