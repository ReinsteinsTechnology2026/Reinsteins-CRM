const express = require("express");

const router = express.Router();

const { submitDemoRequest } = require("../controllers/publicController");
const { demoRequestLimiter } = require("../middleware/rateLimiters");

// ==========================================
// PUBLIC ROUTES (Phase 6)
// Mounted at /api/public in app.js. No authentication middleware on
// any route here -- that is intentional, this is the public website's
// backend surface. Every handler is deliberately narrow (see
// controllers/publicController.js).
// ==========================================

router.post("/demo-request", demoRequestLimiter, submitDemoRequest);

module.exports = router;
