const express = require("express");

const router = express.Router();

const {
    getLinks,
    createLink,
    deleteLink,
} = require("../controllers/workItemLinkController");

const { protect } = require("../middleware/authMiddleware");

// ==========================================
// WORK ITEM LINKS
//
// No requireProjectPermission(key, resolver) middleware
// here -- unlike Epic/Feature/User Story routes, a link
// request doesn't have a single :projectId path segment
// (POST carries TWO arbitrary-typed item references in
// its body). Access is resolved and checked inline in
// the controller instead, the same shape
// taskActivityController.js already uses for the
// identical problem (an activityId with no projectId in
// the URL either). See workItemLinkController.js.
// ==========================================

// GET /api/work-item-links/:sourceType/:sourceId
router.get(
    "/:sourceType/:sourceId",
    protect,
    getLinks
);

// POST /api/work-item-links
router.post(
    "/",
    protect,
    createLink
);

// DELETE /api/work-item-links/:id
router.delete(
    "/:id",
    protect,
    deleteLink
);

module.exports = router;
